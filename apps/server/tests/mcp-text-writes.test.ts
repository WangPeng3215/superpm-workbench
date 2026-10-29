import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ArtifactReadResult,
  McpArtifactDirectoryData,
  McpArtifactTextWriteData,
  McpMemoryData,
  McpMemoryWriteData,
  McpReadResult,
  Requirement,
} from "@superpm/shared";
import { migrate } from "../src/db/migrate.js";
import { ArtifactService } from "../src/services/artifacts.js";
import { DailyTaskService } from "../src/services/daily-tasks.js";
import { IssueService } from "../src/services/issues.js";
import {
  buildMcpTools,
  type McpGateway,
  type McpToolCallOptions,
} from "../src/services/mcp-gateway.js";
import { McpWriteService } from "../src/services/mcp-writes.js";
import { MeetingService } from "../src/services/meetings.js";
import { NoteService } from "../src/services/notes.js";
import { RequirementDirectoryResolver } from "../src/services/requirement-directory.js";
import { RequirementProgressService } from "../src/services/requirement-progress.js";
import { RequirementService } from "../src/services/requirements.js";

interface AuditRow {
  id: number;
  tool: string;
  requirement_id: number | null;
  target_type: string | null;
  target_id: string | null;
  params_hash: string;
  idempotency_key: string | null;
  confirmation_id: number | null;
  actor_name: string | null;
  outcome: string;
  error_code: string | null;
  result_summary: string | null;
}

const ACTOR: McpToolCallOptions = { actorName: "codex" };
const hashOf = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

describe("MCP 低风险文本写入", () => {
  let directory: string;
  let workspace: string;
  let db: Database.Database;
  let requirements: RequirementService;
  let directories: RequirementDirectoryResolver;
  let artifacts: ArtifactService;
  let gateway: McpGateway;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "superpm-mcp-text-"));
    workspace = join(directory, "workspace");
    mkdirSync(workspace, { recursive: true });
    db = new Database(join(directory, "superpm.sqlite"));
    migrate(db);
    requirements = new RequirementService(db);
    directories = new RequirementDirectoryResolver(db, workspace);
    artifacts = new ArtifactService(db, workspace, requirements, directories);
    const issues = new IssueService(db, requirements, workspace, directories);
    const progress = new RequirementProgressService(
      requirements,
      issues,
      artifacts,
      directories,
    );
    gateway = buildMcpTools({
      requirements,
      issues,
      artifacts,
      progress,
      meetings: new MeetingService(db),
      notes: new NoteService(db, new DailyTaskService(db)),
      writes: new McpWriteService(db, { enabled: true }),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const createRequirement = (name = "文本写入需求", initialize = true) => {
    const requirement = requirements.create({
      name,
      proposedAt: "2026-10-15",
    }) as Requirement;
    if (initialize) directories.initialize(requirement.id);
    return requirement;
  };
  const dataOf = <T>(
    name: string,
    input: unknown,
    options: McpToolCallOptions = ACTOR,
  ): T => {
    const result = gateway.call(name, input, options);
    if (!result.ok)
      throw new Error(
        `工具 ${name} 失败：${result.error.code} ${result.error.message}`,
      );
    return (result.data as McpReadResult<T>).data;
  };
  const errorOf = (
    name: string,
    input: unknown,
    options: McpToolCallOptions = ACTOR,
  ) => {
    const result = gateway.call(name, input, options);
    if (result.ok) throw new Error(`工具 ${name} 本应失败`);
    return result.error;
  };
  const auditRows = () =>
    db.prepare("SELECT * FROM mcp_audit ORDER BY id ASC").all() as AuditRow[];
  const memoryPath = (requirementId: number) =>
    join(directories.absoluteRoot(requirementId), "需求记忆.md");
  const textPath = (requirementId: number, relativePath: string) =>
    join(directories.absoluteRoot(requirementId), relativePath);

  it("需求记忆：未初始化需求可创建，索引立即可见，审计不含正文且无需确认令牌", () => {
    const requirement = createRequirement("记忆创建需求", false);
    const content = "# 需求记忆\n\n## 已确认事实\n\n- 正文 SECRET_MEMORY_BODY";
    const result = dataOf<McpMemoryWriteData>(
      "requirement.memory.update",
      {
        requirementId: requirement.id,
        mode: "replace",
        content,
        idempotencyKey: "idem-memory-create-0001",
      },
      ACTOR,
    );
    expect(result.created).toBe(true);
    expect(result.mode).toBe("replace");
    expect(result.indexSync).toBe("synced");
    expect(result.version).toBe(hashOf(content));
    expect(readFileSync(memoryPath(requirement.id), "utf8")).toBe(content);

    const memory = dataOf<McpMemoryData>("requirement.memory.get", {
      requirementId: requirement.id,
    });
    expect(memory.exists).toBe(true);
    expect(memory.content).toBe(content);
    expect(memory.version).toBe(result.version);
    expect(memory.node?.id).toBe(result.node.id);

    const listed = dataOf<McpArtifactDirectoryData>("artifact.list", {
      requirementId: requirement.id,
    });
    expect(listed.files.map((file) => file.name)).toContain("需求记忆.md");
    const detail = dataOf<ArtifactReadResult>("artifact.get", {
      requirementId: requirement.id,
      nodeId: result.node.id,
    });
    expect(detail.kind).toBe("text");
    expect(detail.content).toBe(content);

    const success = auditRows().find((row) => row.outcome === "success")!;
    expect(success).toMatchObject({
      tool: "requirement.memory.update",
      requirement_id: requirement.id,
      confirmation_id: null,
      idempotency_key: "idem-memory-create-0001",
      actor_name: "mcp:codex",
      error_code: null,
    });
    expect(success.params_hash).toHaveLength(64);
    expect(success.result_summary).not.toContain("SECRET_MEMORY_BODY");
    expect(JSON.stringify(success)).not.toContain("SECRET_MEMORY_BODY");
    expect(JSON.stringify(success)).not.toContain(workspace);
  });

  it("需求记忆：追加、版本冲突、缺失版本与幂等重复", () => {
    const requirement = createRequirement();
    const initial = dataOf<McpMemoryData>("requirement.memory.get", {
      requirementId: requirement.id,
    });
    expect(initial.exists).toBe(true);
    expect(initial.version).toMatch(/^[0-9a-f]{64}$/);

    const appended = dataOf<McpMemoryWriteData>("requirement.memory.update", {
      requirementId: requirement.id,
      mode: "append",
      content: "## 下一步行动\n\n- 验证追加内容",
      expectedVersion: initial.version,
      idempotencyKey: "idem-memory-append-0001",
    });
    expect(appended.created).toBe(false);
    expect(appended.mode).toBe("append");
    expect(appended.version).not.toBe(initial.version);
    const appendedText = readFileSync(memoryPath(requirement.id), "utf8");
    expect(appendedText).toContain(initial.content);
    expect(appendedText).toContain("验证追加内容");

    const conflict = errorOf("requirement.memory.update", {
      requirementId: requirement.id,
      mode: "replace",
      content: "过期版本写入",
      expectedVersion: initial.version,
      idempotencyKey: "idem-memory-conflict-0001",
    });
    expect(conflict.code).toBe("CONFLICT");
    expect(readFileSync(memoryPath(requirement.id), "utf8")).toBe(appendedText);

    const missingVersion = errorOf("requirement.memory.update", {
      requirementId: requirement.id,
      mode: "replace",
      content: "缺少版本",
      idempotencyKey: "idem-memory-missing-0001",
    });
    expect(missingVersion.code).toBe("VALIDATION_ERROR");

    const duplicate = errorOf("requirement.memory.update", {
      requirementId: requirement.id,
      mode: "replace",
      content: "重复提交",
      expectedVersion: appended.version,
      idempotencyKey: "idem-memory-append-0001",
    });
    expect(duplicate.code).toBe("CONFLICT");
    expect(readFileSync(memoryPath(requirement.id), "utf8")).toBe(appendedText);

    const errorAudit = auditRows().find(
      (row) =>
        row.outcome === "error" && row.tool === "requirement.memory.update",
    )!;
    expect(errorAudit.confirmation_id).toBeNull();
    expect(errorAudit.idempotency_key).toBeNull();
    expect(JSON.stringify(errorAudit)).not.toContain("过期版本写入");
  });

  it("artifact.createText：默认 .md、同名冲突、扩展名/路径/跨需求/系统目录防护", () => {
    const requirement = createRequirement("文本创建需求");
    const other = createRequirement("另一个需求");
    const created = dataOf<McpArtifactTextWriteData>(
      "artifact.createText",
      {
        requirementId: requirement.id,
        name: "分析结论",
        content: "# 分析结论\n\n正文",
        idempotencyKey: "idem-text-create-0001",
      },
      ACTOR,
    );
    expect(created.node.name).toBe("分析结论.md");
    expect(created.node.extension).toBe(".md");
    expect(created.version).toBe(hashOf("# 分析结论\n\n正文"));
    expect(created.indexSync).toBe("synced");
    expect(
      readFileSync(textPath(requirement.id, created.node.relativePath), "utf8"),
    ).toBe("# 分析结论\n\n正文");

    const listed = dataOf<McpArtifactDirectoryData>("artifact.list", {
      requirementId: requirement.id,
    });
    expect(listed.files.map((file) => file.id)).toContain(created.node.id);
    const detail = dataOf<ArtifactReadResult>("artifact.get", {
      requirementId: requirement.id,
      nodeId: created.node.id,
    });
    expect(detail.content).toBe("# 分析结论\n\n正文");
    expect(detail.version).toBe(created.version);

    expect(
      errorOf("artifact.createText", {
        requirementId: requirement.id,
        name: "分析结论.md",
        content: "覆盖",
        idempotencyKey: "idem-text-duplicate-0001",
      }).code,
    ).toBe("CONFLICT");
    expect(
      readFileSync(textPath(requirement.id, created.node.relativePath), "utf8"),
    ).toBe("# 分析结论\n\n正文");

    expect(
      errorOf("artifact.createText", {
        requirementId: requirement.id,
        name: "脚本.exe",
        idempotencyKey: "idem-text-ext-0001",
      }).code,
    ).toBe("UNSUPPORTED_FILE_TYPE");
    expect(
      errorOf("artifact.createText", {
        requirementId: requirement.id,
        name: "需求记忆.md",
        idempotencyKey: "idem-text-memory-0001",
      }).code,
    ).toBe("CONFLICT");
    expect(
      errorOf("artifact.createText", {
        requirementId: requirement.id,
        name: "../逃逸.md",
        idempotencyKey: "idem-text-path-0001",
      }).code,
    ).toBe("VALIDATION_ERROR");
    expect(
      errorOf("artifact.createText", {
        requirementId: requirement.id,
        name: "~$临时文档.md",
        idempotencyKey: "idem-text-temp-0001",
      }).code,
    ).toBe("VALIDATION_ERROR");
    expect(
      errorOf("artifact.createText", {
        requirementId: other.id,
        parentId: created.node.id,
        name: "跨需求.md",
        idempotencyKey: "idem-text-cross-0001",
      }).code,
    ).toBe("NOT_FOUND");

    artifacts.refreshDirectory(requirement.id);
    const images = artifacts
      .listNodes(requirement.id, null)
      .folders.find((folder) => folder.name === "images");
    expect(images).toBeDefined();
    expect(
      errorOf("artifact.createText", {
        requirementId: requirement.id,
        parentId: images!.id,
        name: "图片说明.md",
        idempotencyKey: "idem-text-images-0001",
      }).code,
    ).toBe("CONFLICT");
    expect(existsSync(textPath(requirement.id, "逃逸.md"))).toBe(false);
  });

  it("artifact.updateText：版本校验、全量替换、记忆与二进制防护、缺失与跨需求", () => {
    const requirement = createRequirement("文本更新需求");
    const other = createRequirement("另一个更新需求");
    const created = dataOf<McpArtifactTextWriteData>(
      "artifact.createText",
      {
        requirementId: requirement.id,
        name: "设计说明.md",
        content: "旧正文",
        idempotencyKey: "idem-update-create-0001",
      },
      ACTOR,
    );

    const updated = dataOf<McpArtifactTextWriteData>(
      "artifact.updateText",
      {
        requirementId: requirement.id,
        nodeId: created.node.id,
        content: "新正文\n\n第二段",
        expectedVersion: created.version,
        idempotencyKey: "idem-update-text-0001",
      },
      ACTOR,
    );
    expect(updated.version).not.toBe(created.version);
    expect(updated.version).toBe(hashOf("新正文\n\n第二段"));
    const path = textPath(requirement.id, updated.node.relativePath);
    expect(readFileSync(path, "utf8")).toBe("新正文\n\n第二段");
    const detail = dataOf<ArtifactReadResult>("artifact.get", {
      requirementId: requirement.id,
      nodeId: created.node.id,
    });
    expect(detail.content).toBe("新正文\n\n第二段");
    expect(detail.version).toBe(updated.version);

    const conflict = errorOf("artifact.updateText", {
      requirementId: requirement.id,
      nodeId: created.node.id,
      content: "覆盖",
      expectedVersion: created.version,
      idempotencyKey: "idem-update-stale-0001",
    });
    expect(conflict.code).toBe("CONFLICT");
    expect(readFileSync(path, "utf8")).toBe("新正文\n\n第二段");

    const memory = artifacts.ensureMemory(requirement.id);
    expect(
      errorOf("artifact.updateText", {
        requirementId: requirement.id,
        nodeId: memory.id,
        content: "绕过记忆工具",
        expectedVersion: "0".repeat(64),
        idempotencyKey: "idem-update-memory-0001",
      }).code,
    ).toBe("CONFLICT");

    const binary = artifacts.createFile(requirement.id, {
      name: "二进制.bin",
      initialContent: "binary",
    });
    expect(
      errorOf("artifact.updateText", {
        requirementId: requirement.id,
        nodeId: binary.id,
        content: "文本",
        expectedVersion: "0".repeat(64),
        idempotencyKey: "idem-update-binary-0001",
      }).code,
    ).toBe("UNSUPPORTED_FILE_TYPE");

    const otherFile = dataOf<McpArtifactTextWriteData>(
      "artifact.createText",
      {
        requirementId: other.id,
        name: "其他需求.md",
        content: "其他",
        idempotencyKey: "idem-update-other-0001",
      },
      ACTOR,
    );
    expect(
      errorOf("artifact.updateText", {
        requirementId: requirement.id,
        nodeId: otherFile.node.id,
        content: "越权",
        expectedVersion: otherFile.version,
        idempotencyKey: "idem-update-cross-0001",
      }).code,
    ).toBe("NOT_FOUND");

    rmSync(path);
    expect(
      errorOf("artifact.updateText", {
        requirementId: requirement.id,
        nodeId: created.node.id,
        content: "缺失后写入",
        expectedVersion: updated.version,
        idempotencyKey: "idem-update-missing-0001",
      }).code,
    ).toBe("NOT_FOUND");
    artifacts.refreshDirectory(requirement.id);
    expect(
      db
        .prepare("SELECT status FROM artifact_nodes WHERE id=?")
        .get(created.node.id),
    ).toMatchObject({ status: "missing" });
  });

  it("write.prepare 不接受低风险自动写入工具", () => {
    const requirement = createRequirement();
    expect(
      errorOf("write.prepare", {
        tool: "requirement.memory.update",
        input: {
          requirementId: requirement.id,
          mode: "replace",
          content: "内容",
        },
        idempotencyKey: "idem-prepare-auto-0001",
      }).code,
    ).toBe("VALIDATION_ERROR");
  });

  it("索引登记失败：创建回滚文件并返回 INDEX_SYNC_FAILED", () => {
    const requirement = createRequirement();
    db.exec(
      "CREATE TRIGGER fail_artifact_insert BEFORE INSERT ON artifact_nodes BEGIN SELECT RAISE(ABORT, 'forced index failure'); END",
    );
    try {
      const error = errorOf("artifact.createText", {
        requirementId: requirement.id,
        name: "索引失败.md",
        content: "内容",
        idempotencyKey: "idem-index-insert-0001",
      });
      expect(error.code).toBe("INDEX_SYNC_FAILED");
      expect(existsSync(textPath(requirement.id, "索引失败.md"))).toBe(false);
      expect(
        auditRows().some(
          (row) =>
            row.outcome === "error" &&
            row.tool === "artifact.createText" &&
            row.error_code === "INDEX_SYNC_FAILED",
        ),
      ).toBe(true);
    } finally {
      db.exec("DROP TRIGGER fail_artifact_insert");
    }
  });

  it("索引更新失败：恢复原内容并返回 INDEX_SYNC_FAILED", () => {
    const requirement = createRequirement();
    const created = dataOf<McpArtifactTextWriteData>(
      "artifact.createText",
      {
        requirementId: requirement.id,
        name: "更新失败.md",
        content: "原始内容",
        idempotencyKey: "idem-index-update-create-0001",
      },
      ACTOR,
    );
    const path = textPath(requirement.id, created.node.relativePath);
    db.exec(
      "CREATE TRIGGER fail_artifact_update BEFORE UPDATE ON artifact_nodes BEGIN SELECT RAISE(ABORT, 'forced index failure'); END",
    );
    try {
      const error = errorOf("artifact.updateText", {
        requirementId: requirement.id,
        nodeId: created.node.id,
        content: "不应保留的新内容",
        expectedVersion: created.version,
        idempotencyKey: "idem-index-update-0001",
      });
      expect(error.code).toBe("INDEX_SYNC_FAILED");
      expect(readFileSync(path, "utf8")).toBe("原始内容");
    } finally {
      db.exec("DROP TRIGGER fail_artifact_update");
    }
  });

  it("真实 stdio 客户端：发现新增工具，完成记忆与文档写入且立即可读", async () => {
    const requirement = createRequirement("stdio 文本写入需求");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    env.SUPERPM_DATA_DIR = directory;
    env.SUPERPM_WORKSPACE_DIR = workspace;
    env.SUPERPM_MCP_WRITE = "1";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/mcp/stdio.ts", import.meta.url)),
      ],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "vitest-stdio", version: "1.0.0" });
    const dataOfResult = <T>(
      result: Awaited<ReturnType<typeof client.callTool>>,
    ) => {
      if (result.isError || !result.structuredContent)
        throw new Error(`MCP 调用失败：${JSON.stringify(result)}`);
      return (result.structuredContent as unknown as McpReadResult<T>).data;
    };
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "requirement.memory.update",
          "artifact.createText",
          "artifact.updateText",
        ]),
      );

      const initialMemory = dataOfResult<McpMemoryData>(
        await client.callTool({
          name: "requirement.memory.get",
          arguments: { requirementId: requirement.id },
        }),
      );
      expect(initialMemory.version).toBeTruthy();

      const memory = dataOfResult<McpMemoryWriteData>(
        await client.callTool({
          name: "requirement.memory.update",
          arguments: {
            requirementId: requirement.id,
            mode: "append",
            content: "stdio 追加结论",
            expectedVersion: initialMemory.version,
            idempotencyKey: "idem-stdio-memory-0001",
          },
        }),
      );
      expect(memory.created).toBe(false);
      expect(memory.mode).toBe("append");

      const readBack = dataOfResult<McpMemoryData>(
        await client.callTool({
          name: "requirement.memory.get",
          arguments: { requirementId: requirement.id },
        }),
      );
      expect(readBack.content).toContain("stdio 追加结论");
      expect(readBack.version).toBe(memory.version);

      const created = dataOfResult<McpArtifactTextWriteData>(
        await client.callTool({
          name: "artifact.createText",
          arguments: {
            requirementId: requirement.id,
            name: "stdio 分析",
            content: "初稿",
            idempotencyKey: "idem-stdio-create-0001",
          },
        }),
      );
      expect(created.node.relativePath).toBe("stdio 分析.md");

      const updated = dataOfResult<McpArtifactTextWriteData>(
        await client.callTool({
          name: "artifact.updateText",
          arguments: {
            requirementId: requirement.id,
            nodeId: created.node.id,
            content: "终稿",
            expectedVersion: created.version,
            idempotencyKey: "idem-stdio-update-0001",
          },
        }),
      );
      expect(updated.version).not.toBe(created.version);

      const listed = dataOfResult<McpArtifactDirectoryData>(
        await client.callTool({
          name: "artifact.list",
          arguments: { requirementId: requirement.id },
        }),
      );
      expect(listed.files.some((file) => file.id === created.node.id)).toBe(
        true,
      );

      const detail = dataOfResult<ArtifactReadResult>(
        await client.callTool({
          name: "artifact.get",
          arguments: {
            requirementId: requirement.id,
            nodeId: created.node.id,
          },
        }),
      );
      expect(detail.content).toBe("终稿");
      expect(detail.version).toBe(updated.version);
    } finally {
      await client.close();
    }
  });
});
