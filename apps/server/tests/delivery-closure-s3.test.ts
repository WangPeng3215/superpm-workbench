import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate";
import { runAsUser } from "../src/db/scope";
import { ProjectService } from "../src/services/projects";
import { DeliveryService } from "../src/services/deliveries";

describe("S3 delivery blockers and project closure", () => {
  let db: Database.Database;
  let projectId: number;
  let deliveryId: number;
  let requirementId: number;
  let issueId: number;
  const as = <T>(userId: number, fn: () => T): T =>
    runAsUser({ userId, isAdmin: false }, fn);

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    const users = db.prepare(
      "INSERT INTO users(username,display_name,password_hash,password_salt,created_at,updated_at) VALUES(?,?,'x','x','now','now')",
    );
    users.run("owner", "项目负责人");
    users.run("product", "产品负责人");
    const projects = new ProjectService(db);
    projectId = as(1, () => projects.create({ name: "S3 项目" }, "s3-project").project.id);
    db.prepare("INSERT INTO project_members(project_id,user_id,joined_at) VALUES (?,?,?)").run(projectId, 2, "now");
    db.prepare("INSERT INTO project_member_roles(project_id,user_id,role) VALUES (?,?,?)").run(projectId, 2, "product_owner");
    db.prepare(
      "INSERT INTO requirements(requirement_no,name,type,priority,description,status,current_stage,parent_id,proposed_at,created_at,updated_at,user_id,project_id,acceptance_criteria) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("REQ-0001", "客户登录", "feature", "P1", "正文", "completed", "online", null, "2026-11-20", "now", "now", 1, projectId, "能登录");
    requirementId = Number((db.prepare("SELECT id FROM requirements WHERE project_id=?").get(projectId) as { id: number }).id);
    issueId = Number(db.prepare(
      "INSERT INTO issues(user_id,requirement_id,stage,title,description,status,created_at,updated_at,is_deleted,version) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(1, requirementId, "testing", "登录失败", "阻断", "processing", "now", "now", 0, 1).lastInsertRowid);
    deliveryId = Number((db.prepare("SELECT id FROM deliveries WHERE project_id=?").get(projectId) as { id: number }).id);
  });

  afterEach(() => db.close());

  it("records failed acceptance with a same-project issue reference and customer confirmation snapshot", () => {
    const service = new DeliveryService(db);
    const scoped = as(1, () => service.confirmScope(deliveryId, { expectedVersion: 1, requirementIds: [requirementId] }));
    const round = as(1, () => service.submitAcceptance(deliveryId, {
      expectedVersion: scoped.version,
      scopeVersionId: scoped.scopeVersion!.id,
      evidence: [{ kind: "text", label: "报告", content: "报告正文" }],
      customerConfirmation: {
        confirmedByName: "客户张三",
        confirmedByRole: "客户代表",
        confirmedAt: "2026-11-20T10:00:00.000Z",
        evidence: { kind: "text", label: "邮件回执", content: "确认通过修复后再验收" },
      },
    }, "s3-acceptance-1"));
    const completed = as(1, () => service.recordAcceptanceResults(round.id, {
      expectedVersion: round.deliveryVersion,
      scopeVersionId: round.scopeVersionId,
      results: [{ scopeItemId: round.items[0].scopeItemId, result: "failed", reason: "仍失败", issueId }],
    }));
    expect(completed.items[0]).toMatchObject({ result: "failed", issueId });
    expect(completed.customerConfirmation).toMatchObject({
      confirmedByName: "客户张三",
      confirmedByRole: "客户代表",
      confirmedAt: "2026-11-20T10:00:00.000Z",
      evidence: expect.objectContaining({ immutable: true, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    });
  });

  it.each(["add", "resolve", "acceptRisk"] as const)("allows acceptance after pending-round blocker action %s while rejecting stale writes", (action) => {
    const service = new DeliveryService(db);
    const scoped = as(1, () => service.confirmScope(deliveryId, { expectedVersion: 1, requirementIds: [requirementId] }));
    const round = as(1, () => service.submitAcceptance(deliveryId, {
      expectedVersion: scoped.version, scopeVersionId: scoped.scopeVersion!.id,
      evidence: [{ kind: "text", label: "交付证据", content: "提交后处理阻断" }],
    }));
    const blocker = as(1, () => service.addBlockingIssue(deliveryId, { issueId, expectedVersion: round.deliveryVersion, impact: "上线风险" }));
    if (action === "resolve") as(1, () => service.resolveBlockingIssue(blocker.id, { expectedVersion: blocker.version }));
    if (action === "acceptRisk") as(1, () => service.acceptRisk(blocker.id, { expectedVersion: blocker.version, reason: "已评估风险", evidence: { kind: "text", label: "批准", content: "同意" } }));
    const results = { scopeVersionId: round.scopeVersionId, results: [{ scopeItemId: round.items[0].scopeItemId, result: "passed" as const }] };
    expect(() => as(1, () => service.recordAcceptanceResults(round.id, { ...results, expectedVersion: round.deliveryVersion }))).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    const latest = as(1, () => service.get(deliveryId));
    const accepted = as(1, () => service.recordAcceptanceResults(round.id, { ...results, expectedVersion: latest.version }));
    expect(accepted).toMatchObject({ status: "passed", submittedBy: 1, completedBy: 1, deliveryVersion: round.deliveryVersion });
    expect(as(1, () => service.get(deliveryId))).toMatchObject({ status: "accepted", version: latest.version + 1 });
  });

  it("requires current issue version risk acceptance before closure and keeps closure history", () => {
    const service = new DeliveryService(db);
    const scoped = as(1, () => service.confirmScope(deliveryId, { expectedVersion: 1, requirementIds: [requirementId] }));
    const round = as(1, () => service.submitAcceptance(deliveryId, {
      expectedVersion: scoped.version,
      scopeVersionId: scoped.scopeVersion!.id,
      evidence: [{ kind: "text", label: "验收记录", content: "需求验收通过" }],
    }, "s3-close-acceptance"));
    as(1, () => service.recordAcceptanceResults(round.id, {
      expectedVersion: round.deliveryVersion,
      scopeVersionId: round.scopeVersionId,
      results: [{ scopeItemId: round.items[0].scopeItemId, result: "passed" }],
    }, "s3-close-results"));
    const { blocker, blockerInput } = as(1, () => {
      const blockerInput = { issueId, expectedVersion: service.get(deliveryId).version, impact: "无法交付" };
      const blocker = service.addBlockingIssue(deliveryId, blockerInput, "s3-blocker-add-1");
      return { blocker, blockerInput };
    });
    const blockerRetry = as(1, () => service.addBlockingIssue(deliveryId, blockerInput, "s3-blocker-add-1"));
    expect(blockerRetry.id).toBe(blocker.id);
    expect(as(1, () => service.listBlockingIssues(deliveryId))).toHaveLength(1);
    expect(as(1, () => service.closureCheck(projectId))).toMatchObject({ canClose: false });
    expect(() => as(1, () => service.closeProject(projectId, { expectedVersion: 2, reason: "准备结项" }, "s3-close-1"))).toThrow(expect.objectContaining({ code: "CLOSURE_BLOCKED" }));
    const acceptedRisk = as(1, () => service.acceptRisk(blocker.id, { expectedVersion: blocker.version, reason: "客户接受延期", evidence: { kind: "text", label: "确认", content: "同意延期" } }, "s3-risk-1"));
    expect(as(1, () => service.acceptRisk(blocker.id, { expectedVersion: blocker.version, reason: "客户接受延期", evidence: { kind: "text", label: "确认", content: "同意延期" } }, "s3-risk-1")).riskAcceptance?.id).toBe(acceptedRisk.riskAcceptance?.id);
    const closed = as(1, () => service.closeProject(projectId, { expectedVersion: 3, reason: "风险已接受" }, "s3-close-2"));
    expect(as(1, () => service.closeProject(projectId, { expectedVersion: 3, reason: "风险已接受" }, "s3-close-2")).project.version).toBe(closed.project.version);
    expect(closed.project.status).toBe("closed");
    expect(as(1, () => service.closures(projectId))).toHaveLength(1);
    const reopened = as(1, () => service.lifecycle(projectId, { action: "reopen", expectedVersion: closed.project.version, reason: "客户新增范围" }, "s3-reopen-1"));
    expect(reopened.project.status).toBe("active");
    expect(as(1, () => service.closures(projectId))).toHaveLength(2);
  });
});
