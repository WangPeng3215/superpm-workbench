import {
  integer,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import type {
  IssueType,
  Requirement,
  RequirementFile,
  Stage,
} from "@superpm/shared";
export const requirements = sqliteTable("requirements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requirementNo: text("requirement_no").notNull().unique(),
  name: text("name").notNull(),
  type: text("type").$type<Requirement["type"]>().notNull(),
  priority: text("priority").$type<Requirement["priority"]>().notNull(),
  description: text("description").notNull(),
  descriptionHtml: text("description_html").notNull().default(""),
  status: text("status").$type<Requirement["status"]>().notNull(),
  currentStage: text("current_stage").$type<Stage>().notNull(),
  parentId: integer("parent_id").references(
    (): AnySQLiteColumn => requirements.id,
  ),
  proposedAt: text("proposed_at").notNull(),
  expectedAt: text("expected_at"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  plannedReleaseAt: text("planned_release_at"),
  releasedAt: text("released_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
});
export const stageHistory = sqliteTable("requirement_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requirementId: integer("requirement_id")
    .notNull()
    .references(() => requirements.id),
  fromStage: text("from_stage").$type<Stage>().notNull(),
  toStage: text("to_stage").$type<Stage>().notNull(),
  actor: text("actor").notNull(),
  note: text("note").notNull(),
  createdAt: text("created_at").notNull(),
});
export const requirementFiles = sqliteTable("requirement_files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requirementId: integer("requirement_id")
    .notNull()
    .references(() => requirements.id),
  phase: text("phase").$type<Stage>().notNull(),
  category: text("category").$type<RequirementFile["category"]>().notNull(),
  name: text("name").notNull(),
  fileName: text("file_name").notNull(),
  // 过渡列：语义已由 resource_type/status 承接，阶段 9 清理迁移中移除
  kind: text("kind").notNull().default("file"),
  linkUrl: text("link_url"),
  isFinal: integer("is_final", { mode: "boolean" }).notNull().default(false),
  resourceType: text("resource_type")
    .$type<"file" | "link" | "text">()
    .notNull()
    .default("file"),
  storageType: text("storage_type")
    .$type<"local" | "database" | "external">()
    .notNull()
    .default("local"),
  relativePath: text("relative_path"),
  textContent: text("text_content"),
  mimeType: text("mime_type"),
  // 数据库列名为 description；JS 标识符加前缀避免与需求表同名概念混淆
  assetDescription: text("description"),
  // 数据库列名为 status（与 requirements.status 无冲突，分属不同表）
  assetStatus: text("status")
    .$type<"draft" | "final" | "archived" | "missing">()
    .notNull()
    .default("draft"),
  isDeleted: integer("is_deleted", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
// 问题表：stage 为产生阶段，四阶段均可记录
export const issues = sqliteTable("issues", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requirementId: integer("requirement_id")
    .notNull()
    .references(() => requirements.id),
  stage: text("stage").$type<Stage>().notNull(),
  issueKey: text("issue_key"),
  title: text("title").notNull(),
  // 描述列：迁移 0009 起正文唯一权威存储为工作区 md 文件（requirements/{rid}/issues/{id}.md），两列仅存量兼容
  description: text("description").notNull().default(""),
  descriptionHtml: text("description_html").notNull().default(""),
  issueType: text("issue_type").$type<IssueType>(),
  // 库内列默认值仍为历史值 'open'（SQLite 低成本改默认需重建表），业务层写入始终显式指定状态
  status: text("status")
    .$type<"pending" | "to_confirm" | "processing" | "resolved" | "wont_fix">()
    .notNull()
    .default("pending"),
  solution: text("solution"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  resolvedAt: text("resolved_at"),
  // closed 状态已退役；closed_at 列仅为存量兼容保留，不再写入
  closedAt: text("closed_at"),
  isDeleted: integer("is_deleted", { mode: "boolean" })
    .notNull()
    .default(false),
});
// 问题处理记录：追加式历史，禁止更新/删除
export const issueActivities = sqliteTable("issue_activities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  issueId: integer("issue_id")
    .notNull()
    .references(() => issues.id),
  activityType: text("activity_type")
    .$type<"comment" | "solution" | "status_change" | "system">()
    .notNull(),
  content: text("content").notNull().default(""),
  oldStatus: text("old_status"),
  newStatus: text("new_status"),
  actorType: text("actor_type").$type<"user" | "ai" | "system">(),
  actorName: text("actor_name"),
  createdAt: text("created_at").notNull(),
});
// 问题与产出物关联：同问题同产出物唯一，删除实体仅清索引行不碰物理文件
export const issueAssets = sqliteTable("issue_assets", {
  issueId: integer("issue_id")
    .notNull()
    .references(() => issues.id),
  assetId: integer("asset_id")
    .notNull()
    .references(() => requirementFiles.id),
  relationType: text("relation_type")
    .$type<"evidence" | "solution_material" | "reference" | "other">()
    .notNull()
    .default("reference"),
  createdAt: text("created_at").notNull(),
});
// 问题与知识库节点关联（迁移 0008）：issue_assets 的替代表，文件夹与文件均可关联；
// artifact_nodes 为硬删除，节点移除时关联行级联清理
export const issueArtifactLinks = sqliteTable("issue_artifact_links", {
  issueId: integer("issue_id")
    .notNull()
    .references(() => issues.id),
  artifactId: integer("artifact_id")
    .notNull()
    .references(() => artifactNodes.id),
  relationType: text("relation_type")
    .$type<"evidence" | "solution_material" | "reference" | "other">()
    .notNull()
    .default("reference"),
  createdAt: text("created_at").notNull(),
});
// 本地登录用户：密码用 scrypt 派生密钥存储，盐值独立成列
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
// 应用级元数据：认证签名密钥等键值对
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
// 需求知识库：文件/目录索引（迁移 0007）；磁盘是文件存在性的依据，本表只存元数据
export const artifactNodes = sqliteTable("artifact_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requirementId: integer("requirement_id")
    .notNull()
    .references(() => requirements.id),
  // 空 = 挂在需求根目录
  parentId: integer("parent_id").references(
    (): AnySQLiteColumn => artifactNodes.id,
  ),
  nodeType: text("node_type").$type<"folder" | "file">().notNull(),
  name: text("name").notNull(),
  // 相对需求根目录、正斜杠分隔；(requirement_id, relative_path) 唯一
  relativePath: text("relative_path").notNull(),
  extension: text("extension"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  modifiedAt: text("modified_at"),
  indexedAt: text("indexed_at").notNull(),
  contentHash: text("content_hash"),
  status: text("status")
    .$type<"normal" | "missing" | "external_changed" | "conflict">()
    .notNull()
    .default("normal"),
  isFinal: integer("is_final", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
// 需求知识库：外部链接（迁移 0007）；只存 SQLite 记录，不在磁盘创建同名文件
export const artifactLinks = sqliteTable("artifact_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requirementId: integer("requirement_id")
    .notNull()
    .references(() => requirements.id),
  folderNodeId: integer("folder_node_id").references(() => artifactNodes.id),
  name: text("name").notNull(),
  url: text("url").notNull(),
  description: text("description"),
  isFinal: integer("is_final", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const requirementAudit = sqliteTable("requirement_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requirementId: integer("requirement_id")
    .notNull()
    .references(() => requirements.id),
  action: text("action").notNull(),
  payload: text("payload").notNull(),
  createdAt: text("created_at").notNull(),
});
// M3 受控写入：一次性确认令牌（只存哈希）与追加式审计。
export const mcpWriteConfirmations = sqliteTable("mcp_write_confirmations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  tool: text("tool").notNull(),
  requirementId: integer("requirement_id").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  paramsHash: text("params_hash").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull(),
});
export const mcpAudit = sqliteTable("mcp_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tool: text("tool").notNull(),
  requirementId: integer("requirement_id"),
  targetType: text("target_type"),
  targetId: text("target_id"),
  paramsHash: text("params_hash").notNull(),
  idempotencyKey: text("idempotency_key").unique(),
  confirmationId: integer("confirmation_id").references(
    () => mcpWriteConfirmations.id,
  ),
  actorName: text("actor_name"),
  outcome: text("outcome").$type<"prepared" | "success" | "error">().notNull(),
  errorCode: text("error_code"),
  resultSummary: text("result_summary"),
  createdAt: text("created_at").notNull(),
});
