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
    issues = new IssueService(db, requirements);
    gateway = buildMcpTools({ requirements, files, issues });
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const createRequirement = (name = "登录流程优化") =>
    requirements.create({ name, proposedAt: "2026-10-15" }) as Requirement;

  const createIssueViaMcp = (
    requirementId: number,
    idempotencyKey: string,
    title = "按钮样式与设计稿不一致",
  ) =>
    gateway.call(
      "issue.create",
      { requirementId, phase: "design", title },
      { idempotencyKey },
    ) as Issue;

  it("契约完整性：14 个工具、只读/写各 7、幂等标注与错误码白名单一致", () => {
    expect(mcpToolContracts).toHaveLength(14);
    const readonly = mcpToolContracts.filter((contract) => contract.kind === "readonly");
    const mutating = mcpToolContracts.filter((contract) => contract.kind === "mutating");
    expect(readonly).toHaveLength(7);
    expect(mutating).toHaveLength(7);
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
    const issue = createIssueViaMcp(requirement.id, "issue-1");

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
      status: "open",
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

  it("issue.create 幂等：同幂等键只创建一条且返回同 id，不同键各建一条", () => {
    const requirement = createRequirement();
    const first = createIssueViaMcp(requirement.id, "same-key");
    // 同键重放：直接返回首次结果，即使入参不同也不生效
    const replay = createIssueViaMcp(requirement.id, "same-key", "不同标题也不会生效");
    expect(replay.id).toBe(first.id);
    expect(replay.title).toBe(first.title);
    expect(issues.list(requirement.id).total).toBe(1);

    const second = createIssueViaMcp(requirement.id, "other-key", "第二个问题");
    expect(second.id).not.toBe(first.id);
    expect(issues.list(requirement.id).total).toBe(2);
  });

  it("solution 守卫：一次调用既提交 solution 又置 resolved 被拒，两步显式调用成功", () => {
    const requirement = createRequirement();
    const issue = createIssueViaMcp(requirement.id, "guard-issue");
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
    ).toMatchObject({ status: "open", solution: null });

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
      status: "open",
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
      "issue.create",
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
    const issue = createIssueViaMcp(requirement.id, "comment-issue");
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
    const rejected = gateway.call("issue.create", {
      requirementId: requirement.id,
      phase: "design",
      title: "无键调用",
    }) as StructuredError;
    expect(rejected).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(issues.list(requirement.id).total).toBe(0);

    // 只读工具不需要幂等键；列表仅包含 setUp 创建的需求，被拒调用未产生额外副作用
    const listed = gateway.call("requirement.list", {}) as RequirementListResult;
    expect(listed.total).toBe(1);
  });

  it("issue.linkAsset / issue.unlinkAsset：关联去重返回 CONFLICT，取消后可复检", () => {
    const requirement = createRequirement();
    const issue = createIssueViaMcp(requirement.id, "link-issue");
    const asset = gateway.call(
      "asset.create",
      {
        requirementId: requirement.id,
        phase: "design",
        category: "uiAssets",
        name: "问题截图",
        resourceType: "text",
        textContent: "截图说明",
      },
      { idempotencyKey: "link-asset" },
    ) as RequirementFile;

    const linked = gateway.call(
      "issue.linkAsset",
      { requirementId: requirement.id, issueId: issue.id, assetId: asset.id, relationType: "evidence" },
      { idempotencyKey: "link-1" },
    );
    expect(linked).toMatchObject({ issueId: issue.id, assetId: asset.id, relationType: "evidence" });

    const duplicate = gateway.call(
      "issue.linkAsset",
      { requirementId: requirement.id, issueId: issue.id, assetId: asset.id },
      { idempotencyKey: "link-2" },
    ) as StructuredError;
    expect(duplicate).toMatchObject({ error: { code: "CONFLICT" } });

    // 取消关联返回 void；关联不存在时返回结构化 NOT_FOUND
    expect(
      gateway.call(
        "issue.unlinkAsset",
        { requirementId: requirement.id, issueId: issue.id, assetId: asset.id },
        { idempotencyKey: "unlink-1" },
      ),
    ).toBeUndefined();
    const again = gateway.call(
      "issue.unlinkAsset",
      { requirementId: requirement.id, issueId: issue.id, assetId: asset.id },
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

    const issue = createIssueViaMcp(requirement.id, "activities-issue");
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
