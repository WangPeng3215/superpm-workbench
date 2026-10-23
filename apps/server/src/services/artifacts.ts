import type Database from "better-sqlite3";
import {
  artifactContentSaveSchema,
  artifactFileCreateSchema,
  artifactFolderCreateSchema,
  artifactLinkCreateSchema,
  artifactLinkUpdateSchema,
  artifactFinalSchema,
  artifactMoveSchema,
  artifactRefreshSchema,
  artifactRenameSchema,
  artifactImageUploadSchema,
  artifactUploadMaxBytes,
  artifactUploadMaxLabel,
  artifactMemoryName,
  requirementImagesFolder,
  isSafeExternalUrl,
  isValidArtifactName,
  requirementMemoryTemplate,
  type ArtifactBreadcrumbItem,
  type ArtifactDirectory,
  type ArtifactImageUploadResult,
  type ArtifactLink,
  type ArtifactMemoryReadResult,
  type ArtifactMemoryStatus,
  type ArtifactNode,
  type ArtifactNodeDetails,
  type ArtifactNodeType,
  type ArtifactReadResult,
  type ArtifactRefreshResult,
  type ArtifactStats,
  type ArtifactStatus,
} from "@superpm/shared";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DomainError, RequirementService } from "./requirements.js";
import { RequirementDirectoryResolver } from "./requirement-directory.js";
import { allowSystemOpen } from "../config/index.js";
import { MIME_BY_EXTENSION } from "./requirement-files.js";
import { buildSystemOpenCommand } from "./system-open.js";

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
  is_final: number;
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
  is_final: number;
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
    isFinal: Boolean(row.is_final),
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
    isFinal: Boolean(row.is_final),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function extensionOf(name: string): string | null {
  const extension = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : null;
}
// 引用扫描只读文本类文件；未知二进制格式跳过，避免误判与无谓 IO
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
  ".json",
  ".csv",
  ".xml",
  ".svg",
  ".yaml",
  ".yml",
]);
function isTextReadable(extension: string | null): boolean {
  return extension !== null && TEXT_EXTENSIONS.has(extension.toLowerCase());
}
// 图片类型按文件头识别（不信任前端声明的 MIME），与旧图片上传接口同一套校验
function detectImageType(
  buffer: Buffer,
): { extension: string; mime: string } | null {
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { extension: "png", mime: "image/png" };
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return { extension: "jpg", mime: "image/jpeg" };
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString()))
    return { extension: "gif", mime: "image/gif" };
  if (
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  )
    return { extension: "webp", mime: "image/webp" };
  return null;
}
// 图片基名清洗：去掉扩展名与非法字符，保证落盘文件名安全可读
function sanitizeImageStem(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const clean = base
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 60);
  return clean || `image-${Date.now().toString(36)}`;
}
// 相对路径计算（正斜杠）：以 fromDir 为基准指向 toPath，如 fromDir="需求分析" → "../images/x.png"
function relativePosix(fromDir: string, toPath: string): string {
  const from = fromDir ? fromDir.split("/") : [];
  const to = toPath.split("/");
  let common = 0;
  while (
    common < from.length &&
    common < to.length - 1 &&
    from[common] === to[common]
  )
    common += 1;
  const ups = from.length - common;
  return [...Array<string>(ups).fill(".."), ...to.slice(common)].join("/");
}
// 反解：把相对文档目录的路径还原为需求内路径（拒绝越界），供图片读取使用
function resolveDocRelative(baseDir: string, relativePath: string): string {
  const segments = baseDir ? baseDir.split("/") : [];
  for (const segment of relativePath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length)
        throw new DomainError("INVALID_PATH", "图片路径越界");
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}
// 相对引用判定：非协议、非根路径、非协议相对地址（Markdown 中的图片才需要改写）
function isRelativeReference(src: string): boolean {
  return Boolean(src) && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(src);
}
// 取所在目录（正斜杠），根目录文件返回空串
function dirOf(relativePath: string): string {
  return relativePath.includes("/")
    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
    : "";
}

/**
 * 需求知识库服务（开发文档第 5/6 章）：文件与目录索引 + 外部链接 + 需求记忆。
 * UI 与未来 MCP 共用本服务；磁盘操作成功后才更新索引，路径安全与旧文件服务同一套防护。
 * 索引与磁盘无法共用事务：磁盘先行，索引更新失败时可通过 refreshDirectory 重新扫描修复。
 */
export class ArtifactService {
  private readonly directories: RequirementDirectoryResolver;
  constructor(
    private db: Database.Database,
    private root: string,
    private requirements: RequirementService,
    // 需求目录映射解析器：与 issues / requirement-files / stage-workspace 共用同一份路径规则
    directories?: RequirementDirectoryResolver,
  ) {
    this.directories =
      directories ?? new RequirementDirectoryResolver(db, root);
  }

  // ===== 查询 =====

  /**
   * 列出目录内容（含进入目录时的轻量磁盘检查）；q 非空时按名称做全需求范围搜索。
   * sync=false 时完全跳过磁盘检查与索引写入（MCP 只读工具使用）；
   * limit 为每类（目录/文件/链接）上限，返回 total 与 truncated 供调用方判断。
   */
  listNodes(
    requirementId: number,
    parentId: number | null,
    q = "",
    options: { sync?: boolean; limit?: number } = {},
  ): ArtifactDirectory {
    const keyword = q.trim();
    if (keyword) return this.searchNodes(requirementId, keyword, options.limit);
    const parent = this.requireParent(requirementId, parentId);
    const parentPath = parent ? parent.relativePath : "";
    // 轻量检查：对比当前目录的磁盘与索引（缺失标记、外部修改提示、新条目拾取）
    if (options.sync !== false)
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
    return this.finalizeDirectory(
      {
        requirementId,
        parentId,
        parentPath,
        breadcrumb: this.breadcrumbFrom(requirementId, parentId),
        folders,
        files,
        links,
        search: "",
      },
      options.limit,
    );
  }

  /** 节点详情：路径链 + 子树规模（供删除影响范围提示与详情展示） */
  getNodeDetails(nodeId: number): ArtifactNodeDetails {
    return this.detailsOf(this.nodeRow(nodeId));
  }

  /** 需求作用域的节点详情：跨需求节点一律按不存在处理（MCP 使用） */
  getNodeDetailsForRequirement(
    requirementId: number,
    nodeId: number,
  ): ArtifactNodeDetails {
    this.requirements.get(requirementId);
    const row = this.nodeRow(nodeId);
    if (row.requirement_id !== requirementId)
      throw new DomainError("NOT_FOUND", "文件或目录不存在", 404);
    return this.detailsOf(row);
  }

  /**
   * 只读节点读取（MCP 使用）：
   * - 文件夹：返回面包屑与后代数量，content=null；
   * - 文本文件：返回截断后的正文，不写回索引元数据；
   * - 二进制文件：只返回元数据，content=null（不返回 base64）。
   */
  readArtifact(
    requirementId: number,
    nodeId: number,
    maxChars = 50000,
  ): ArtifactReadResult {
    const details = this.getNodeDetailsForRequirement(requirementId, nodeId);
    const node = details.node;
    const cap = Math.max(1, Math.min(Math.trunc(maxChars), 100000));
    if (node.nodeType === "folder")
      return {
        ...details,
        kind: "folder",
        content: null,
        truncated: false,
        maxChars: cap,
      };
    if (!isTextReadable(node.extension))
      return {
        ...details,
        kind: "binary",
        content: null,
        truncated: false,
        maxChars: cap,
      };
    const path = this.resolvePathReadOnly(requirementId, node.relativePath);
    // 只读读取不标记 missing：文件缺失时明确报错，由用户刷新目录处理
    if (!existsSync(path) || lstatSync(path).isSymbolicLink())
      throw new DomainError("NOT_FOUND", "文件不存在或已被移动", 404);
    const text = this.readTextLimited(path, cap);
    return {
      ...details,
      kind: "text",
      content: text.content,
      truncated: text.truncated,
      maxChars: cap,
    };
  }

  /** 只读需求记忆：不初始化工作区、不创建目录/模板、不刷新索引 */
  readMemory(
    requirementId: number,
    maxChars = 50000,
  ): ArtifactMemoryReadResult {
    const requirement = this.requirements.get(requirementId);
    const cap = Math.max(1, Math.min(Math.trunc(maxChars), 100000));
    const empty = (
      status: ArtifactMemoryStatus,
      node: ArtifactNode | null,
    ): ArtifactMemoryReadResult => ({
      requirementId,
      exists: false,
      status,
      node,
      content: "",
      truncated: false,
      maxChars: cap,
    });
    const rootAbs = this.directories.tryResolveReadOnly(requirementId, "");
    if (!rootAbs) return empty("not_initialized", null);
    const fileAbs = join(rootAbs, artifactMemoryName);
    const node = this.memoryNode(requirementId);
    if (!existsSync(fileAbs)) return empty("missing", node);
    if (lstatSync(fileAbs).isSymbolicLink())
      throw new DomainError("INVALID_PATH", "需求记忆文件不能是符号链接");
    const text = this.readTextLimited(fileAbs, cap);
    return {
      requirementId: requirement.id,
      exists: true,
      status: "available",
      node,
      content: text.content,
      truncated: text.truncated,
      maxChars: cap,
    };
  }

  /** 产出物统计（只读 SQL + 磁盘存在性；不读取正文） */
  stats(requirementId: number): ArtifactStats {
    this.requirements.get(requirementId);
    const typeRows = this.db
      .prepare(
        "SELECT node_type, COUNT(*) AS total FROM artifact_nodes WHERE requirement_id=? GROUP BY node_type",
      )
      .all(requirementId) as { node_type: ArtifactNodeType; total: number }[];
    const statusRows = this.db
      .prepare(
        "SELECT status, COUNT(*) AS total FROM artifact_nodes WHERE requirement_id=? AND status != 'normal' GROUP BY status",
      )
      .all(requirementId) as { status: ArtifactStatus; total: number }[];
    const links = this.db
      .prepare(
        "SELECT COUNT(*) AS total FROM artifact_links WHERE requirement_id=?",
      )
      .get(requirementId) as { total: number };
    const countOf = (type: ArtifactNodeType) =>
      typeRows.find((row) => row.node_type === type)?.total ?? 0;
    const statusOf = (status: ArtifactStatus) =>
      statusRows.find((row) => row.status === status)?.total ?? 0;
    return {
      folders: countOf("folder"),
      files: countOf("file"),
      links: links.total,
      missing: statusOf("missing"),
      externalChanged: statusOf("external_changed"),
      memoryStatus: this.memoryStatus(requirementId),
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
    return this.insertNode(
      requirementId,
      data.parentId,
      "folder",
      name,
      relativePath,
      {
        modifiedAt: statSync(target).mtime.toISOString(),
      },
    );
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
    return this.insertNode(
      requirementId,
      data.parentId,
      "file",
      name,
      relativePath,
      {
        extension,
        mimeType: extension
          ? (MIME_BY_EXTENSION[extension.slice(1)] ?? null)
          : null,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        contentHash: this.hashOf(content),
      },
    );
  }

  /**
   * 上传本地文件到指定文件夹：原名写入磁盘并登记索引。
   * 同名时自动追加 -1、-2 等后缀，不覆盖已有文件（与图片上传策略一致）。
   */
  uploadFile(
    requirementId: number,
    parentId: number | null,
    rawName: string,
    data: Buffer,
  ): ArtifactNode {
    if (!Buffer.isBuffer(data))
      throw new DomainError("VALIDATION_ERROR", "缺少文件内容");
    if (data.length > artifactUploadMaxBytes)
      throw new DomainError(
        "PAYLOAD_TOO_LARGE",
        `单个文件不能超过 ${artifactUploadMaxLabel}`,
        413,
      );
    const requestedName = this.assertNodeName(rawName);
    const parent = this.requireParent(requirementId, parentId);
    this.assertParentOnDisk(parent);
    const name = this.uniqueUploadName(
      requirementId,
      parentId,
      parent,
      requestedName,
    );
    const relativePath = this.childPath(parent, name);
    const target = this.resolvePath(requirementId, relativePath, false);
    writeFileSync(target, data, { flag: "wx" });
    const stat = statSync(target);
    const extension = extensionOf(name);
    return this.insertNode(
      requirementId,
      parentId,
      "file",
      name,
      relativePath,
      {
        extension,
        mimeType: extension
          ? (MIME_BY_EXTENSION[extension.slice(1)] ?? null)
          : null,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        contentHash: this.hashOf(data),
      },
    );
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
    const currentAbs = this.resolvePath(
      node.requirementId,
      node.relativePath,
      false,
    );
    const nextAbs = this.resolvePath(node.requirementId, nextPath, false);
    if (!existsSync(currentAbs))
      throw new DomainError("NOT_FOUND", "磁盘上找不到原文件或目录", 404);
    if (existsSync(nextAbs))
      throw new DomainError("CONFLICT", "磁盘上已存在同名文件或目录", 409);
    // 先磁盘后索引；磁盘失败时保留旧元数据并抛出明确错误
    renameSync(currentAbs, nextAbs);
    // 文档位置变化后图片相对路径失效：能可靠识别引用时同步改写（文档 §12.4）
    this.rebaseImageReferences(
      node.id,
      node.requirementId,
      node.relativePath,
      nextPath,
    );
    // 目录改名/移动会整体位移其后代文档，同样需要改写这些文档内的图片引用
    if (node.nodeType === "folder")
      this.rebaseDescendantImageReferences(
        node.requirementId,
        node.relativePath,
        nextPath,
      );
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
    this.assertNoSibling(
      node.requirementId,
      data.targetParentId,
      node.name,
      node.id,
    );
    const nextPath = this.childPath(target, node.name);
    const currentAbs = this.resolvePath(
      node.requirementId,
      node.relativePath,
      false,
    );
    const nextAbs = this.resolvePath(node.requirementId, nextPath, false);
    if (!existsSync(currentAbs))
      throw new DomainError("NOT_FOUND", "磁盘上找不到原文件或目录", 404);
    if (existsSync(nextAbs))
      throw new DomainError(
        "CONFLICT",
        "目标磁盘位置已存在同名文件或目录",
        409,
      );
    renameSync(currentAbs, nextAbs);
    // 文档移动后图片相对路径失效：能可靠识别引用时同步改写（文档 §12.4）
    this.rebaseImageReferences(
      node.id,
      node.requirementId,
      node.relativePath,
      nextPath,
    );
    // 目录移动会整体位移其后代文档，同样需要改写这些文档内的图片引用
    if (node.nodeType === "folder")
      this.rebaseDescendantImageReferences(
        node.requirementId,
        node.relativePath,
        nextPath,
      );
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
    // 需求记忆文件与 images 目录不可通过普通删除移除（文档 §12.3）
    this.assertMutable(node, "删除");
    // 图片仍被系统管理的文档引用时阻止删除，避免 Markdown 出现失效图片
    if (node.nodeType === "file") this.assertNotReferencedImage(node);
    const all = this.db
      .prepare("SELECT * FROM artifact_nodes WHERE requirement_id=?")
      .all(node.requirementId) as ArtifactNodeRow[];
    const descendants = this.filterDescendants(all, node.relativePath);
    if (node.nodeType === "folder" && !recursive) {
      const directChildren = all.filter(
        (item) => item.parent_id === node.id,
      ).length;
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
    const target = this.resolvePath(
      node.requirementId,
      node.relativePath,
      false,
    );
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

  // ===== 最终确认版本 =====

  setNodeFinal(nodeId: number, input: unknown): ArtifactNode {
    const data = artifactFinalSchema.parse(input);
    const node = toNode(this.nodeRow(nodeId));
    if (node.nodeType === "folder")
      throw new DomainError("VALIDATION_ERROR", "文件夹不支持标记最终版");
    this.db
      .prepare("UPDATE artifact_nodes SET is_final=?, updated_at=? WHERE id=?")
      .run(data.isFinal ? 1 : 0, new Date().toISOString(), node.id);
    return toNode(this.nodeRow(node.id));
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
      if (
        !data.force &&
        node.modifiedAt !== null &&
        diskMtime !== node.modifiedAt
      )
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

  /**
   * 图片上传（文档 §12.4）：写入需求根目录的 images/，按文档所在目录计算相对路径。
   * 同名图片不静默覆盖：重名时追加 -1、-2 等安全后缀。
   */
  uploadImage(
    requirementId: number,
    input: unknown,
  ): ArtifactImageUploadResult {
    const data = artifactImageUploadSchema.parse(input);
    this.requirements.get(requirementId);
    const buffer = Buffer.from(data.data, "base64");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024)
      throw new DomainError("VALIDATION_ERROR", "图片大小应为 1 字节至 5 MB");
    const detected = detectImageType(buffer);
    if (!detected)
      throw new DomainError(
        "VALIDATION_ERROR",
        "仅支持 PNG、JPEG、GIF 或 WebP 图片",
      );
    // 文档所在目录决定相对路径基准；未提供节点时按需求根目录计算
    let baseDir = "";
    if (data.nodeId !== null) {
      const node = toNode(this.nodeRow(data.nodeId));
      if (node.requirementId !== requirementId)
        throw new DomainError("NOT_FOUND", "文档不存在", 404);
      baseDir = node.relativePath.includes("/")
        ? node.relativePath.slice(0, node.relativePath.lastIndexOf("/"))
        : "";
    }
    const stem = data.fileName
      ? sanitizeImageStem(data.fileName)
      : `image-${Date.now().toString(36)}`;
    const imagesAbs = this.resolvePath(
      requirementId,
      requirementImagesFolder,
      true,
    );
    let fileName = `${stem}.${detected.extension}`;
    for (let index = 1; existsSync(join(imagesAbs, fileName)); index += 1) {
      if (index > 999)
        throw new DomainError("CONFLICT", "同名图片过多，请更换图片名称", 409);
      fileName = `${stem}-${index}.${detected.extension}`;
    }
    const targetAbs = join(imagesAbs, fileName);
    writeFileSync(targetAbs, buffer, { flag: "wx" });
    const stat = statSync(targetAbs);
    const relativePath = `images/${fileName}`;
    // 登记（或复用）images 目录节点与图片节点，保持索引与磁盘一致
    const imagesNode = this.ensureImagesFolder(requirementId);
    const existing = this.db
      .prepare(
        "SELECT * FROM artifact_nodes WHERE requirement_id=? AND relative_path=?",
      )
      .get(requirementId, relativePath) as ArtifactNodeRow | undefined;
    const node = existing
      ? this.syncMetadata(
          toNode(existing),
          stat.size,
          stat.mtime.toISOString(),
          this.hashOf(buffer),
        )
      : this.insertNode(
          requirementId,
          imagesNode.id,
          "file",
          fileName,
          relativePath,
          {
            extension: detected.extension,
            mimeType: detected.mime,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            contentHash: this.hashOf(buffer),
          },
        );
    const docRelative = baseDir
      ? relativePosix(baseDir, relativePath)
      : relativePath;
    return {
      node,
      relativePath: docRelative,
      markdown: `![${stem}](${docRelative})`,
    };
  }

  // images 目录节点：系统级目录，缺索引时补建（不新建磁盘目录，调用方已确保存在）
  private ensureImagesFolder(requirementId: number): ArtifactNode {
    const row = this.db
      .prepare(
        "SELECT * FROM artifact_nodes WHERE requirement_id=? AND relative_path=?",
      )
      .get(requirementId, requirementImagesFolder) as
      ArtifactNodeRow | undefined;
    if (row) return toNode(row);
    const abs = this.resolvePath(requirementId, requirementImagesFolder, false);
    return this.insertNode(
      requirementId,
      null,
      "folder",
      requirementImagesFolder,
      requirementImagesFolder,
      {
        modifiedAt: existsSync(abs) ? statSync(abs).mtime.toISOString() : null,
      },
    );
  }

  /**
   * 按文档相对路径读取图片（文档 §12.4）：Markdown 里写的是相对文档所在目录的路径，
   * 如 需求分析/xx.md 中的 ../images/a.png。这里以文档目录为基准解析并限制在需求根目录内。
   */
  imageByPath(
    requirementId: number,
    docNodeId: number | null,
    relativePath: string,
  ): { data: Buffer; mime: string } {
    this.requirements.get(requirementId);
    let baseDir = "";
    if (docNodeId !== null) {
      const node = toNode(this.nodeRow(docNodeId));
      if (node.requirementId !== requirementId)
        throw new DomainError("NOT_FOUND", "文档不存在", 404);
      baseDir = node.relativePath.includes("/")
        ? node.relativePath.slice(0, node.relativePath.lastIndexOf("/"))
        : "";
    }
    const target = resolveDocRelative(baseDir, relativePath);
    const abs = this.resolvePath(requirementId, target, false);
    if (!existsSync(abs) || !statSync(abs).isFile())
      throw new DomainError("NOT_FOUND", "图片不存在", 404);
    if (lstatSync(abs).isSymbolicLink())
      throw new DomainError("INVALID_PATH", "路径不能包含符号链接");
    const extension = extname(abs).slice(1).toLowerCase();
    return {
      data: readFileSync(abs),
      mime: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
    };
  }

  /** 打开物理位置：目录进入资源管理器；文件默认程序打开，reveal 时定位并选中 */
  openSystem(nodeId: number, options: { reveal?: boolean } = {}): void {
    const node = toNode(this.nodeRow(nodeId));
    if (node.nodeType === "folder" && options.reveal)
      throw new DomainError("VALIDATION_ERROR", "目录不支持定位文件");
    // 打开目录与在文件夹中定位只做展示；仅“用默认程序打开文件”受执行开关约束
    if (node.nodeType === "file" && !options.reveal && !allowSystemOpen)
      throw new DomainError(
        "FORBIDDEN",
        "本地程序打开功能未启用（需设置 SUPERPM_ALLOW_SYSTEM_OPEN=1）",
        403,
      );
    const path = this.resolvePath(node.requirementId, node.relativePath, false);
    this.assertOnDisk(node, path);
    const { command, args } = buildSystemOpenCommand(path, {
      reveal: options.reveal,
    });
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  /** 打开需求内物理目录（relativePath 为空表示需求根目录） */
  openDirectory(requirementId: number, relativePath = ""): void {
    this.requirements.get(requirementId);
    const path = this.resolvePath(requirementId, relativePath, false);
    if (!existsSync(path))
      throw new DomainError("NOT_FOUND", "目录不存在，请重新初始化或刷新", 404);
    if (!statSync(path).isDirectory())
      throw new DomainError("VALIDATION_ERROR", "目标不是目录");
    const { command, args } = buildSystemOpenCommand(path);
    const child = spawn(command, args, {
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
    // 普通刷新不得重建系统级资源（文档 §12.1/§12.3）：需求记忆缺失时按 missing 标记，
    // 由状态查询提示并交给显式「修复默认结构」补建，避免覆盖用户的整理结果。
    const relativePath = (data.relativePath ?? "").replace(/^\/+|\/+$/g, "");
    if (
      relativePath
        .split("/")
        .some((segment) => segment === ".." || segment === ".")
    )
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
            .prepare(
              "UPDATE artifact_nodes SET status='missing', updated_at=? WHERE id=?",
            )
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
    const walk = (
      dirAbs: string,
      relPrefix: string,
      parentId: number | null,
    ) => {
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
              existing.size_bytes !== stat.size ||
              existing.modified_at !== modifiedAt;
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
          .prepare(
            "UPDATE artifact_nodes SET status='missing', updated_at=? WHERE id=?",
          )
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
    if (
      data.url !== undefined &&
      (!isSafeExternalUrl(data.url) || /^ftp:/i.test(data.url))
    )
      throw new DomainError(
        "VALIDATION_ERROR",
        "链接仅支持 http:// 或 https:// 开头的地址",
      );
    const name =
      data.name === undefined ? link.name : this.assertNodeName(data.name);
    const folderNodeId =
      data.folderNodeId === undefined ? link.folderNodeId : data.folderNodeId;
    if (folderNodeId !== link.folderNodeId)
      this.requireParent(link.requirementId, folderNodeId);
    if (name !== link.name || folderNodeId !== link.folderNodeId)
      this.assertNoSibling(
        link.requirementId,
        folderNodeId,
        name,
        undefined,
        link.id,
      );
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

  setLinkFinal(linkId: number, input: unknown): ArtifactLink {
    const data = artifactFinalSchema.parse(input);
    const link = toLink(this.linkRow(linkId));
    this.db
      .prepare("UPDATE artifact_links SET is_final=?, updated_at=? WHERE id=?")
      .run(data.isFinal ? 1 : 0, new Date().toISOString(), link.id);
    return toLink(this.linkRow(link.id));
  }

  deleteLink(linkId: number): void {
    // 只删除本地记录，不影响外部资源
    this.linkRow(linkId);
    this.db.prepare("DELETE FROM artifact_links WHERE id=?").run(linkId);
  }

  // ===== 需求记忆（文档 4.3）=====

  /**
   * 读取需求记忆节点（文档 §12.1/§12.3）。
   * 需求尚未初始化时懒初始化整套目录结构；已初始化但文件在磁盘上缺失（外部删除）时，
   * 不静默重建，而是标记索引缺失并提示走显式「修复默认结构」。
   */
  ensureMemory(requirementId: number): ArtifactNode {
    const requirement = this.requirements.get(requirementId);
    const existing = this.db
      .prepare(
        "SELECT * FROM artifact_nodes WHERE requirement_id=? AND relative_path=?",
      )
      .get(requirementId, artifactMemoryName) as ArtifactNodeRow | undefined;
    const initialized = this.directories.row(requirementId);
    if (!initialized) {
      // 存量需求首次访问：按统一流程初始化（含目录映射、默认目录与需求记忆）
      this.directories.initialize(requirementId);
      const row = this.db
        .prepare(
          "SELECT * FROM artifact_nodes WHERE requirement_id=? AND relative_path=?",
        )
        .get(requirementId, artifactMemoryName) as ArtifactNodeRow | undefined;
      if (row) return toNode(row);
    }
    const rootAbs = this.resolvePath(requirementId, "", false);
    const fileAbs = join(rootAbs, artifactMemoryName);
    const template = requirementMemoryTemplate(requirement.name);
    if (!existsSync(fileAbs)) {
      // 已初始化却缺失：系统级资源被外部删除，交由显式修复流程处理
      if (initialized) {
        if (existing && existing.status !== "missing")
          this.db
            .prepare(
              "UPDATE artifact_nodes SET status='missing', updated_at=? WHERE id=?",
            )
            .run(new Date().toISOString(), existing.id);
        throw new DomainError(
          "NOT_FOUND",
          "需求记忆文件已在磁盘上缺失，请在文档管理中执行「修复默认结构」",
          404,
        );
      }
      // 磁盘缺失（含首建）：写模板文件；索引缺失时一并补建，索引存在时恢复元数据
      mkdirSync(dirname(fileAbs), { recursive: true });
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

  /** 刷新需求记忆：外部修改后重新登记大小与修改时间（文件缺失时明确报错，不静默重建） */
  refreshMemory(requirementId: number): ArtifactNode {
    const node = this.ensureMemory(requirementId);
    const fileAbs = this.resolvePath(requirementId, artifactMemoryName, false);
    const stat = statSync(fileAbs);
    return this.syncMetadata(
      node,
      stat.size,
      stat.mtime.toISOString(),
      this.hashOf(readFileSync(fileAbs)),
    );
  }

  // ===== 内部工具：路径安全与索引维护 =====

  // 逐级解析需求内相对路径：委托给目录解析器，保证与其它服务同一套防护。
  // create=false 时不落盘建目录（用于"目标必须不存在"或只读解析），存在性由调用方判定
  private resolvePath(
    requirementId: number,
    relativePath: string,
    create: boolean,
  ): string {
    return this.directories.resolve(requirementId, relativePath, create);
  }

  private assertNodeName(name: string): string {
    if (!isValidArtifactName(name))
      throw new DomainError(
        "VALIDATION_ERROR",
        '名称不能为空，不能包含 \\ / : * ? " < > | 等字符，不能含连续点，且不能以点或空格结尾',
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
    const parentAbs = this.resolvePath(
      parent.requirementId,
      parent.relativePath,
      false,
    );
    if (!existsSync(parentAbs) || lstatSync(parentAbs).isSymbolicLink())
      throw new DomainError(
        "CONFLICT",
        "父目录在磁盘上已缺失，请先刷新目录树或恢复该目录",
        409,
      );
  }

  // 同级重名检测：上传需要在保留原名与自动改名之间判断，不抛错
  private siblingExists(
    requirementId: number,
    parentId: number | null,
    name: string,
  ): boolean {
    const node = this.db
      .prepare(
        "SELECT id FROM artifact_nodes WHERE requirement_id=? AND parent_id IS ? AND name=?",
      )
      .get(requirementId, parentId, name);
    if (node) return true;
    const link = this.db
      .prepare(
        "SELECT id FROM artifact_links WHERE requirement_id=? AND folder_node_id IS ? AND name=?",
      )
      .get(requirementId, parentId, name);
    return Boolean(link);
  }

  // 同名上传不覆盖：保留扩展名并追加 -1、-2 等安全后缀
  private uniqueUploadName(
    requirementId: number,
    parentId: number | null,
    parent: ArtifactNode | null,
    name: string,
  ): string {
    const extension = extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    const taken = (candidate: string) =>
      existsSync(
        this.resolvePath(
          requirementId,
          this.childPath(parent, candidate),
          false,
        ),
      ) || this.siblingExists(requirementId, parentId, candidate);
    if (!taken(name)) return name;
    for (let index = 1; index <= 999; index += 1) {
      const suffix = `-${index}`;
      const maxStem = Math.max(0, 200 - suffix.length - extension.length);
      const candidate = `${stem.slice(0, maxStem)}${suffix}${extension}`;
      if (!taken(candidate)) return candidate;
    }
    throw new DomainError("CONFLICT", "同名文件过多，请更换文件名", 409);
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

  /**
   * 图片引用检查（文档 §12.4）：images/ 下的图片仍被系统管理的文档引用时阻止删除，
   * 并提示引用来源；引用形式按相对路径或文件名匹配（Markdown 与 HTML 两种写法都覆盖）。
   */
  private assertNotReferencedImage(node: ArtifactNode) {
    if (!node.relativePath.startsWith(`${requirementImagesFolder}/`)) return;
    const referrers = this.findImageReferences(node.requirementId, node.name);
    if (!referrers.length) return;
    throw new DomainError(
      "CONFLICT",
      `图片仍被 ${referrers.length} 个文档引用（${referrers.slice(0, 3).join("、")}${referrers.length > 3 ? " 等" : ""}），请先解除引用再删除`,
      409,
    );
  }

  /**
   * 文档移动/重命名后修正图片相对路径（文档 §12.4）。
   * 只处理能以「原文档目录」为基准安全还原到需求内 images/ 的相对路径；
   * 还原不可靠（绝对地址、外部地址、越界）时原样保留，避免静默破坏内容。
   */
  private rebaseImageReferences(
    nodeId: number,
    requirementId: number,
    oldDocPath: string,
    newDocPath: string,
  ) {
    if (!isTextReadable(extensionOf(newDocPath))) return;
    const oldDir = dirOf(oldDocPath);
    const newDir = dirOf(newDocPath);
    if (oldDir === newDir) return;
    this.rewriteImageReferences(
      nodeId,
      requirementId,
      newDocPath,
      oldDir,
      newDir,
    );
  }

  /**
   * 目录改名/移动后修正其后代文档的图片相对路径（文档 §12.4）。
   * 后代文档的所在目录整体位移，逐个按新旧目录基准改写；不可靠的引用保持原样。
   */
  private rebaseDescendantImageReferences(
    requirementId: number,
    oldPrefix: string,
    newPrefix: string,
  ) {
    const rows = this.db
      .prepare(
        "SELECT * FROM artifact_nodes WHERE requirement_id=? AND node_type='file'",
      )
      .all(requirementId) as ArtifactNodeRow[];
    for (const row of this.filterDescendants(rows, oldPrefix)) {
      if (!isTextReadable(row.extension)) continue;
      const newPath = `${newPrefix}/${row.relative_path.slice(oldPrefix.length + 1)}`;
      const oldDir = dirOf(row.relative_path);
      const newDir = dirOf(newPath);
      if (oldDir === newDir) continue;
      this.rewriteImageReferences(
        row.id,
        requirementId,
        newPath,
        oldDir,
        newDir,
      );
    }
  }

  /** 把 docPath 文档内指向 images/ 的相对引用从 oldDir 基准改写到 newDir 基准 */
  private rewriteImageReferences(
    nodeId: number,
    requirementId: number,
    docPath: string,
    oldDir: string,
    newDir: string,
  ) {
    const abs = this.resolvePath(requirementId, docPath, false);
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) return;
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      return;
    }
    let changed = false;
    const next = content.replace(
      /(!\[[^\]]*\]\()([^)\s]+)(\))/g,
      (match, head: string, src: string, tail: string) => {
        if (!isRelativeReference(src)) return match;
        let target: string;
        try {
          target = resolveDocRelative(oldDir, src);
        } catch {
          return match;
        }
        // 仅改写确实指向本需求 images/ 的引用，其它相对链接保持不变
        if (!target.startsWith(`${requirementImagesFolder}/`)) return match;
        changed = true;
        return `${head}${relativePosix(newDir, target)}${tail}`;
      },
    );
    if (!changed) return;
    writeFileSync(abs, next, "utf8");
    const stat = statSync(abs);
    this.syncMetadata(
      toNode(this.nodeRow(nodeId)),
      stat.size,
      stat.mtime.toISOString(),
      this.hashOf(next),
    );
  }

  /**
   * 扫描需求内文本文件与问题记录，找出引用了指定图片文件名的位置。
   * 问题描述存于 issues/{id}.md、解决方案存于 issues.solution，二者都不在
   * artifact_nodes 索引中，需要单独扫描，否则删除被问题引用的图片不会被拦截。
   */
  private findImageReferences(
    requirementId: number,
    fileName: string,
  ): string[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM artifact_nodes WHERE requirement_id=? AND node_type='file'",
      )
      .all(requirementId) as ArtifactNodeRow[];
    const pattern = new RegExp(
      `${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=["')\\s]|$)`,
      "i",
    );
    const hits: string[] = [];
    for (const row of rows) {
      if (row.relative_path.startsWith(`${requirementImagesFolder}/`)) continue;
      if (!isTextReadable(row.extension)) continue;
      const abs = this.resolvePath(requirementId, row.relative_path, false);
      if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) continue;
      try {
        if (pattern.test(readFileSync(abs, "utf8")))
          hits.push(row.relative_path);
      } catch {
        // 读取失败（编码/权限）不作为引用判定依据，跳过
      }
    }
    const issues = this.db
      .prepare(
        "SELECT id, solution FROM issues WHERE requirement_id=? AND is_deleted=0",
      )
      .all(requirementId) as { id: number; solution: string | null }[];
    for (const issue of issues) {
      let referenced = Boolean(issue.solution && pattern.test(issue.solution));
      if (!referenced) {
        try {
          const file = join(
            this.directories.resolve(requirementId, "issues", false),
            `${issue.id}.md`,
          );
          referenced =
            existsSync(file) &&
            !lstatSync(file).isSymbolicLink() &&
            pattern.test(readFileSync(file, "utf8"));
        } catch {
          referenced = false;
        }
      }
      if (referenced) hits.push(`问题 #${issue.id}`);
    }
    return hits;
  }

  // 系统级资源保护（文档 §12.3）：需求记忆文件与 images 目录不可删、不可改名、不可移动。
  // 保护在后端服务内统一实现，前端与未来 MCP 调用同一入口，无法绕过。
  private assertMutable(node: ArtifactNode, action: string) {
    if (node.relativePath === artifactMemoryName)
      throw new DomainError("CONFLICT", `需求记忆文件不可${action}`, 409);
    if (node.relativePath === requirementImagesFolder)
      throw new DomainError(
        "CONFLICT",
        `images 目录是系统级资源，不可${action}`,
        409,
      );
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
    return [
      { id: null, name: this.requirements.get(requirementId).name },
      ...chain,
    ];
  }

  private searchNodes(
    requirementId: number,
    keyword: string,
    limit?: number,
  ): ArtifactDirectory {
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
    return this.finalizeDirectory(
      {
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
      },
      limit,
    );
  }

  // 目录结果收尾：limit 作用于每一类，total 保留截断前数量
  private finalizeDirectory(
    base: ArtifactDirectory,
    limit?: number,
  ): ArtifactDirectory {
    const total = {
      folders: base.folders.length,
      files: base.files.length,
      links: base.links.length,
    };
    if (limit === undefined) return base;
    const cap = Math.max(0, Math.trunc(limit));
    return {
      ...base,
      folders: base.folders.slice(0, cap),
      files: base.files.slice(0, cap),
      links: base.links.slice(0, cap),
      total,
      truncated: total.folders > cap || total.files > cap || total.links > cap,
    };
  }

  private detailsOf(row: ArtifactNodeRow): ArtifactNodeDetails {
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

  private memoryNode(requirementId: number): ArtifactNode | null {
    const row = this.db
      .prepare(
        "SELECT * FROM artifact_nodes WHERE requirement_id=? AND relative_path=?",
      )
      .get(requirementId, artifactMemoryName) as ArtifactNodeRow | undefined;
    return row ? toNode(row) : null;
  }

  // 需求记忆磁盘状态：只做存在性判断，不创建、不读取正文
  private memoryStatus(requirementId: number): ArtifactMemoryStatus {
    const rootAbs = this.directories.tryResolveReadOnly(requirementId, "");
    if (!rootAbs) return "not_initialized";
    const fileAbs = join(rootAbs, artifactMemoryName);
    if (!existsSync(fileAbs)) return "missing";
    if (lstatSync(fileAbs).isSymbolicLink())
      throw new DomainError("INVALID_PATH", "需求记忆文件不能是符号链接");
    return "available";
  }

  // 只读路径解析：不补目录映射；目录未初始化时由调用方按缺失处理
  private resolvePathReadOnly(
    requirementId: number,
    relativePath: string,
  ): string {
    return this.directories.resolveReadOnly(requirementId, relativePath);
  }

  /**
   * 限长读取 UTF-8 文本：最多读取 maxChars 个字符所需的字节数，避免把超大文件
   * 整体载入内存。truncated 表示文件还有未返回的内容。
   */
  private readTextLimited(
    path: string,
    maxChars: number,
  ): { content: string; truncated: boolean } {
    const stat = statSync(path);
    // 目录、设备等特殊文件不能按文本读取，统一按不存在处理，避免平台差异
    if (!stat.isFile())
      throw new DomainError("NOT_FOUND", "文件不存在或不可读取", 404);
    // UTF-8 单字符最多 4 字节；多读 4 字节用于判断是否仍有剩余内容
    const maxBytes = maxChars * 4 + 4;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      let offset = 0;
      while (offset < length) {
        const read = readSync(fd, buffer, offset, length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      const decoded = buffer.subarray(0, offset).toString("utf8");
      if (stat.size > offset) {
        return { content: decoded.slice(0, maxChars), truncated: true };
      }
      if (decoded.length > maxChars)
        return { content: decoded.slice(0, maxChars), truncated: true };
      return { content: decoded, truncated: false };
    } finally {
      closeSync(fd);
    }
  }

  // 进入目录时的轻量检查（单层，不递归）：缺失标记、外部修改提示、磁盘新条目拾取
  private lightCheck(
    requirementId: number,
    parent: ArtifactNode | null,
    parentPath: string,
  ) {
    // 浏览目录不得隐式建目录（文档 §12.1）：目录缺失时只把索引标记为缺失
    const dirAbs = this.resolvePath(requirementId, parentPath, false);
    const now = new Date().toISOString();
    const rows = this.rowsOf(requirementId, parent?.id ?? null);
    if (!existsSync(dirAbs)) {
      for (const row of rows)
        if (row.status !== "missing")
          this.db
            .prepare(
              "UPDATE artifact_nodes SET status='missing', updated_at=? WHERE id=?",
            )
            .run(now, row.id);
      return;
    }
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
            row.node_type === "file"
              ? stat.mtime.toISOString()
              : row.modified_at,
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
        this.insertNodeRow(
          requirementId,
          parentId,
          "file",
          entry.name,
          rel,
          stat.mtime.toISOString(),
          {
            extension,
            mimeType: extension
              ? (MIME_BY_EXTENSION[extension.slice(1)] ?? null)
              : null,
            sizeBytes: stat.size,
            contentHash: this.hashOf(readFileSync(abs)),
          },
        );
      }
    }
  }

  // 磁盘存在性检查：缺失时标记 missing（不删行），由刷新或用户决定恢复/清理
  private assertOnDisk(node: ArtifactNode, path: string) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
      if (node.status !== "missing") {
        this.db
          .prepare(
            "UPDATE artifact_nodes SET status='missing', updated_at=? WHERE id=?",
          )
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
      .run(
        sizeBytes,
        modifiedAt,
        contentHash,
        new Date().toISOString(),
        node.id,
      );
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
        .prepare(
          "UPDATE artifact_nodes SET relative_path=?, updated_at=? WHERE id=?",
        )
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
