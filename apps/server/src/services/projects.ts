import type Database from "better-sqlite3";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  projectCreateSchema,
  projectUpdateSchema,
  projectMemberWriteSchema,
  projectLeadsUpdateSchema,
  projectLifecycleSchema,
  projectArchiveSchema,
  projectListSchema,
  projectMemberRemoveSchema,
  requirementShareSchema,
  type Project,
  type ProjectDetail,
  type ProjectOverview,
  type ProjectMember,
  type ProjectRole,
  type ProjectTaskResponsibilityTransfer,
  type SharePreview,
} from "@superpm/shared";
import { DomainError } from "./domain-error.js";
import {
  assertProjectAccess,
  assertProjectVersion,
  capabilitiesFor,
  currentActor,
  projectRolesFor,
  type ProjectAction,
} from "./project-access.js";
import { businessDate } from "./business-time.js";

const projectColumns: Record<string, string> = {
  projectNo: "project_no",
  name: "name",
  goal: "goal",
  scopeSummary: "scope_summary",
  customerName: "customer_name",
  customerContact: "customer_contact",
  plannedStartDate: "planned_start_date",
  targetDeliveryDate: "target_delivery_date",
  ownerUserId: "owner_user_id",
  productOwnerUserId: "product_owner_user_id",
  status: "status",
  previousStatus: "previous_status",
  version: "version",
  archivedAt: "archived_at",
  createdBy: "created_by",
  createdAt: "created_at",
  updatedAt: "updated_at",
};
const projection =
  "id, " +
  Object.entries(projectColumns)
    .map(([key, column]) => column + " AS " + key)
    .join(", ");
const previewInput = z
  .object({ rootRequirementId: z.number().int().positive() })
  .strict();
function versionedInput(input: unknown) {
  if (
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    !("expectedVersion" in input)
  )
    throw new DomainError("VERSION_REQUIRED", "请携带最新版本后保存", 428);
  return input;
}
interface TreeRow {
  id: number;
  requirement_no: string;
  name: string;
  version: number;
  user_id: number;
  project_id: number | null;
  parent_id: number | null;
}
interface PreviewToken {
  actor: number;
  project: number;
  projectVersion: number;
  root: number;
  tree: { id: number; version: number }[];
  fingerprint: string;
  expires: number;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

export class ProjectService {
  constructor(private readonly db: Database.Database) {}
  list(input: unknown) {
    const query = projectListSchema.parse(input);
    const actor = currentActor(this.db);
    const params: unknown[] = [];
    const filters = [
      query.view === "archived"
        ? "archived_at IS NOT NULL"
        : "archived_at IS NULL",
    ];
    if (
      !actor.isAdmin ||
      query.view === "owned" ||
      query.view === "participating"
    ) {
      filters.push(
        "EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=projects.id AND m.user_id=? AND m.status='active')",
      );
      params.push(actor.id);
    }
    if (query.view === "owned") {
      filters.push("owner_user_id=?");
      params.push(actor.id);
    }
    if (query.q) {
      filters.push(
        "(name LIKE ? ESCAPE '!' OR project_no LIKE ? ESCAPE '!' OR customer_name LIKE ? ESCAPE '!')",
      );
      const q = "%" + query.q.replace(/[!%_]/g, "!$&") + "%";
      params.push(q, q, q);
    }
    const where = filters.join(" AND ");
    const column = projectColumns[query.sortBy];
    const direction = query.sortOrder === "asc" ? "ASC" : "DESC";
    const sort = query.sortBy === "projectNo" ? "id" : column;
    const total = (
      this.db
        .prepare("SELECT count(*) AS n FROM projects WHERE " + where)
        .get(...params) as { n: number }
    ).n;
    const items = this.db
      .prepare(
        "SELECT " +
          projection +
          " FROM projects WHERE " +
          where +
          " ORDER BY " +
          sort +
          " " +
          direction +
          ", id ASC LIMIT ? OFFSET ?",
      )
      .all(
        ...params,
        query.pageSize,
        (query.page - 1) * query.pageSize,
      ) as Project[];
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
  get(id: number): ProjectDetail {
    const { roles, project } = assertProjectAccess(this.db, id);
    return {
      project: this.row(id),
      members: this.members(id),
      capabilities: capabilitiesFor(
        roles,
        Boolean(project.archived_at) ||
          ["closed", "cancelled"].includes(project.status),
      ),
    };
  }
  overview(id: number): ProjectOverview {
    const access = assertProjectAccess(this.db, id, "read", true);
    const project = this.row(id);
    const requirementRows = this.db
      .prepare(
        "SELECT id,status,parent_id AS parentId FROM requirements WHERE project_id=? AND deleted_at IS NULL",
      )
      .all(id) as { id: number; status: string; parentId: number | null }[];
    const requirementStatus: Record<string, number> = {};
    for (const row of requirementRows)
      requirementStatus[row.status] = (requirementStatus[row.status] ?? 0) + 1;
    const requirementIdsWithChildren = new Set(
      requirementRows
        .map((row) => row.parentId)
        .filter((parentId): parentId is number => parentId !== null),
    );
    const leafRequirementIds = new Set(
      requirementRows
        .filter((row) => !requirementIdsWithChildren.has(row.id))
        .map((row) => row.id),
    );
    const taskRows = this.db
      .prepare(
        "SELECT id,title,status,due_date AS dueDate,assignee_user_id AS assigneeUserId,confirmer_user_id AS confirmerUserId FROM project_tasks WHERE project_id=?",
      )
      .all(id) as {
        id: number;
        title: string;
        status: string;
        dueDate: string | null;
        assigneeUserId: number;
        confirmerUserId: number;
      }[];
    const taskStatus: Record<string, number> = {};
    const today = businessDate(new Date());
    const overdueTasks = taskRows
      .filter(
        (row) =>
          row.dueDate !== null &&
          row.dueDate < today &&
          !["completed", "cancelled"].includes(row.status),
      )
      .map((row) => row.id);
    for (const row of taskRows)
      taskStatus[row.status] = (taskStatus[row.status] ?? 0) + 1;
    const deliveryRows = this.db
      .prepare(
        "SELECT id,name,status,version,planned_delivery_date AS plannedDate,acceptance_owner_user_id AS acceptanceOwnerUserId,current_scope_version_id AS currentScopeVersionId FROM deliveries WHERE project_id=? ORDER BY id",
      )
      .all(id) as {
        id: number;
        name: string;
        status: string;
        version: number;
        plannedDate: string | null;
        acceptanceOwnerUserId: number | null;
        currentScopeVersionId: number | null;
      }[];
    const deliveryStatus: Record<string, number> = {};
    for (const row of deliveryRows)
      deliveryStatus[row.status] = (deliveryStatus[row.status] ?? 0) + 1;

    type DeliveryScopeItemRow = {
      deliveryId: number;
      scopeVersionId: number;
      requirementId: number;
    };
    const activeDeliveries = deliveryRows.filter(
      (delivery) => delivery.status !== "cancelled",
    );
    const scopeItems = activeDeliveries.flatMap((delivery) =>
      delivery.currentScopeVersionId
        ? (this.db
            .prepare(
              "SELECT ? AS deliveryId,scope_version_id AS scopeVersionId,requirement_id AS requirementId FROM delivery_scope_items WHERE scope_version_id=? ORDER BY id",
            )
            .all(delivery.id, delivery.currentScopeVersionId) as DeliveryScopeItemRow[])
        : [],
    );
    const requirementById = new Map(
      requirementRows.map((row) => [row.id, row]),
    );
    const currentScopeIds = new Set<number>();
    for (const item of scopeItems) {
      if (
        requirementById.has(item.requirementId) &&
        leafRequirementIds.has(item.requirementId)
      )
        currentScopeIds.add(item.requirementId);
    }
    const confirmedDeliveryCount = activeDeliveries.filter(
      (delivery) => delivery.currentScopeVersionId !== null,
    ).length;
    const unconfirmedDeliveries = activeDeliveries.length - confirmedDeliveryCount;
    const scopeState: ProjectOverview["deliveryScope"]["state"] =
      currentScopeIds.size > 0
        ? "confirmed"
        : confirmedDeliveryCount > 0
          ? "empty"
          : "unconfirmed";
    let executionCompleted: number | null = null;
    let accepted: number | null = null;
    let failed: number | null = null;
    if (scopeState === "confirmed") {
      executionCompleted = [...currentScopeIds].filter(
        (requirementId) => requirementById.get(requirementId)?.status === "completed",
      ).length;
      accepted = 0;
      failed = 0;
      for (const delivery of activeDeliveries) {
        if (!delivery.currentScopeVersionId) continue;
        const round = this.db
          .prepare(
            "SELECT id,status FROM delivery_acceptance_rounds WHERE delivery_id=? AND scope_version_id=? AND status IN ('passed','failed') ORDER BY round_no DESC LIMIT 1",
          )
          .get(delivery.id, delivery.currentScopeVersionId) as
          | { id: number; status: "passed" | "failed" }
          | undefined;
        if (!round) continue;
        const results = this.db
          .prepare(
            "SELECT scope_item_id AS scopeItemId,requirement_id AS requirementId,result FROM delivery_acceptance_items WHERE round_id=?",
          )
          .all(round.id) as { scopeItemId: number; requirementId: number; result: "passed" | "failed" }[];
        const effectiveItemIds = new Set(
          scopeItems
            .filter((item) => item.deliveryId === delivery.id && requirementById.has(item.requirementId) && leafRequirementIds.has(item.requirementId))
            .map((item) => item.requirementId),
        );
        for (const result of results) {
          if (!effectiveItemIds.has(result.requirementId)) continue;
          if (result.result === "passed") accepted++;
          else if (result.result === "failed") failed++;
        }
      }
    }
    const scopeTotal = scopeState === "confirmed" ? currentScopeIds.size : null;
    const executionPercent =
      scopeTotal === null ? null : Math.round(((executionCompleted ?? 0) / scopeTotal) * 100);
    const acceptancePercent =
      scopeTotal === null ? null : Math.round(((accepted ?? 0) / scopeTotal) * 100);
    const failedDeliveries = activeDeliveries
      .filter((delivery) => {
        if (!delivery.currentScopeVersionId) return false;
        const round = this.db
          .prepare(
            "SELECT status FROM delivery_acceptance_rounds WHERE delivery_id=? AND scope_version_id=? AND status IN ('passed','failed') ORDER BY round_no DESC LIMIT 1",
          )
          .get(delivery.id, delivery.currentScopeVersionId) as
          | { status: string }
          | undefined;
        return round?.status === "failed";
      })
      .map((delivery) => delivery.id);
    const overdueDeliveries = activeDeliveries
      .filter(
        (delivery) =>
          delivery.plannedDate !== null &&
          delivery.plannedDate < today &&
          !["accepted", "cancelled"].includes(delivery.status),
      )
      .map((delivery) => delivery.id);
    const projectWritable =
      !project.archivedAt &&
      !["closed", "cancelled", "paused"].includes(project.status);
    const canAct =
      projectWritable && access.roles.some((role) => role !== "viewer");
    const isOwner = canAct && access.roles.includes("owner");
    const myActions: ProjectOverview["myActions"]["items"] = [];
    for (const task of taskRows) {
      if (
        canAct &&
        task.assigneeUserId === access.actor.id &&
        task.status === "in_progress"
      )
        myActions.push({
          id: task.id,
          kind: "task",
          action: "submit",
          title: task.title,
          dueDate: task.dueDate,
        });
      if (
        canAct &&
        task.confirmerUserId === access.actor.id &&
        task.status === "pending_confirmation"
      )
        myActions.push({
          id: task.id,
          kind: "task",
          action: "confirm",
          title: task.title,
          dueDate: task.dueDate,
        });
    }
    for (const delivery of activeDeliveries) {
      if (
        isOwner &&
        delivery.status === "planning" &&
        !delivery.currentScopeVersionId
      )
        myActions.push({
          id: delivery.id,
          kind: "delivery",
          action: "confirm_scope",
          title: delivery.name,
          dueDate: delivery.plannedDate,
        });
      if (
        canAct &&
        delivery.acceptanceOwnerUserId === access.actor.id &&
        delivery.status === "awaiting_acceptance" &&
        delivery.currentScopeVersionId !== null &&
        Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM delivery_acceptance_rounds WHERE delivery_id=? AND scope_version_id=? AND delivery_version=? AND status='pending' LIMIT 1",
            )
            .get(
              delivery.id,
              delivery.currentScopeVersionId,
              delivery.version,
            ),
        )
      )
        myActions.push({
          id: delivery.id,
          kind: "delivery",
          action: "accept",
          title: delivery.name,
          dueDate: delivery.plannedDate,
        });
    }
    const riskByKey = new Map<string, ProjectOverview["risks"]["items"][number]>();
    const addRisk = (
      kind: ProjectOverview["risks"]["items"][number]["kind"],
      entityId: number,
      reason: ProjectOverview["risks"]["items"][number]["reasons"][number],
      title: string,
    ) => {
      const key = kind + ":" + entityId;
      let item = riskByKey.get(key);
      if (!item) {
        item = { key, kind, id: entityId, title, reasons: [] };
        riskByKey.set(key, item);
      }
      if (!item.reasons.includes(reason)) item.reasons.push(reason);
    };
    for (const requirement of requirementRows)
      if (requirement.status === "blocked")
        addRisk("requirement", requirement.id, "blocked", "阻塞需求 #" + requirement.id);
    for (const task of taskRows) {
      if (task.status === "blocked")
        addRisk("task", task.id, "blocked", "阻塞任务 #" + task.id);
      if (overdueTasks.includes(task.id))
        addRisk("task", task.id, "overdue", "逾期任务 #" + task.id);
    }
    const addDeliveryRisk = (
      deliveryId: number,
      reason: ProjectOverview["risks"]["items"][number]["reasons"][number],
    ) => {
      const delivery = activeDeliveries.find((item) => item.id === deliveryId);
      if (delivery)
        addRisk("delivery", delivery.id, reason, "交付 " + delivery.name);
    };
    for (const deliveryId of failedDeliveries)
      addDeliveryRisk(deliveryId, "failed_acceptance");
    for (const deliveryId of overdueDeliveries)
      addDeliveryRisk(deliveryId, "overdue");
    const blockers = this.db.prepare(
      "SELECT b.id,b.delivery_id AS deliveryId,b.impact,i.version AS issueVersion " +
        "FROM delivery_blocking_issues b " +
        "JOIN deliveries d ON d.id=b.delivery_id " +
        "JOIN issues i ON i.id=b.issue_id " +
        "WHERE d.project_id=? AND d.status<>'cancelled' AND b.resolved_at IS NULL " +
        "AND i.is_deleted=0 AND i.status NOT IN ('resolved','wont_fix') " +
        "AND NOT EXISTS (SELECT 1 FROM delivery_risk_acceptances a " +
        "WHERE a.blocking_issue_id=b.id AND a.issue_version=i.version) ORDER BY b.id",
    ).all(id) as { id: number; deliveryId: number; impact: string; issueVersion: number }[];
    for (const blocker of blockers)
      addDeliveryRisk(blocker.deliveryId, "blocking_issue");
    for (const delivery of activeDeliveries) {
      if (!delivery.currentScopeVersionId) continue;
      const unresolvedFollowUp = this.db.prepare(
        "SELECT 1 FROM delivery_scope_changes WHERE delivery_id=? AND scope_version_id=? " +
          "AND change_type IN ('remove','postpone','waive') AND follow_up_delivery_id IS NULL " +
          "AND (follow_up_owner_user_id IS NULL OR follow_up_date IS NULL) LIMIT 1",
      ).get(delivery.id, delivery.currentScopeVersionId);
      if (unresolvedFollowUp) addDeliveryRisk(delivery.id, "scope_follow_up");
    }
    return {
      project,
      requirements: {
        total: requirementRows.length,
        byStatus: requirementStatus,
        completed: requirementStatus.completed ?? 0,
        blocked: requirementStatus.blocked ?? 0,
      },
      tasks: {
        total: taskRows.length,
        byStatus: taskStatus,
        pending: taskStatus.pending ?? 0,
        blocked: taskStatus.blocked ?? 0,
        overdue: overdueTasks.length,
      },
      deliveries: {
        total: deliveryRows.length,
        byStatus: deliveryStatus,
        active: deliveryStatus.active ?? 0,
        awaitingAcceptance: deliveryStatus.awaiting_acceptance ?? 0,
      },
      deliveryScope: {
        state: scopeState,
        total: scopeTotal,
        executionCompleted,
        executionPercent,
        accepted,
        acceptancePercent,
        failed,
        unconfirmedDeliveries,
      },
      risks: {
        items: [...riskByKey.values()],
        blockedRequirements: requirementRows
          .filter((row) => row.status === "blocked")
          .map((row) => row.id),
        blockedTasks: taskRows
          .filter((row) => row.status === "blocked")
          .map((row) => row.id),
        overdueTasks,
        failedDeliveries,
        overdueDeliveries,
      },
      myActions: { items: myActions },
      recentEvents: this.events(id, {})
        .items as ProjectOverview["recentEvents"],
    };
  }
  create(input: unknown, key?: string) {
    const data = projectCreateSchema.parse(input);
    return this.command("project.create", null, data, key, "read", () => {
      const actor = currentActor(this.db);
      const now = new Date().toISOString();
      const next = (
        this.db
          .prepare("SELECT coalesce(max(id),0)+1 AS n FROM projects")
          .get() as { n: number }
      ).n;
      const number = "PRJ-" + String(next).padStart(4, "0");
      const result = this.db
        .prepare(
          "INSERT INTO projects(project_no,name,goal,scope_summary,customer_name,customer_contact,planned_start_date,target_delivery_date,owner_user_id,product_owner_user_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          number,
          data.name,
          data.goal,
          data.scopeSummary,
          data.customerName,
          data.customerContact,
          data.plannedStartDate,
          data.targetDeliveryDate,
          actor.id,
          actor.id,
          actor.id,
          now,
          now,
        );
      const id = Number(result.lastInsertRowid);
      this.db
        .prepare(
          "INSERT INTO project_members(project_id,user_id,joined_at) VALUES (?,?,?)",
        )
        .run(id, actor.id, now);
      for (const role of ["owner", "product_owner"])
        this.db
          .prepare(
            "INSERT INTO project_member_roles(project_id,user_id,role) VALUES (?,?,?)",
          )
          .run(id, actor.id, role);
      this.db
        .prepare(
          "INSERT INTO deliveries(project_id,name,is_default,created_by,created_at,updated_at) VALUES (?,'默认交付',1,?,?,?)",
        )
        .run(id, actor.id, now, now);
      this.event(id, "project_created", { name: data.name });
      return this.get(id);
    });
  }
  update(id: number, input: unknown) {
    const { expectedVersion, ...patch } = projectUpdateSchema.parse(
      versionedInput(input),
    );
    return this.transaction(() => {
      assertProjectAccess(this.db, id, "edit");
      const current = this.get(id);
      assertProjectVersion(current.project.version, expectedVersion, current);
      const merged = { ...current.project, ...patch };
      if (
        merged.plannedStartDate &&
        merged.targetDeliveryDate &&
        merged.targetDeliveryDate < merged.plannedStartDate
      )
        throw new DomainError(
          "VALIDATION_ERROR",
          "目标交付日不能早于计划开始日",
          400,
        );
      this.patch(id, patch, expectedVersion);
      this.event(id, "project_updated", { fields: Object.keys(patch) });
      return this.get(id);
    });
  }
  candidates(id: number, input: unknown) {
    assertProjectAccess(this.db, id, "members");
    const { q } = z
      .object({ q: z.string().trim().min(2).max(100) })
      .strict()
      .parse(input);
    const pattern = "%" + q.replace(/[!%_]/g, "!$&") + "%";
    return {
      items: this.db
        .prepare(
          "SELECT id,username,display_name AS displayName FROM users WHERE status='active' AND (username LIKE ? ESCAPE '!' OR display_name LIKE ? ESCAPE '!') ORDER BY username,id LIMIT 20",
        )
        .all(pattern, pattern),
    };
  }
  writeMember(
    id: number,
    input: unknown,
    expectedUserId?: number,
    key?: string,
  ) {
    const data = projectMemberWriteSchema.parse(versionedInput(input));
    if (expectedUserId !== undefined && expectedUserId !== data.userId)
      throw new DomainError("VALIDATION_ERROR", "成员标识不一致", 400);
    return this.command(
      "project.member.write",
      id,
      data,
      key,
      "members",
      () => {
        const current = this.get(id);
        assertProjectVersion(
          current.project.version,
          data.expectedVersion,
          current,
        );
        const user = this.db
          .prepare("SELECT id FROM users WHERE id=? AND status='active'")
          .get(data.userId);
        if (!user) throw new DomainError("CONFLICT", "请选择有效账号", 409);
        const transferredTaskIds = this.assertCanRemoveResponsibilities(
          current.project,
          data.userId,
          data.roles,
          data.taskTransfers ?? [],
        );
        const now = new Date().toISOString();
        this.db
          .prepare(
            "INSERT INTO project_members(project_id,user_id,status,joined_at,removed_at) VALUES (?,?,'active',?,NULL) ON CONFLICT(project_id,user_id) DO UPDATE SET status='active',joined_at=excluded.joined_at,removed_at=NULL",
          )
          .run(id, data.userId, now);
        this.db
          .prepare(
            "DELETE FROM project_member_roles WHERE project_id=? AND user_id=?",
          )
          .run(id, data.userId);
        for (const role of data.roles)
          this.db
            .prepare(
              "INSERT INTO project_member_roles(project_id,user_id,role) VALUES (?,?,?)",
            )
            .run(id, data.userId, role);
        this.patch(id, {}, data.expectedVersion);
        this.event(id, "member_roles_updated", {
          userId: data.userId,
          roles: data.roles,
          transferredTaskIds,
        });
        return this.get(id);
      },
    );
  }
  removeMember(id: number, userId: number, input: unknown, key?: string) {
    const data = projectMemberRemoveSchema.parse(versionedInput(input));
    return this.command(
      "project.member.remove",
      id,
      { ...data, userId },
      key,
      "members",
      () => {
        const current = this.get(id);
        assertProjectVersion(
          current.project.version,
          data.expectedVersion,
          current,
        );
        if (!this.members(id).some((m) => m.userId === userId))
          throw new DomainError("NOT_FOUND", "项目成员不存在", 404);
        const transferredTaskIds = this.assertCanRemoveResponsibilities(
          current.project,
          userId,
          [],
          data.taskTransfers ?? [],
        );
        this.db
          .prepare(
            "UPDATE project_members SET status='removed',removed_at=? WHERE project_id=? AND user_id=?",
          )
          .run(new Date().toISOString(), id, userId);
        this.db
          .prepare(
            "DELETE FROM project_member_roles WHERE project_id=? AND user_id=?",
          )
          .run(id, userId);
        this.patch(id, {}, data.expectedVersion);
        this.event(id, "member_removed", { userId, transferredTaskIds });
        const actor = currentActor(this.db);
        if (actor.id === userId && !actor.isAdmin)
          return {
            project: this.row(id),
            members: [],
            capabilities: capabilitiesFor([]),
          };
        return this.get(id);
      },
    );
  }
  leads(id: number, input: unknown) {
    const data = projectLeadsUpdateSchema.parse(versionedInput(input));
    return this.transaction(() => {
      assertProjectAccess(this.db, id, "members");
      const current = this.get(id);
      assertProjectVersion(
        current.project.version,
        data.expectedVersion,
        current,
      );
      if (
        !projectRolesFor(this.db, id, data.ownerUserId).includes("owner") ||
        !projectRolesFor(this.db, id, data.productOwnerUserId).includes(
          "product_owner",
        )
      )
        throw new DomainError(
          "CONFLICT",
          "主要负责人必须为具有对应角色的有效成员",
          409,
        );
      this.patch(
        id,
        {
          ownerUserId: data.ownerUserId,
          productOwnerUserId: data.productOwnerUserId,
        },
        data.expectedVersion,
      );
      this.event(id, "project_leads_updated", {
        ownerUserId: data.ownerUserId,
        productOwnerUserId: data.productOwnerUserId,
      });
      return this.get(id);
    });
  }
  archive(id: number, input: unknown, key?: string) {
    const data = projectArchiveSchema.parse(versionedInput(input));
    return this.command(
      "project.archive",
      id,
      data,
      key,
      "archive",
      () => {
        const current = this.get(id);
        assertProjectVersion(
          current.project.version,
          data.expectedVersion,
          current,
        );
        if (
          data.archived &&
          !["closed", "cancelled"].includes(current.project.status)
        )
          throw new DomainError(
            "INVALID_TRANSITION",
            "只有已结项或已取消的项目可以归档",
            409,
          );
        this.patch(
          id,
          { archivedAt: data.archived ? new Date().toISOString() : null },
          data.expectedVersion,
        );
        this.event(
          id,
          data.archived ? "project_archived" : "project_restored",
          {},
        );
        return this.get(id);
      },
      true,
    );
  }
  lifecycle(id: number, input: unknown, key?: string) {
    const data = projectLifecycleSchema.parse(versionedInput(input));
    return this.command(
      "project.lifecycle",
      id,
      data,
      key,
      "lifecycle",
      () => {
        const current = this.get(id);
        const p = current.project;
        assertProjectVersion(p.version, data.expectedVersion, current);
        if (p.archivedAt)
          throw new DomainError(
            "PROJECT_READ_ONLY",
            "请先解除归档，再改变项目状态",
            409,
          );
        let status = p.status;
        let previous = p.previousStatus;
        if (data.action === "start" && p.status === "planning")
          status = "active";
        else if (
          data.action === "pause" &&
          ["planning", "active"].includes(p.status)
        ) {
          previous = p.status;
          status = "paused";
        } else if (data.action === "resume" && p.status === "paused") {
          status = p.previousStatus === "planning" ? "planning" : "active";
          previous = null;
        } else if (
          data.action === "cancel" &&
          ["planning", "active", "paused"].includes(p.status)
        ) {
          previous = p.status;
          status = "cancelled";
        } else if (data.action === "reopen" && p.status === "cancelled") {
          status = "active";
          previous = null;
        } else
          throw new DomainError(
            "INVALID_TRANSITION",
            "当前阶段不能执行该状态操作，验收与结项将在后续阶段开放",
            409,
          );
        this.patch(id, { status, previousStatus: previous }, p.version);
        this.event(id, "project_" + data.action, {
          reason: data.reason,
          fromStatus: p.status,
          toStatus: status,
        });
        return this.get(id);
      },
      data.action === "reopen",
    );
  }
  sharePreview(id: number, input: unknown): SharePreview {
    const { rootRequirementId } = previewInput.parse(input);
    const { actor, project } = assertProjectAccess(this.db, id, "requirements");
    const tree = this.privateTree(rootRequirementId, actor.id);
    const expires = Date.now() + 5 * 60_000;
    const token = this.sign({
      actor: actor.id,
      project: id,
      projectVersion: project.version,
      root: rootRequirementId,
      tree: tree.map((r) => ({ id: r.id, version: r.version })),
      fingerprint: this.resourceFingerprint(tree),
      expires,
    });
    const ids = tree.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const count = (table: string, where = "") =>
      (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM " +
              table +
              " WHERE requirement_id IN (" +
              placeholders +
              ")" +
              where,
          )
          .get(...ids) as { n: number }
      ).n;
    return {
      rootRequirementId,
      projectId: id,
      token,
      requirements: tree.map((r) => ({
        id: r.id,
        requirementNo: r.requirement_no,
        name: r.name,
        version: r.version,
      })),
      issueCount: count("issues", " AND is_deleted=0"),
      artifactCount:
        count("artifact_nodes") +
        count("artifact_links") +
        count("requirement_files", " AND is_deleted=0"),
      expiresAt: new Date(expires).toISOString(),
    };
  }
  share(id: number, input: unknown, key?: string) {
    const data = requirementShareSchema.parse(versionedInput(input));
    return this.command(
      "project.requirements.share",
      id,
      data,
      key,
      "requirements",
      () => {
        const current = this.get(id);
        assertProjectVersion(
          current.project.version,
          data.expectedVersion,
          current,
        );
        const actor = currentActor(this.db);
        const token = this.verify(data.token);
        if (
          token.actor !== actor.id ||
          token.project !== id ||
          token.expires < Date.now()
        )
          throw new DomainError(
            "PREVIEW_EXPIRED",
            "共享预览已失效，请重新预览",
            409,
          );
        if (token.projectVersion !== current.project.version)
          throw new DomainError(
            "PREVIEW_STALE",
            "项目或成员已改变，请重新预览",
            409,
          );
        const tree = this.privateTree(token.root, actor.id);
        if (
          hash(tree.map((r) => ({ id: r.id, version: r.version }))) !==
            hash(token.tree) ||
          this.resourceFingerprint(tree) !== token.fingerprint
        )
          throw new DomainError(
            "PREVIEW_STALE",
            "需求树或资料已改变，请重新预览",
            409,
          );
        const assignee =
          data.assigneeUserId ?? current.project.productOwnerUserId;
        const developer = data.developerUserId ?? null;
        for (const userId of [assignee, developer])
          if (
            userId !== null &&
            !projectRolesFor(this.db, id, userId).some(
              (role) => role !== "viewer",
            )
          )
            throw new DomainError(
              "CONFLICT",
              "责任人必须是有效非只读成员",
              409,
            );
        const now = new Date().toISOString();
        for (const requirement of tree) {
          const changed = this.db
            .prepare(
              "UPDATE requirements SET project_id=?,assignee_user_id=?,developer_user_id=?,version=version+1,updated_at=? WHERE id=? AND version=? AND project_id IS NULL AND user_id=?",
            )
            .run(
              id,
              assignee,
              developer,
              now,
              requirement.id,
              requirement.version,
              actor.id,
            );
          if (changed.changes !== 1)
            throw new DomainError(
              "PREVIEW_STALE",
              "需求已改变，请重新预览",
              409,
            );
          this.db
            .prepare(
              "INSERT INTO requirement_audit(requirement_id,action,payload,created_at,user_id,actor_user_id) VALUES (?,?,?,?,?,?)",
            )
            .run(
              requirement.id,
              "project_shared",
              JSON.stringify({ projectId: id }),
              now,
              actor.id,
              actor.id,
            );
        }
        this.patch(id, {}, data.expectedVersion);
        this.event(id, "requirements_shared", {
          rootRequirementId: token.root,
          requirementIds: tree.map((r) => r.id),
        });
        return this.get(id);
      },
    );
  }
  events(id: number, input: unknown) {
    assertProjectAccess(this.db, id);
    const query = z
      .object({ cursor: z.coerce.number().int().positive().optional() })
      .strict()
      .parse(input);
    const rows = this.db
      .prepare(
        "SELECT id,action,actor_name_snapshot AS actorNameSnapshot,payload,created_at AS createdAt FROM project_events WHERE project_id=?" +
          (query.cursor ? " AND id < ?" : "") +
          " ORDER BY id DESC LIMIT 31",
      )
      .all(id, ...(query.cursor ? [query.cursor] : [])) as {
      id: number;
      action: string;
      actorNameSnapshot: string;
      payload: string;
      createdAt: string;
    }[];
    const hasMore = rows.length > 30;
    const page = rows.slice(0, 30);
    return {
      items: page.map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1].id) : null,
    };
  }
  private row(id: number) {
    return this.db
      .prepare("SELECT " + projection + " FROM projects WHERE id=?")
      .get(id) as Project;
  }
  private members(id: number): ProjectMember[] {
    const rows = this.db
      .prepare(
        "SELECT m.project_id AS projectId,m.user_id AS userId,u.username,u.display_name AS displayName,m.status,u.status AS accountStatus,m.joined_at AS joinedAt,m.removed_at AS removedAt,group_concat(r.role) AS roles FROM project_members m JOIN users u ON u.id=m.user_id LEFT JOIN project_member_roles r ON r.project_id=m.project_id AND r.user_id=m.user_id WHERE m.project_id=? AND m.status='active' GROUP BY m.project_id,m.user_id ORDER BY m.joined_at,m.user_id",
      )
      .all(id) as (Omit<ProjectMember, "roles"> & { roles: string | null })[];
    return rows.map((r) => ({
      ...r,
      roles: (r.roles?.split(",") ?? []) as ProjectRole[],
    }));
  }
  private patch(id: number, patch: Record<string, unknown>, expected: number) {
    const entries = Object.entries(patch);
    const set = entries.map(([key]) => projectColumns[key] + "=?");
    const result = this.db
      .prepare(
        "UPDATE projects SET " +
          [...set, "version=version+1", "updated_at=?"].join(",") +
          " WHERE id=? AND version=?",
      )
      .run(
        ...entries.map(([, v]) => v),
        new Date().toISOString(),
        id,
        expected,
      );
    if (result.changes !== 1)
      throw new DomainError(
        "VERSION_CONFLICT",
        "项目已更新，请刷新后重试",
        409,
        { current: this.get(id) },
      );
  }
  private event(id: number, action: string, payload: unknown) {
    const actor = currentActor(this.db);
    this.db
      .prepare(
        "INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        action,
        actor.id,
        actor.display_name || actor.username,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }
  private assertCanRemoveResponsibilities(
    p: Project,
    userId: number,
    roles: ProjectRole[],
    taskTransfers: ProjectTaskResponsibilityTransfer[],
  ) {
    const obligations: { type: string; id: number }[] = [];
    const transferredTaskIds = this.transferProjectTaskResponsibilities(
      p.id,
      userId,
      roles,
      taskTransfers,
    );
    if (p.ownerUserId === userId && !roles.includes("owner"))
      obligations.push({ type: "project_owner", id: p.id });
    if (p.productOwnerUserId === userId && !roles.includes("product_owner"))
      obligations.push({ type: "project_product_owner", id: p.id });
    if (!roles.includes("owner")) {
      const currentRoles = projectRolesFor(this.db, p.id, userId);
      const owners = this.db
        .prepare(
          "SELECT count(*) AS n FROM project_member_roles r JOIN project_members m ON m.project_id=r.project_id AND m.user_id=r.user_id JOIN users u ON u.id=m.user_id WHERE r.project_id=? AND r.role='owner' AND m.status='active' AND u.status='active'",
        )
        .get(p.id) as { n: number };
      if (currentRoles.includes("owner") && owners.n <= 1)
        obligations.push({ type: "last_owner", id: p.id });
    }
    if (!roles.some((role) => role !== "viewer")) {
      const requirements = this.db
        .prepare(
          "SELECT id,assignee_user_id,developer_user_id FROM requirements WHERE project_id=? AND deleted_at IS NULL AND status NOT IN ('completed','cancelled') AND (assignee_user_id=? OR developer_user_id=?)",
        )
        .all(p.id, userId, userId) as {
        id: number;
        assignee_user_id: number | null;
        developer_user_id: number | null;
      }[];
      for (const r of requirements) {
        if (r.assignee_user_id === userId)
          obligations.push({ type: "requirement_assignee", id: r.id });
        if (r.developer_user_id === userId)
          obligations.push({ type: "requirement_developer", id: r.id });
      }
    }
    if (obligations.length)
      throw new DomainError(
        "RESPONSIBILITY_TRANSFER_REQUIRED",
        "请先移交负责人或未完成需求责任，再移除成员或角色",
        409,
        { obligations },
      );
    return transferredTaskIds;
  }
  private transferProjectTaskResponsibilities(
    projectId: number,
    userId: number,
    roles: ProjectRole[],
    transfers: ProjectTaskResponsibilityTransfer[],
  ): number[] {
    const losesTaskCapability = !roles.some((role) => role !== "viewer");
    const tasks = losesTaskCapability
      ? (this.db
          .prepare(
            "SELECT id,version,assignee_user_id,confirmer_user_id FROM project_tasks WHERE project_id=? AND status NOT IN ('completed','cancelled') AND (assignee_user_id=? OR confirmer_user_id=?) ORDER BY id",
          )
          .all(projectId, userId, userId) as {
          id: number;
          version: number;
          assignee_user_id: number;
          confirmer_user_id: number;
        }[])
      : [];
    if (tasks.length === 0) {
      if (transfers.length)
        throw new DomainError(
          "VALIDATION_ERROR",
          "当前成员无需移交项目任务责任",
          400,
        );
      return [];
    }

    const byTaskId = new Map<number, ProjectTaskResponsibilityTransfer>();
    for (const transfer of transfers) {
      if (byTaskId.has(transfer.taskId))
        throw new DomainError("VALIDATION_ERROR", "同一任务不能重复移交", 400);
      byTaskId.set(transfer.taskId, transfer);
    }
    const requiredObligations = tasks.flatMap((task) => [
      ...(task.assignee_user_id === userId
        ? [{ type: "project_task_assignee", id: task.id }]
        : []),
      ...(task.confirmer_user_id === userId
        ? [{ type: "project_task_confirmer", id: task.id }]
        : []),
    ]);
    const taskIds = new Set(tasks.map((task) => task.id));
    const unexpectedTaskIds = transfers
      .filter((transfer) => !taskIds.has(transfer.taskId))
      .map((transfer) => transfer.taskId);
    if (transfers.length !== tasks.length || unexpectedTaskIds.length)
      throw new DomainError(
        "RESPONSIBILITY_TRANSFER_REQUIRED",
        "请为所有未完成项目任务指定责任接收人",
        409,
        { obligations: requiredObligations, unexpectedTaskIds },
      );

    const actor = currentActor(this.db);
    const now = new Date().toISOString();
    const pendingUpdates: {
      task: (typeof tasks)[number];
      changes: Record<string, { before: number; after: number }>;
    }[] = [];
    for (const task of tasks) {
      const transfer = byTaskId.get(task.id)!;
      if (transfer.expectedVersion !== task.version)
        throw new DomainError(
          "VERSION_CONFLICT",
          "任务已被其他成员更新，请刷新后重试",
          409,
          { taskId: task.id, currentVersion: task.version },
        );
      const changes: Record<string, { before: number; after: number }> = {};
      if (task.assignee_user_id === userId) {
        if (transfer.assigneeUserId === undefined)
          throw new DomainError(
            "RESPONSIBILITY_TRANSFER_REQUIRED",
            "请为所有未完成项目任务指定执行人",
            409,
            { obligations: [{ type: "project_task_assignee", id: task.id }] },
          );
        if (transfer.assigneeUserId === userId)
          throw new DomainError(
            "INVALID_TRANSFER_TARGET",
            "执行人不能继续由待移除成员担任",
            409,
            { taskId: task.id, responsibility: "assignee" },
          );
        this.assertTaskResponsibilityTarget(
          projectId,
          transfer.assigneeUserId,
          "assignee",
          task.id,
        );
        changes.assigneeUserId = {
          before: task.assignee_user_id,
          after: transfer.assigneeUserId,
        };
      } else if (transfer.assigneeUserId !== undefined) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "只能移交当前成员承担的任务执行责任",
          400,
          { taskId: task.id, responsibility: "assignee" },
        );
      }
      if (task.confirmer_user_id === userId) {
        if (transfer.confirmerUserId === undefined)
          throw new DomainError(
            "RESPONSIBILITY_TRANSFER_REQUIRED",
            "请为所有未完成项目任务指定确认人",
            409,
            { obligations: [{ type: "project_task_confirmer", id: task.id }] },
          );
        if (transfer.confirmerUserId === userId)
          throw new DomainError(
            "INVALID_TRANSFER_TARGET",
            "确认人不能继续由待移除成员担任",
            409,
            { taskId: task.id, responsibility: "confirmer" },
          );
        this.assertTaskResponsibilityTarget(
          projectId,
          transfer.confirmerUserId,
          "confirmer",
          task.id,
        );
        changes.confirmerUserId = {
          before: task.confirmer_user_id,
          after: transfer.confirmerUserId,
        };
      } else if (transfer.confirmerUserId !== undefined) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "只能移交当前成员承担的任务确认责任",
          400,
          { taskId: task.id, responsibility: "confirmer" },
        );
      }
      pendingUpdates.push({ task, changes });
    }

    for (const { task, changes } of pendingUpdates) {
      const entries = Object.entries(changes);
      const columns: Record<string, string> = {
        assigneeUserId: "assignee_user_id",
        confirmerUserId: "confirmer_user_id",
      };
      const result = this.db
        .prepare(
          "UPDATE project_tasks SET " +
            [
              ...entries.map(([field]) => columns[field] + "=?"),
              "version=version+1",
              "updated_at=?",
            ].join(",") +
            " WHERE id=? AND project_id=? AND version=?",
        )
        .run(
          ...entries.map(([, change]) => change.after),
          now,
          task.id,
          projectId,
          task.version,
        );
      if (result.changes !== 1)
        throw new DomainError(
          "VERSION_CONFLICT",
          "任务已被其他成员更新，请刷新后重试",
          409,
          { taskId: task.id },
        );
      this.db
        .prepare(
          "INSERT INTO project_task_actions(task_id,action,actor_user_id,actor_name_snapshot,reason,payload_json,created_at) VALUES (?, 'edit', ?, ?, '', ?, ?)",
        )
        .run(
          task.id,
          actor.id,
          actor.display_name || actor.username,
          JSON.stringify(changes),
          now,
        );
    }
    return tasks.map((task) => task.id);
  }
  private assertTaskResponsibilityTarget(
    projectId: number,
    userId: number,
    responsibility: "assignee" | "confirmer",
    taskId: number,
  ) {
    const roles = projectRolesFor(this.db, projectId, userId);
    const capable =
      responsibility === "assignee"
        ? roles.some((role) =>
            ["owner", "product_owner", "contributor"].includes(role),
          )
        : roles.some((role) =>
            ["owner", "product_owner", "contributor"].includes(role),
          );
    if (!capable)
      throw new DomainError(
        "INVALID_TRANSFER_TARGET",
        responsibility === "assignee"
          ? "执行人必须是具有任务执行能力的有效项目成员"
          : "确认人必须是具有任务确认能力的有效项目成员",
        409,
        { taskId, responsibility, userId },
      );
  }
  private privateTree(rootId: number, userId: number): TreeRow[] {
    const root = this.db
      .prepare(
        "SELECT id,requirement_no,name,version,user_id,project_id,parent_id FROM requirements WHERE id=? AND deleted_at IS NULL",
      )
      .get(rootId) as TreeRow | undefined;
    if (!root || root.user_id !== userId)
      throw new DomainError("NOT_FOUND", "私人需求不存在", 404);
    if (root.parent_id !== null || root.project_id !== null)
      throw new DomainError("CONFLICT", "请从未关联项目的主需求发起共享", 409);
    const children = this.db
      .prepare(
        "SELECT id,requirement_no,name,version,user_id,project_id,parent_id FROM requirements WHERE parent_id=? AND deleted_at IS NULL ORDER BY id",
      )
      .all(rootId) as TreeRow[];
    const tree = [root, ...children];
    if (children.length) {
      const deeper = this.db
        .prepare(
          "SELECT 1 FROM requirements WHERE parent_id IN (" +
            children.map(() => "?").join(",") +
            ") AND deleted_at IS NULL LIMIT 1",
        )
        .get(...children.map((r) => r.id));
      if (deeper)
        throw new DomainError(
          "CONFLICT",
          "历史需求树超过两级，请先整理后共享",
          409,
        );
    }
    if (tree.some((r) => r.user_id !== userId || r.project_id !== null))
      throw new DomainError(
        "CONFLICT",
        "需求树存在其他作者或项目，不能整体共享",
        409,
      );
    return tree;
  }
  private resourceFingerprint(tree: TreeRow[]) {
    const ids = tree.map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    return hash(
      ["issues", "artifact_nodes", "artifact_links", "requirement_files"].map(
        (table) =>
          this.db
            .prepare(
              "SELECT id,version FROM " +
                table +
                " WHERE requirement_id IN (" +
                marks +
                ") ORDER BY id",
            )
            .all(...ids),
      ),
    );
  }
  private secret() {
    return (
      this.db
        .prepare("SELECT value FROM app_meta WHERE key='auth_secret'")
        .get() as { value: string }
    ).value;
  }
  private sign(value: PreviewToken) {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return (
      payload +
      "." +
      createHmac("sha256", this.secret()).update(payload).digest("base64url")
    );
  }
  private verify(token: string): PreviewToken {
    try {
      const [payload, signature, ...extra] = token.split(".");
      if (!payload || !signature || extra.length) throw new Error();
      const expected = createHmac("sha256", this.secret())
        .update(payload)
        .digest();
      const given = Buffer.from(signature, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected))
        throw new Error();
      const value = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as PreviewToken;
      if (
        !Number.isSafeInteger(value.actor) ||
        !Number.isSafeInteger(value.project) ||
        !Number.isSafeInteger(value.root) ||
        !Number.isFinite(value.expires) ||
        !Array.isArray(value.tree)
      )
        throw new Error();
      return value;
    } catch {
      throw new DomainError(
        "PREVIEW_EXPIRED",
        "共享预览令牌无效，请重新预览",
        409,
      );
    }
  }
  private command(
    command: string,
    projectId: number | null,
    input: unknown,
    key: string | undefined,
    action: ProjectAction,
    fn: () => ProjectDetail,
    allowReadonly = false,
  ): ProjectDetail {
    return this.transaction(() => {
      const actor = currentActor(this.db);
      if (projectId !== null)
        assertProjectAccess(this.db, projectId, action, true);
      const normalizedKey = key ?? randomUUID();
      if (!normalizedKey.trim() || normalizedKey.length > 200)
        throw new DomainError("VALIDATION_ERROR", "幂等键格式不正确", 400);
      const requestHash = hash({ projectId, input });
      const existing = this.db
        .prepare(
          "SELECT project_id,request_hash,response FROM project_commands WHERE actor_user_id=? AND command=? AND idempotency_key=?",
        )
        .get(actor.id, command, normalizedKey) as
        | { project_id: number | null; request_hash: string; response: string }
        | undefined;
      if (existing) {
        if (existing.project_id !== null)
          assertProjectAccess(this.db, existing.project_id);
        if (existing.request_hash !== requestHash)
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "同一幂等键不能用于不同请求",
            409,
          );
        return this.get(existing.project_id!);
      }
      if (projectId !== null)
        assertProjectAccess(this.db, projectId, action, allowReadonly);
      const slot = this.db
        .prepare(
          "INSERT INTO project_commands(project_id,actor_user_id,command,idempotency_key,request_hash,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          projectId,
          actor.id,
          command,
          normalizedKey,
          requestHash,
          new Date().toISOString(),
        );
      const result = fn();
      this.db
        .prepare(
          "UPDATE project_commands SET project_id=?,response=? WHERE id=?",
        )
        .run(
          result.project.id,
          JSON.stringify({ projectId: result.project.id }),
          slot.lastInsertRowid,
        );
      return result;
    });
  }
  private transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
}
