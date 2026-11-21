import type Database from "better-sqlite3";
import { currentUserScope } from "../db/scope.js";
import { DomainError } from "./domain-error.js";
import { assertProjectAccess } from "./project-access.js";
import { isUntrustedToolContext } from "./access-context.js";
export type RequirementAction =
  "read" | "edit" | "contribute" | "artifact_write" | "artifact_manage";
export interface RequirementAccessRow {
  id: number;
  user_id: number;
  project_id: number | null;
  current_stage: string;
  assignee_user_id: number | null;
  developer_user_id: number | null;
  version: number;
  parent_id: number | null;
  [key: string]: unknown;
}
/** For private-subject joins: authorize only the requirement summary, never the subject. */
export function requirementVisibilitySql(alias = "r"): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid SQL alias");
  const scope = currentUserScope();
  if (!scope || isUntrustedToolContext()) return alias + ".project_id IS NULL";
  if (scope.isAdmin) return "1=1";
  if (!Number.isSafeInteger(scope.userId) || scope.userId <= 0) return "0=1";
  const id = scope.userId;
  return `((${alias}.project_id IS NULL AND ${alias}.user_id=${id}) OR (${alias}.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM project_members vrm JOIN users vru ON vru.id=vrm.user_id WHERE vrm.project_id=${alias}.project_id AND vrm.user_id=${id} AND vrm.status='active' AND vru.status='active')))`;
}
export function assertRequirementAccess(
  db: Database.Database,
  id: number,
  action: RequirementAction = "read",
): RequirementAccessRow {
  const row = db
    .prepare("SELECT * FROM requirements WHERE id=? AND deleted_at IS NULL")
    .get(id) as RequirementAccessRow | undefined;
  if (!row) throw new DomainError("NOT_FOUND", "需求不存在", 404);
  const scope = currentUserScope();
  if (row.project_id === null) {
    if (scope && !scope.isAdmin && row.user_id !== scope.userId)
      throw new DomainError("NOT_FOUND", "需求不存在", 404);
    return row;
  }
  if (!scope || isUntrustedToolContext())
    throw new DomainError("NOT_FOUND", "需求不存在", 404);
  const { roles, project } = assertProjectAccess(db, row.project_id);
  if (action === "read") return row;
  const manager = roles.includes("owner") || roles.includes("product_owner");
  const contributor = roles.includes("contributor");
  const permitted =
    manager ||
    (action === "contribute" && contributor) ||
    (action === "artifact_write" &&
      contributor &&
      (row.assignee_user_id === scope.userId ||
        row.developer_user_id === scope.userId));
  if (!permitted)
    throw new DomainError("FORBIDDEN", "当前项目角色不允许修改该需求资源", 403);
  if (project.archived_at || ["closed", "cancelled"].includes(project.status))
    throw new DomainError("PROJECT_READ_ONLY", "项目当前为只读状态", 409);
  return row;
}
