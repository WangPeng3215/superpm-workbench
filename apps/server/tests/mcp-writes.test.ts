import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Issue,
  McpIssueLinkWriteData,
  McpIssueUnlinkWriteData,
  McpIssueWriteData,
  McpReadResult,
  McpWritePrepareData,
  Requirement,
} from "@superpm/shared";
import { migrate } from "../src/db/migrate.js";
import { ArtifactService } from "../src/services/artifacts.js";
import { IssueService } from "../src/services/issues.js";
import {
  buildMcpTools,
  type McpGateway,
  type McpToolCallOptions,
} from "../src/services/mcp-gateway.js";
import { McpWriteService } from "../src/services/mcp-writes.js";
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
  created_at: string;
}

const ACTOR: McpToolCallOptions = { actorName: "claude-code" };

describe("MCP 受控写入（M3）", () => {
  let directory: string;
  let databaseFile: string;
  let workspace: string;
  let db: Database.Database;
  let requirements: RequirementService;
  let directories: RequirementDirectoryResolver;
  let artifacts: ArtifactService;
  let issues: IssueService;
  let progress: RequirementProgressService;
  let writes: McpWriteService;
  let gateway: McpGateway;
  let clock: Date;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "superpm-mcp-write-"));
    databaseFile = join(directory, "test.sqlite");
    workspace = join(directory, "workspace");
    mkdirSync(workspace, { recursive: true });
    db = new Database(databaseFile);
    migrate(db);
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
    clock = new Date("2026-10-20T00:00:00.000Z");
    writes = new McpWriteService(db, {
      enabled: true,
      confirmationTtlMs: 60_000,
      now: () => clock,
    });
    gateway = buildMcpTools({
      requirements,
      issues,
      artifacts,
      progress,
      writes,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const createRequirement = (name = "MCP 写入需求") => {
    const requirement = requirements.create({
      name,
      proposedAt: "2026-10-15",
    }) as Requirement;
    directories.initialize(requirement.id);
    return requirement;
  };
  const createIssue = (requirementId: number, title = "待修改问题") =>
    issues.create(requirementId, { stage: "design", title }) as Issue;

  const dataOf = <T>(
    name: string,
    input: unknown,
    options?: McpToolCallOptions,
  ): McpReadResult<T> => {
    const result = gateway.call(name, input, options);
    if (!result.ok)
      throw new Error(
        `工具 ${name} 失败：${result.error.code} ${result.error.message}`,
      );
    return result.data as McpReadResult<T>;
  };
  const errorOf = (
    name: string,
    input: unknown,
    options?: McpToolCallOptions,
  ) => {
    const result = gateway.call(name, input, options);
    if (result.ok) throw new Error(`工具 ${name} 本应失败`);
    return result.error;
  };
  const prepare = (
    tool: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ) =>
    dataOf<McpWritePrepareData>(
      "write.prepare",
      { tool, input, idempotencyKey },
      ACTOR,
    ).data;
  const auditRows = () =>
    db.prepare("SELECT * FROM mcp_audit ORDER BY id ASC").all() as AuditRow[];
  const activityCount = (issueId: number) =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS total FROM issue_activities WHERE issue_id=?",
        )
        .get(issueId) as { total: number }
    ).total;
  const linkCount = (issueId: number) =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS total FROM issue_artifact_links WHERE issue_id=?",
        )
        .get(issueId) as { total: number }
    ).total;

  it("issue.update：确认令牌执行成功，活动与审计记录 AI 来源且不落正文", () => {
    const requirement = createRequirement();
    const issue = createIssue(requirement.id);
    const payload = {
      requirementId: requirement.id,
      issueId: issue.id,
      title: "AI 修正标题",
      status: "processing",
    };
    const prepared = prepare("issue.update", payload, "idem-update-0001");
    expect(prepared.tool).toBe("issue.update");
    expect(prepared.summary).toContain("title");
    expect(prepared.summary).not.toContain("AI 修正标题");
    expect(prepared.confirmationToken.length).toBeGreaterThanOrEqual(32);

    const result = dataOf<McpIssueWriteData>(
      "issue.update",
      {
        ...payload,
        confirmationToken: prepared.confirmationToken,
        idempotencyKey: "idem-update-0001",
      },
      ACTOR,
    ).data;
    expect(result.issue).toMatchObject({
      id: issue.id,
      title: "AI 修正标题",
      status: "processing",
    });
    expect(result.changedFields).toEqual(
      expect.arrayContaining(["title", "status"]),
    );
    expect(result.activityId).not.toBeNull();

    const detail = issues.detail(requirement.id, issue.id);
    expect(detail.title).toBe("AI 修正标题");
    expect(detail.activities.at(-1)).toMatchObject({
      activityType: "status_change",
      oldStatus: "pending",
      newStatus: "processing",
      actorType: "ai",
      actorName: "mcp:claude-code",
    });

    const rows = auditRows();
    expect(rows.map((row) => row.outcome)).toEqual(["prepared", "success"]);
    expect(rows[0]).toMatchObject({
      tool: "issue.update",
      requirement_id: requirement.id,
      target_type: "issue",
      target_id: String(issue.id),
      idempotency_key: null,
      actor_name: "mcp:claude-code",
      error_code: null,
    });
    expect(rows[1]).toMatchObject({
      tool: "issue.update",
      idempotency_key: "idem-update-0001",
      actor_name: "mcp:claude-code",
      outcome: "success",
      error_code: null,
    });
    expect(rows[1].params_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].params_hash).toBe(rows[1].params_hash);
    expect(rows[1].result_summary).toContain("title");
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(prepared.confirmationToken);
    expect(serialized).not.toContain("AI 修正标题");
    expect(serialized).not.toContain(workspace);
  });

  it("issue.comment：追加评论并返回新增活动 ID", () => {
    const requirement = createRequirement();
    const issue = createIssue(requirement.id);
    const payload = {
      requirementId: requirement.id,
      issueId: issue.id,
      content: "已定位到原因",
    };
    const prepared = prepare("issue.comment", payload, "idem-comment-0001");
    const result = dataOf<McpIssueWriteData>(
      "issue.comment",
      {
        ...payload,
        confirmationToken: prepared.confirmationToken,
        idempotencyKey: "idem-comment-0001",
      },
      ACTOR,
    ).data;
    expect(result.changedFields).toEqual(["comment"]);
    expect(result.activityId).not.toBeNull();
    const detail = issues.detail(requirement.id, issue.id);
    const comment = detail.activities.find(
      (activity) => activity.id === result.activityId,
    );
    expect(comment).toMatchObject({
      activityType: "comment",
      content: "已定位到原因",
      actorType: "ai",
      actorName: "mcp:claude-code",
    });
  });

  it("缺少确认令牌时拒绝写入，不产生业务记录与审计", () => {
    const requirement = createRequirement();
    const issue = createIssue(requirement.id);
    const error = errorOf(
      "issue.update",
      {
        requirementId: requirement.id,
        issueId: issue.id,
        title: "未确认标题",
        idempotencyKey: "idem-missing-0001",
      },
      ACTOR,
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain("write.prepare");
    expect(issues.detail(requirement.id, issue.id).title).toBe("待修改问题");
    expect(auditRows()).toHaveLength(0);
  });

  it("确认令牌过期后拒绝写入", () => {
    const requirement = createRequirement();
    const issue = createIssue(requirement.id);
    const payload = {
      requirementId: requirement.id,
      issueId: issue.id,
      title: "过期后的标题",
    };
    const prepared = prepare("issue.update", payload, "idem-expired-0001");
    clock = new Date(clock.getTime() + 60_001);
    const error = errorOf(
      "issue.update",
      {
        ...payload,
        confirmationToken: prepared.confirmationToken,
        idempotencyKey: "idem-expired-0001",
      },
      ACTOR,
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain("过期");
    expect(issues.detail(requirement.id, issue.id).title).toBe("待修改问题");
    expect(auditRows().map((row) => row.outcome)).toEqual(["prepared"]);
  });

  it("参数与 prepare 不一致时拒绝写入，且不消耗令牌", () => {
    const requirement = createRequirement();
    const issue = createIssue(requirement.id);
    const preparedPayload = {
      requirementId: requirement.id,
      issueId: issue.id,
      title: "确认时的标题",
    };
    const prepared = prepare(
      "issue.update",
      preparedPayload,
      "idem-mismatch-0001",
    );
    const error = errorOf(
      "issue.update",
      {
        ...preparedPayload,
        title: "执行时被替换的标题",
        confirmationToken: prepared.confirmationToken,
        idempotencyKey: "idem-mismatch-0001",
      },
      ACTOR,
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain("不匹配");
    expect(issues.detail(requirement.id, issue.id).title).toBe("待修改问题");

    // 参数不匹配不消耗令牌：按 prepare 时的参数重试可成功
    const result = dataOf<McpIssueWriteData>(
      "issue.update",
      {
        ...preparedPayload,
        confirmationToken: prepared.confirmationToken,
        idempotencyKey: "idem-mismatch-0001",
      },
      ACTOR,
    ).data;
    expect(result.issue.title).toBe("确认时的标题");
  });

  it("确认令牌只能使用一次", () => {
    const requirement = createRequirement();
    const issue = createIssue(requirement.id);
    const payload = {
      requirementId: requirement.id,
      issueId: issue.id,
      content: "一次性评论",
    };
    const prepared = prepare("issue.comment", payload, "idem-reuse-0001");
    dataOf<McpIssueWriteData>(
      "issue.comment",
      {
        ...payload,
        confirmationToken: prepared.confirmationToken,
        idempotencyKey: "idem-reuse-0001",
      },
      ACTOR,
    );
    const countAfterFirst = activityCount(issue.id);
    const error = errorOf(
      "issue.comment",
      {
        ...payload,
        confirmationToken: prepared.confirmationToken,
        idempotencyKey: "idem-reuse-0001",
      },
      ACTOR,
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain("已使用");
    expect(activityCount(issue.id)).toBe(countAfterFirst);
  });

  it("idempotencyKey 重复的 prepare 与重放均被拒绝", () => {
    const requirement = createRequirement();
    const issue = createIssue(requirement.id);
    const payload = {
      requirementId: requirement.id,
      issueId: issue.id,
      content: "幂等评论",
    };
    const prepared = prepare("issue.comment", payload, "idem-duplicate-0001");
    const duplicatePrepare = errorOf(
      "write.prepare",
      {
        tool: "issue.comment",
        input: payload,
        idempotencyKey: "idem-duplicate-0001",
      },
      ACTOR,
    );
    expect(duplicatePrepare.code).toBe("CONFLICT");

    dataOf<McpIssueWriteData>(
      "issue.comment",
      {
        ...payload,
        confirmationToken: prepared.confirmationToken,
        idempotencyKey: "idem-duplicate-0001",
      },
      ACTOR,
    );
    const countAfterFirst = activityCount(issue.id);
    const replay = errorOf(
      "write.prepare",
      {
        tool: "issue.comment",
        input: { ...payload, content: "重放评论" },
        idempotencyKey: "idem-duplicate-0001",
      },
      ACTOR,
    );
    expect(replay.code).toBe("CONFLICT");
    expect(activityCount(issue.id)).toBe(countAfterFirst);
  });

  it("业务校验失败时不产生部分写入，确认令牌被消耗并记录错误审计", () => {
    const requirement = createRequirement();
    const issue = createIssue(requirement.id);
    const before = issues.detail(requirement.id, issue.id);
    const payload = {
      requirementId: requirement.id,
      issueId: issue.id,
      title: "不应写入的标题",
      status: "resolved",
    };
    const prepared = prepare("issue.update", payload, "idem-invalid-0001");
    const error = errorOf(
      "issue.update",
      {
        ...payload,
        confirmationToken: prepared.confirmationToken,
        idempotencyKey: "idem-invalid-0001",
      },
      ACTOR,
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("解决方案");
    const after = issues.detail(requirement.id, issue.id);
    expect(after.title).toBe(before.title);
    expect(after.status).toBe(before.status);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.activities).toHaveLength(before.activities.length);

    const rows = auditRows();
    expect(rows.map((row) => row.outcome)).toEqual(["prepared", "error"]);
    expect(rows[1]).toMatchObject({
      error_code: "VALIDATION_ERROR",
      idempotency_key: null,
      actor_name: "mcp:claude-code",
    });
    expect(rows[1].result_summary).toContain("title");
    expect(rows[1].result_summary).not.toContain("不应写入的标题");

    // 业务失败后令牌已消耗，必须重新 prepare
    const retry = errorOf(
      "issue.update",
      {
        ...payload,
        confirmationToken: prepared.confirmationToken,
        idempotencyKey: "idem-invalid-0001",
      },
      ACTOR,
    );
    expect(retry.code).toBe("FORBIDDEN");
    expect(retry.message).toContain("已使用");
  });

  it("issue.linkAsset / issue.unlinkAsset：确认后建立与移除关联，不触碰节点", () => {
    const requirement = createRequirement();
    const issue = createIssue(requirement.id);
    const artifact = artifacts.createFile(requirement.id, {
      parentId: null,
      name: "证据截图.md",
      initialContent: "证据内容",
    }) as { id: number };
    const linkPayload = {
      requirementId: requirement.id,
      issueId: issue.id,
      assetId: artifact.id,
      relationType: "evidence",
    };
    const preparedLink = prepare(
      "issue.linkAsset",
      linkPayload,
      "idem-link-0001",
    );
    const linked = dataOf<McpIssueLinkWriteData>(
      "issue.linkAsset",
      {
        ...linkPayload,
        confirmationToken: preparedLink.confirmationToken,
        idempotencyKey: "idem-link-0001",
      },
      ACTOR,
    ).data;
    expect(linked).toEqual({
      issueId: issue.id,
      assetId: artifact.id,
      relationType: "evidence",
      linked: true,
    });
    expect(linkCount(issue.id)).toBe(1);
    const stored = db
      .prepare(
        "SELECT relation_type FROM issue_artifact_links WHERE issue_id=? AND artifact_id=?",
      )
      .get(issue.id, artifact.id) as { relation_type: string };
    expect(stored.relation_type).toBe("evidence");

    // 重复关联由业务层拒绝，审计记录错误
    const duplicatePayload = { ...linkPayload };
    const duplicatePrepared = prepare(
      "issue.linkAsset",
      duplicatePayload,
      "idem-link-0002",
    );
    const duplicate = errorOf(
      "issue.linkAsset",
      {
        ...duplicatePayload,
        confirmationToken: duplicatePrepared.confirmationToken,
        idempotencyKey: "idem-link-0002",
      },
      ACTOR,
    );
    expect(duplicate.code).toBe("CONFLICT");
    expect(linkCount(issue.id)).toBe(1);

    const unlinkPayload = {
      requirementId: requirement.id,
      issueId: issue.id,
      assetId: artifact.id,
    };
    const preparedUnlink = prepare(
      "issue.unlinkAsset",
      unlinkPayload,
      "idem-unlink-0001",
    );
    const unlinked = dataOf<McpIssueUnlinkWriteData>(
      "issue.unlinkAsset",
      {
        ...unlinkPayload,
        confirmationToken: preparedUnlink.confirmationToken,
        idempotencyKey: "idem-unlink-0001",
      },
      ACTOR,
    ).data;
    expect(unlinked).toEqual({
      issueId: issue.id,
      assetId: artifact.id,
      unlinked: true,
    });
    expect(linkCount(issue.id)).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM artifact_nodes").get(),
    ).toEqual({ total: 1 });
    expect(JSON.stringify(auditRows())).not.toContain(workspace);
  });

  it("跨需求访问返回 NOT_FOUND，不写入任何记录", () => {
    const requirementA = createRequirement("需求 A");
    const requirementB = createRequirement("需求 B");
    const issueA = createIssue(requirementA.id);
    const payload = {
      requirementId: requirementB.id,
      issueId: issueA.id,
      content: "越权评论",
    };
    const prepared = prepare("issue.comment", payload, "idem-cross-0001");
    const error = errorOf(
      "issue.comment",
      {
        ...payload,
        confirmationToken: prepared.confirmationToken,
        idempotencyKey: "idem-cross-0001",
      },
      ACTOR,
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(activityCount(issueA.id)).toBe(1); // 仅创建时的系统记录
    const rows = auditRows();
    expect(rows.map((row) => row.outcome)).toEqual(["prepared", "error"]);
    expect(rows[1].error_code).toBe("NOT_FOUND");
  });

  it("WAL 与 busy_timeout 生效，跨连接幂等键唯一约束仍有效", () => {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);

    const second = new Database(databaseFile);
    try {
      second.pragma("busy_timeout = 5000");
      second.pragma("foreign_keys = ON");
      second.pragma("journal_mode = WAL");
      const secondWrites = new McpWriteService(second, {
        enabled: true,
        now: () => clock,
      });
      const requirement = createRequirement();
      const issue = createIssue(requirement.id);
      const payload = {
        requirementId: requirement.id,
        issueId: issue.id,
        content: "跨连接评论",
      };
      const target = {
        requirementId: requirement.id,
        targetType: "issue",
        targetId: String(issue.id),
      };
      writes.prepare({
        tool: "issue.comment",
        payload,
        idempotencyKey: "idem-cross-conn-0001",
        target,
        actorName: "mcp:first",
        summary: "跨连接评论",
      });
      let code: string | undefined;
      try {
        secondWrites.prepare({
          tool: "issue.comment",
          payload,
          idempotencyKey: "idem-cross-conn-0001",
          target,
          actorName: "mcp:second",
          summary: "跨连接评论",
        });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe("CONFLICT");
      // 第二连接可读到第一连接的确认记录
      expect(
        (
          second
            .prepare("SELECT COUNT(*) AS total FROM mcp_write_confirmations")
            .get() as { total: number }
        ).total,
      ).toBe(1);
    } finally {
      second.close();
    }
  });
});
