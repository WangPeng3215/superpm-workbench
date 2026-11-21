import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  projectTaskActionSchema,
  projectTaskCreateSchema,
  projectTaskListSchema,
  projectTaskUpdateSchema,
  projectTaskEvidenceSchema,
  type ProjectTask,
  type ProjectTaskAction,
  type ProjectTaskActionInput,
  type ProjectTaskCapabilities,
  type ProjectTaskCreate,
  type ProjectTaskDetail,
  type ProjectTaskEvidenceReference,
  type ProjectTaskList,
  type ProjectTaskStatus,
  type ProjectTaskUpdate,
} from "@superpm/shared";
import {
  assertProjectAccess,
  assertProjectVersion,
  currentActor,
  projectRolesFor,
} from "./project-access.js";
import { DomainError } from "./domain-error.js";

type Row = {
  id: number;
  project_id: number;
  requirement_id: number | null;
  title: string;
  description: string;
  type: ProjectTask["type"];
  assignee_user_id: number;
  confirmer_user_id: number;
  due_date: string | null;
  status: ProjectTaskStatus;
  previous_status: ProjectTaskStatus | null;
  version: number;
  created_by: number;
  created_at: string;
  updated_at: string;
};
const now = () => new Date().toISOString();
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const activeStates = new Set<ProjectTaskStatus>([
  "pending",
  "in_progress",
  "pending_confirmation",
  "blocked",
]);

export class ProjectTaskService {
  constructor(private readonly db: Database.Database) {}

  list(projectId: number, input: unknown): ProjectTaskList {
    const access = assertProjectAccess(this.db, projectId, "read", true);
    const query = projectTaskListSchema.parse(input);
    const actorId = access.actor.id;
    const predicates = ["project_id=?"];
    const params: unknown[] = [projectId];
    for (const [key, column] of [
      ["assigneeUserId", "assignee_user_id"],
      ["confirmerUserId", "confirmer_user_id"],
      ["requirementId", "requirement_id"],
      ["status", "status"],
    ] as const) {
      const value = query[key];
      if (value !== undefined) {
        predicates.push(column + "=?");
        params.push(value);
      }
    }
    const where = predicates.join(" AND ");
    const total = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM project_tasks WHERE " + where)
          .get(...params) as { n: number }
      ).n,
    );
    const rows = this.db
      .prepare(
        "SELECT * FROM project_tasks WHERE " +
          where +
          " ORDER BY id DESC LIMIT ? OFFSET ?",
      )
      .all(
        ...params,
        query.pageSize,
        (query.page - 1) * query.pageSize,
      ) as Row[];
    const items = rows.map((row) => this.toTask(row, actorId, access.roles));
    const roles = access.roles;
    const canCreate =
      this.isProjectWritable(access.project) && roles.includes("owner");
    return { items, total, canCreate };
  }

  listRequirements(
    projectId: number,
    input: { q?: string; limit?: number; includeId?: number } = {},
  ) {
    const access = assertProjectAccess(this.db, projectId, "read", true);
    const q = input.q?.trim() ?? "";
    if (
      q.length > 100 ||
      (input.limit !== undefined &&
        (!Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 100)) ||
      (input.includeId !== undefined &&
        (!Number.isSafeInteger(input.includeId) || input.includeId < 1))
    )
      throw new DomainError("VALIDATION_ERROR", "需求筛选参数无效");
    const limit = input.limit ?? 50;
    const rows = this.db
      .prepare(
        "SELECT r.id,r.requirement_no,r.name,r.developer_user_id FROM requirements r WHERE r.project_id=? AND r.deleted_at IS NULL AND (?='' OR r.name LIKE ? OR r.requirement_no LIKE ? OR r.id=?) AND NOT EXISTS (SELECT 1 FROM requirements child WHERE child.parent_id=r.id AND child.project_id=r.project_id AND child.deleted_at IS NULL) ORDER BY CASE WHEN r.id=? THEN 0 ELSE 1 END,r.requirement_no LIMIT ?",
      )
      .all(
        projectId,
        q,
        "%" + q + "%",
        "%" + q + "%",
        input.includeId ?? -1,
        input.includeId ?? -1,
        limit,
      ) as {
      id: number;
      requirement_no: string;
      name: string;
      developer_user_id: number | null;
    }[];
    const manager = access.roles.some(
      (role) => role === "owner" || role === "product_owner",
    );
    const writable = this.isProjectWritable(access.project);
    return {
      items: rows.map((row) => ({
        id: row.id,
        requirementNo: row.requirement_no,
        name: row.name,
        canCreate:
          writable &&
          (manager ||
            (access.roles.includes("contributor") &&
              row.developer_user_id === access.actor.id)),
      })),
    };
  }

  get(taskId: number): ProjectTaskDetail {
    const { task, access } = this.readTask(taskId);
    return this.detail(task, access.actor.id, access.roles);
  }

  create(projectId: number, input: unknown, key?: string): ProjectTaskDetail {
    const data = projectTaskCreateSchema.parse(input) as ReturnType<
      typeof projectTaskCreateSchema.parse
    >;
    return this.command("project_task.create", projectId, key, data, () => {
      const access = assertProjectAccess(this.db, projectId, "read", true);
      this.assertProjectWritable(access.project, true);
      const roles = access.roles;
      this.assertCanCreate(
        roles,
        access.actor.id,
        projectId,
        data.requirementId,
      );
      this.validateAssignees(
        projectId,
        data.assigneeUserId,
        data.confirmerUserId,
      );
      if (data.requirementId)
        this.requireRequirement(projectId, data.requirementId);
      const timestamp = now();
      const result = this.db
        .prepare(
          "INSERT INTO project_tasks(project_id,requirement_id,title,description,type,assignee_user_id,confirmer_user_id,due_date,status,previous_status,version,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',NULL,1,?,?,?)",
        )
        .run(
          projectId,
          data.requirementId ?? null,
          data.title,
          data.description,
          data.type,
          data.assigneeUserId,
          data.confirmerUserId,
          data.dueDate,
          access.actor.id,
          timestamp,
          timestamp,
        );
      const id = Number(result.lastInsertRowid);
      this.recordAction(
        id,
        "created",
        access.actor.id,
        access.actor.display_name || access.actor.username,
        "",
        timestamp,
        {
          title: { after: data.title },
          description: { after: data.description },
          type: { after: data.type },
          assigneeUserId: { after: data.assigneeUserId },
          confirmerUserId: { after: data.confirmerUserId },
          requirementId: { after: data.requirementId ?? null },
          dueDate: { after: data.dueDate },
        },
      );
      return this.get(id);
    });
  }

  update(taskId: number, input: unknown): ProjectTaskDetail {
    this.readTask(taskId);
    this.requireExpectedVersion(input);
    const data = projectTaskUpdateSchema.parse(input);
    return this.transaction(() => {
      const { task, access } = this.readTask(taskId);
      this.assertProjectWritable(access.project, false);
      this.assertTaskWriteRole(access.roles);
      if (!activeStates.has(task.status))
        throw new DomainError("INVALID_TRANSITION", "已结束任务不可编辑", 409);
      assertProjectVersion(
        task.version,
        data.expectedVersion,
        this.detail(task, access.actor.id, access.roles),
      );
      const manager = access.roles.includes("owner");
      const isAssignee = task.assignee_user_id === access.actor.id;
      if (!manager && !isAssignee)
        throw new DomainError("FORBIDDEN", "当前角色不能编辑此任务", 403);
      if (
        !manager &&
        (data.assigneeUserId !== undefined ||
          data.confirmerUserId !== undefined ||
          data.requirementId !== undefined)
      )
        throw new DomainError(
          "FORBIDDEN",
          "只有项目负责人可以调整任务责任或需求关联",
          403,
        );
      if (!manager && this.hasSubmissions(taskId))
        throw new DomainError(
          "INVALID_TRANSITION",
          "任务提交后不能编辑，请通过退回或重开调整",
          409,
        );
      if (
        data.requirementId !== undefined &&
        data.requirementId !== task.requirement_id &&
        this.hasSubmissions(taskId)
      )
        throw new DomainError(
          "INVALID_TRANSITION",
          "任务提交后不能更改关联需求",
          409,
        );
      const nextRequirement =
        data.requirementId === undefined
          ? task.requirement_id
          : data.requirementId;
      if (nextRequirement !== null)
        this.requireRequirement(task.project_id, nextRequirement);
      if (
        data.assigneeUserId !== undefined ||
        data.confirmerUserId !== undefined
      )
        this.validateAssignees(
          task.project_id,
          data.assigneeUserId ?? task.assignee_user_id,
          data.confirmerUserId ?? task.confirmer_user_id,
        );
      const fields = [
        "title",
        "description",
        "type",
        "assigneeUserId",
        "confirmerUserId",
        "requirementId",
        "dueDate",
      ] as const;
      const columns: Record<(typeof fields)[number], string> = {
        title: "title",
        description: "description",
        type: "type",
        assigneeUserId: "assignee_user_id",
        confirmerUserId: "confirmer_user_id",
        requirementId: "requirement_id",
        dueDate: "due_date",
      };
      const assignments: string[] = [];
      const values: unknown[] = [];
      const timestamp = now();
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      const rowValues: Record<(typeof fields)[number], unknown> = {
        title: task.title,
        description: task.description,
        type: task.type,
        assigneeUserId: task.assignee_user_id,
        confirmerUserId: task.confirmer_user_id,
        requirementId: task.requirement_id,
        dueDate: task.due_date,
      };
      for (const field of fields)
        if (data[field] !== undefined) {
          assignments.push(columns[field] + "=?");
          values.push(data[field]);
          changes[field] = { before: rowValues[field], after: data[field] };
        }
      assignments.push("version=version+1", "updated_at=?");
      values.push(timestamp, taskId, task.version);
      const result = this.db
        .prepare(
          "UPDATE project_tasks SET " +
            assignments.join(",") +
            " WHERE id=? AND version=?",
        )
        .run(...values);
      if (result.changes !== 1)
        throw new DomainError("VERSION_CONFLICT", "任务已被其他成员更新", 409);
      this.recordAction(
        taskId,
        "edit",
        access.actor.id,
        access.actor.display_name || access.actor.username,
        "",
        timestamp,
        changes,
      );
      return this.get(taskId);
    });
  }

  action(taskId: number, input: unknown, key?: string): ProjectTaskDetail {
    this.readTask(taskId);
    this.requireExpectedVersion(input);
    const data = projectTaskActionSchema.parse(input) as ProjectTaskActionInput;
    const task = this.rawTask(taskId);
    if (!task) throw new DomainError("NOT_FOUND", "任务不存在", 404);
    return this.command(
      "project_task.action",
      task.project_id,
      key,
      { taskId, ...data },
      () => {
        const { task: fresh, access } = this.readTask(taskId);
        this.assertProjectWritable(access.project, false);
        this.assertActionPermission(
          fresh,
          data.action,
          access.actor.id,
          access.roles,
          access.project,
        );
        assertProjectVersion(
          fresh.version,
          data.expectedVersion,
          this.detail(fresh, access.actor.id, access.roles),
        );
        const timestamp = now();
        let next: ProjectTaskStatus = fresh.status;
        let previous: ProjectTaskStatus | null = fresh.previous_status;
        switch (data.action) {
          case "start":
            this.requireStatus(
              fresh.status === "pending",
              "只有待开始任务可以开始",
            );
            next = "in_progress";
            previous = null;
            break;
          case "block":
            this.requireStatus(
              fresh.status === "pending" || fresh.status === "in_progress",
              "当前状态的任务不能阻塞",
            );
            next = "blocked";
            previous = fresh.status;
            break;
          case "resume":
            this.requireStatus(
              fresh.status === "blocked" && fresh.previous_status !== null,
              "任务当前不处于可恢复的阻塞状态",
            );
            next = fresh.previous_status!;
            previous = null;
            break;
          case "submit":
            this.requireStatus(
              fresh.status === "in_progress",
              "只有进行中的任务可以提交确认",
            );
            const evidence = this.validateEvidence(fresh, data.evidence ?? []);
            this.db
              .prepare(
                "INSERT INTO project_task_submissions(task_id,submitted_by,summary,evidence_json,created_at) VALUES(?,?,?,?,?)",
              )
              .run(
                taskId,
                access.actor.id,
                data.summary ?? "",
                JSON.stringify(evidence),
                timestamp,
              );
            next = "pending_confirmation";
            previous = null;
            break;
          case "approve":
          case "return": {
            this.requireStatus(
              fresh.status === "pending_confirmation",
              "当前没有待确认的任务提交",
            );
            const submission = this.db
              .prepare(
                "SELECT id FROM project_task_submissions WHERE task_id=? ORDER BY id DESC LIMIT 1",
              )
              .get(taskId) as { id: number } | undefined;
            if (
              !submission ||
              this.db
                .prepare(
                  "SELECT id FROM project_task_reviews WHERE submission_id=?",
                )
                .get(submission.id)
            )
              throw new DomainError(
                "INVALID_TRANSITION",
                "当前提交已处理，请刷新任务后重试",
                409,
              );
            const result = data.action === "approve" ? "approved" : "returned";
            this.db
              .prepare(
                "INSERT INTO project_task_reviews(submission_id,reviewer_user_id,result,reason,created_at) VALUES(?,?,?,?,?)",
              )
              .run(
                submission.id,
                access.actor.id,
                result,
                data.reason ?? "",
                timestamp,
              );
            next = data.action === "approve" ? "completed" : "in_progress";
            previous = null;
            break;
          }
          case "cancel":
            this.requireStatus(
              activeStates.has(fresh.status),
              "已结束任务不能取消",
            );
            next = "cancelled";
            previous = null;
            break;
          case "reopen":
            this.requireStatus(
              fresh.status === "completed",
              "只有已完成任务可以重开",
            );
            next = "in_progress";
            previous = null;
            break;
        }
        const result = this.db
          .prepare(
            "UPDATE project_tasks SET status=?,previous_status=?,version=version+1,updated_at=? WHERE id=? AND version=?",
          )
          .run(next, previous, timestamp, taskId, fresh.version);
        if (result.changes !== 1)
          throw new DomainError(
            "VERSION_CONFLICT",
            "任务已被其他成员更新",
            409,
          );
        this.recordAction(
          taskId,
          data.action,
          access.actor.id,
          access.actor.display_name || access.actor.username,
          data.reason ?? "",
          timestamp,
        );
        return this.get(taskId);
      },
    );
  }

  /** Called inside daily-plan/clock write transactions, and deliberately rechecks current membership. */
  assertDailyPlanAccess(
    taskId: number,
    purpose: "plan" | "start" = "plan",
  ): {
    id: number;
    projectId: number;
    requirementId: number | null;
    assigneeUserId: number;
    version: number;
  } {
    const { task, access } = this.readTask(taskId);
    this.assertTaskWriteRole(access.roles);
    if (task.assignee_user_id !== access.actor.id)
      throw new DomainError(
        "FORBIDDEN",
        "仅任务执行人可安排或开始关联的个人计划",
        403,
      );
    if (!activeStates.has(task.status))
      throw new DomainError(
        "INVALID_TRANSITION",
        "已结束任务不能创建新的个人安排或计时",
        409,
      );
    if (purpose === "start" && task.status === "blocked")
      throw new DomainError(
        "INVALID_TRANSITION",
        "阻塞任务不能开始关联计时",
        409,
      );
    if (purpose === "start" && task.status === "pending_confirmation")
      throw new DomainError(
        "INVALID_TRANSITION",
        "待确认任务不能开始关联计时",
        409,
      );
    if (purpose === "start" && access.project.status === "paused")
      throw new DomainError(
        "PROJECT_READ_ONLY",
        "项目暂停期间不能开始关联计时",
        409,
      );
    if (purpose === "start" && !this.isProjectWritable(access.project))
      throw new DomainError(
        "PROJECT_READ_ONLY",
        "项目当前不能开始关联计时",
        409,
      );
    return {
      id: task.id,
      projectId: task.project_id,
      requirementId: task.requirement_id,
      assigneeUserId: task.assignee_user_id,
      version: task.version,
    };
  }

  private validateEvidence(
    task: Row,
    evidence: ProjectTaskActionInput["evidence"] = [],
  ): ProjectTaskEvidenceReference[] {
    const references: ProjectTaskEvidenceReference[] = [];
    for (const raw of evidence) {
      const item = projectTaskEvidenceSchema.parse(raw);
      if (item.kind === "external_link") {
        references.push({
          ...item,
          displayName: item.label ?? new URL(item.url).hostname,
        });
        continue;
      }
      if (task.requirement_id === null)
        throw new DomainError(
          "VALIDATION_ERROR",
          "项目级任务不能引用需求产物",
          400,
        );
      const row =
        item.kind === "artifact_node"
          ? (this.db
              .prepare(
                "SELECT n.name FROM artifact_nodes n JOIN requirements r ON r.id=n.requirement_id WHERE n.id=? AND n.requirement_id=? AND n.node_type='file' AND n.status='normal' AND r.project_id=? AND r.deleted_at IS NULL AND r.user_id>=0",
              )
              .get(item.id, task.requirement_id, task.project_id) as
              { name: string } | undefined)
          : (this.db
              .prepare(
                "SELECT f.name FROM requirement_files f JOIN requirements r ON r.id=f.requirement_id WHERE f.id=? AND f.requirement_id=? AND f.is_deleted=0 AND r.project_id=? AND r.deleted_at IS NULL AND r.user_id>=0",
              )
              .get(item.id, task.requirement_id, task.project_id) as
              { name: string } | undefined);
      if (!row)
        throw new DomainError(
          "VALIDATION_ERROR",
          "证据必须来自任务关联需求中仍可用的资源",
          400,
        );
      references.push({ ...item, displayName: row.name });
    }
    return references;
  }

  private assertActionPermission(
    task: Row,
    action: ProjectTaskAction,
    actorId: number,
    roles: string[],
    project: { status: string; archived_at: string | null },
  ) {
    this.assertTaskWriteRole(roles);
    const manager = roles.includes("owner");
    const assignee = task.assignee_user_id === actorId;
    const confirmer = task.confirmer_user_id === actorId;
    const allowed =
      action === "approve" || action === "return"
        ? confirmer
        : action === "reopen"
          ? confirmer || manager
          : action === "cancel"
            ? manager || assignee
            : assignee;
    if (!allowed)
      throw new DomainError(
        "FORBIDDEN",
        "当前账号不是此任务的执行人或确认人",
        403,
      );
    if (
      action !== "cancel" &&
      (project.archived_at ||
        ["closed", "cancelled", "paused"].includes(project.status))
    )
      throw new DomainError(
        "PROJECT_READ_ONLY",
        "项目当前为只读或暂停状态",
        409,
      );
  }

  private toTask(
    row: Row,
    actorId: number,
    roles: string[],
    project?: { status: string; archived_at: string | null },
  ): ProjectTask {
    const p = project ?? this.project(row.project_id);
    const writable = this.isProjectWritable(p) && p.status !== "paused";
    const canAct = roles.some((role) => role !== "viewer");
    const manager = roles.includes("owner");
    const assignee = row.assignee_user_id === actorId;
    const confirmer = row.confirmer_user_id === actorId;
    const actions: ProjectTaskAction[] = [];
    if (
      canAct &&
      writable &&
      !["completed", "cancelled"].includes(row.status) &&
      row.status !== "blocked"
    ) {
      if (assignee && row.status === "pending") actions.push("start");
      if (assignee && ["pending", "in_progress"].includes(row.status))
        actions.push("block");
      if (assignee && row.status === "in_progress") actions.push("submit");
      if (confirmer && row.status === "pending_confirmation")
        actions.push("approve", "return");
      if (
        (manager || assignee) &&
        !["completed", "cancelled"].includes(row.status)
      )
        actions.push("cancel");
    }
    if (
      canAct &&
      writable &&
      row.status === "blocked" &&
      row.assignee_user_id === actorId &&
      row.previous_status
    )
      actions.push("resume");
    if (
      canAct &&
      writable &&
      row.status === "completed" &&
      (manager || confirmer)
    )
      actions.push("reopen");
    return {
      id: row.id,
      projectId: row.project_id,
      requirementId: row.requirement_id,
      title: row.title,
      description: row.description,
      type: row.type,
      assigneeUserId: row.assignee_user_id,
      confirmerUserId: row.confirmer_user_id,
      dueDate: row.due_date,
      status: row.status,
      previousStatus: row.previous_status,
      version: row.version,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      capabilities: {
        canEdit:
          canAct &&
          writable &&
          !["completed", "cancelled"].includes(row.status) &&
          (manager || (assignee && !this.hasSubmissions(row.id))),
        canPlan:
          canAct &&
          !p.archived_at &&
          !["closed", "cancelled"].includes(p.status) &&
          activeStates.has(row.status) &&
          assignee,
        actions,
      },
    };
  }

  private detail(
    task: Row,
    actorId: number,
    roles: string[],
  ): ProjectTaskDetail {
    const submissions = this.db
      .prepare(
        "SELECT s.id,s.submitted_by,s.summary,s.evidence_json,s.created_at,r.id AS review_id,r.reviewer_user_id,r.result,r.reason,r.created_at AS reviewed_at FROM project_task_submissions s LEFT JOIN project_task_reviews r ON r.submission_id=s.id WHERE s.task_id=? ORDER BY s.id",
      )
      .all(task.id) as {
      id: number;
      submitted_by: number;
      summary: string;
      evidence_json: string;
      created_at: string;
      review_id: number | null;
      reviewer_user_id: number | null;
      result: "approved" | "returned" | null;
      reason: string | null;
      reviewed_at: string | null;
    }[];
    const actions = this.db
      .prepare(
        "SELECT id,action,actor_user_id,actor_name_snapshot,reason,payload_json,created_at FROM project_task_actions WHERE task_id=? ORDER BY id",
      )
      .all(task.id) as {
      id: number;
      action: ProjectTaskAction | "created" | "edit";
      actor_user_id: number;
      actor_name_snapshot: string;
      reason: string;
      payload_json: string;
      created_at: string;
    }[];
    return {
      ...this.toTask(task, actorId, roles),
      submissions: submissions.map((row) => ({
        id: row.id,
        submittedBy: row.submitted_by,
        summary: row.summary,
        evidence: JSON.parse(
          row.evidence_json,
        ) as ProjectTaskEvidenceReference[],
        createdAt: row.created_at,
        review:
          row.review_id === null
            ? null
            : {
                id: row.review_id,
                reviewerUserId: row.reviewer_user_id!,
                result: row.result!,
                reason: row.reason!,
                createdAt: row.reviewed_at!,
              },
      })),
      actions: actions.map((row) => ({
        id: row.id,
        action: row.action,
        actorUserId: row.actor_user_id,
        actorNameSnapshot: row.actor_name_snapshot,
        reason: row.reason,
        changes: JSON.parse(row.payload_json) as Record<string, unknown>,
        createdAt: row.created_at,
      })),
    };
  }

  private readTask(taskId: number) {
    const actor = currentActor(this.db);
    const task = this.rawTask(taskId);
    if (!task) throw new DomainError("NOT_FOUND", "任务不存在", 404);
    const access = assertProjectAccess(this.db, task.project_id, "read", true);
    return { task, access: { ...access, actor } };
  }

  private rawTask(taskId: number): Row | undefined {
    return this.db
      .prepare("SELECT * FROM project_tasks WHERE id=?")
      .get(taskId) as Row | undefined;
  }
  private assertTaskWriteRole(roles: string[]) {
    if (!roles.some((role) => role !== "viewer"))
      throw new DomainError("FORBIDDEN", "当前只读角色不能操作项目任务", 403);
  }
  private project(projectId: number) {
    return this.db
      .prepare("SELECT id,status,archived_at FROM projects WHERE id=?")
      .get(projectId) as {
      id: number;
      status: string;
      archived_at: string | null;
    };
  }
  private isProjectWritable(project: {
    status: string;
    archived_at: string | null;
  }) {
    return (
      !project.archived_at && !["closed", "cancelled"].includes(project.status)
    );
  }
  private assertProjectWritable(
    project: { status: string; archived_at: string | null },
    allowPaused: boolean,
  ) {
    if (
      !this.isProjectWritable(project) ||
      (!allowPaused && project.status === "paused")
    )
      throw new DomainError(
        "PROJECT_READ_ONLY",
        "项目当前为只读或暂停状态",
        409,
      );
  }
  private hasSubmissions(taskId: number) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM project_task_submissions WHERE task_id=? LIMIT 1",
        )
        .get(taskId),
    );
  }

  private requireRequirement(projectId: number, requirementId: number) {
    const row = this.db
      .prepare(
        "SELECT r.id,r.project_id,r.deleted_at,r.developer_user_id FROM requirements r WHERE r.id=?",
      )
      .get(requirementId) as
      | {
          id: number;
          project_id: number | null;
          deleted_at: string | null;
          developer_user_id: number | null;
        }
      | undefined;
    if (!row || row.project_id !== projectId || row.deleted_at !== null)
      throw new DomainError(
        "VALIDATION_ERROR",
        "关联需求不存在或不属于当前项目",
        400,
      );
    if (
      this.db
        .prepare(
          "SELECT 1 FROM requirements WHERE parent_id=? AND project_id=? AND deleted_at IS NULL LIMIT 1",
        )
        .get(requirementId, projectId)
    )
      throw new DomainError(
        "VALIDATION_ERROR",
        "项目任务只能关联有效叶子需求",
        400,
      );
    return row;
  }

  private validateAssignees(
    projectId: number,
    assigneeId: number,
    confirmerId: number,
  ) {
    for (const userId of new Set([assigneeId, confirmerId])) {
      const valid = this.db
        .prepare(
          "SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? AND m.user_id=? AND m.status='active' AND u.status='active' AND EXISTS (SELECT 1 FROM project_member_roles r WHERE r.project_id=m.project_id AND r.user_id=m.user_id AND r.role IN ('owner','product_owner','contributor'))",
        )
        .get(projectId, userId);
      if (!valid)
        throw new DomainError(
          "VALIDATION_ERROR",
          "执行人与确认人必须是当前项目的有效非只读成员",
          400,
        );
    }
  }

  private assertCanCreate(
    roles: string[],
    actorId: number,
    projectId: number,
    requirementId?: number,
  ) {
    if (roles.includes("owner")) return;
    if (!requirementId)
      throw new DomainError("FORBIDDEN", "仅项目负责人可创建项目级任务", 403);
    if (roles.includes("product_owner")) return;
    if (!roles.includes("contributor"))
      throw new DomainError("FORBIDDEN", "当前项目角色不能创建任务", 403);
    if (
      this.requireRequirement(projectId, requirementId).developer_user_id !==
      actorId
    )
      throw new DomainError(
        "FORBIDDEN",
        "仅可为自己负责开发的需求创建任务",
        403,
      );
  }

  private requireStatus(
    condition: boolean,
    message: string,
  ): asserts condition {
    if (!condition) throw new DomainError("INVALID_TRANSITION", message, 409);
  }
  private requireExpectedVersion(input: unknown) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      !("expectedVersion" in input)
    )
      throw new DomainError("VERSION_REQUIRED", "请携带最新版本后保存", 428);
  }
  private recordAction(
    taskId: number,
    action: ProjectTaskAction | "created" | "edit",
    actorId: number,
    actorName: string,
    reason: string,
    createdAt: string,
    payload: unknown = {},
  ) {
    this.db
      .prepare(
        "INSERT INTO project_task_actions(task_id,action,actor_user_id,actor_name_snapshot,reason,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        taskId,
        action,
        actorId,
        actorName,
        reason,
        JSON.stringify(payload),
        createdAt,
      );
  }

  private command(
    command: string,
    projectId: number,
    key: string | undefined,
    input: unknown,
    fn: () => ProjectTaskDetail,
  ): ProjectTaskDetail {
    return this.transaction(() => {
      const actor = currentActor(this.db);
      const normalizedKey = key ?? randomUUID();
      if (!normalizedKey.trim() || normalizedKey.length > 200)
        throw new DomainError("VALIDATION_ERROR", "幂等键格式不正确", 400);
      assertProjectAccess(this.db, projectId, "read", true);
      const requestHash = hash({ projectId, input });
      const existing = this.db
        .prepare(
          "SELECT id,project_id,request_hash FROM project_commands WHERE actor_user_id=? AND command=? AND idempotency_key=?",
        )
        .get(actor.id, command, normalizedKey) as
        | { id: number; project_id: number | null; request_hash: string }
        | undefined;
      if (existing) {
        if (existing.project_id !== null)
          assertProjectAccess(this.db, existing.project_id, "read", true);
        if (existing.request_hash !== requestHash)
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "同一幂等键不能用于不同请求",
            409,
          );
        const response = this.db
          .prepare("SELECT response FROM project_commands WHERE id=?")
          .get(existing.id) as { response: string };
        const taskId = Number(JSON.parse(response.response).taskId);
        const task = this.rawTask(taskId);
        if (!task || task.project_id !== existing.project_id)
          throw new DomainError("NOT_FOUND", "任务不存在", 404);
        const access = assertProjectAccess(
          this.db,
          task.project_id,
          "read",
          true,
        );
        if (command === "project_task.create") {
          this.assertCanCreate(
            access.roles,
            actor.id,
            projectId,
            (input as { requirementId?: number }).requirementId,
          );
        } else {
          const action = (input as { action: ProjectTaskAction }).action;
          this.assertActionPermission(
            task,
            action,
            actor.id,
            access.roles,
            access.project,
          );
        }
        return this.detail(task, actor.id, access.roles);
      }
      this.db
        .prepare(
          "INSERT INTO project_commands(project_id,actor_user_id,command,idempotency_key,request_hash,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(projectId, actor.id, command, normalizedKey, requestHash, now());
      const result = fn();
      const slot = this.db
        .prepare(
          "SELECT id FROM project_commands WHERE actor_user_id=? AND command=? AND idempotency_key=?",
        )
        .get(actor.id, command, normalizedKey) as { id: number };
      this.db
        .prepare("UPDATE project_commands SET response=? WHERE id=?")
        .run(JSON.stringify({ taskId: result.id }), slot.id);
      return result;
    });
  }
  private transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
}
