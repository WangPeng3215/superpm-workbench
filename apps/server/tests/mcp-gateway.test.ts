import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type {
  ArtifactMemoryReadResult,
  ArtifactReadResult,
  Issue,
  McpArtifactDirectoryData,
  McpIssueActivitiesData,
  McpIssueDetailData,
  McpIssueListData,
  McpMemoryData,
  McpProgressData,
  McpRequirementDetailData,
  McpRequirementListData,
  McpReadResult,
  Requirement,
} from "@superpm/shared";
import {
  MCP_ERROR_CODES,
  MCP_UNTRUSTED_CONTENT_NOTICE,
  mcpAutoWriteToolNames,
  mcpConfirmedWriteToolNames,
  mcpMutatingToolNames,
  mcpReadonlyToolNames,
  mcpToolContracts,
  mcpWritePayloadSchemas,
  mcpWriteToolNames,
} from "@superpm/shared";
import { migrate } from "../src/db/migrate";
import { ArtifactService } from "../src/services/artifacts";
import { DailyTaskService } from "../src/services/daily-tasks";
import { IssueService } from "../src/services/issues";
import { buildMcpTools, type McpGateway } from "../src/services/mcp-gateway";
import { McpWriteService } from "../src/services/mcp-writes";
import { MeetingService } from "../src/services/meetings";
import { NoteService } from "../src/services/notes";
import { RequirementDirectoryResolver } from "../src/services/requirement-directory";
import { RequirementProgressService } from "../src/services/requirement-progress";
import { RequirementService } from "../src/services/requirements";

interface StructuredError {
  error: { code: string; message: string };
}

describe("MCP 只读契约（M2）", () => {
  let directory: string;
  let workspace: string;
  let db: Database.Database;
  let requirements: RequirementService;
  let directories: RequirementDirectoryResolver;
  let artifacts: ArtifactService;
  let issues: IssueService;
  let progress: RequirementProgressService;
  let meetings: MeetingService;
  let notes: NoteService;
  let gateway: McpGateway;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "superpm-mcp-"));
    db = new Database(join(directory, "test.sqlite"));
    migrate(db);
    workspace = join(directory, "workspace");
    mkdirSync(workspace, { recursive: true });
    requirements = new RequirementService(db);
    directories = new RequirementDirectoryResolver(db, workspace);
    artifacts = new ArtifactService(db, workspace, requirements, directories);
    issues = new IssueService(db, requirements, workspace, directories);
    progress = new RequirementProgressService(
      requirements,
      issues,
      artifacts,
      directories,
    );
    meetings = new MeetingService(db);
    notes = new NoteService(db, new DailyTaskService(db));
    gateway = buildMcpTools({
      requirements,
      issues,
      artifacts,
      progress,
      meetings,
      notes,
      writes: new McpWriteService(db),
    });
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const createRequirement = (name = "登录流程优化") => {
    const requirement = requirements.create({
      name,
      description: "这是一个用于测试的较长需求描述",
      proposedAt: "2026-10-15",
    }) as Requirement;
    directories.initialize(requirement.id);
    return requirement;
  };
  const createRawRequirement = (name = "尚未初始化的需求") =>
    requirements.create({ name, proposedAt: "2026-10-15" }) as Requirement;
  const createIssueDirect = (
    requirementId: number,
    title: string,
    description = "",
  ) =>
    issues.create(requirementId, {
      stage: "design",
      title,
      description,
    }) as Issue;

  const ok = <T>(name: string, input: unknown): McpReadResult<T> => {
    const result = gateway.call(name, input);
    if (!result.ok)
      throw new Error(
        `工具 ${name} 失败：${result.error.code} ${result.error.message}`,
      );
    return result.data as McpReadResult<T>;
  };
  const dataOf = <T>(name: string, input: unknown): T =>
    ok<T>(name, input).data;
  const errorOf = (name: string, input: unknown): StructuredError => {
    const result = gateway.call(name, input);
    if (result.ok) throw new Error(`工具 ${name} 本应失败`);
    return { error: result.error };
  };
  const tableCount = (
    table:
      | "requirements"
      | "requirement_directories"
      | "issues"
      | "issue_activities"
      | "artifact_nodes"
      | "artifact_links",
  ) =>
    (
      db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
        total: number;
      }
    ).total;

  it("契约完整性：15 个只读 + 15 个写工具，写工具要求幂等键，错误码在白名单内", () => {
    expect(mcpToolContracts).toHaveLength(30);
    expect(mcpReadonlyToolNames).toHaveLength(15);
    expect(mcpMutatingToolNames).toHaveLength(15);
    expect(mcpConfirmedWriteToolNames).toHaveLength(12);
    expect(mcpAutoWriteToolNames).toHaveLength(3);
    expect(mcpToolContracts.map((contract) => contract.name).sort()).toEqual(
      [...mcpReadonlyToolNames, ...mcpMutatingToolNames].sort(),
    );
    // 确认令牌只覆盖受确认写入，低风险自动写入不进入 prepare
    expect(Object.keys(mcpWritePayloadSchemas).sort()).toEqual(
      [...mcpConfirmedWriteToolNames].sort(),
    );
    for (const contract of mcpToolContracts) {
      expect(contract.kind).toBe(
        (mcpReadonlyToolNames as readonly string[]).includes(contract.name)
          ? "readonly"
          : "mutating",
      );
      expect(contract.idempotency).toBe(
        contract.kind === "readonly" ? "none" : "key-required",
      );
      for (const code of contract.allowedErrors)
        expect(MCP_ERROR_CODES).toContain(code);
    }
  });

  it("默认网关只注册只读工具，不暴露 asset.* 或写工具", () => {
    expect(gateway.tools.size).toBe(15);
    for (const contract of mcpToolContracts.filter(
      (item) => item.kind === "readonly",
    )) {
      const executor = gateway.tools.get(contract.name);
      expect(executor).toBeDefined();
      expect(executor?.kind).toBe("readonly");
    }
    const names = [...gateway.tools.keys()];
    expect(names.some((name) => name.startsWith("asset."))).toBe(false);
    expect(names).not.toContain("issue.update");
    expect(names).not.toContain("issue.create");
    expect(names).not.toContain("issue.comment");
    expect(names).not.toContain("requirement.memory.update");
    expect(names).not.toContain("artifact.createText");
    expect(names).not.toContain("artifact.updateText");
    expect(gateway.writeEnabled).toBe(false);
    expect(errorOf("issue.update", {}).error.code).toBe("FORBIDDEN");
    expect(errorOf("write.prepare", {}).error.code).toBe("FORBIDDEN");
    expect(
      errorOf("requirement.memory.update", {
        requirementId: 1,
        mode: "replace",
        content: "x",
        idempotencyKey: "idem-disabled-0001",
      }).error.code,
    ).toBe("FORBIDDEN");
  });

  it("requirement.list / requirement.get：摘要与树形关系，不返回完整正文", () => {
    const parent = createRequirement("主需求");
    const child = requirements.create({
      name: "子需求",
      parentId: parent.id,
      proposedAt: "2026-10-16",
    }) as Requirement;

    const listed = dataOf<McpRequirementListData>("requirement.list", {});
    expect(listed.total).toBe(1);
    expect(listed.matchedCount).toBe(2);
    expect(listed.items).toHaveLength(1);
    const parentSummary = listed.items.find((item) => item.id === parent.id)!;
    expect(parentSummary.children.map((item) => item.id)).toEqual([child.id]);
    expect(parentSummary).not.toHaveProperty("description");
    expect(parentSummary).not.toHaveProperty("descriptionHtml");

    const detail = dataOf<McpRequirementDetailData>("requirement.get", {
      id: parent.id,
      maxChars: 4,
    });
    expect(detail.requirement.description).toBe("这是一个");
    expect(detail.truncated).toBe(true);
    expect(detail.truncatedFields).toContain("description");
    expect(detail.relations.children.map((item) => item.id)).toEqual([
      child.id,
    ]);
    expect(detail.relations.parent).toBeNull();

    const childDetail = dataOf<McpRequirementDetailData>("requirement.get", {
      id: child.id,
    });
    expect(childDetail.relations.parent?.id).toBe(parent.id);
  });

  it("requirement.memory.get：读取需求记忆且按 maxChars 截断", () => {
    const requirement = createRequirement();
    const node = artifacts.ensureMemory(requirement.id);
    artifacts.saveText(node.id, { content: "# 需求记忆\n已确认事实" });

    const full = dataOf<McpMemoryData>("requirement.memory.get", {
      requirementId: requirement.id,
    });
    expect(full.status).toBe("available");
    expect(full.exists).toBe(true);
    expect(full.content).toContain("已确认事实");
    expect(full.version).toBe(
      createHash("sha256")
        .update("# 需求记忆\n已确认事实", "utf8")
        .digest("hex"),
    );

    const clipped = dataOf<McpMemoryData>("requirement.memory.get", {
      requirementId: requirement.id,
      maxChars: 5,
    });
    expect(clipped.content).toHaveLength(5);
    expect(clipped.truncated).toBe(true);
    // 版本始终基于全文，不因截断而改变
    expect(clipped.version).toBe(full.version);
  });

  it("requirement.memory.get：未初始化需求不创建目录、不写映射", () => {
    const requirement = createRawRequirement();
    expect(tableCount("requirement_directories")).toBe(0);

    const memory = dataOf<McpMemoryData>("requirement.memory.get", {
      requirementId: requirement.id,
    });
    expect(memory).toMatchObject({
      exists: false,
      status: "not_initialized",
      content: "",
    });
    expect(tableCount("requirement_directories")).toBe(0);
    expect(existsSync(join(workspace, "requirements"))).toBe(false);
  });

  it("requirement.progress.get：组合需求、工作区、阶段历史、问题与产出物统计", () => {
    const requirement = createRequirement();
    requirements.update(requirement.id, {
      currentStage: "design",
      stageNote: "进入 UI 设计",
    });
    const openIssue = createIssueDirect(requirement.id, "待分析问题");
    const resolvedIssue = createIssueDirect(requirement.id, "已解决问题");
    issues.update(requirement.id, resolvedIssue.id, {
      solution: "调整间距后解决",
    });
    issues.update(requirement.id, resolvedIssue.id, { status: "resolved" });
    artifacts.createFile(requirement.id, {
      name: "分析说明.md",
      initialContent: "正文",
    });

    const snapshot = dataOf<McpProgressData>("requirement.progress.get", {
      requirementId: requirement.id,
    });
    expect(snapshot.requirement).toMatchObject({
      id: requirement.id,
      currentStage: "design",
    });
    expect(snapshot.workspace.directoryExists).toBe(true);
    expect(snapshot.stageHistory).toHaveLength(1);
    expect(snapshot.issues.total).toBe(2);
    expect(snapshot.issues.open).toBe(1);
    expect(snapshot.issues.resolved).toBe(1);
    expect(snapshot.issues.statusCounts.pending).toBe(1);
    expect(snapshot.artifacts.files).toBe(1);
    expect(snapshot.artifacts.memoryStatus).toBe("available");
    expect(openIssue.id).toBeDefined();
  });

  it("issue.list：分页、状态计数与摘要，不返回完整描述", () => {
    const requirement = createRequirement();
    for (let index = 1; index <= 3; index += 1)
      createIssueDirect(requirement.id, `问题 ${index}`, `描述 ${index}`);

    const firstPage = dataOf<McpIssueListData>("issue.list", {
      requirementId: requirement.id,
      limit: 2,
      offset: 0,
    });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.total).toBe(3);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.items[0]).not.toHaveProperty("description");
    expect(
      firstPage.items.every((item) =>
        item.descriptionPreview.startsWith("描述 "),
      ),
    ).toBe(true);
    expect(firstPage.items[0].descriptionLength).toBe(4);

    const secondPage = dataOf<McpIssueListData>("issue.list", {
      requirementId: requirement.id,
      limit: 2,
      offset: 2,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);

    const filtered = dataOf<McpIssueListData>("issue.list", {
      requirementId: requirement.id,
      q: "问题 2",
    });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].title).toBe("问题 2");
  });

  it("issue.get / issue.activities：文本按 maxChars 截断并标记字段", () => {
    const requirement = createRequirement();
    const issue = createIssueDirect(requirement.id, "截断测试", "0123456789");
    issues.update(requirement.id, issue.id, { solution: "abcdefghij" });
    issues.comment(requirement.id, issue.id, {
      content: "这是一条很长的处理说明",
    });

    const detail = dataOf<McpIssueDetailData>("issue.get", {
      requirementId: requirement.id,
      issueId: issue.id,
      maxChars: 4,
    });
    expect(detail.issue.description).toBe("0123");
    expect(detail.issue.solution).toBe("abcd");
    expect(detail.truncatedFields).toContain("description");
    expect(detail.truncatedFields).toContain("solution");
    expect(detail.activities.some((item) => item.content.length <= 4)).toBe(
      true,
    );
    expect(detail.issue).not.toHaveProperty("activities");

    const activities = dataOf<McpIssueActivitiesData>("issue.activities", {
      requirementId: requirement.id,
      issueId: issue.id,
      maxChars: 5,
    });
    const comment = activities.items.find(
      (item) => item.activityType === "comment",
    )!;
    expect(comment.content).toBe("这是一条很");
    expect(activities.truncatedFields).toContain(
      `activities[${activities.items.indexOf(comment)}].content`,
    );
  });

  it("artifact.list：sync=false 不拾取磁盘新文件、不写索引；limit 生效", () => {
    const requirement = createRequirement();
    for (let index = 1; index <= 3; index += 1)
      artifacts.createFile(requirement.id, {
        name: `文件${index}.md`,
        initialContent: `内容${index}`,
      });
    const root = directories.absoluteRoot(requirement.id);
    writeFileSync(join(root, "外部新增.md"), "外部文件", "utf8");
    const rowsBefore = tableCount("artifact_nodes");

    const listed = dataOf<McpArtifactDirectoryData>("artifact.list", {
      requirementId: requirement.id,
      limit: 2,
    });
    expect(listed.files).toHaveLength(2);
    expect(listed.total.files).toBe(3);
    expect(listed.limit).toBe(2);
    expect(listed.truncated).toBe(true);
    expect(listed.files.map((file) => file.name)).not.toContain("外部新增.md");
    expect(tableCount("artifact_nodes")).toBe(rowsBefore);
    expect(existsSync(join(root, "外部新增.md"))).toBe(true);

    // 对照：HTTP 界面路径 sync=true 会拾取磁盘新文件（默认目录也会一并登记）
    artifacts.listNodes(requirement.id, null, "", { sync: true });
    expect(tableCount("artifact_nodes")).toBeGreaterThan(rowsBefore);
    expect(
      db
        .prepare(
          "SELECT 1 FROM artifact_nodes WHERE requirement_id=? AND name='外部新增.md'",
        )
        .get(requirement.id),
    ).toBeTruthy();
  });

  it("artifact.get：文本截断 / 二进制不返回内容 / 文件夹详情", () => {
    const requirement = createRequirement();
    const text = artifacts.createFile(requirement.id, {
      name: "说明.md",
      initialContent: "0123456789",
    });
    const binary = artifacts.createFile(requirement.id, {
      name: "data.bin",
      initialContent: "\u0000\u0001binary",
    });
    const folder = artifacts.createFolder(requirement.id, { name: "设计稿" });

    const textResult = dataOf<ArtifactReadResult>("artifact.get", {
      requirementId: requirement.id,
      nodeId: text.id,
      maxChars: 4,
    });
    expect(textResult.kind).toBe("text");
    expect(textResult.content).toBe("0123");
    expect(textResult.truncated).toBe(true);
    expect(textResult.version).toBe(
      createHash("sha256").update("0123456789", "utf8").digest("hex"),
    );

    const binaryResult = dataOf<ArtifactReadResult>("artifact.get", {
      requirementId: requirement.id,
      nodeId: binary.id,
    });
    expect(binaryResult.kind).toBe("binary");
    expect(binaryResult.content).toBeNull();
    expect(binaryResult.version).toBeNull();

    const folderResult = dataOf<ArtifactReadResult>("artifact.get", {
      requirementId: requirement.id,
      nodeId: folder.id,
    });
    expect(folderResult.kind).toBe("folder");
    expect(folderResult.content).toBeNull();
    expect(folderResult.descendantCount).toBe(0);
    expect(folderResult.version).toBeNull();
  });

  it("需求作用域：跨需求的 issue / artifact 一律 NOT_FOUND", () => {
    const first = createRequirement("需求一");
    const second = createRequirement("需求二");
    const issue = createIssueDirect(second.id, "第二个需求的问题");
    const file = artifacts.createFile(second.id, {
      name: "第二个需求的文档.md",
      initialContent: "正文",
    });

    expect(
      errorOf("issue.get", {
        requirementId: first.id,
        issueId: issue.id,
      }).error.code,
    ).toBe("NOT_FOUND");
    expect(
      dataOf<McpIssueListData>("issue.list", {
        requirementId: first.id,
      }).total,
    ).toBe(0);
    expect(
      errorOf("artifact.get", {
        requirementId: first.id,
        nodeId: file.id,
      }).error.code,
    ).toBe("NOT_FOUND");
    expect(
      dataOf<McpArtifactDirectoryData>("artifact.list", {
        requirementId: first.id,
      }).files,
    ).toHaveLength(0);
  });

  it("只读副作用约束：调用全部工具前后数据库与需求记忆均不变化", () => {
    const requirement = createRequirement();
    const issue = createIssueDirect(requirement.id, "只读检查", "描述");
    issues.update(requirement.id, issue.id, { solution: "结论" });
    const file = artifacts.createFile(requirement.id, {
      name: "只读.md",
      initialContent: "内容",
    });
    const memory = artifacts.ensureMemory(requirement.id);
    const memoryPath = join(
      directories.absoluteRoot(requirement.id),
      "需求记忆.md",
    );
    const memoryMtime = statSync(memoryPath).mtimeMs;
    const memoryContent = readFileSync(memoryPath, "utf8");
    const snapshot = {
      requirements: tableCount("requirements"),
      requirement_directories: tableCount("requirement_directories"),
      issues: tableCount("issues"),
      issue_activities: tableCount("issue_activities"),
      artifact_nodes: tableCount("artifact_nodes"),
      artifact_links: tableCount("artifact_links"),
    };

    ok("requirement.list", {});
    ok("requirement.get", { id: requirement.id });
    ok("requirement.memory.get", { requirementId: requirement.id });
    ok("requirement.progress.get", { requirementId: requirement.id });
    ok("issue.list", { requirementId: requirement.id });
    ok("issue.get", { requirementId: requirement.id, issueId: issue.id });
    ok("issue.activities", {
      requirementId: requirement.id,
      issueId: issue.id,
    });
    ok("artifact.list", { requirementId: requirement.id });
    ok("artifact.get", { requirementId: requirement.id, nodeId: file.id });

    expect({
      requirements: tableCount("requirements"),
      requirement_directories: tableCount("requirement_directories"),
      issues: tableCount("issues"),
      issue_activities: tableCount("issue_activities"),
      artifact_nodes: tableCount("artifact_nodes"),
      artifact_links: tableCount("artifact_links"),
    }).toEqual(snapshot);
    expect(statSync(memoryPath).mtimeMs).toBe(memoryMtime);
    expect(readFileSync(memoryPath, "utf8")).toBe(memoryContent);
    expect(memory.id).toBeDefined();
  });

  it("结果附带不可信内容提示；未知工具与非法入参返回结构化错误", () => {
    const requirement = createRequirement();
    const result = ok<McpRequirementListData>("requirement.list", {});
    expect(result.notice).toBe(MCP_UNTRUSTED_CONTENT_NOTICE);

    expect(errorOf("requirement.delete", {})).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(errorOf("requirement.get", { id: "abc" }).error.code).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      errorOf("issue.list", { requirementId: requirement.id, limit: 500 }).error
        .code,
    ).toBe("VALIDATION_ERROR");
    expect(errorOf("requirement.get", { id: 999999 }).error.code).toBe(
      "NOT_FOUND",
    );
  });

  it("安全边界：工具集快照固定，不含 SQL / 路径 / 文件系统 / 任意写工具", () => {
    const names = mcpToolContracts.map((contract) => contract.name).sort();
    expect(names).toEqual([
      "artifact.createText",
      "artifact.get",
      "artifact.list",
      "artifact.updateText",
      "issue.activities",
      "issue.comment",
      "issue.get",
      "issue.linkAsset",
      "issue.list",
      "issue.unlinkAsset",
      "issue.update",
      "meeting.create",
      "meeting.delete",
      "meeting.get",
      "meeting.list",
      "meeting.search",
      "meeting.update",
      "note.archive",
      "note.convertToTask",
      "note.create",
      "note.delete",
      "note.get",
      "note.list",
      "note.search",
      "note.update",
      "requirement.get",
      "requirement.list",
      "requirement.memory.get",
      "requirement.memory.update",
      "requirement.progress.get",
    ]);
    for (const name of names) {
      expect(name.toLowerCase()).not.toMatch(
        /sql|path|filesystem|shell|exec|\bfs\b/,
      );
      if (
        name.startsWith("issue.") &&
        name !== "issue.get" &&
        name !== "issue.list" &&
        name !== "issue.activities"
      )
        expect(mcpWriteToolNames).toContain(name);
    }
    // create/delete 仅限低风险业务实体与受限文本文件；不提供通用删除能力
    expect(names.filter((name) => /create|delete/.test(name))).toEqual([
      "artifact.createText",
      "meeting.create",
      "meeting.delete",
      "note.create",
      "note.delete",
    ]);
  });

  it("ArtifactMemoryReadResult 类型可被服务直接返回", () => {
    const requirement = createRequirement();
    const result: ArtifactMemoryReadResult = artifacts.readMemory(
      requirement.id,
    );
    expect(result.status).toBe("available");
  });
});
