import type Database from "better-sqlite3";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentUserScope } from "../db/scope.js";
import { assertRequirementAccess } from "./requirement-access.js";
import { assertResourceVersion, contentVersion } from "./requirement-files.js";
import {
  issueAssetLinkSchema,
  issueCommentSchema,
  issueCreateSchema,
  issueStages,
  issueStatuses,
  issueUpdateSchema,
  type Issue,
  type IssueActivity,
  type IssueAssetLink,
  type IssueAssetListResult,
  type IssueDetail,
  type IssueListResult,
  type IssueStage,
  type IssueStats,
  type IssueStatus,
  type IssueType,
} from "@superpm/shared";
import { DomainError, RequirementService } from "./requirements.js";
import { RequirementDirectoryResolver } from "./requirement-directory.js";

// 正文保存端点的入参校验（与通用更新分离：正文只写 md 文件，不进数据库列）
const issueDescriptionSaveSchema = z
  .object({
    content: z.string().max(200000),
    expectedVersion: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export interface IssueListQuery {
  stage?: IssueStage;
  status?: IssueStatus;
  type?: IssueType;
  // 标题 + 描述关键词（描述存于 md 文件，读取后在服务层过滤）
  q?: string;
  // 未指定 limit 时返回全部匹配项（HTTP 界面保持原行为）；MCP 显式分页
  limit?: number;
  offset?: number;
}

interface LinkRow {
  issue_id: number;
  // SELECT 里以 asset_id 别名输出（避免与产出物表的 id 混淆）
  asset_id: number;
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
  version: number;
  requirement_id: number;
  stage: Issue["stage"];
  issue_key: string | null;
  title: string;
  issue_type: Issue["type"];
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
function toIssue(row: IssueRow, description: string): Issue {
  return {
    id: row.id,
    version: row.version,
    requirementId: row.requirement_id,
    stage: row.stage,
    issueKey: row.issue_key,
    title: row.title,
    description,
    type: row.issue_type,
    status: row.status,
    solution: row.solution ?? "",
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
function emptyStatusCounts(): Record<IssueStatus, number> {
  return Object.fromEntries(
    issueStatuses.map((status) => [status, 0]),
  ) as Record<IssueStatus, number>;
}
export interface IssueActor {
  actorType: "user" | "ai" | "system";
  actorName: string;
}
const LOCAL_ACTOR: IssueActor = {
  actorType: "user",
  actorName: "local-user",
};

// 问题正文 md 文件路径：需求根目录下 issues/{id}.md（迁移 0009 起正文的唯一权威存储）。
// 需求根目录由 RequirementDirectoryResolver 统一解析（可读目录名 + 路径安全）。
function issueDescriptionFile(
  resolver: RequirementDirectoryResolver,
  requirementId: number,
  issueId: number,
  create: boolean,
): string | null {
  if (create)
    return join(
      resolver.resolve(requirementId, "issues", true, "contribute"),
      `${issueId}.md`,
    );
  // 读取不得隐式建目录或补映射：目录未初始化时按"无正文"处理
  const directory = resolver.tryResolveReadOnly(requirementId, "issues");
  return directory === null ? null : join(directory, `${issueId}.md`);
}

export class IssueService {
  private readonly directories?: RequirementDirectoryResolver;
  constructor(
    private db: Database.Database,
    private requirements: RequirementService,
    // 工作区根目录：正文 md 文件存放位置；未提供时正文读写退化为空串/跳过（仅测试场景）
    private workspacePath?: string,
    directories?: RequirementDirectoryResolver,
  ) {
    this.directories =
      directories ??
      (workspacePath
        ? new RequirementDirectoryResolver(db, workspacePath)
        : undefined);
  }
  list(requirementId: number, query: IssueListQuery = {}): IssueListResult {
    this.requirements.get(requirementId);
    const conditions = ["requirement_id=? AND is_deleted=0"];
    const params: (string | number)[] = [requirementId];
    if (query.stage) {
      conditions.push("stage=?");
      params.push(query.stage);
    }
    if (query.type) {
      conditions.push("issue_type=?");
      params.push(query.type);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM issues WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC, id DESC`,
      )
      .all(...params) as IssueRow[];
    const keyword = query.q?.trim().toLowerCase() ?? "";
    const matched = rows
      .map((row) =>
        toIssue(row, this.readDescription(row.requirement_id, row.id)),
      )
      .filter(
        (issue) =>
          !keyword ||
          issue.title.toLowerCase().includes(keyword) ||
          issue.description.toLowerCase().includes(keyword),
      );
    // 计数只按关键词/类型/阶段过滤，不受状态筛选影响
    const statusCounts = emptyStatusCounts();
    for (const issue of matched) statusCounts[issue.status] += 1;
    const filtered = query.status
      ? matched.filter((issue) => issue.status === query.status)
      : matched;
    const offset = Math.max(0, query.offset ?? 0);
    const items =
      query.limit === undefined
        ? filtered
        : filtered.slice(offset, offset + query.limit);
    return {
      items,
      total: filtered.length,
      statusCounts,
      limit: query.limit ?? null,
      offset,
      hasMore:
        query.limit !== undefined && offset + items.length < filtered.length,
    };
  }

  /** 问题统计（只读，不读取正文）：进度快照与 MCP 使用 */
  stats(requirementId: number): IssueStats {
    this.requirements.get(requirementId);
    const statusCounts = emptyStatusCounts();
    const byStage = Object.fromEntries(
      issueStages.map((stage) => [stage, 0]),
    ) as Record<IssueStage, number>;
    const rows = this.db
      .prepare(
        "SELECT status, stage, COUNT(*) AS total FROM issues WHERE requirement_id=? AND is_deleted=0 GROUP BY status, stage",
      )
      .all(requirementId) as {
      status: IssueStatus;
      stage: IssueStage;
      total: number;
    }[];
    let total = 0;
    for (const row of rows) {
      total += row.total;
      statusCounts[row.status] += row.total;
      byStage[row.stage] += row.total;
    }
    return {
      total,
      open:
        statusCounts.pending +
        statusCounts.to_confirm +
        statusCounts.processing,
      resolved: statusCounts.resolved,
      wontFix: statusCounts.wont_fix,
      statusCounts,
      byStage,
    };
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
    return this.db
      .transaction(() => {
        assertRequirementAccess(this.db, requirementId, "contribute");
        const requirement = this.requirements.get(requirementId);
        const data = issueCreateSchema.parse(input);
        const now = new Date().toISOString();
        return this.db.transaction(() => {
          const result = this.db
            .prepare(
              "INSERT INTO issues(user_id, requirement_id, stage, title, issue_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
            )
            .run(
              currentUserScope()?.userId ?? 0,
              requirementId,
              data.stage ?? requirement.currentStage,
              data.title,
              data.type ?? null,
              now,
              now,
            );
          const issueId = Number(result.lastInsertRowid);
          // 正文直接落盘为 md 文件；写盘失败随事务回滚，不产生半成品问题
          this.writeDescription(requirementId, issueId, data.description);
          // 创建即写入一条系统记录，保证时间线完整（统一约定）
          this.db
            .prepare(
              "INSERT INTO issue_activities(user_id, issue_id, activity_type, content, actor_type, actor_name, created_at) VALUES (?, ?, 'system', ?, ?, ?, ?)",
            )
            .run(
              currentUserScope()?.userId ?? 0,
              issueId,
              "创建问题",
              "system",
              this.trustedActor(requirementId, LOCAL_ACTOR).actorName,
              now,
            );
          return this.row(requirementId, issueId);
        })();
      })
      .immediate();
  }
  update(
    requirementId: number,
    issueId: number,
    input: unknown,
    actor: IssueActor = LOCAL_ACTOR,
  ) {
    return this.db
      .transaction(() => {
        assertRequirementAccess(this.db, requirementId, "edit");
        const trustedActor = this.trustedActor(requirementId, actor);
        const issue = this.row(requirementId, issueId);
        const patch = issueUpdateSchema.parse(input);
        assertResourceVersion(
          this.db,
          requirementId,
          issue.version,
          patch.expectedVersion,
          issue,
        );
        const nextSolution = patch.solution ?? issue.solution;
        // 「已解决」必须有正式结论；暂不处理不要求解决说明
        if (patch.status === "resolved" && !nextSolution.trim())
          throw new DomainError(
            "VALIDATION_ERROR",
            "请先填写解决方案/最终结论，再将问题标记为已解决",
            400,
          );
        const now = new Date().toISOString();
        return this.db.transaction(() => {
          // solution 变更：更新快照列并追加一条 solution 历史
          if (
            patch.solution !== undefined &&
            patch.solution !== issue.solution
          ) {
            this.db
              .prepare(
                "INSERT INTO issue_activities(user_id, issue_id, activity_type, content, actor_type, actor_name, created_at) VALUES (?, ?, 'solution', ?, ?, ?, ?)",
              )
              .run(
                currentUserScope()?.userId ?? 0,
                issueId,
                patch.solution,
                trustedActor.actorType,
                trustedActor.actorName,
                now,
              );
          }
          // 状态变更：只允许在已解决时保留解决时间，离开已解决即清空
          const nextStatus = patch.status ?? issue.status;
          if (patch.status && patch.status !== issue.status) {
            this.db
              .prepare(
                "INSERT INTO issue_activities(user_id, issue_id, activity_type, content, old_status, new_status, actor_type, actor_name, created_at) VALUES (?, ?, 'status_change', '', ?, ?, ?, ?, ?)",
              )
              .run(
                currentUserScope()?.userId ?? 0,
                issueId,
                issue.status,
                patch.status,
                trustedActor.actorType,
                trustedActor.actorName,
                now,
              );
          }
          const resolvedAt =
            nextStatus === "resolved"
              ? issue.status === "resolved"
                ? (issue.resolvedAt ?? now)
                : now
              : null;
          // 标题/类型/阶段/状态/方案一次写回；描述单独落盘为 md 文件
          this.db
            .prepare(
              "UPDATE issues SET title=?, stage=?, issue_type=?, status=?, solution=?, resolved_at=?, version=version+1, updated_at=? WHERE id=?",
            )
            .run(
              patch.title ?? issue.title,
              patch.stage ?? issue.stage,
              patch.type === undefined ? issue.type : patch.type,
              nextStatus,
              nextSolution || null,
              resolvedAt,
              now,
              issueId,
            );
          if (
            patch.description !== undefined &&
            patch.description !== issue.description
          )
            this.writeDescription(requirementId, issueId, patch.description);
          return this.row(requirementId, issueId);
        })();
      })
      .immediate();
  }
  // 正文直读：返回 md 文件原始内容（缺失视为空串）
  getDescription(requirementId: number, issueId: number) {
    const issue = this.row(requirementId, issueId);
    return {
      content: issue.description,
      version: contentVersion(issue.description),
    };
  }
  // 正文直写：保存 md 文件并刷新 updated_at
  saveDescription(requirementId: number, issueId: number, input: unknown) {
    return this.db
      .transaction(() => {
        assertRequirementAccess(this.db, requirementId, "edit");
        const issue = this.row(requirementId, issueId);
        const { content, expectedVersion } =
          issueDescriptionSaveSchema.parse(input);
        assertResourceVersion(
          this.db,
          requirementId,
          contentVersion(issue.description),
          expectedVersion,
          { content: issue.description },
        );
        const now = new Date().toISOString();
        return this.db.transaction(() => {
          this.db
            .prepare(
              "UPDATE issues SET version=version+1, updated_at=? WHERE id=?",
            )
            .run(now, issueId);
          this.writeDescription(requirementId, issueId, content);
          return { updatedAt: now, version: contentVersion(content) };
        })();
      })
      .immediate();
  }
  comment(
    requirementId: number,
    issueId: number,
    input: unknown,
    actor: IssueActor = LOCAL_ACTOR,
    idempotencyKey?: string,
  ) {
    const requirement = assertRequirementAccess(
      this.db,
      requirementId,
      "contribute",
    );
    const { content } = issueCommentSchema.parse(input);
    if (requirement.project_id !== null && !idempotencyKey?.trim())
      throw new DomainError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "共享讨论必须提供 Idempotency-Key",
        400,
      );
    if (
      idempotencyKey &&
      (idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey))
    )
      throw new DomainError("VALIDATION_ERROR", "Idempotency-Key 无效", 400);
    return this.db
      .transaction(() => {
        assertRequirementAccess(this.db, requirementId, "contribute");
        this.row(requirementId, issueId);
        const userId = currentUserScope()?.userId ?? 0;
        const command = "issue.comment";
        const requestHash = contentVersion(
          JSON.stringify({ requirementId, issueId, content }),
        );
        const useCommand =
          requirement.project_id !== null && idempotencyKey !== undefined;
        if (useCommand) {
          const previous = this.db
            .prepare(
              "SELECT request_hash FROM project_commands WHERE actor_user_id=? AND command=? AND idempotency_key=?",
            )
            .get(userId, command, idempotencyKey) as
            { request_hash: string } | undefined;
          if (previous) {
            if (previous.request_hash !== requestHash)
              throw new DomainError(
                "IDEMPOTENCY_CONFLICT",
                "同一幂等键不能用于不同讨论",
                409,
              );
            return this.detail(requirementId, issueId);
          }
        }
        const now = new Date().toISOString();
        const trustedActor = this.trustedActor(requirementId, actor);
        const result = this.db
          .prepare(
            "INSERT INTO issue_activities(user_id, issue_id, activity_type, content, actor_type, actor_name, created_at) VALUES (?, ?, 'comment', ?, ?, ?, ?)",
          )
          .run(
            userId,
            issueId,
            content,
            trustedActor.actorType,
            trustedActor.actorName,
            now,
          );
        this.db
          .prepare("UPDATE issues SET updated_at=? WHERE id=?")
          .run(now, issueId);
        if (useCommand)
          this.db
            .prepare(
              "INSERT INTO project_commands(project_id,actor_user_id,command,idempotency_key,request_hash,response,created_at) VALUES (?,?,?,?,?,?,?)",
            )
            .run(
              requirement.project_id,
              userId,
              command,
              idempotencyKey,
              requestHash,
              JSON.stringify({ activityId: Number(result.lastInsertRowid) }),
              now,
            );
        return this.detail(requirementId, issueId);
      })
      .immediate();
  }
  remove(requirementId: number, issueId: number, expectedVersion?: number) {
    return this.db
      .transaction(() => {
        assertRequirementAccess(this.db, requirementId, "edit");
        const issue = this.row(requirementId, issueId);
        assertResourceVersion(
          this.db,
          requirementId,
          issue.version,
          expectedVersion,
          issue,
        );
        // 软删除：仅标记索引行；问题与产出物的关联行随之清理（md 文件与 images/ 图片保留）
        this.row(requirementId, issueId);
        this.db.transaction(() => {
          this.db
            .prepare(
              "UPDATE issues SET is_deleted=1, version=version+1, updated_at=? WHERE id=?",
            )
            .run(new Date().toISOString(), issueId);
          this.db
            .prepare("DELETE FROM issue_artifact_links WHERE issue_id=?")
            .run(issueId);
        })();
      })
      .immediate();
  }
  // 关联列表：join artifact_nodes 投影名称/类型/相对路径（节点硬删除后关联行级联清理，天然无悬空）
  listAssets(requirementId: number, issueId: number): IssueAssetListResult {
    this.row(requirementId, issueId);

    const rows = this.db
      .prepare(
        `SELECT link.issue_id, link.artifact_id AS asset_id, link.relation_type, link.created_at AS link_created_at, node.id AS node_id, node.node_type AS node_type, node.name AS node_name, node.relative_path AS node_relative_path FROM issue_artifact_links AS link JOIN artifact_nodes AS node ON node.id = link.artifact_id WHERE link.issue_id=? AND node.requirement_id=? ORDER BY link.created_at DESC, link.artifact_id DESC`,
      )
      .all(issueId, requirementId) as LinkRow[];
    const items = rows.map((row) => ({
      issueId: row.issue_id,
      assetId: row.asset_id,
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
    return this.db
      .transaction(() => {
        assertRequirementAccess(this.db, requirementId, "contribute");
        this.row(requirementId, issueId);
        const data = issueAssetLinkSchema.parse(input);
        const node = this.db
          .prepare(
            "SELECT id, node_type, name, relative_path FROM artifact_nodes WHERE id=? AND requirement_id=?",
          )
          .get(data.assetId, requirementId) as
          | {
              id: number;
              node_type: IssueAssetLink["asset"]["nodeType"];
              name: string;
              relative_path: string;
            }
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
            "INSERT INTO issue_artifact_links(user_id, issue_id, artifact_id, relation_type, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            currentUserScope()?.userId ?? 0,
            issueId,
            data.assetId,
            data.relationType,
            now,
          );
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
      })
      .immediate();
  }
  // 取消关联：仅移除关联行，绝不触碰产出物本体与物理文件
  unlinkAsset(requirementId: number, issueId: number, assetId: number) {
    return this.db
      .transaction(() => {
        assertRequirementAccess(this.db, requirementId, "contribute");
        this.row(requirementId, issueId);
        const result = this.db
          .prepare(
            "DELETE FROM issue_artifact_links WHERE issue_id=? AND artifact_id=?",
          )
          .run(issueId, assetId);
        if (result.changes === 0)
          throw new DomainError("NOT_FOUND", "关联关系不存在", 404);
      })
      .immediate();
  }
  // 读取正文 md 文件；工作区未配置或文件缺失时返回空串（只读，不建目录）
  private readDescription(requirementId: number, issueId: number): string {
    if (!this.directories) return "";
    const file = issueDescriptionFile(
      this.directories,
      requirementId,
      issueId,
      false,
    );
    return file && existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  private writeDescription(
    requirementId: number,
    issueId: number,
    content: string,
  ) {
    if (!this.directories) return;
    const file = issueDescriptionFile(
      this.directories,
      requirementId,
      issueId,
      true,
    );
    if (!file) return;
    writeFileSync(file, content, "utf8");
  }
  private trustedActor(requirementId: number, actor: IssueActor): IssueActor {
    if (assertRequirementAccess(this.db, requirementId).project_id === null)
      return actor;
    const userId = currentUserScope()?.userId;
    const user = this.db
      .prepare("SELECT display_name FROM users WHERE id=?")
      .get(userId) as { display_name: string } | undefined;
    if (!user) throw new DomainError("NOT_FOUND", "操作者不存在", 404);
    return { actorType: "user", actorName: user.display_name };
  }
  private row(requirementId: number, issueId: number) {
    this.requirements.get(requirementId);
    const row = this.db
      .prepare("SELECT * FROM issues WHERE id=? AND is_deleted=0")
      .get(issueId) as IssueRow | undefined;
    if (!row || row.requirement_id !== requirementId)
      throw new DomainError("NOT_FOUND", "问题不存在", 404);
    return toIssue(row, this.readDescription(requirementId, issueId));
  }
}
