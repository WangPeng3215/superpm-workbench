import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type {
  Issue,
  IssueDetail,
  IssueListResult,
  Requirement,
  RequirementFile,
  RequirementFileList,
  RequirementListResult,
} from "@superpm/shared";
import {
  MCP_ERROR_CODES,
  mcpMutatingToolNames,
  mcpReadonlyToolNames,
  mcpToolContracts,
} from "@superpm/shared";
import { migrate } from "../src/db/migrate";
import { IssueService } from "../src/services/issues";
import { buildMcpTools, type McpGateway } from "../src/services/mcp-gateway";
import { RequirementFileService } from "../src/services/requirement-files";
import { RequirementService } from "../src/services/requirements";

interface StructuredError {
  error: { code: string; message: string };
}

describe("MCP 契约与服务网关", () => {
  let directory: string;
  let db: Database.Database;
  let requirements: RequirementService;
  let files: RequirementFileService;
  let issues: IssueService;
  let gateway: McpGateway;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "superpm-mcp-"));
    db = new Database(join(directory, "test.sqlite"));
    migrate(db);
    const workspace = join(directory, "workspace");
    mkdirSync(workspace, { recursive: true });
    requirements = new RequirementService(db);
    files = new RequirementFileService(db, workspace, requirements);
    issues = new IssueService(db, requirements, workspace);
    gateway = buildMcpTools({ requirements, files, issues });
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const createRequirement = (name = "登录流程优化") =>
    requirements.create({ name, proposedAt: "2026-10-15" }) as Requirement;

  // 正式问题记录只能由用户界面创建：测试直接调用业务服务，不经过 MCP
  const createIssueDirect = (
    requirementId: number,
    title = "按钮样式与设计稿不一致",
  ) => issues.create(requirementId, { stage: "design", title }) as Issue;

  it("契约完整性：13 个工具、只读 7 / 写 6、幂等标注与错误码白名单一致", () => {
    expect(mcpToolContracts).toHaveLength(13);
    const readonly = mcpToolContracts.filter((contract) => contract.kind === "readonly");
    const mutating = mcpToolContracts.filter((contract) => contract.kind === "mutating");
    expect(readonly).toHaveLength(7);
    expect(mutating).toHaveLength(6);
    expect(readonly.map((contract) => contract.name).sort()).toEqual(
      [...mcpReadonlyToolNames].sort(),
    );
    expect(mutating.map((contract) => contract.name).sort()).toEqual(
      [...mcpMutatingToolNames].sort(),
    );
    for (const contract of readonly) expect(contract.idempotency).toBe("none");
    for (const contract of mutating) expect(contract.idempotency).toBe("key-required");
    // 每个工具 allowedErrors ⊆ MCP_ERROR_CODES
    for (const contract of mcpToolContracts)
      for (const code of contract.allowedErrors) expect(MCP_ERROR_CODES).toContain(code);
  });

  it("契约与服务映射：每个契约工具在网关都有唯一执行器，一一对应不缺失", () => {
    for (const contract of mcpToolContracts) {
      const executor = gateway.tools.get(contract.name);
      expect(executor).toBeDefined();
      expect(typeof executor?.execute).toBe("function");
      expect(executor?.kind).toBe(contract.kind);
    }
    // 不多不少：网关不提供契约之外的任何工具
    expect(gateway.tools.size).toBe(mcpToolContracts.length);
  });

  it("只读往返：requirement.list / issue.list / issue.get / asset.get 返回与业务服务一致的真实数据", () => {
    const requirement = createRequirement();
    const created = gateway.call(
      "asset.create",
      {
        requirementId: requirement.id,
        phase: "analysis",
        category: "other",
        name: "背景说明",
        resourceType: "text",
        textContent: "本项目背景说明正文",
      },
      { idempotencyKey: "asset-1" },
    ) as RequirementFile;
    const issue = createIssueDirect(requirement.id);

    const listed = gateway.call("requirement.list", {}) as RequirementListResult;
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({ id: requirement.id, name: "登录流程优化" });
    // 与直接调用业务服务的结果一致（不做第二套业务逻辑）
    expect(listed).toEqual(requirements.list({}));

    const issueListed = gateway.call("issue.list", {
      requirementId: requirement.id,
    }) as IssueListResult;
    expect(issueListed.total).toBe(1);
    expect(issueListed).toEqual(issues.list(requirement.id));

    const detail = gateway.call("issue.get", {
      requirementId: requirement.id,
      issueId: issue.id,
    }) as IssueDetail;
    expect(detail).toMatchObject({
      id: issue.id,
      status: "pending",
      title: "按钮样式与设计稿不一致",
    });
    expect(detail.activities).toHaveLength(1);
    expect(detail.activities[0]).toMatchObject({ activityType: "system" });

    const asset = gateway.call("asset.get", {
      requirementId: requirement.id,
      assetId: created.id,
    }) as { file: RequirementFile; content: string };
    expect(asset.file).toMatchObject({ id: created.id, name: "背景说明", resourceType: "text" });
    expect(asset.content).toBe("本项目背景说明正文");
  });

  it("MCP 不提供 issue.create：AI 无法写入正式问题记录", () => {
    const requirement = createRequirement();
    expect(mcpToolContracts.map((contract) => contract.name)).not.toContain(
      "issue.create",
    );
    const rejected = gateway.call(
      "issue.create",
      {
        requirementId: requirement.id,
        stage: "design",
        title: "AI 自行创建的问题",
      },
      { idempotencyKey: "create-1" },
    ) as StructuredError;
    expect(rejected).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(issues.list(requirement.id).total).toBe(0);
  });

  it("issue.update 幂等：同幂等键只生效一次且返回首次结果", () => {
    const requirement = createRequirement();
    const issue = createIssueDirect(requirement.id);
    const first = gateway.call(
      "issue.update",
      { requirementId: requirement.id, issueId: issue.id, title: "第一次修改" },
      { idempotencyKey: "same-key" },
    ) as Issue;
    expect(first.title).toBe("第一次修改");
    // 同键重放：直接返回首次结果，即使入参不同也不生效
    const replay = gateway.call(
      "issue.update",
      {
        requirementId: requirement.id,
        issueId: issue.id,
        title: "同键重放不会生效",
      },
      { idempotencyKey: "same-key" },
    ) as Issue;
    expect(replay.id).toBe(first.id);
    expect(replay.title).toBe("第一次修改");
    const detail = gateway.call("issue.get", {
      requirementId: requirement.id,
      issueId: issue.id,
    }) as IssueDetail;
    expect(detail.title).toBe("第一次修改");
    // 不同键正常工作
    const second = gateway.call(
      "issue.update",
      { requirementId: requirement.id, issueId: issue.id, title: "第二次修改" },
      { idempotencyKey: "other-key" },
    ) as Issue;
    expect(second.title).toBe("第二次修改");
  });

  it("solution 守卫：无方案不能解决；一次调用既提交 solution 又置 resolved 被拒，两步显式调用成功", () => {
    const requirement = createRequirement();
    const issue = createIssueDirect(requirement.id);
    // 服务层守卫：没有正式结论不得标记已解决
    const missingSolution = gateway.call(
      "issue.update",
      { requirementId: requirement.id, issueId: issue.id, status: "resolved" },
      { idempotencyKey: "guard-0" },
    ) as StructuredError;
    expect(missingSolution).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    const rejected = gateway.call(
      "issue.update",
      {
        requirementId: requirement.id,
        issueId: issue.id,
        solution: "调整间距为 8px 并重新导出切图",
        status: "resolved",
      },
      { idempotencyKey: "guard-1" },
    ) as StructuredError;
    expect(rejected).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    // 被拒调用不得产生任何副作用
    expect(
      gateway.call("issue.get", { requirementId: requirement.id, issueId: issue.id }) as IssueDetail,
    ).toMatchObject({ status: "pending", solution: "" });

    // 第一步：显式保存解决方案（状态保持不变）
    const saved = gateway.call(
      "issue.update",
      {
        requirementId: requirement.id,
        issueId: issue.id,
        solution: "调整间距为 8px 并重新导出切图",
      },
      { idempotencyKey: "guard-2" },
    ) as Issue;
    expect(saved).toMatchObject({
      status: "pending",
      solution: "调整间距为 8px 并重新导出切图",
    });

    // 第二步：单独显式变更状态为 resolved
    const resolved = gateway.call(
      "issue.update",
      { requirementId: requirement.id, issueId: issue.id, status: "resolved" },
      { idempotencyKey: "guard-3" },
    ) as Issue;
    expect(resolved).toMatchObject({ status: "resolved" });
    expect(resolved.resolvedAt).toBeTruthy();
  });

  it("错误结构：不存在的资源、未知工具与非法入参均返回结构化错误", () => {
    const missing = gateway.call("requirement.get", { id: 999999 }) as StructuredError;
    expect(missing).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(missing.error.message).toContain("需求不存在");

    const unknown = gateway.call("requirement.delete", {}) as StructuredError;
    expect(unknown).toMatchObject({ error: { code: "NOT_FOUND" } });

    const invalid = gateway.call("requirement.get", { id: "abc" }) as StructuredError;
    expect(invalid).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("安全边界：工具集快照固定，不含 SQL/路径/文件系统类工具", () => {
    const names = mcpToolContracts.map((contract) => contract.name).sort();
    expect(names).toEqual([
      "asset.create",
      "asset.get",
      "asset.list",
      "asset.updateStatus",
      "issue.activities",
      "issue.comment",
      "issue.get",
      "issue.linkAsset",
      "issue.list",
      "issue.unlinkAsset",
      "issue.update",
      "requirement.get",
      "requirement.list",
    ]);
    for (const name of names)
      expect(name.toLowerCase()).not.toMatch(/sql|path|file-?system|shell|exec|\bfs\b/);
  });

  it("issue.comment 幂等：同幂等键不重复追加活动", () => {
    const requirement = createRequirement();
    const issue = createIssueDirect(requirement.id);
    gateway.call(
      "issue.comment",
      { requirementId: requirement.id, issueId: issue.id, content: "已与设计师确认" },
      { idempotencyKey: "comment-1" },
    );
    gateway.call(
      "issue.comment",
      { requirementId: requirement.id, issueId: issue.id, content: "重复的评论不应生效" },
      { idempotencyKey: "comment-1" },
    );
    let detail = gateway.call("issue.get", {
      requirementId: requirement.id,
      issueId: issue.id,
    }) as IssueDetail;
    const comments = detail.activities.filter((item) => item.activityType === "comment");
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe("已与设计师确认");

    gateway.call(
      "issue.comment",
      { requirementId: requirement.id, issueId: issue.id, content: "补充说明" },
      { idempotencyKey: "comment-2" },
    );
    detail = gateway.call("issue.get", {
      requirementId: requirement.id,
      issueId: issue.id,
    }) as IssueDetail;
    expect(detail.activities.filter((item) => item.activityType === "comment")).toHaveLength(2);
  });

  it("幂等保护：mutating 工具缺少幂等键被拒且不产生副作用，只读工具无需幂等键", () => {
    const requirement = createRequirement();
    const issue = createIssueDirect(requirement.id, "原始标题");
    const rejected = gateway.call("issue.update", {
      requirementId: requirement.id,
      issueId: issue.id,
      title: "无键调用",
    }) as StructuredError;
    expect(rejected).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    const unchanged = gateway.call("issue.get", {
      requirementId: requirement.id,
      issueId: issue.id,
    }) as IssueDetail;
    expect(unchanged.title).toBe("原始标题");

    // 只读工具不需要幂等键；被拒调用未产生额外副作用
    const listed = gateway.call("requirement.list", {}) as RequirementListResult;
    expect(listed.total).toBe(1);
  });

  it("issue.linkAsset / issue.unlinkAsset：关联去重返回 CONFLICT，取消后可复检", () => {
    const requirement = createRequirement();
    const issue = createIssueDirect(requirement.id);
    // 问题关联已切换到 artifacts 体系：直接向 artifact_nodes 插入一个文件节点
    const now = "2026-01-01T00:00:00.000Z";
    const node = db
      .prepare(
        "INSERT INTO artifact_nodes(requirement_id, parent_id, node_type, name, relative_path, indexed_at, created_at, updated_at) VALUES (?, NULL, 'file', '问题截图.md', '问题截图.md', ?, ?, ?)",
      )
      .run(requirement.id, now, now, now);
    const nodeId = Number(node.lastInsertRowid);

    const linked = gateway.call(
      "issue.linkAsset",
      { requirementId: requirement.id, issueId: issue.id, assetId: nodeId, relationType: "evidence" },
      { idempotencyKey: "link-1" },
    );
    expect(linked).toMatchObject({
      issueId: issue.id,
      assetId: nodeId,
      relationType: "evidence",
      asset: { id: nodeId, nodeType: "file", name: "问题截图.md" },
    });

    const duplicate = gateway.call(
      "issue.linkAsset",
      { requirementId: requirement.id, issueId: issue.id, assetId: nodeId },
      { idempotencyKey: "link-2" },
    ) as StructuredError;
    expect(duplicate).toMatchObject({ error: { code: "CONFLICT" } });

    // 取消关联返回 void；关联不存在时返回结构化 NOT_FOUND
    expect(
      gateway.call(
        "issue.unlinkAsset",
        { requirementId: requirement.id, issueId: issue.id, assetId: nodeId },
        { idempotencyKey: "unlink-1" },
      ),
    ).toBeUndefined();
    const again = gateway.call(
      "issue.unlinkAsset",
      { requirementId: requirement.id, issueId: issue.id, assetId: nodeId },
      { idempotencyKey: "unlink-2" },
    ) as StructuredError;
    expect(again).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("asset.list / issue.activities / asset.updateStatus：分组列表、时间线与确认版状态往返", () => {
    const requirement = createRequirement();
    const asset = gateway.call(
      "asset.create",
      {
        requirementId: requirement.id,
        phase: "analysis",
        category: "record",
        name: "分析记录补充",
        resourceType: "text",
        textContent: "记录内容",
      },
      { idempotencyKey: "asset-status-1" },
    ) as RequirementFile;

    const listed = gateway.call("asset.list", { requirementId: requirement.id }) as RequirementFileList;
    expect(listed.phase).toBe("all");
    expect(listed.groups.flatMap((group) => group.files).map((file) => file.id)).toContain(asset.id);

    const finalized = gateway.call(
      "asset.updateStatus",
      {
        requirementId: requirement.id,
        assetId: asset.id,
        status: "final",
        description: "已确认版本",
      },
      { idempotencyKey: "asset-status-2" },
    ) as RequirementFile;
    expect(finalized).toMatchObject({ id: asset.id, status: "final", description: "已确认版本" });

    const issue = createIssueDirect(requirement.id);
    gateway.call(
      "issue.comment",
      { requirementId: requirement.id, issueId: issue.id, content: "进展更新" },
      { idempotencyKey: "activities-comment" },
    );
    const activities = gateway.call("issue.activities", {
      requirementId: requirement.id,
      issueId: issue.id,
    }) as { items: IssueDetail["activities"] };
    expect(activities.items.map((item) => item.activityType)).toEqual(["system", "comment"]);
  });
});
