import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.TZ = "Asia/Shanghai";

let migrate: typeof import("../src/db/migrate.js").migrate;
let runAsUser: typeof import("../src/db/scope.js").runAsUser;
let ProjectService: typeof import("../src/services/projects.js").ProjectService;
let DeliveryService: typeof import("../src/services/deliveries.js").DeliveryService;

describe("project overview service aggregation", () => {
  let db: Database.Database;
  let projects: InstanceType<typeof ProjectService>;
  let deliveries: InstanceType<typeof DeliveryService>;
  let projectId: number;
  let defaultDeliveryId: number;
  const ownerId = 1;
  const productId = 2;
  const developerId = 3;
  const as = <T>(userId: number, fn: () => T): T =>
    runAsUser({ userId, isAdmin: false }, fn);

  beforeAll(async () => {
    ({ migrate } = await import("../src/db/migrate.js"));
    ({ runAsUser } = await import("../src/db/scope.js"));
    ({ ProjectService } = await import("../src/services/projects.js"));
    ({ DeliveryService } = await import("../src/services/deliveries.js"));
  });

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    const insertUser = db.prepare(
      "INSERT INTO users(username,display_name,password_hash,password_salt,created_at,updated_at) VALUES(?,?,'x','x','now','now')",
    );
    insertUser.run("overview-owner", "项目负责人");
    insertUser.run("overview-product", "产品负责人");
    insertUser.run("overview-developer", "开发成员");
    projects = new ProjectService(db);
    deliveries = new DeliveryService(db);
    projectId = as(ownerId, () => projects.create({ name: "概览聚合" }).project.id);
    for (const [userId, role] of [
      [productId, "product_owner"],
      [developerId, "contributor"],
    ] as const) {
      db.prepare(
        "INSERT INTO project_members(project_id,user_id,joined_at) VALUES(?,?,?)",
      ).run(projectId, userId, "now");
      db.prepare(
        "INSERT INTO project_member_roles(project_id,user_id,role) VALUES(?,?,?)",
      ).run(projectId, userId, role);
    }
    defaultDeliveryId = (
      db
        .prepare("SELECT id FROM deliveries WHERE project_id=? AND is_default=1")
        .get(projectId) as { id: number }
    ).id;
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  function requirement(
    name: string,
    status: string,
    parentId: number | null = null,
  ) {
    const result = db
      .prepare(
        "INSERT INTO requirements(requirement_no,name,type,priority,description,status,current_stage,parent_id,proposed_at,created_at,updated_at,user_id,project_id,acceptance_criteria) VALUES(?,?,'feature','P2',?,?, 'analysis',?,'2026-11-20','2026-11-20T00:00:00.000Z','2026-11-20T00:00:00.000Z',?,?,?)",
      )
      .run(
        `OV-${Date.now()}-${Math.random()}`,
        name,
        name,
        status,
        parentId,
        ownerId,
        projectId,
        `${name} 验收标准`,
      );
    return Number(result.lastInsertRowid);
  }

  function task(input: {
    title: string;
    assigneeId: number;
    confirmerId: number;
    status: string;
    dueDate?: string | null;
    previousStatus?: string | null;
  }) {
    const result = db
      .prepare(
        "INSERT INTO project_tasks(project_id,title,type,assignee_user_id,confirmer_user_id,due_date,status,previous_status,created_by,created_at,updated_at) VALUES(?,?,'development',?,?,?,?,?,?,?,?)",
      )
      .run(
        projectId,
        input.title,
        input.assigneeId,
        input.confirmerId,
        input.dueDate ?? null,
        input.status,
        input.previousStatus ?? null,
        ownerId,
        "2026-11-20T00:00:00.000Z",
        "2026-11-20T00:00:00.000Z",
      );
    return Number(result.lastInsertRowid);
  }

  function confirmScope(requirementIds: number[]) {
    return as(ownerId, () =>
      deliveries.confirmScope(defaultDeliveryId, {
        expectedVersion: 1,
        requirementIds,
      }),
    );
  }

  it("counts current committed leaf requirements and separates execution from acceptance", () => {
    const parentId = requirement("功能父需求", "blocked");
    const completedId = requirement("已完成子需求", "completed", parentId);
    const activeId = requirement("进行中子需求", "in_progress", parentId);
    requirement("未纳入范围需求", "completed");
    const scoped = confirmScope([completedId, activeId]);

    const round = as(ownerId, () =>
      deliveries.submitAcceptance(defaultDeliveryId, {
        expectedVersion: scoped.version,
        scopeVersionId: scoped.scopeVersion!.id,
        evidence: [{ kind: "text", label: "验收记录", content: "结果" }],
      }),
    );
    as(ownerId, () =>
      deliveries.recordAcceptanceResults(round.id, {
        expectedVersion: round.deliveryVersion,
        scopeVersionId: round.scopeVersionId,
        results: [
          { scopeItemId: round.items[0].scopeItemId, result: "passed" },
          {
            scopeItemId: round.items[1].scopeItemId,
            result: "failed",
            reason: "尚未满足标准",
          },
        ],
      }),
    );

    const overview = as(ownerId, () => projects.overview(projectId));

    expect(overview.requirements.total).toBe(4);
    expect(overview.deliveryScope).toMatchObject({
      state: "confirmed",
      total: 2,
      executionCompleted: 1,
      executionPercent: 50,
      accepted: 1,
      acceptancePercent: 50,
      failed: 1,
      unconfirmedDeliveries: 0,
    });
    expect(overview.risks.failedDeliveries).toEqual([defaultDeliveryId]);
  });

  it("uses null denominators for unconfirmed and empty delivery scopes", () => {
    const unconfirmed = as(ownerId, () => projects.overview(projectId));
    expect(unconfirmed.deliveryScope).toMatchObject({
      state: "unconfirmed",
      total: null,
      executionPercent: null,
      acceptancePercent: null,
    });

    confirmScope([]);
    const empty = as(ownerId, () => projects.overview(projectId));
    expect(empty.deliveryScope).toMatchObject({
      state: "empty",
      total: null,
      executionPercent: null,
      acceptancePercent: null,
    });
  });

  it("does not carry acceptance results forward to a newer scope version", () => {
    const requirementId = requirement("范围修订需求", "completed");
    const firstScope = confirmScope([requirementId]);
    const round = as(ownerId, () =>
      deliveries.submitAcceptance(defaultDeliveryId, {
        expectedVersion: firstScope.version,
        scopeVersionId: firstScope.scopeVersion!.id,
        evidence: [{ kind: "text", label: "验收记录", content: "通过" }],
      }),
    );
    as(ownerId, () =>
      deliveries.recordAcceptanceResults(round.id, {
        expectedVersion: round.deliveryVersion,
        scopeVersionId: round.scopeVersionId,
        results: round.items.map((item) => ({
          scopeItemId: item.scopeItemId,
          result: "passed" as const,
        })),
      }),
    );

    const secondScope = as(ownerId, () =>
      deliveries.confirmScope(defaultDeliveryId, {
        expectedVersion: round.deliveryVersion + 1,
        requirementIds: [requirementId],
        changeReason: "重新确认当前交付范围",
      }),
    );
    const overview = as(ownerId, () => projects.overview(projectId));

    expect(secondScope.scopeVersion!.id).not.toBe(firstScope.scopeVersion!.id);
    expect(overview.deliveryScope).toMatchObject({
      total: 1,
      accepted: 0,
      acceptancePercent: 0,
    });
  });

  it("excludes invalid scope leaves and cancelled delivery commitments from acceptance progress", () => {
    const formerLeaf = requirement("原范围叶子", "completed");
    const included = requirement("当前有效范围叶子", "completed");
    const scoped = confirmScope([formerLeaf, included]);
    const round = as(ownerId, () =>
      deliveries.submitAcceptance(defaultDeliveryId, {
        expectedVersion: scoped.version,
        scopeVersionId: scoped.scopeVersion!.id,
        evidence: [{ kind: "text", label: "验收记录", content: "结果" }],
      }),
    );
    as(ownerId, () =>
      deliveries.recordAcceptanceResults(round.id, {
        expectedVersion: round.deliveryVersion,
        scopeVersionId: round.scopeVersionId,
        results: round.items.map((item) => ({
          scopeItemId: item.scopeItemId,
          result: "passed" as const,
        })),
      }),
    );
    // Represent historical data that predates the editable-scope guard.
    requirement("新建子需求", "not_started", formerLeaf);
    expect(as(ownerId, () => projects.overview(projectId)).deliveryScope)
      .toMatchObject({ total: 1, accepted: 1, acceptancePercent: 100 });
    db.prepare("UPDATE deliveries SET status='cancelled' WHERE id=?").run(defaultDeliveryId);
    expect(as(ownerId, () => projects.overview(projectId)).deliveryScope)
      .toMatchObject({ total: null, accepted: null, acceptancePercent: null, unconfirmedDeliveries: 0 });
  });

  it("shows only actionable todos for writable members and a current pending acceptance", () => {
    const scopeId = requirement("需要确认范围", "completed");
    expect(as(ownerId, () => projects.overview(projectId)).myActions.items)
      .toEqual([expect.objectContaining({ id: defaultDeliveryId, action: "confirm_scope" })]);
    const scoped = confirmScope([scopeId]);
    const taskId = task({
      title: "待提交任务",
      assigneeId: developerId,
      confirmerId: ownerId,
      status: "in_progress",
    });
    db.prepare("UPDATE deliveries SET acceptance_owner_user_id=? WHERE id=?")
      .run(developerId, defaultDeliveryId);
    as(ownerId, () => deliveries.submitAcceptance(defaultDeliveryId, {
      expectedVersion: scoped.version,
      scopeVersionId: scoped.scopeVersion!.id,
      evidence: [{ kind: "text", label: "送验", content: "内容" }],
    }));
    const ownItems = () => as(developerId, () => projects.overview(projectId)).myActions.items;
    expect(ownItems()).toEqual([
      expect.objectContaining({ id: taskId, action: "submit" }),
      expect.objectContaining({ id: defaultDeliveryId, action: "accept" }),
    ]);
    db.prepare("UPDATE project_member_roles SET role='viewer' WHERE project_id=? AND user_id=?")
      .run(projectId, developerId);
    expect(ownItems()).toEqual([]);
    db.prepare("UPDATE project_member_roles SET role='contributor' WHERE project_id=? AND user_id=?")
      .run(projectId, developerId);
    db.prepare("UPDATE projects SET status='paused' WHERE id=?").run(projectId);
    expect(ownItems()).toEqual([]);
    db.prepare("UPDATE projects SET status='active' WHERE id=?").run(projectId);
    db.prepare("UPDATE deliveries SET current_scope_version_id=NULL WHERE id=?").run(defaultDeliveryId);
    expect(ownItems()).toEqual([expect.objectContaining({ id: taskId, action: "submit" })]);
  });

  it("combines risks by source and disregards risk acceptance for an older issue version", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T17:00:00.000Z"));
    const requirementId = requirement("阻断问题所属需求", "in_progress");
    const issueId = Number(db.prepare(
      "INSERT INTO issues(user_id,requirement_id,stage,title,description,status,created_at,updated_at,is_deleted,version) VALUES(?,?,'analysis','模拟阻断','','processing','now','now',0,2)",
    ).run(ownerId, requirementId).lastInsertRowid);
    db.prepare("UPDATE deliveries SET planned_delivery_date='2026-11-20' WHERE id=?").run(defaultDeliveryId);
    const blockerId = Number(db.prepare(
      "INSERT INTO delivery_blocking_issues(delivery_id,issue_id,issue_version,impact,created_by,created_at) VALUES(?,?,1,'影响最终交付',?,'now')",
    ).run(defaultDeliveryId, issueId, ownerId).lastInsertRowid);
    db.prepare("INSERT INTO delivery_risk_acceptances(blocking_issue_id,issue_version,reason,evidence_kind,evidence_label,evidence_url,accepted_by,accepted_at) VALUES(?,1,'旧版本','url','证据','https://example.com',?,'now')")
      .run(blockerId, ownerId);
    const risks = () => as(ownerId, () => projects.overview(projectId)).risks.items;
    expect(risks()).toEqual([expect.objectContaining({
      id: defaultDeliveryId,
      kind: "delivery",
      reasons: ["overdue", "blocking_issue"],
    })]);
    db.prepare("UPDATE issues SET status='resolved' WHERE id=?").run(issueId);
    expect(risks()).toEqual([expect.objectContaining({
      id: defaultDeliveryId,
      reasons: ["overdue"],
    })]);
  });

  it("uses the business date for overdue checks and only returns actions for the current actor", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T17:00:00.000Z"));
    db.prepare("UPDATE projects SET status='active' WHERE id=?").run(projectId);
    const overdueId = task({
      title: "已到期任务",
      assigneeId: developerId,
      confirmerId: ownerId,
      status: "in_progress",
      dueDate: "2026-11-20",
    });
    const submitId = task({
      title: "本人待提交",
      assigneeId: developerId,
      confirmerId: ownerId,
      status: "in_progress",
    });
    const confirmId = task({
      title: "本人待确认",
      assigneeId: developerId,
      confirmerId: ownerId,
      status: "pending_confirmation",
    });
    const reqId = requirement("待验收范围", "completed");
    const scoped = confirmScope([reqId]);
    db.prepare("UPDATE deliveries SET acceptance_owner_user_id=? WHERE id=?").run(
      productId,
      defaultDeliveryId,
    );
    as(ownerId, () =>
      deliveries.submitAcceptance(defaultDeliveryId, {
        expectedVersion: scoped.version,
        scopeVersionId: scoped.scopeVersion!.id,
        evidence: [{ kind: "text", label: "交付证据", content: "待验收" }],
      }),
    );

    const developerView = as(developerId, () => projects.overview(projectId));
    const productView = as(productId, () => projects.overview(projectId));
    const ownerView = as(ownerId, () => projects.overview(projectId));

    expect(developerView.risks.overdueTasks).toContain(overdueId);
    expect(developerView.myActions.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: submitId, kind: "task", action: "submit" }),
      ]),
    );
    expect(developerView.myActions.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: confirmId })]),
    );
    expect(ownerView.myActions.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: confirmId, kind: "task", action: "confirm" }),
      ]),
    );
    expect(productView.myActions.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: defaultDeliveryId,
          kind: "delivery",
          action: "accept",
        }),
      ]),
    );
    expect(developerView.myActions.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: defaultDeliveryId,
          kind: "delivery",
        }),
      ]),
    );
  });
});
