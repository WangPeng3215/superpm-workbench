import type Database from "better-sqlite3";
import {
  issueAssetLinkSchema,
  issueCommentSchema,
  issueCreateSchema,
  issueUpdateSchema,
  type Issue,
  type IssueActivity,
  type IssueAssetLink,
  type IssueAssetListResult,
  type IssueDetail,
  type IssueListResult,
  type IssueStatus,
} from "@superpm/shared";
import { DomainError, RequirementService } from "./requirements.js";

interface LinkRow {
  issue_id: number;
  artifact_id: number;
  relation_type: IssueAssetLink["relationType"];
  // 别名避免与产出物表的 created_at 同名冲突
  link_created_at: string;
  // artifact_nodes 投影列
  node_id: number;
  node_type: IssueAssetLink["asset"]["nodeType"];
  node_name: string;
  node_relative_path: string;
}

interface IssueRow {
  id: number;
  requirement_id: number;
  phase: Issue["phase"];
  issue_key: string | null;
  title: string;
  description: string;
  description_html: string;
  issue_type: Issue["issueType"];
  status: IssueStatus;
  solution: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  is_deleted: number;
}
interface ActivityRow {
  id: number;
  issue_id: number;
  activity_type: IssueActivity["activityType"];
  content: string;
  old_status: IssueStatus | null;
  new_status: IssueStatus | null;
  actor_type: IssueActivity["actorType"];
  actor_name: string | null;
  created_at: string;
}
function toIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    phase: row.phase,
    issueKey: row.issue_key,
    title: row.title,
    description: row.description,
    descriptionHtml: row.description_html,
    issueType: row.issue_type,
    status: row.status,
    solution: row.solution,
    isDeleted: row.is_deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}
function toActivity(row: ActivityRow): IssueActivity {
  return {
    id: row.id,
    issueId: row.issue_id,
    activityType: row.activity_type,
    content: row.content,
    oldStatus: row.old_status,
    newStatus: row.new_status,
    actorType: row.actor_type,
    actorName: row.actor_name,
    createdAt: row.created_at,
  };
}
const LOCAL_ACTOR = { actorType: "user" as const, actorName: "local-user" };
export class IssueService {
  constructor(
    private db: Database.Database,
    private requirements: RequirementService,
  ) {}
  list(requirementId: number, phase?: string, status?: string): IssueListResult {
    this.requirements.get(requirementId);
    const conditions = ["requirement_id=? AND is_deleted=0"];
    const params: (string | number)[] = [requirementId];
    if (phase) {
      conditions.push("phase=?");
      params.push(phase);
    }
    if (status) {
      conditions.push("status=?");
      params.push(status);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM issues WHERE ${conditions.join(" AND ")} ORDER BY id DESC`,
      )
      .all(...params) as IssueRow[];
    return { items: rows.map(toIssue), total: rows.length };
  }
  detail(requirementId: number, issueId: number): IssueDetail {
    const issue = this.row(requirementId, issueId);
    const activities = (
      this.db
        .prepare(
          "SELECT * FROM issue_activities WHERE issue_id=? ORDER BY id ASC",
        )
        .all(issueId) as ActivityRow[]
    ).map(toActivity);
    return { ...issue, activities };
  }
  create(requirementId: number, input: unknown) {
    this.requirements.get(requirementId);
    const data = issueCreateSchema.parse(input);
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          "INSERT INTO issues(requirement_id, phase, title, description, description_html, issue_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)",
        )
        .run(
          requirementId,
          data.phase,
          data.title,
          data.description,
          data.descriptionHtml,
          data.issueType ?? null,
          now,
          now,
        );
      const issueId = Number(result.lastInsertRowid);
      // 创建即写入一条系统记录，保证时间线完整（统一约定）
      this.db
        .prepare(
          "INSERT INTO issue_activities(issue_id, activity_type, content, actor_type, actor_name, created_at) VALUES (?, 'system', ?, ?, ?, ?)",
        )
        .run(issueId, "创建问题", "system", "local-user", now);
      return this.row(requirementId, issueId);
    })();
  }
  update(requirementId: number, issueId: number, input: unknown) {
    const issue = this.row(requirementId, issueId);
    const patch = issueUpdateSchema.parse(input);
    const now = new Date().toISOString();
    // 解决时必须具备解决说明：本次提交的 solution 或已存在的 solution
    if (patch.status === "resolved") {
      const solution = patch.solution ?? issue.solution;
      if (!solution?.trim())
        throw new DomainError(
          "VALIDATION_ERROR",
          "标记为已解决前请先填写解决说明",
        );
    }
    return this.db.transaction(() => {
      // solution 变更：更新快照列并追加一条 solution 历史
      if (patch.solution !== undefined && patch.solution !== issue.solution) {
        this.db
          .prepare("UPDATE issues SET solution=?, updated_at=? WHERE id=?")
          .run(patch.solution, now, issueId);
        this.db
          .prepare(
            "INSERT INTO issue_activities(issue_id, activity_type, content, actor_type, actor_name, created_at) VALUES (?, 'solution', ?, ?, ?, ?)",
          )
          .run(issueId, patch.solution, LOCAL_ACTOR.actorType, LOCAL_ACTOR.actorName, now);
      }
      // 状态变更：更新状态与时间戳列并追加 status_change 历史；重新打开时清空解决时间
      if (patch.status && patch.status !== issue.status) {
        const resolvedAt =
          patch.status === "resolved"
            ? now
            : patch.status === "open"
              ? null
              : issue.resolvedAt;
        this.db
          .prepare("UPDATE issues SET status=?, updated_at=?, resolved_at=? WHERE id=?")
          .run(patch.status, now, resolvedAt, issueId);
        this.db
          .prepare(
            "INSERT INTO issue_activities(issue_id, activity_type, content, old_status, new_status, actor_type, actor_name, created_at) VALUES (?, 'status_change', '', ?, ?, ?, ?, ?)",
          )
          .run(
            issueId,
            issue.status,
            patch.status,
            LOCAL_ACTOR.actorType,
            LOCAL_ACTOR.actorName,
            now,
          );
      }
      // 其余字段直接更新（标题/描述/类型不进历史时间线）；
      // description_html 仅在取值变化时写入，避免自动保存的空转覆盖
      const descHtmlChanged =
        patch.descriptionHtml !== undefined &&
        patch.descriptionHtml !== issue.descriptionHtml;
      if (
        patch.title !== undefined ||
        patch.description !== undefined ||
        patch.issueType !== undefined ||
        descHtmlChanged
      )
        this.db
          .prepare(
            "UPDATE issues SET title=?, description=?, description_html=?, issue_type=?, updated_at=? WHERE id=?",
          )
          .run(
            patch.title ?? issue.title,
            patch.description ?? issue.description,
            descHtmlChanged ? patch.descriptionHtml! : issue.descriptionHtml,
            patch.issueType === undefined ? issue.issueType : patch.issueType,
            now,
            issueId,
          );
      return this.row(requirementId, issueId);
    })();
  }
  comment(requirementId: number, issueId: number, input: unknown) {
    this.row(requirementId, issueId);
    const { content } = issueCommentSchema.parse(input);
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO issue_activities(issue_id, activity_type, content, actor_type, actor_name, created_at) VALUES (?, 'comment', ?, ?, ?, ?)",
      )
      .run(issueId, content, LOCAL_ACTOR.actorType, LOCAL_ACTOR.actorName, now);
    this.db
      .prepare("UPDATE issues SET updated_at=? WHERE id=?")
      .run(now, issueId);
    return this.detail(requirementId, issueId);
  }
  remove(requirementId: number, issueId: number) {
    // 软删除：仅标记索引行；问题与产出物的关联行随之清理
    this.row(requirementId, issueId);
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE issues SET is_deleted=1, updated_at=? WHERE id=?")
        .run(new Date().toISOString(), issueId);
      this.db
        .prepare("DELETE FROM issue_artifact_links WHERE issue_id=?")
        .run(issueId);
    })();
  }
  // 关联列表：join artifact_nodes 投影名称/类型/相对路径（节点硬删除后关联行级联清理，天然无悬空）
  listAssets(requirementId: number, issueId: number): IssueAssetListResult {
    this.row(requirementId, issueId);
    const rows = this.db
      .prepare(
        "SELECT link.issue_id, link.artifact_id AS asset_id, link.relation_type, link.created_at AS link_created_at, node.id AS node_id, node.node_type AS node_type, node.name AS node_name, node.relative_path AS node_relative_path FROM issue_artifact_links AS link JOIN artifact_nodes AS node ON node.id = link.artifact_id WHERE link.issue_id=? ORDER BY link.created_at DESC, link.artifact_id DESC",
      )
      .all(issueId) as LinkRow[];
    const items: IssueAssetLink[] = rows.map((row) => ({
      issueId: row.issue_id,
      assetId: row.artifact_id,
      relationType: row.relation_type,
      createdAt: row.link_created_at,
      asset: {
        id: row.node_id,
        nodeType: row.node_type,
        name: row.node_name,
        relativePath: row.node_relative_path,
      },
    }));
    return { items, total: items.length };
  }
  // 建立关联：问题与 artifact 节点必须同属一个需求；重复关联被拒绝；文件夹与文件均可
  linkAsset(requirementId: number, issueId: number, input: unknown) {
    const issue = this.row(requirementId, issueId);
    const data = issueAssetLinkSchema.parse(input);
    const node = this.db
      .prepare(
        "SELECT id, node_type, name, relative_path FROM artifact_nodes WHERE id=? AND requirement_id=?",
      )
      .get(data.assetId, requirementId) as
      | { id: number; node_type: IssueAssetLink["asset"]["nodeType"]; name: string; relative_path: string }
      | undefined;
    if (!node)
      throw new DomainError("NOT_FOUND", "产出物不存在或不属于该需求", 404);
    const existing = this.db
      .prepare(
        "SELECT 1 FROM issue_artifact_links WHERE issue_id=? AND artifact_id=?",
      )
      .get(issueId, data.assetId);
    if (existing)
      throw new DomainError("CONFLICT", "该产出物已与当前问题关联", 409);
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO issue_artifact_links(issue_id, artifact_id, relation_type, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(issueId, data.assetId, data.relationType, now);
    return {
      issueId,
      assetId: data.assetId,
      relationType: data.relationType,
      createdAt: now,
      // 关联建立时问题与资源同需求；跨阶段/跨目录引用合理，不限制节点层级
      asset: {
        id: node.id,
        nodeType: node.node_type,
        name: node.name,
        relativePath: node.relative_path,
      },
    } satisfies IssueAssetLink;
  }
  // 取消关联：仅移除关联行，绝不触碰产出物本体与物理文件
  unlinkAsset(requirementId: number, issueId: number, assetId: number) {
    this.row(requirementId, issueId);
    const result = this.db
      .prepare(
        "DELETE FROM issue_artifact_links WHERE issue_id=? AND artifact_id=?",
      )
      .run(issueId, assetId);
    if (result.changes === 0)
      throw new DomainError("NOT_FOUND", "关联关系不存在", 404);
  }
  private row(requirementId: number, issueId: number) {
    this.requirements.get(requirementId);
    const row = this.db
      .prepare("SELECT * FROM issues WHERE id=? AND is_deleted=0")
      .get(issueId) as IssueRow | undefined;
    if (!row || row.requirement_id !== requirementId)
      throw new DomainError("NOT_FOUND", "问题不存在", 404);
    return toIssue(row);
  }
}
