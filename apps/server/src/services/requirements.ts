import {
  requirementCreateSchema,
  requirementUpdateSchema,
  requirementListSchema,
  stages,
  type RequirementReferenceState,
} from "@superpm/shared";
import type Database from "better-sqlite3";
import { RequirementsRepository } from "../repositories/requirements.js";
import type { RequirementDirectoryResolver } from "./requirement-directory.js";
import { assertRequirementAccess } from "./requirement-access.js";
import {
  assertProjectAccess,
  assertProjectVersion,
  projectRolesFor,
} from "./project-access.js";
import { currentUserScope } from "../db/scope.js";

import { DomainError } from "./domain-error.js";
export { DomainError } from "./domain-error.js";
export class RequirementService {
  private readonly repo: RequirementsRepository;
  constructor(
    private readonly db: Database.Database,
    // 可选：提供时 createWithWorkspace 才会初始化物理目录（MCP 等只建记录的调用方无需注入）
    private readonly directories?: RequirementDirectoryResolver,
    // 仓储层使用原生连接：drizzle 生成的语句自带参数绑定，隔离条件在仓储内显式书写
    ormDb?: Database.Database,
  ) {
    this.repo = new RequirementsRepository(ormDb ?? db);
  }
  create(input: unknown) {
    const data = requirementCreateSchema.parse(input);
    return this.transaction(() => {
      this.checkParent(data.parentId);
      if (data.parentId !== null) {
        const parent = this.get(data.parentId);
        if (data.projectId !== null && data.projectId !== parent.projectId)
          throw new DomainError("CONFLICT", "主子需求必须属于同一项目", 409);
        data.projectId = parent.projectId;
        assertRequirementAccess(this.db, parent.id, "edit");
      }
      if (data.projectId !== null) {
        const { project } = assertProjectAccess(
          this.db,
          data.projectId,
          "requirements",
        );
        data.assigneeUserId ??= project.product_owner_user_id;
      }
      this.checkResponsibilities(
        data.projectId,
        data.assigneeUserId,
        data.developerUserId,
      );
      const item = this.repo.insert(data);
      this.repo.audit(item.id, "create", data);
      this.projectEvent(item.projectId, "requirement_created", item.id);
      return item;
    });
  }
  /**
   * 建需求的统一入口：普通建需与优化点转换都走这里，避免出现第二套创建逻辑。
   * 目录初始化沿用既有补偿语义——失败不阻断建需，状态落库为 failed 供前端重试。
   * 返回 workspaceReady 便于调用方提示「目录待修复」。
   */
  createWithWorkspace(input: unknown): {
    requirement: ReturnType<RequirementService["create"]>;
    workspaceReady: boolean;
    workspaceError: unknown;
  } {
    const requirement = this.create(input);
    if (!this.directories)
      return { requirement, workspaceReady: true, workspaceError: null };
    try {
      this.directories.initialize(requirement.id);
      return { requirement, workspaceReady: true, workspaceError: null };
    } catch (error) {
      return { requirement, workspaceReady: false, workspaceError: error };
    }
  }
  get(id: number) {
    assertRequirementAccess(this.db, id);
    const item = this.repo.get(id);
    if (!item) throw new DomainError("NOT_FOUND", "需求不存在", 404);
    return item;
  }
  list(input: unknown) {
    return this.repo.list(requirementListSchema.parse(input));
  }
  update(id: number, input: unknown) {
    const parsed = requirementUpdateSchema.parse(input);
    const { stageNote, expectedVersion, ...patch } = parsed;
    return this.transaction(() => {
      const existing = this.get(id);
      assertRequirementAccess(this.db, id, "edit");
      if (existing.projectId !== null || expectedVersion !== undefined)
        assertProjectVersion(existing.version, expectedVersion, existing);
      if (
        patch.currentStage &&
        patch.currentStage !== existing.currentStage &&
        stages.indexOf(patch.currentStage) !==
          stages.indexOf(existing.currentStage) + 1 &&
        !stageNote?.trim()
      )
        throw new DomainError(
          "VALIDATION_ERROR",
          "跳过或退回需求阶段时请填写原因",
          400,
          { field: "stageNote" },
        );
      if (patch.parentId !== undefined) this.checkParent(patch.parentId, id);
      if (
        patch.parentId != null &&
        this.get(patch.parentId).projectId !== existing.projectId
      )
        throw new DomainError("CONFLICT", "主子需求必须属于同一项目", 409);
      this.checkResponsibilities(
        existing.projectId,
        patch.assigneeUserId === undefined
          ? existing.assigneeUserId
          : patch.assigneeUserId,
        patch.developerUserId === undefined
          ? existing.developerUserId
          : patch.developerUserId,
      );
      const updated = this.repo.update(id, patch, expectedVersion);
      if (!updated) throw new DomainError("NOT_FOUND", "需求不存在", 404);
      if (patch.currentStage && patch.currentStage !== existing.currentStage) {
        this.repo.addHistory({
          requirementId: id,
          fromStage: existing.currentStage,
          toStage: patch.currentStage,
          actor: this.actorName(),
          note: stageNote ?? "",
          createdAt: new Date().toISOString(),
        });
      }
      this.repo.audit(id, "update", parsed);
      this.projectEvent(existing.projectId, "requirement_updated", id);
      return updated;
    });
  }
  remove(id: number, expectedVersion?: number) {
    this.transaction(() => {
      const existing = this.get(id);
      assertRequirementAccess(this.db, id, "edit");
      if (existing.projectId !== null || expectedVersion !== undefined)
        assertProjectVersion(existing.version, expectedVersion, existing);
      if (this.repo.children(id).length)
        throw new DomainError("CONFLICT", "存在有效子需求，无法删除", 409);
      this.repo.softDelete(id, expectedVersion);
      // 需求为软删除，外键级联不会触发；会议关联必须显式清理，避免留下悬空记录。
      this.db
        .prepare("DELETE FROM meeting_requirements WHERE requirement_id = ?")
        .run(id);
      // 优化点关联同样显式清理：保留优化点原始内容与「已转正式需求」状态，
      // 只断开关联并标记失效，允许用户在优化点详情中重新转换。
      this.db
        .prepare(
          "UPDATE optimization_points SET requirement_id = NULL, updated_at = ? WHERE requirement_id = ?",
        )
        .run(new Date().toISOString(), id);
      this.repo.audit(id, "delete", {});
      this.projectEvent(existing.projectId, "requirement_deleted", id);
    });
  }
  references(ids: number[]): RequirementReferenceState[] {
    if (!ids.length) return [];
    const rows = this.repo.references(ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => {
      const row = byId.get(id);
      return row && !row.deletedAt
        ? {
            id,
            requirementNo: row.requirementNo,
            name: row.name,
            exists: true,
          }
        : { id, requirementNo: null, name: null, exists: false };
    });
  }
  history(id: number) {
    this.get(id);
    return this.repo.history(id);
  }
  relations(id: number) {
    const item = this.get(id);
    return {
      parent:
        item.parentId === null ? null : (this.repo.get(item.parentId) ?? null),
      children: this.repo.children(id),
    };
  }
  private checkParent(parentId: number | null, id?: number) {
    if (parentId === null) return;
    const parent = this.get(parentId);
    if (
      parent.parentId !== null ||
      parent.id === id ||
      (id && this.repo.children(id).length)
    ) {
      throw new DomainError(
        "CONFLICT",
        "仅支持两级需求，父需求必须为主需求",
        409,
      );
    }
  }
  private actorName() {
    const userId = currentUserScope()?.userId;
    if (!userId) return "system";
    const user = this.db
      .prepare("SELECT display_name,username FROM users WHERE id=?")
      .get(userId) as { display_name: string; username: string } | undefined;
    return user?.display_name || user?.username || "unknown";
  }
  private checkResponsibilities(
    projectId: number | null,
    assignee: number | null,
    developer: number | null,
  ) {
    for (const userId of [assignee, developer]) {
      if (userId === null) continue;
      if (projectId === null) {
        if (userId !== currentUserScope()?.userId)
          throw new DomainError("CONFLICT", "私人需求不能分配给其他账号", 409);
      } else if (
        !projectRolesFor(this.db, projectId, userId).some(
          (role) => role !== "viewer",
        )
      )
        throw new DomainError(
          "CONFLICT",
          "需求责任人必须为有效且非只读的项目成员",
          409,
        );
    }
  }
  private projectEvent(
    projectId: number | null,
    action: string,
    requirementId: number,
  ) {
    if (projectId === null) return;
    this.db
      .prepare(
        "INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        projectId,
        action,
        currentUserScope()?.userId ?? null,
        this.actorName(),
        JSON.stringify({ requirementId }),
        new Date().toISOString(),
      );
  }
  private transaction<T>(fn: () => T) {
    return this.db.transaction(fn).immediate();
  }
}
