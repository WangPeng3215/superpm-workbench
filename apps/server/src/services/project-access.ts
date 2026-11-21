import type Database from "better-sqlite3";
import type { ProjectCapabilities, ProjectRole } from "@superpm/shared";
import { currentUserScope } from "../db/scope.js";
import { DomainError } from "./domain-error.js";
import { isUntrustedToolContext } from "./access-context.js";

export interface ProjectAccessRow {
  id: number;
  status: string;
  archived_at: string | null;
  version: number;
  owner_user_id: number;
  product_owner_user_id: number;
}
export type ProjectAction =
  "read" | "edit" | "members" | "requirements" | "archive" | "lifecycle";
export function currentActor(db: Database.Database) {
  const scope = currentUserScope();
  if (!scope || isUntrustedToolContext())
    throw new DomainError("UNAUTHORIZED", "项目操作需要可信账号身份", 401);
  const user = db
    .prepare("SELECT id, username, display_name, status FROM users WHERE id=?")
    .get(scope.userId) as
    | { id: number; username: string; display_name: string; status: string }
    | undefined;
  if (!user || user.status !== "active")
    throw new DomainError("UNAUTHORIZED", "账号已失效", 401);
  return { ...user, isAdmin: scope.isAdmin };
}
export function projectRolesFor(
  db: Database.Database,
  projectId: number,
  userId: number,
): ProjectRole[] {
  return (
    db
      .prepare(
        `SELECT r.role FROM project_member_roles r JOIN project_members m ON m.project_id=r.project_id AND m.user_id=r.user_id JOIN users u ON u.id=m.user_id WHERE r.project_id=? AND r.user_id=? AND m.status='active' AND u.status='active' ORDER BY r.role`,
      )
      .all(projectId, userId) as { role: ProjectRole }[]
  ).map((x) => x.role);
}
export function capabilitiesFor(
  roles: ProjectRole[],
  readonly = false,
): ProjectCapabilities {
  const owner = !readonly && roles.includes("owner");
  const product = !readonly && (owner || roles.includes("product_owner"));
  return {
    canEditProject: owner,
    canManageMembers: owner,
    canManageRequirements: product,
    canManageProjectTasks: owner,
    canPrepareDelivery: product,
    canConfirmScope: owner,
    canCloseProject: owner,
  };
}
export function assertProjectAccess(
  db: Database.Database,
  projectId: number,
  action: ProjectAction = "read",
  allowReadonly = false,
) {
  const scope = currentUserScope();
  if (!scope || isUntrustedToolContext())
    throw new DomainError("NOT_FOUND", "项目不存在", 404);
  const actor = currentActor(db);
  const row = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as
    ProjectAccessRow | undefined;
  const roles = projectRolesFor(db, projectId, actor.id);
  if (!row || (!roles.length && !actor.isAdmin))
    throw new DomainError("NOT_FOUND", "项目不存在", 404);
  if (action === "read") return { project: row, roles, actor };
  const permitted =
    action === "requirements"
      ? roles.some((r) => r === "owner" || r === "product_owner")
      : roles.includes("owner");
  if (!permitted)
    throw new DomainError("FORBIDDEN", "当前项目角色不允许此操作", 403);
  if (
    !allowReadonly &&
    (row.archived_at || ["closed", "cancelled"].includes(row.status))
  )
    throw new DomainError("PROJECT_READ_ONLY", "项目当前为只读状态", 409);
  return { project: row, roles, actor };
}
export function assertProjectVersion(
  actual: number,
  expected: number | undefined,
  current: unknown,
) {
  if (expected === undefined)
    throw new DomainError("VERSION_REQUIRED", "请携带最新版本后保存", 428);
  if (actual !== expected)
    throw new DomainError(
      "VERSION_CONFLICT",
      "内容已被其他成员更新，请核对后重试",
      409,
      { current },
    );
}
