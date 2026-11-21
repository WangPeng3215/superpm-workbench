import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate";
import { runAsUser } from "../src/db/scope";
import { ProjectService } from "../src/services/projects";
import { DeliveryService } from "../src/services/deliveries";

describe("delivery scope service", () => {
  let db: Database.Database;
  let service: DeliveryService;
  let projectId: number;
  let defaultDeliveryId: number;
  const owner = 1;
  const product = 2;
  const contributor = 3;

  const as = <T>(userId: number, fn: () => T): T =>
    runAsUser({ userId, isAdmin: false }, fn);

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    const insertUser = db.prepare(
      "INSERT INTO users(username,display_name,password_hash,password_salt,created_at,updated_at) VALUES(?,?,'x','x','now','now')",
    );
    insertUser.run("owner", "项目负责人");
    insertUser.run("product", "产品负责人");
    insertUser.run("contributor", "开发成员");
    const projects = new ProjectService(db);
    projectId = as(owner, () =>
      projects.create({ name: "交付项目" }, "delivery-project").project.id,
    );
    for (const [userId, role] of [
      [product, "product_owner"],
      [contributor, "contributor"],
    ] as const) {
      db.prepare(
        "INSERT INTO project_members(project_id,user_id,joined_at) VALUES (?,?,?)",
      ).run(projectId, userId, "now");
      db.prepare(
        "INSERT INTO project_member_roles(project_id,user_id,role) VALUES (?,?,?)",
      ).run(projectId, userId, role);
    }
    defaultDeliveryId = (
      db
        .prepare("SELECT id FROM deliveries WHERE project_id=? AND is_default=1")
        .get(projectId) as { id: number }
    ).id;
    service = new DeliveryService(db);
  });

  afterEach(() => db.close());

  function requirement(id: number, name: string, parentId: number | null = null) {
    db.prepare(
      "INSERT INTO requirements(requirement_no,name,type,priority,description,status,current_stage,parent_id,proposed_at,created_at,updated_at,user_id,project_id,acceptance_criteria) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "REQ-" + String(id).padStart(4, "0"),
      name,
      "feature",
      "P2",
      name + " 正文",
      "not_started",
      "analysis",
      parentId,
      "2026-11-20",
      "2026-11-20T00:00:00.000Z",
      "2026-11-20T00:00:00.000Z",
      owner,
      projectId,
      name + " 验收标准",
    );
  }

  it("keeps a default delivery, supports idempotent creation, and exposes project scope", () => {
    const first = as(owner, () => service.list(projectId));
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      id: defaultDeliveryId,
      isDefault: true,
      name: "默认交付",
      version: 1,
      acceptanceOwnerUserId: owner,
      scopeVersion: null,
    });

    const created = as(owner, () =>
      service.create(
        projectId,
        { name: "第二批交付", acceptanceOwnerUserId: product },
        "delivery-create-1",
      ),
    );
    expect(created).toMatchObject({
      name: "第二批交付",
      isDefault: false,
      acceptanceOwnerUserId: product,
    });
    expect(
      as(owner, () =>
        service.create(
          projectId,
          { name: "第二批交付", acceptanceOwnerUserId: product },
          "delivery-create-1",
        ),
      ).id,
    ).toBe(created.id);
  });

  it("confirms only same-project leaf requirements with version CAS", () => {
    requirement(1, "用户登录");
    const confirmed = as(owner, () =>
      service.confirmScope(defaultDeliveryId, {
        expectedVersion: 1,
        requirementIds: [1],
      }),
    );
    expect(confirmed).toMatchObject({
      version: 2,
      scopeVersion: { version: 1, changeReason: "" },
    });
    expect(confirmed.scopeVersion?.items[0]).toMatchObject({
      requirementId: 1,
      requirementNo: "REQ-0001",
      requirementVersion: 1,
      acceptanceCriteria: "用户登录 验收标准",
    });
    expect(() =>
      as(owner, () =>
        service.confirmScope(defaultDeliveryId, {
          expectedVersion: 1,
          requirementIds: [1],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));

    requirement(2, "父需求");
    requirement(3, "子需求", 2);
    expect(() =>
      as(owner, () =>
        service.confirmScope(defaultDeliveryId, {
          expectedVersion: 2,
          requirementIds: [2],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_REQUIREMENT" }));
  });

  it("prevents parallel active commitment and requires a recorded follow-up on scope removal", () => {
    requirement(1, "用户登录");
    requirement(2, "组织切换");
    const first = as(owner, () =>
      service.confirmScope(defaultDeliveryId, {
        expectedVersion: 1,
        requirementIds: [1, 2],
      }),
    );
    const second = as(owner, () =>
      service.create(projectId, { name: "第二批" }, "delivery-create-2"),
    );
    expect(() =>
      as(owner, () =>
        service.confirmScope(second.id, {
          expectedVersion: 1,
          requirementIds: [1],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "REQUIREMENT_ALREADY_COMMITTED" }));

    expect(() =>
      as(owner, () =>
        service.confirmScope(defaultDeliveryId, {
          expectedVersion: first.version,
          requirementIds: [1],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "SCOPE_CHANGE_REASON_REQUIRED" }));

    const revised = as(owner, () =>
      service.confirmScope(defaultDeliveryId, {
        expectedVersion: first.version,
        requirementIds: [1],
        changeReason: "组织切换延期到第二批",
        changes: [
          {
            type: "postpone",
            requirementId: 2,
            reason: "客户确认延后",
            followUpDeliveryId: second.id,
          },
        ],
      }),
    );
    expect(revised.scopeVersion?.version).toBe(2);
    expect(revised.scopeVersion?.changes[0]).toMatchObject({
      type: "postpone",
      requirementId: 2,
      followUpDeliveryId: second.id,
    });
    expect(
      as(owner, () =>
        service.confirmScope(second.id, {
          expectedVersion: 1,
          requirementIds: [2],
        }),
      ).scopeVersion?.items[0].requirementId,
    ).toBe(2);
  });

  it("submits immutable evidence snapshots and requires complete per-item acceptance results", () => {
    requirement(1, "用户登录");
    requirement(2, "组织切换");
    const scoped = as(owner, () =>
      service.confirmScope(defaultDeliveryId, {
        expectedVersion: 1,
        requirementIds: [1, 2],
      }),
    );
    const scopeVersionId = scoped.scopeVersion!.id;

    const first = as(owner, () =>
      service.submitAcceptance(
        defaultDeliveryId,
        {
          expectedVersion: scoped.version,
          scopeVersionId,
          deliveryNotes: "交付 v1",
          evidence: [
            { kind: "text", label: "发布说明", content: "版本 1" },
            { kind: "url", label: "演示地址", url: "https://example.com/demo" },
          ],
        },
        "acceptance-submit-1",
      ),
    );
    expect(first).toMatchObject({
      deliveryId: defaultDeliveryId,
      scopeVersionId,
      round: 1,
      status: "pending",
    });
    expect(first.deliveryVersion).toBe(scoped.version + 1);
    expect(as(owner, () => service.get(defaultDeliveryId)).version).toBe(
      first.deliveryVersion,
    );
    expect(first.evidence).toEqual([
      expect.objectContaining({
        kind: "text",
        label: "发布说明",
        content: "版本 1",
        immutable: true,
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      expect.objectContaining({
        kind: "url",
        immutable: false,
        contentHash: null,
      }),
    ]);
    expect(as(owner, () => service.get(defaultDeliveryId)).status).toBe(
      "awaiting_acceptance",
    );
    expect(
      as(owner, () =>
        service.submitAcceptance(
          defaultDeliveryId,
          {
            expectedVersion: scoped.version,
            scopeVersionId,
            deliveryNotes: "交付 v1",
            evidence: [
              { kind: "text", label: "发布说明", content: "版本 1" },
              { kind: "url", label: "演示地址", url: "https://example.com/demo" },
            ],
          },
          "acceptance-submit-1",
        ),
      ).id,
    ).toBe(first.id);
    expect(() =>
      as(owner, () =>
        service.submitAcceptance(
          defaultDeliveryId,
          {
            expectedVersion: first.deliveryVersion,
            scopeVersionId,
            evidence: [
              { kind: "text", label: "重复提交", content: "x" },
            ],
          },
          "acceptance-submit-duplicate",
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "ACCEPTANCE_PENDING" }));
    expect(() =>
      as(owner, () =>
        service.submitAcceptance(
          defaultDeliveryId,
          {
            expectedVersion: scoped.version,
            scopeVersionId,
            evidence: [{ kind: "text", label: "过期版本", content: "x" }],
          },
          "acceptance-submit-stale-version",
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));

    expect(() =>
      as(owner, () =>
        service.recordAcceptanceResults(first.id, {
          expectedVersion: first.deliveryVersion,
          scopeVersionId,
          results: [
            { scopeItemId: first.items[0].scopeItemId, result: "passed" },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "ACCEPTANCE_RESULTS_INCOMPLETE" }));

    const failed = as(owner, () =>
      service.recordAcceptanceResults(first.id, {
        expectedVersion: first.deliveryVersion,
        scopeVersionId,
        results: [
          { scopeItemId: first.items[0].scopeItemId, result: "passed" },
          {
            scopeItemId: first.items[1].scopeItemId,
            result: "failed",
            reason: "组织切换仍有问题",
          },
        ],
      }),
    );
    expect(failed.status).toBe("failed");
    expect(failed.deliveryVersion).toBe(first.deliveryVersion);
    expect(as(owner, () => service.get(defaultDeliveryId)).status).toBe(
      "active",
    );
    expect(as(owner, () => service.get(defaultDeliveryId)).version).toBe(
      first.deliveryVersion + 1,
    );
    expect(failed.items[1]).toMatchObject({
      result: "failed",
      reason: "组织切换仍有问题",
    });

    const latest = as(owner, () => service.get(defaultDeliveryId));
    const second = as(owner, () =>
      service.submitAcceptance(
        defaultDeliveryId,
        {
          expectedVersion: latest.version,
          scopeVersionId,
          evidence: [
            { kind: "text", label: "修复说明", content: "版本 2" },
          ],
        },
        "acceptance-submit-2",
      ),
    );
    expect(second.round).toBe(2);
    expect(second.deliveryVersion).toBe(latest.version + 1);
    const passed = as(owner, () =>
      service.recordAcceptanceResults(second.id, {
        expectedVersion: second.deliveryVersion,
        scopeVersionId,
        results: second.items.map((item) => ({
          scopeItemId: item.scopeItemId,
          result: "passed" as const,
        })),
      }),
    );
    expect(passed.status).toBe("passed");
    expect(as(owner, () => service.get(defaultDeliveryId))).toMatchObject({
      status: "accepted",
      version: second.deliveryVersion + 1,
    });
    expect(as(owner, () => service.acceptanceRounds(defaultDeliveryId))).toHaveLength(
      2,
    );
  });

  it("rejects URL-only evidence because it is not an immutable snapshot", () => {
    requirement(1, "URL 不能独立作为验收证据");
    const scoped = as(owner, () =>
      service.confirmScope(defaultDeliveryId, {
        expectedVersion: 1,
        requirementIds: [1],
      }),
    );
    expect(() =>
      as(owner, () =>
        service.submitAcceptance(defaultDeliveryId, {
          expectedVersion: scoped.version,
          scopeVersionId: scoped.scopeVersion!.id,
          evidence: [
            { kind: "url", label: "外部演示", url: "https://example.com/demo" },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "IMMUTABLE_EVIDENCE_REQUIRED" }));
    expect(as(owner, () => service.get(defaultDeliveryId)).status).toBe("active");
    expect(as(owner, () => service.acceptanceRounds(defaultDeliveryId))).toEqual([]);
  });

  it("rolls back an entire acceptance submission when a protected file snapshot fails", () => {
    requirement(1, "附件读取失败");
    const scoped = as(owner, () =>
      service.confirmScope(defaultDeliveryId, {
        expectedVersion: 1,
        requirementIds: [1],
      }),
    );
    const sourceResourceId = Number(
      db
        .prepare(
          "INSERT INTO requirement_files(requirement_id,phase,category,name,file_name,created_at,updated_at,kind,resource_type,storage_type,status,is_deleted) VALUES(?,'analysis','record','报告','report.pdf','now','now','file','file','local','draft',0)",
        )
        .run(1).lastInsertRowid,
    );
    service = new DeliveryService(db, {
      content() {
        throw new Error("不应读取文本附件");
      },
      raw() {
        throw new Error("受保护的附件读取失败");
      },
    });

    expect(() =>
      as(owner, () =>
        service.submitAcceptance(
          defaultDeliveryId,
          {
            expectedVersion: scoped.version,
            scopeVersionId: scoped.scopeVersion!.id,
            evidence: [
              { kind: "text", label: "说明", content: "先写入后回滚" },
              { kind: "file", label: "报告", sourceResourceId },
            ],
          },
          "acceptance-snapshot-failure",
        ),
      ),
    ).toThrow("受保护的附件读取失败");
    expect(as(owner, () => service.get(defaultDeliveryId)).status).toBe("active");
    expect(as(owner, () => service.acceptanceRounds(defaultDeliveryId))).toEqual([]);
    expect(
      db
        .prepare("SELECT count(*) AS count FROM project_commands WHERE command='delivery.acceptance_submit'")
        .get(),
    ).toMatchObject({ count: 0 });
  });

  it("supersedes a pending round atomically when its scope is revised", () => {
    requirement(1, "需要重新验收的需求");
    const scoped = as(owner, () =>
      service.confirmScope(defaultDeliveryId, {
        expectedVersion: 1,
        requirementIds: [1],
      }),
    );
    const round = as(owner, () =>
      service.submitAcceptance(
        defaultDeliveryId,
        {
          expectedVersion: scoped.version,
          scopeVersionId: scoped.scopeVersion!.id,
          evidence: [{ kind: "text", label: "原版本", content: "原证据" }],
        },
        "acceptance-before-scope-revision",
      ),
    );
    const revised = as(owner, () =>
      service.confirmScope(defaultDeliveryId, {
        expectedVersion: round.deliveryVersion,
        requirementIds: [1],
        changeReason: "验收前更新范围快照",
      }),
    );
    expect(revised.status).toBe("active");
    expect(as(owner, () => service.acceptanceRounds(defaultDeliveryId))).toEqual(
      [expect.objectContaining({ id: round.id, status: "superseded" })],
    );
    expect(
      db
        .prepare("SELECT action,payload FROM project_events WHERE project_id=? AND action='delivery_acceptance_superseded'")
        .all(projectId),
    ).toEqual([
      expect.objectContaining({
        action: "delivery_acceptance_superseded",
        payload: expect.stringContaining(`\"roundId\":${round.id}`),
      }),
    ]);
    expect(() =>
      as(owner, () =>
        service.recordAcceptanceResults(round.id, {
          expectedVersion: revised.version,
          scopeVersionId: round.scopeVersionId,
          results: [{ scopeItemId: round.items[0].scopeItemId, result: "passed" }],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "ACCEPTANCE_SUPERSEDED" }));
    expect(as(owner, () => service.get(defaultDeliveryId)).status).toBe("active");
  });

  it("only the designated acceptance owner can record item results", () => {
    requirement(1, "验收权限");
    db.prepare("UPDATE deliveries SET acceptance_owner_user_id=? WHERE id=?").run(
      product,
      defaultDeliveryId,
    );
    const scoped = as(owner, () =>
      service.confirmScope(defaultDeliveryId, {
        expectedVersion: 1,
        requirementIds: [1],
      }),
    );
    const round = as(owner, () =>
      service.submitAcceptance(
        defaultDeliveryId,
        {
          expectedVersion: scoped.version,
          scopeVersionId: scoped.scopeVersion!.id,
          evidence: [{ kind: "text", label: "验收说明", content: "待验收" }],
        },
        "acceptance-designated-owner",
      ),
    );
    const results = [{ scopeItemId: round.items[0].scopeItemId, result: "passed" as const }];
    expect(() =>
      as(contributor, () =>
        service.recordAcceptanceResults(round.id, {
          expectedVersion: round.deliveryVersion,
          scopeVersionId: round.scopeVersionId,
          results,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    db.prepare("UPDATE project_member_roles SET role='viewer' WHERE project_id=? AND user_id=?").run(
      projectId,
      product,
    );
    expect(() =>
      as(product, () =>
        service.recordAcceptanceResults(round.id, {
          expectedVersion: round.deliveryVersion,
          scopeVersionId: round.scopeVersionId,
          results,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(as(owner, () => service.acceptanceRounds(defaultDeliveryId)[0].status)).toBe(
      "pending",
    );
    db.prepare("UPDATE project_member_roles SET role='product_owner' WHERE project_id=? AND user_id=?").run(
      projectId,
      product,
    );
    expect(
      as(product, () =>
        service.recordAcceptanceResults(round.id, {
          expectedVersion: round.deliveryVersion,
          scopeVersionId: round.scopeVersionId,
          results,
        }),
      ).status,
    ).toBe("passed");
  });
});
