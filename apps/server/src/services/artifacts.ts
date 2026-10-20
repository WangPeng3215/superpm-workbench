import type Database from "better-sqlite3";
import {
  artifactContentSaveSchema,
  artifactFileCreateSchema,
  artifactFolderCreateSchema,
  artifactLinkCreateSchema,
  artifactLinkUpdateSchema,
  artifactMemoryName,
  artifactMoveSchema,
  artifactRefreshSchema,
  artifactRenameSchema,
  isSafeExternalUrl,
  isValidArtifactName,
  requirementMemoryTemplate,
  type ArtifactBreadcrumbItem,
  type ArtifactDirectory,
  type ArtifactLink,
  type ArtifactNode,
  type ArtifactNodeDetails,
  type ArtifactNodeType,
  type ArtifactRefreshResult,
  type ArtifactStatus,
} from "@superpm/shared";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { DomainError, RequirementService } from "./requirements.js";
import { allowSystemOpen } from "../config/index.js";
import { MIME_BY_EXTENSION } from "./requirement-files.js";

// 文件/目录索引行（snake_case，与迁移 0007 列名一致）
export interface ArtifactNodeRow {
  id: number;
  requirement_id: number;
  parent_id: number | null;
  node_type: ArtifactNodeType;
  name: string;
  relative_path: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  modified_at: string | null;
  indexed_at: string;
  content_hash: string | null;
  status: ArtifactStatus;
  created_at: string;
  updated_at: string;
}
export interface ArtifactLinkRow {
  id: number;
  requirement_id: number;
  folder_node_id: number | null;
  name: string;
  url: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}
function toNode(row: ArtifactNodeRow): ArtifactNode {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    parentId: row.parent_id,
    nodeType: row.node_type,
    name: row.name,
    relativePath: row.relative_path,
    extension: row.extension,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function toLink(row: ArtifactLinkRow): ArtifactLink {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    folderNodeId: row.folder_node_id,
    name: row.name,
    url: row.url,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function extensionOf(name: string): string | null {
  const extension = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : null;
}

/**
 * 需求知识库服务（开发文档第 5/6 章）：文件与目录索引 + 外部链接 + 需求记忆。
 * UI 与未来 MCP 共用本服务；磁盘操作成功后才更新索引，路径安全与旧文件服务同一套防护。
 * 索引与磁盘无法共用事务：磁盘先行，索引更新失败时可通过 refreshDirectory 重新扫描修复。
 */
export class ArtifactService {
  constructor(
    private db: Database.Database,
    private root: string,
    private requirements: RequirementService,
  ) {}

  // ===== 查询 =====

  /** 列出目录内容（含进入目录时的轻量磁盘检查）；q 非空时按名称做全需求范围搜索 */
  listNodes(
    requirementId: number,
    parentId: number | null,
    q = "",
  ): ArtifactDirectory {
    const keyword = q.trim();
    if (keyword) return this.searchNodes(requirementId, keyword);
    const parent = this.requireParent(requirementId, parentId);
    const parentPath = parent ? parent.relativePath : "";
    // 轻量检查：对比当前目录的磁盘与索引（缺失标记、外部修改提示、新条目拾取）
    this.lightCheck(requirementId, parent, parentPath);
    const rows = this.rowsOf(requirementId, parentId);
    const childCounts = new Map<number, number>();
    for (const row of this.db
      .prepare(
        "SELECT parent_id, COUNT(*) AS total FROM artifact_nodes WHERE requirement_id=? AND parent_id IS NOT NULL GROUP BY parent_id",
      )
      .all(requirementId) as { parent_id: number; total: number }[]) {
      childCounts.set(row.parent_id, row.total);
    }
    const folders = rows
      .filter((row) => row.node_type === "folder")
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
      .map(toNode);
    for (const folder of folders)
      folder.childCount = childCounts.get(folder.id) ?? 0;
    const files = rows
      .filter((row) => row.node_type === "file")
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
      .map(toNode);
    const links = this.linksOf(requirementId, parentId)
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
      .map(toLink);
    return {
      requirementId,
      parentId,
      parentPath,
      breadcrumb: this.breadcrumbFrom(requirementId, parentId),
      folders,
      files,
      links,
      search: "",
    };
  }

  /** 节点详情：路径链 + 子树规模（供删除影响范围提示与详情展示） */
  getNodeDetails(nodeId: number): ArtifactNodeDetails {
    const row = this.nodeRow(nodeId);
    const node = toNode(row);
    const descendantCount =
      node.nodeType === "folder"
        ? this.descendantsOf(node.requirementId, node.relativePath).length
        : 0;
    return {
      node,
      breadcrumb: this.breadcrumbFrom(node.requirementId, node.parentId),
      descendantCount,
    };
  }

  // ===== 新建 =====

  createFolder(requirementId: number, input: unknown): ArtifactNode {
    const data = artifactFolderCreateSchema.parse(input);
    const name = this.assertNodeName(data.name);
    const parent = this.requireParent(requirementId, data.parentId);
    this.assertParentOnDisk(parent);
    const relativePath = this.childPath(parent, name);
    const target = this.resolvePath(requirementId, relativePath, false);
    this.assertNoSibling(requirementId, data.parentId, name);
    // 先磁盘后索引：目标已存在时拒绝，避免索引与磁盘状态分叉
    if (existsSync(target))
      throw new DomainError("CONFLICT", "磁盘上已存在同名文件或目录", 409);
    mkdirSync(target);
    return this.insertNode(requirementId, data.parentId, "folder", name, relativePath, {
      modifiedAt: statSync(target).mtime.toISOString(),
    });
  }

  createFile(requirementId: number, input: unknown): ArtifactNode {
    const data = artifactFileCreateSchema.parse(input);
    const name = this.assertNodeName(data.name);
    const parent = this.requireParent(requirementId, data.parentId);
    this.assertParentOnDisk(parent);
    const relativePath = this.childPath(parent, name);
    const target = this.resolvePath(requirementId, relativePath, false);
    this.assertNoSibling(requirementId, data.parentId, name);
    if (existsSync(target))
      throw new DomainError("CONFLICT", "磁盘上已存在同名文件或目录", 409);
    // 文件类型不设白名单：任意扩展名都真实落盘（空文件或带初始文本）
    const content = data.initialContent ?? "";
    writeFileSync(target, content, { flag: "wx", encoding: "utf8" });
    const stat = statSync(target);
    const extension = extensionOf(name);
    return this.insertNode(requirementId, data.parentId, "file", name, relativePath, {
      extension,
      mimeType: extension ? (MIME_BY_EXTENSION[extension.slice(1)] ?? null) : null,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      contentHash: this.hashOf(content),
    });
  }

  // ===== 重命名 / 移动 / 删除 =====

  renameNode(nodeId: number, input: unknown): ArtifactNode {
    const data = artifactRenameSchema.parse(input);
    const name = this.assertNodeName(data.name);
    const node = toNode(this.nodeRow(nodeId));
    this.assertMutable(node, "重命名");
    if (node.name === name) return node;
    const parent = this.requireParent(node.requirementId, node.parentId);
    this.assertParentOnDisk(parent);
    this.assertNoSibling(node.requirementId, node.parentId, name, node.id);
    const nextPath = this.childPath(parent, name);
    const currentAbs = this.resolvePath(node.requirementId, node.relativePath, false);
    const nextAbs = this.resolvePath(node.requirementId, nextPath, false);
    if (!existsSync(currentAbs))
      throw new DomainError("NOT_FOUND", "磁盘上找不到原文件或目录", 404);
    if (existsSync(nextAbs))
      throw new DomainError("CONFLICT", "磁盘上已存在同名文件或目录", 409);
    // 先磁盘后索引；磁盘失败时保留旧元数据并抛出明确错误
    renameSync(currentAbs, nextAbs);
    return this.db.transaction(() => {
      const extension = node.nodeType === "file" ? extensionOf(name) : null;
      this.db
        .prepare(
          "UPDATE artifact_nodes SET name=?, relative_path=?, extension=?, updated_at=? WHERE id=?",
        )
        .run(name, nextPath, extension, new Date().toISOString(), node.id);
      this.repathDescendants(node.requirementId, node.relativePath, nextPath);
      return toNode(this.nodeRow(node.id));
    })();
  }

  moveNode(nodeId: number, input: unknown): ArtifactNode {
    const data = artifactMoveSchema.parse(input);
    const node = toNode(this.nodeRow(nodeId));
    this.assertMutable(node, "移动");
    if (data.targetParentId === node.parentId) return node;
    const target = this.requireParent(node.requirementId, data.targetParentId);
    this.assertParentOnDisk(target);
    // 循环移动：目标不能是自身，也不能位于自身子树内
    if (target) {
      if (target.id === node.id)
        throw new DomainError("CONFLICT", "不能将目录移动到自身内部", 409);
      if (this.ancestorIds(target).has(node.id))
        throw new DomainError("CONFLICT", "不能将目录移动到其子目录内", 409);
    }
    this.assertNoSibling(node.requirementId, data.targetParentId, node.name, node.id);
    const nextPath = this.childPath(target, node.name);
    const currentAbs = this.resolvePath(node.requirementId, node.relativePath, false);
    const nextAbs = this.resolvePath(node.requirementId, nextPath, false);
    if (!existsSync(currentAbs))
      throw new DomainError("NOT_FOUND", "磁盘上找不到原文件或目录", 404);
    if (existsSync(nextAbs))
      throw new DomainError("CONFLICT", "目标磁盘位置已存在同名文件或目录", 409);
    renameSync(currentAbs, nextAbs);
    return this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE artifact_nodes SET parent_id=?, relative_path=?, updated_at=? WHERE id=?",
        )
        .run(data.targetParentId, nextPath, new Date().toISOString(), node.id);
      this.repathDescendants(node.requirementId, node.relativePath, nextPath);
      return toNode(this.nodeRow(node.id));
    })();
  }

  deleteNode(nodeId: number, recursive: boolean): void {
    const node = toNode(this.nodeRow(nodeId));
    // 需求记忆文件不可通过普通删除移除（文档 5）
    this.assertMutable(node, "删除");
    const all = this.db
      .prepare("SELECT * FROM artifact_nodes WHERE requirement_id=?")
      .all(node.requirementId) as ArtifactNodeRow[];
    const descendants = this.filterDescendants(all, node.relativePath);
    if (node.nodeType === "folder" && !recursive) {
      const directChildren = all.filter((item) => item.parent_id === node.id).length;
      const links = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS total FROM artifact_links WHERE requirement_id=? AND folder_node_id=?",
          )
          .get(node.requirementId, node.id) as { total: number }
      ).total;
      if (directChildren + links > 0) {
        const total = descendants.length + links;
        throw new DomainError(
          "CONFLICT",
          `目录非空，包含 ${total} 个子项（含子目录与文件），请确认后递归删除`,
          409,
        );
      }
    }
    const target = this.resolvePath(node.requirementId, node.relativePath, false);
    if (existsSync(target)) rmSync(target, { recursive: true });
    // 磁盘删除成功后清理索引：后代节点与被删目录内的链接记录
    this.db.transaction(() => {
      const doomed = [node.id, ...descendants.map((item) => item.id)];
      const placeholders = doomed.map(() => "?").join(",");
      this.db
        .prepare(
          `DELETE FROM artifact_links WHERE requirement_id=? AND folder_node_id IN (${placeholders})`,
        )
        .run(node.requirementId, ...doomed);
      this.db
        .prepare(`DELETE FROM artifact_nodes WHERE id IN (${placeholders})`)
        .run(...doomed);
    })();
  }

  // ===== 内容读写（编辑器 / raw）=====

  /** 读取文本内容（Markdown 编辑器等）：磁盘缺失时标记 missing 并返回 404 */
  readText(nodeId: number): { node: ArtifactNode; content: string } {
    const node = toNode(this.nodeRow(nodeId));
    if (node.nodeType !== "file")
      throw new DomainError("VALIDATION_ERROR", "目录节点没有文件内容");
    const path = this.resolvePath(node.requirementId, node.relativePath, false);
    this.assertOnDisk(node, path);
    const stat = statSync(path);
    return {
      node: this.syncMetadata(node, stat.size, stat.mtime.toISOString(), null),
      content: readFileSync(path, "utf8"),
    };
  }

  /** 写入文本内容：磁盘修改时间与索引不一致（外部修改）时不静默覆盖，需 force 显式确认 */
  saveText(nodeId: number, input: unknown): ArtifactNode {
    const data = artifactContentSaveSchema.parse(input);
    const node = toNode(this.nodeRow(nodeId));
    if (node.nodeType !== "file")
      throw new DomainError("VALIDATION_ERROR", "目录节点没有文件内容");
    const path = this.resolvePath(node.requirementId, node.relativePath, false);
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink())
        throw new DomainError("INVALID_PATH", "文件不能是符号链接");
      const diskMtime = statSync(path).mtime.toISOString();
      if (!data.force && node.modifiedAt !== null && diskMtime !== node.modifiedAt)
        throw new DomainError(
          "FILE_CONFLICT",
          "文件已被外部程序修改，保存将覆盖外部修改；请确认后重试",
          409,
        );
    }
    writeFileSync(path, data.content, "utf8");
    const stat = statSync(path);
    return this.syncMetadata(
      node,
      stat.size,
      stat.mtime.toISOString(),
      this.hashOf(data.content),
    );
  }

  /** 二进制读取（图片预览 / PDF / 下载）：按扩展名推断 MIME */
  raw(nodeId: number): { data: Buffer; mime: string; fileName: string } {
    const node = toNode(this.nodeRow(nodeId));
    if (node.nodeType !== "file")
      throw new DomainError("VALIDATION_ERROR", "目录节点没有文件内容");
    const path = this.resolvePath(node.requirementId, node.relativePath, false);
    this.assertOnDisk(node, path);
    const extension = (node.extension ?? extensionOf(node.name) ?? "").slice(1);
    return {
      data: readFileSync(path),
      mime:
        node.mimeType?.split(";")[0] ??
        MIME_BY_EXTENSION[extension] ??
        "application/octet-stream",
      fileName: node.name,
    };
  }

  /** 本地默认程序打开：总开关关闭时拒绝（与旧体系同一机制） */
  openSystem(nodeId: number): void {
    if (!allowSystemOpen)
      throw new DomainError(
        "FORBIDDEN",
        "本地程序打开功能未启用（需设置 SUPERPM_ALLOW_SYSTEM_OPEN=1）",
        403,
      );
    const node = toNode(this.nodeRow(nodeId));
    if (node.nodeType !== "file")
      throw new DomainError("VALIDATION_ERROR", "目录不支持本地程序打开");
    const path = this.resolvePath(node.requirementId, node.relativePath, false);
    this.assertOnDisk(node, path);
    // Windows 用 start，macOS 用 open，其余走 xdg-open；detached 避免阻塞请求
    const command =
      process.platform === "win32"
        ? ["cmd", "/c", "start", "", path]
        : process.platform === "darwin"
          ? ["open", path]
          : ["xdg-open", path];
    const child = spawn(command[0], command.slice(1), {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  // ===== 刷新与外部修改（文档 5）=====

  /** 递归扫描目录（默认需求根目录）：新增拾取、外部删除标记 missing、外部修改刷新元数据并标记 */
  refreshDirectory(
    requirementId: number,
    input: unknown = {},
  ): ArtifactRefreshResult {
    const data = artifactRefreshSchema.parse(input);
    this.ensureMemory(requirementId);
    const relativePath = (data.relativePath ?? "").replace(/^\/+|\/+$/g, "");
    if (relativePath.split("/").some((segment) => segment === ".." || segment === "."))
      throw new DomainError("INVALID_PATH", "路径包含非法段");
    const all = this.db
      .prepare("SELECT * FROM artifact_nodes WHERE requirement_id=?")
      .all(requirementId) as ArtifactNodeRow[];
    const byPath = new Map(all.map((row) => [row.relative_path, row]));
    const prefix = relativePath ? `${relativePath}/` : "";
    const scoped = relativePath
      ? all.filter((row) => row.relative_path.startsWith(prefix))
      : all;
    const rootAbs = this.resolvePath(requirementId, relativePath, false);
    const now = new Date().toISOString();
    // 目录本体在磁盘缺失：索引子树全部标记 missing，等待用户清理或恢复
    if (!existsSync(rootAbs)) {
      let missing = 0;
      for (const row of scoped) {
        if (row.status !== "missing") {
          this.db
            .prepare("UPDATE artifact_nodes SET status='missing', updated_at=? WHERE id=?")
            .run(now, row.id);
          missing += 1;
        }
      }
      return { added: 0, updated: 0, missing };
    }
    // 刷新目标目录若未登记（或登记类型不对），先补建为目录节点
    let rootParentId: number | null = null;
    if (relativePath) {
      const existing = byPath.get(relativePath);
      if (existing && existing.node_type === "folder") {
        rootParentId = existing.id;
      } else if (!existing) {
        const parentRow = byPath.get(
          relativePath.slice(0, relativePath.lastIndexOf("/")),
        );
        rootParentId = this.insertNodeRow(
          requirementId,
          parentRow?.id ?? null,
          "folder",
          relativePath.split("/").pop() ?? relativePath,
          relativePath,
          statSync(rootAbs).mtime.toISOString(),
        );
      } else {
        throw new DomainError("INVALID_PATH", "刷新目标必须是目录");
      }
    }
    let added = 0;
    let updated = 0;
    let missing = 0;
    const seen = new Set<string>();
    const walk = (dirAbs: string, relPrefix: string, parentId: number | null) => {
      for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
        // 不跟随、不登记符号链接
        if (entry.isSymbolicLink()) continue;
        const rel = relPrefix + entry.name;
        seen.add(rel);
        const abs = join(dirAbs, entry.name);
        const existing = byPath.get(rel);
        if (entry.isDirectory()) {
          let folderId = existing?.id;
          if (!existing) {
            folderId = this.insertNodeRow(
              requirementId,
              parentId,
              "folder",
              entry.name,
              rel,
              statSync(abs).mtime.toISOString(),
            );
            added += 1;
          } else if (existing.status === "missing") {
            this.db
              .prepare(
                "UPDATE artifact_nodes SET status='normal', updated_at=? WHERE id=?",
              )
              .run(now, existing.id);
          }
          walk(abs, `${rel}/`, folderId ?? null);
        } else if (entry.isFile()) {
          const stat = statSync(abs);
          const modifiedAt = stat.mtime.toISOString();
          if (!existing) {
            const extension = extensionOf(entry.name);
            this.insertNodeRow(
              requirementId,
              parentId,
              "file",
              entry.name,
              rel,
              modifiedAt,
              {
                extension,
                mimeType: extension
                  ? (MIME_BY_EXTENSION[extension.slice(1)] ?? null)
                  : null,
                sizeBytes: stat.size,
                contentHash: this.hashOf(readFileSync(abs)),
              },
            );
            added += 1;
          } else {
            const changed =
              existing.size_bytes !== stat.size || existing.modified_at !== modifiedAt;
            if (changed || existing.status === "missing") {
              this.db
                .prepare(
                  "UPDATE artifact_nodes SET size_bytes=?, modified_at=?, status=?, updated_at=? WHERE id=?",
                )
                .run(
                  stat.size,
                  modifiedAt,
                  changed ? "external_changed" : "normal",
                  now,
                  existing.id,
                );
              updated += 1;
            }
          }
        }
      }
    };
    walk(rootAbs, prefix, rootParentId);
    // 索引中存在但磁盘缺失的子树：标记 missing（不删行，由用户决定清理或恢复）
    for (const row of scoped) {
      if (!seen.has(row.relative_path) && row.status !== "missing") {
        this.db
          .prepare("UPDATE artifact_nodes SET status='missing', updated_at=? WHERE id=?")
          .run(now, row.id);
        missing += 1;
      }
    }
    return { added, updated, missing };
  }

  // ===== 外部链接 =====

  createLink(requirementId: number, input: unknown): ArtifactLink {
    const data = artifactLinkCreateSchema.parse(input);
    // 外部链接默认仅允许 http/https（文档 3），删除只影响本地记录
    if (!isSafeExternalUrl(data.url) || /^ftp:/i.test(data.url))
      throw new DomainError(
        "VALIDATION_ERROR",
        "链接仅支持 http:// 或 https:// 开头的地址",
      );
    this.requireParent(requirementId, data.folderNodeId);
    const name = this.assertNodeName(data.name);
    this.assertNoSibling(requirementId, data.folderNodeId, name);
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO artifact_links(requirement_id, folder_node_id, name, url, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        requirementId,
        data.folderNodeId,
        name,
        data.url,
        data.description ?? null,
        now,
        now,
      );
    return toLink(this.linkRow(Number(result.lastInsertRowid)));
  }

  updateLink(linkId: number, input: unknown): ArtifactLink {
    const data = artifactLinkUpdateSchema.parse(input);
    const link = toLink(this.linkRow(linkId));
    if (data.url !== undefined && (!isSafeExternalUrl(data.url) || /^ftp:/i.test(data.url)))
      throw new DomainError(
        "VALIDATION_ERROR",
        "链接仅支持 http:// 或 https:// 开头的地址",
      );
    const name = data.name === undefined ? link.name : this.assertNodeName(data.name);
    const folderNodeId =
      data.folderNodeId === undefined ? link.folderNodeId : data.folderNodeId;
    if (folderNodeId !== link.folderNodeId)
      this.requireParent(link.requirementId, folderNodeId);
    if (name !== link.name || folderNodeId !== link.folderNodeId)
      this.assertNoSibling(link.requirementId, folderNodeId, name, undefined, link.id);
    this.db
      .prepare(
        "UPDATE artifact_links SET folder_node_id=?, name=?, url=?, description=?, updated_at=? WHERE id=?",
      )
      .run(
        folderNodeId,
        name,
        data.url ?? link.url,
        data.description === undefined ? link.description : data.description,
        new Date().toISOString(),
        link.id,
      );
    return toLink(this.linkRow(link.id));
  }

  deleteLink(linkId: number): void {
    // 只删除本地记录，不影响外部资源
    this.linkRow(linkId);
    this.db.prepare("DELETE FROM artifact_links WHERE id=?").run(linkId);
  }

  // ===== 需求记忆（文档 4.3）=====

  /** 读取需求记忆节点；文件或索引缺失时按模板补建（存量需求懒初始化，新建需求即时初始化） */
  ensureMemory(requirementId: number): ArtifactNode {
    const requirement = this.requirements.get(requirementId);
    const existing = this.db
      .prepare(
        "SELECT * FROM artifact_nodes WHERE requirement_id=? AND relative_path=?",
      )
      .get(requirementId, artifactMemoryName) as ArtifactNodeRow | undefined;
    const rootAbs = this.resolvePath(requirementId, "", true);
    const fileAbs = join(rootAbs, artifactMemoryName);
    const template = requirementMemoryTemplate(requirement.name);
    if (!existsSync(fileAbs)) {
      // 磁盘缺失（含首建）：写模板文件；索引缺失时一并补建，索引存在时恢复元数据
      writeFileSync(fileAbs, template, "utf8");
      const stat = statSync(fileAbs);
      if (existing) {
        return this.syncMetadata(
          toNode(existing),
          stat.size,
          stat.mtime.toISOString(),
          this.hashOf(template),
        );
      }
      return this.insertNode(
        requirementId,
        null,
        "file",
        artifactMemoryName,
        artifactMemoryName,
        {
          extension: ".md",
          mimeType: "text/markdown; charset=utf-8",
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          contentHash: this.hashOf(template),
        },
      );
    }
    if (!existing) {
      // 磁盘已有文件但索引缺失（外部放置或历史数据）：登记
      const stat = statSync(fileAbs);
      return this.insertNode(
        requirementId,
        null,
        "file",
        artifactMemoryName,
        artifactMemoryName,
        {
          extension: ".md",
          mimeType: "text/markdown; charset=utf-8",
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          contentHash: this.hashOf(readFileSync(fileAbs)),
        },
      );
    }
    return toNode(existing);
  }

  /** 刷新需求记忆：外部修改后重新登记大小与修改时间（文件缺失时补建） */
  refreshMemory(requirementId: number): ArtifactNode {
    const node = this.ensureMemory(requirementId);
    const fileAbs = this.resolvePath(requirementId, artifactMemoryName, false);
    if (!existsSync(fileAbs)) return this.ensureMemory(requirementId);
    const stat = statSync(fileAbs);
    return this.syncMetadata(
      node,
      stat.size,
      stat.mtime.toISOString(),
      this.hashOf(readFileSync(fileAbs)),
    );
  }

  // ===== 内部工具：路径安全与索引维护 =====

  // 逐级解析需求内相对路径：拒绝越界、非法段与符号链接（与旧文件服务同一套防护）。
  // create=false 时不落盘建目录（用于"目标必须不存在"或只读解析），存在性由调用方判定
  private resolvePath(
    requirementId: number,
    relativePath: string,
    create: boolean,
  ): string {
    this.requirements.get(requirementId);
    const root = realpathSync(this.root);
    const segments = ["requirements", String(requirementId)];
    if (relativePath) {
      for (const segment of relativePath.split("/")) {
        if (!segment || segment === "." || segment === "..")
          throw new DomainError("INVALID_PATH", "路径包含非法段");
        segments.push(segment);
      }
    }
    let current = root;
    for (const segment of segments) {
      current = join(current, segment);
      if (!existsSync(current)) {
        if (!create) continue;
        mkdirSync(current);
      }
      if (lstatSync(current).isSymbolicLink())
        throw new DomainError("INVALID_PATH", "路径不能包含符号链接");
      const resolved = realpathSync(current);
      const distance = relative(root, resolved);
      if (distance.startsWith("..") || isAbsolute(distance))
        throw new DomainError("INVALID_PATH", "路径越界");
    }
    return current;
  }

  private assertNodeName(name: string): string {
    if (!isValidArtifactName(name))
      throw new DomainError(
        "VALIDATION_ERROR",
        "名称不能为空，不能包含 \\ / : * ? \" < > | 等字符，不能含连续点，且不能以点或空格结尾",
      );
    return name.trim();
  }

  private childPath(parent: ArtifactNode | null, name: string): string {
    return parent ? `${parent.relativePath}/${name}` : name;
  }

  // 目标父目录：null 为需求根；否则必须是同一需求下的目录节点
  private requireParent(
    requirementId: number,
    parentId: number | null,
  ): ArtifactNode | null {
    this.requirements.get(requirementId);
    if (parentId === null) return null;
    const row = this.nodeRow(parentId);
    if (row.requirement_id !== requirementId)
      throw new DomainError("NOT_FOUND", "父目录不存在", 404);
    if (row.node_type !== "folder")
      throw new DomainError("VALIDATION_ERROR", "父目标必须是文件夹");
    return toNode(row);
  }

  // 父目录在磁盘缺失（外部删除后）时不允许在其下新建或移入，避免"凭空恢复"
  private assertParentOnDisk(parent: ArtifactNode | null) {
    if (!parent) return;
    const parentAbs = this.resolvePath(parent.requirementId, parent.relativePath, false);
    if (!existsSync(parentAbs) || lstatSync(parentAbs).isSymbolicLink())
      throw new DomainError(
        "CONFLICT",
        "父目录在磁盘上已缺失，请先刷新目录树或恢复该目录",
        409,
      );
  }

  // 同级重名拒绝：文件夹/文件/链接共享命名空间，避免索引与磁盘歧义
  private assertNoSibling(
    requirementId: number,
    parentId: number | null,
    name: string,
    excludeNodeId?: number,
    excludeLinkId?: number,
  ) {
    const node = this.db
      .prepare(
        "SELECT id FROM artifact_nodes WHERE requirement_id=? AND parent_id IS ? AND name=? AND id != ?",
      )
      .get(requirementId, parentId, name, excludeNodeId ?? -1);
    if (node)
      throw new DomainError("CONFLICT", "同级已存在同名文件或文件夹", 409);
    const link = this.db
      .prepare(
        "SELECT id FROM artifact_links WHERE requirement_id=? AND folder_node_id IS ? AND name=? AND id != ?",
      )
      .get(requirementId, parentId, name, excludeLinkId ?? -1);
    if (link) throw new DomainError("CONFLICT", "同级已存在同名链接", 409);
  }

  // 需求记忆文件位置与名称固定：不可删、不可改名、不可移动（根目录保护的落点）
  private assertMutable(node: ArtifactNode, action: string) {
    if (node.relativePath === artifactMemoryName)
      throw new DomainError("CONFLICT", `需求记忆文件不可${action}`, 409);
  }

  private insertNode(
    requirementId: number,
    parentId: number | null,
    nodeType: ArtifactNodeType,
    name: string,
    relativePath: string,
    extra: {
      extension?: string | null;
      mimeType?: string | null;
      sizeBytes?: number | null;
      modifiedAt?: string | null;
      contentHash?: string | null;
    } = {},
  ): ArtifactNode {
    const id = this.insertNodeRow(
      requirementId,
      parentId,
      nodeType,
      name,
      relativePath,
      extra.modifiedAt ?? null,
      extra,
    );
    return toNode(this.nodeRow(id));
  }

  private insertNodeRow(
    requirementId: number,
    parentId: number | null,
    nodeType: ArtifactNodeType,
    name: string,
    relativePath: string,
    modifiedAt: string | null,
    extra: {
      extension?: string | null;
      mimeType?: string | null;
      sizeBytes?: number | null;
      contentHash?: string | null;
    } = {},
  ): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO artifact_nodes(requirement_id, parent_id, node_type, name, relative_path, extension, mime_type, size_bytes, modified_at, indexed_at, content_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?, ?)",
      )
      .run(
        requirementId,
        parentId,
        nodeType,
        name,
        relativePath,
        extra.extension ?? null,
        extra.mimeType ?? null,
        extra.sizeBytes ?? null,
        modifiedAt,
        now,
        extra.contentHash ?? null,
        now,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  private nodeRow(nodeId: number): ArtifactNodeRow {
    const row = this.db
      .prepare("SELECT * FROM artifact_nodes WHERE id=?")
      .get(nodeId) as ArtifactNodeRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "文件或目录不存在", 404);
    return row;
  }

  private linkRow(linkId: number): ArtifactLinkRow {
    const row = this.db
      .prepare("SELECT * FROM artifact_links WHERE id=?")
      .get(linkId) as ArtifactLinkRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "链接不存在", 404);
    return row;
  }

  private rowsOf(requirementId: number, parentId: number | null) {
    return this.db
      .prepare(
        "SELECT * FROM artifact_nodes WHERE requirement_id=? AND parent_id IS ?",
      )
      .all(requirementId, parentId) as ArtifactNodeRow[];
  }

  private linksOf(requirementId: number, parentId: number | null) {
    return this.db
      .prepare(
        "SELECT * FROM artifact_links WHERE requirement_id=? AND folder_node_id IS ?",
      )
      .all(requirementId, parentId) as ArtifactLinkRow[];
  }

  private breadcrumbFrom(
    requirementId: number,
    parentId: number | null,
  ): ArtifactBreadcrumbItem[] {
    const chain: ArtifactBreadcrumbItem[] = [];
    let cursor = parentId;
    // 深度上限仅防御脏数据成环；正常目录树远小于该值
    while (cursor !== null && chain.length < 64) {
      const row = this.nodeRow(cursor);
      chain.unshift({ id: row.id, name: row.name });
      cursor = row.parent_id;
    }
    return [{ id: null, name: this.requirements.get(requirementId).name }, ...chain];
  }

  private searchNodes(requirementId: number, keyword: string): ArtifactDirectory {
    this.requirements.get(requirementId);
    // LIKE 通配符转义：按名称做全需求范围搜索（文档 2.5 第一版仅承诺名称搜索）
    const escaped = keyword.replace(/[\\%_]/g, (char) => `\\${char}`);
    const pattern = `%${escaped}%`;
    const rows = (
      this.db
        .prepare(
          "SELECT * FROM artifact_nodes WHERE requirement_id=? AND name LIKE ? ESCAPE '\\' ORDER BY relative_path",
        )
        .all(requirementId, pattern) as ArtifactNodeRow[]
    ).map(toNode);
    const links = (
      this.db
        .prepare(
          "SELECT * FROM artifact_links WHERE requirement_id=? AND name LIKE ? ESCAPE '\\' ORDER BY name",
        )
        .all(requirementId, pattern) as ArtifactLinkRow[]
    ).map(toLink);
    return {
      requirementId,
      parentId: null,
      parentPath: "",
      breadcrumb: [
        { id: null, name: this.requirements.get(requirementId).name },
      ],
      folders: rows.filter((node) => node.nodeType === "folder"),
      files: rows.filter((node) => node.nodeType === "file"),
      links,
      search: keyword,
    };
  }

  // 进入目录时的轻量检查（单层，不递归）：缺失标记、外部修改提示、磁盘新条目拾取
  private lightCheck(
    requirementId: number,
    parent: ArtifactNode | null,
    parentPath: string,
  ) {
    const dirAbs = this.resolvePath(requirementId, parentPath, true);
    if (!existsSync(dirAbs)) return;
    const now = new Date().toISOString();
    const rows = this.rowsOf(requirementId, parent?.id ?? null);
    for (const row of rows) {
      const abs = join(dirAbs, row.name);
      if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) {
        if (row.status !== "missing") {
          this.db
            .prepare(
              "UPDATE artifact_nodes SET status='missing', updated_at=? WHERE id=?",
            )
            .run(now, row.id);
        }
        continue;
      }
      if (row.status === "missing") {
        // 磁盘恢复：登记最新元数据并恢复正常状态
        const stat = statSync(abs);
        this.db
          .prepare(
            "UPDATE artifact_nodes SET size_bytes=?, modified_at=?, status='normal', updated_at=? WHERE id=?",
          )
          .run(
            row.node_type === "file" ? stat.size : row.size_bytes,
            row.node_type === "file" ? stat.mtime.toISOString() : row.modified_at,
            now,
            row.id,
          );
        continue;
      }
      if (row.node_type === "file") {
        const stat = statSync(abs);
        const modifiedAt = stat.mtime.toISOString();
        if (row.size_bytes !== stat.size || row.modified_at !== modifiedAt) {
          // 外部修改：刷新元数据并标记，提示编辑器重读；保存需 force 确认
          this.db
            .prepare(
              "UPDATE artifact_nodes SET size_bytes=?, modified_at=?, status='external_changed', updated_at=? WHERE id=?",
            )
            .run(stat.size, modifiedAt, now, row.id);
        }
      }
    }
    // 磁盘上存在但索引缺失的条目：登记（磁盘是文件存在性的依据）
    const indexed = new Set(rows.map((row) => row.name));
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || indexed.has(entry.name)) continue;
      const rel = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const abs = join(dirAbs, entry.name);
      const stat = statSync(abs);
      const parentId = parent?.id ?? null;
      if (entry.isDirectory()) {
        this.insertNodeRow(
          requirementId,
          parentId,
          "folder",
          entry.name,
          rel,
          stat.mtime.toISOString(),
        );
      } else if (entry.isFile()) {
        const extension = extensionOf(entry.name);
        this.insertNodeRow(requirementId, parentId, "file", entry.name, rel, stat.mtime.toISOString(), {
          extension,
          mimeType: extension ? (MIME_BY_EXTENSION[extension.slice(1)] ?? null) : null,
          sizeBytes: stat.size,
          contentHash: this.hashOf(readFileSync(abs)),
        });
      }
    }
  }

  // 磁盘存在性检查：缺失时标记 missing（不删行），由刷新或用户决定恢复/清理
  private assertOnDisk(node: ArtifactNode, path: string) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
      if (node.status !== "missing") {
        this.db
          .prepare("UPDATE artifact_nodes SET status='missing', updated_at=? WHERE id=?")
          .run(new Date().toISOString(), node.id);
      }
      throw new DomainError("NOT_FOUND", "文件不存在或已被移动", 404);
    }
  }

  // 读写后同步元数据（size/mtime/哈希）；外部修改标记随落盘清为 normal；hash 传 null 保留原值
  private syncMetadata(
    node: ArtifactNode,
    sizeBytes: number,
    modifiedAt: string,
    contentHash: string | null,
  ): ArtifactNode {
    this.db
      .prepare(
        "UPDATE artifact_nodes SET size_bytes=?, modified_at=?, content_hash=COALESCE(?, content_hash), status='normal', updated_at=? WHERE id=?",
      )
      .run(sizeBytes, modifiedAt, contentHash, new Date().toISOString(), node.id);
    return toNode(this.nodeRow(node.id));
  }

  private repathDescendants(
    requirementId: number,
    oldPrefix: string,
    newPrefix: string,
  ) {
    const rows = this.db
      .prepare("SELECT * FROM artifact_nodes WHERE requirement_id=?")
      .all(requirementId) as ArtifactNodeRow[];
    const now = new Date().toISOString();
    for (const row of this.filterDescendants(rows, oldPrefix)) {
      // 前缀改写：后代路径 = 新前缀 + "/" + 旧前缀之后的剩余段
      const nextPath = `${newPrefix}/${row.relative_path.slice(oldPrefix.length + 1)}`;
      this.db
        .prepare("UPDATE artifact_nodes SET relative_path=?, updated_at=? WHERE id=?")
        .run(nextPath, now, row.id);
    }
  }

  private descendantsOf(requirementId: number, relativePath: string) {
    const rows = this.db
      .prepare("SELECT * FROM artifact_nodes WHERE requirement_id=?")
      .all(requirementId) as ArtifactNodeRow[];
    return this.filterDescendants(rows, relativePath);
  }

  // 精确前缀匹配（避免 LIKE 通配符歧义）：后代路径前缀为 `${parent}/`
  private filterDescendants(rows: ArtifactNodeRow[], relativePath: string) {
    const prefix = `${relativePath}/`;
    return rows.filter((row) => row.relative_path.startsWith(prefix));
  }

  private ancestorIds(node: ArtifactNode): Set<number> {
    const chain = new Set<number>();
    let cursor = node.parentId;
    while (cursor !== null && chain.size < 64) {
      chain.add(cursor);
      cursor = toNode(this.nodeRow(cursor)).parentId;
    }
    return chain;
  }

  private hashOf(content: string | Buffer): string {
    return createHash("sha256").update(content).digest("hex");
  }
}
