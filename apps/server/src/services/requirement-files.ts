import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { currentUserScope } from "../db/scope.js";
import { projectRolesFor } from "./project-access.js";
import { assertRequirementAccess } from "./requirement-access.js";
import {
  analysisRecordName,
  categoryDefaultDocs,
  fileCategoryFolders,
  fileCategoryKinds,
  fileCategoryLabels,
  assetCategories,
  isSafeExternalUrl,
  requirementFileContentSchema,
  requirementFileCreateSchema,
  requirementFileUpdateSchema,
  stageFileCategories,
  type AssetResourceType,
  type AssetStatus,
  type AssetStorageType,
  type FileCategory,
  type RequirementFile,
  type RequirementFileList,
  type Stage,
} from "@superpm/shared";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError, RequirementService } from "./requirements.js";
import { RequirementDirectoryResolver } from "./requirement-directory.js";
import { resolveWorkspacePath } from "../storage/workspace.js";
import { allowSystemOpen } from "../config/index.js";
import { launchSystemOpen, systemOpenFailureMessage } from "./system-open.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
// 导出供知识库（artifacts）等服务复用统一的扩展名 → MIME 推断
export const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  html: "text/html; charset=utf-8",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
// 导出供关联服务等问题域模块复用统一投影
export interface FileRow {
  id: number;
  version: number;
  user_id: number;
  requirement_id: number;
  phase: Stage;
  category: FileCategory;
  name: string;
  file_name: string;
  // 过渡列：语义由 resource_type/status 承接，读取时仅作回退
  kind: string;
  link_url: string | null;
  is_final: number;
  resource_type: AssetResourceType;
  storage_type: AssetStorageType;
  relative_path: string | null;
  text_content: string | null;
  mime_type: string | null;
  description: string | null;
  status: AssetStatus;
  is_deleted: number;
  created_at: string;
  updated_at: string;
}
// 导出供关联服务等问题域模块复用统一投影
export function toFile(row: FileRow): RequirementFile {
  // resource_type/status 为权威字段；kind/is_final 为兼容投影（过渡期）
  const resourceType: AssetResourceType =
    row.resource_type ?? (row.kind === "link" ? "link" : "file");
  const status: AssetStatus =
    row.status ?? (row.is_final === 1 ? "final" : "draft");
  return {
    id: row.id,
    version: row.version,
    requirementId: row.requirement_id,
    phase: row.phase,
    category: row.category,
    name: row.name,
    resourceType,
    storageType: row.storage_type,
    status,
    kind: resourceType,
    isFinal: status === "final",
    fileName: row.file_name,
    relativePath: row.relative_path,
    linkUrl: row.link_url,
    textContent: null,
    mimeType: row.mime_type,
    description: row.description,
    isDeleted: row.is_deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function extensionFor(name: string, mime: string) {
  const extension = extname(name).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  const byMime = Object.entries(MIME_BY_EXTENSION).find(
    ([, value]) => value.split(";")[0] === mime.split(";")[0],
  );
  return byMime ? `.${byMime[0]}` : ".bin";
}
export class RequirementFileService {
  private readonly directories: RequirementDirectoryResolver;
  constructor(
    private db: Database.Database,
    private root: string,
    private requirements: RequirementService,
    directories?: RequirementDirectoryResolver,
  ) {
    this.directories =
      directories ?? new RequirementDirectoryResolver(db, root);
  }
  list(id: number, phase: Stage | "all", all: boolean): RequirementFileList {
    this.requirements.get(id);
    if (
      phase !== "all" &&
      assertRequirementAccess(this.db, id).project_id === null
    )
      this.ensureScope(id, phase);
    // all 模式：跨阶段聚合右栏七分类；其余按单阶段分组
    const rows = (
      phase === "all"
        ? this.db
            .prepare(
              "SELECT * FROM requirement_files WHERE requirement_id=? AND is_deleted=0 ORDER BY category, is_final DESC, updated_at DESC, id DESC",
            )
            .all(id)
        : this.db
            .prepare(
              "SELECT * FROM requirement_files WHERE requirement_id=? AND phase=? AND is_deleted=0 ORDER BY category, is_final DESC, updated_at DESC, id DESC",
            )
            .all(id, phase)
    ) as FileRow[];
    const files = rows.map(toFile);
    const categories =
      phase === "all"
        ? assetCategories.map((entry) => ({
            category: entry.key,
            label: entry.label,
          }))
        : stageFileCategories[phase].map((key) => ({
            category: key,
            label: fileCategoryLabels[key],
          }));
    return {
      phase,
      all,
      // 分组集合跟随分类定义（分类是纯标签，与物理目录解耦）
      groups: categories.map(({ category, label }) => {
        const scoped = files.filter((file) => file.category === category);
        return {
          category,
          label,
          total: scoped.length,
          files: all ? scoped : scoped.filter((file) => file.isFinal),
        };
      }),
      editorFile:
        files.find(
          (file) =>
            file.category === "record" && file.name === analysisRecordName,
        ) ?? null,
    };
  }
  create(id: number, input: unknown) {
    return this.db
      .transaction(() => {
        assertRequirementAccess(this.db, id, "artifact_write");
        this.requirements.get(id);
        const data = requirementFileCreateSchema.parse(input);
        if (data.isFinal)
          assertRequirementAccess(this.db, id, "artifact_manage");
        // 分类形态校验：链接语义按分类约束；text 作为轻量文档形态可在文件类分类下创建
        const allowed = fileCategoryKinds[data.category];
        if (
          data.resourceType === "link" &&
          allowed !== "link" &&
          allowed !== "both"
        )
          throw new DomainError("VALIDATION_ERROR", "该分类不支持链接条目");
        if (data.resourceType === "file" && allowed === "link")
          throw new DomainError("VALIDATION_ERROR", "该分类仅支持链接条目");
        this.ensureScope(id, data.phase);
        const now = new Date().toISOString();
        const status: AssetStatus = data.isFinal ? "final" : "draft";
        return this.db.transaction(() => {
          if (data.isFinal)
            this.unmarkFinal(id, data.phase, data.category, data.name);
          if (data.resourceType === "text") {
            // 文本资源：不入盘，直接存库
            const result = this.db
              .prepare(
                "INSERT INTO requirement_files(user_id, requirement_id, phase, category, name, file_name, kind, link_url, is_final, resource_type, storage_type, text_content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', 'text', NULL, ?, 'text', 'database', ?, ?, ?, ?)",
              )
              .run(
                currentUserScope()?.userId ?? 0,
                id,
                data.phase,
                data.category,
                data.name,
                data.isFinal ? 1 : 0,
                data.textContent,
                status,
                now,
                now,
              );
            return this.row(id, Number(result.lastInsertRowid));
          }
          if (data.resourceType === "link") {
            // 链接条目：只写索引，不落盘；协议白名单拒绝 javascript:/data: 等危险协议
            if (!isSafeExternalUrl(data.linkUrl ?? ""))
              throw new DomainError(
                "VALIDATION_ERROR",
                "链接仅支持 http(s):// 或 ftp:// 开头的地址",
              );
            const result = this.db
              .prepare(
                "INSERT INTO requirement_files(user_id, requirement_id, phase, category, name, file_name, kind, link_url, is_final, resource_type, storage_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', 'link', ?, ?, 'link', 'external', ?, ?, ?)",
              )
              .run(
                currentUserScope()?.userId ?? 0,
                id,
                data.phase,
                data.category,
                data.name,
                data.linkUrl,
                data.isFinal ? 1 : 0,
                status,
                now,
                now,
              );
            return this.row(id, Number(result.lastInsertRowid));
          }
          // 文件条目：统一落 files/ 目录，相对路径入库
          const buffer = Buffer.from(data.data ?? "", "base64");
          if (!buffer.length || buffer.length > MAX_FILE_BYTES)
            throw new DomainError(
              "VALIDATION_ERROR",
              "文件大小应为 1 字节至 5 MB",
            );
          const fileName = `${randomUUID()}${extensionFor(data.name, data.mime)}`;
          const directory = this.directory(id, ["files"]);
          const path = join(directory, fileName);
          writeFileSync(path, buffer, { flag: "wx" });
          // 相对路径由目录映射推导，保证与实际落盘的物理目录名一致
          const relativePath = `${this.directories.relativeRoot(id, "artifact_write")}/files/${fileName}`;
          const result = this.db
            .prepare(
              "INSERT INTO requirement_files(user_id, requirement_id, phase, category, name, file_name, kind, link_url, is_final, resource_type, storage_type, relative_path, mime_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'file', NULL, ?, 'file', 'local', ?, ?, ?, ?, ?)",
            )
            .run(
              currentUserScope()?.userId ?? 0,
              id,
              data.phase,
              data.category,
              data.name,
              fileName,
              data.isFinal ? 1 : 0,
              relativePath,
              data.mime,
              status,
              now,
              now,
            );
          return this.row(id, Number(result.lastInsertRowid));
        })();
      })
      .immediate();
  }
  content(id: number, fileId: number) {
    const file = this.row(id, fileId);
    this.assertContentable(file);
    if (file.resourceType === "text") {
      const row = this.rawRow(file.id);
      if (row.text_content === null)
        throw new DomainError("NOT_FOUND", "文本内容不存在", 404);
      return {
        file: { ...file, textContent: row.text_content },
        version: contentVersion(row.text_content),
        content: row.text_content,
      };
    }
    const path = this.resolveLocalPath(file);
    this.assertLocalFile(file, path);
    const content = readFileSync(path, "utf8");
    return { file, content, version: contentVersion(content) };
  }
  saveContent(id: number, fileId: number, input: unknown) {
    return this.db
      .transaction(() => {
        assertRequirementAccess(this.db, id, "artifact_write");
        const file = this.row(id, fileId);
        const raw = this.rawRow(fileId);
        assertResourceWritable(this.db, id, raw.user_id, Boolean(raw.is_final));
        this.assertContentable(file);
        const { content, expectedVersion } =
          requirementFileContentSchema.parse(input);
        const current = this.content(id, fileId).content;
        assertResourceVersion(
          this.db,
          id,
          contentVersion(current),
          expectedVersion,
          { file, content: current },
        );
        if (file.resourceType === "text") {
          this.db
            .prepare(
              "UPDATE requirement_files SET text_content=?, version=version+1, updated_at=? WHERE id=?",
            )
            .run(content, new Date().toISOString(), fileId);
          return this.row(id, fileId);
        }
        const path = this.resolveLocalPath(file);
        if (existsSync(path) && lstatSync(path).isSymbolicLink())
          throw new DomainError("INVALID_PATH", "文件不能是符号链接");
        const previous = readFileSync(path);
        writeFileSync(path, content, "utf8");
        try {
          this.touch(fileId);
          return this.row(id, fileId);
        } catch (error) {
          try {
            writeFileSync(path, previous);
          } catch {
            throw new DomainError(
              "INDEX_SYNC_FAILED",
              "文件索引更新失败且原内容恢复失败，请检查文件",
              500,
            );
          }
          throw error;
        }
      })
      .immediate();
  }
  update(id: number, fileId: number, input: unknown) {
    return this.db
      .transaction(() => {
        assertRequirementAccess(this.db, id, "artifact_manage");
        const file = this.row(id, fileId);
        const patch = requirementFileUpdateSchema.parse(input);
        assertResourceVersion(
          this.db,
          id,
          file.version,
          patch.expectedVersion,
          file,
        );
        // isFinal 为兼容输入：true↔final，false↔draft
        const nextStatus: AssetStatus | undefined = patch.status
          ? patch.status
          : patch.isFinal === undefined
            ? undefined
            : patch.isFinal
              ? "final"
              : "draft";
        return this.db.transaction(() => {
          if (nextStatus === "final")
            this.unmarkFinal(
              id,
              file.phase,
              file.category,
              patch.name ?? file.name,
            );
          const now = new Date().toISOString();
          this.db
            .prepare(
              "UPDATE requirement_files SET name=?, description=?, status=?, is_final=?, version=version+1, updated_at=? WHERE id=?",
            )
            .run(
              patch.name ?? file.name,
              patch.description === undefined
                ? file.description
                : patch.description,
              nextStatus ?? file.status,
              // is_final 过渡列与 status 同步双写，兼容现有消费方
              (nextStatus ?? file.status) === "final" ? 1 : 0,
              now,
              fileId,
            );
          return this.row(id, fileId);
        })();
      })
      .immediate();
  }
  remove(id: number, fileId: number, expectedVersion?: number) {
    return this.db
      .transaction(() => {
        assertRequirementAccess(this.db, id, "artifact_manage");
        const current = this.row(id, fileId);
        assertResourceVersion(
          this.db,
          id,
          current.version,
          expectedVersion,
          current,
        );
        // 软删除：仅标记索引行，不触碰磁盘文件；关联关系随索引一并失效
        this.row(id, fileId);
        this.db.transaction(() => {
          this.db
            .prepare(
              "UPDATE requirement_files SET is_deleted=1, version=version+1, updated_at=? WHERE id=?",
            )
            .run(new Date().toISOString(), fileId);
          this.db
            .prepare("DELETE FROM issue_assets WHERE asset_id=?")
            .run(fileId);
        })();
      })
      .immediate();
  }
  raw(id: number, fileId: number) {
    const file = this.row(id, fileId);
    this.assertContentable(file);
    if (file.resourceType === "text")
      throw new DomainError("VALIDATION_ERROR", "文本资源请通过内容接口读取");
    const path = this.resolveLocalPath(file);
    this.assertLocalFile(file, path);
    // 优先使用创建时记录的 MIME，缺失时按扩展名推断
    const extension = extname(file.fileName).slice(1).toLowerCase();
    return {
      data: readFileSync(path),
      mime:
        file.mimeType?.split(";")[0] ??
        MIME_BY_EXTENSION[extension] ??
        "application/octet-stream",
    };
  }
  // 本地默认程序打开（补充文档 5.4）：默认开启，可显式关闭；仅文件资源可触发
  async openAsset(id: number, fileId: number): Promise<void> {
    if (!allowSystemOpen)
      throw new DomainError(
        "FORBIDDEN",
        "本地程序打开功能已关闭（SUPERPM_ALLOW_SYSTEM_OPEN=0）",
      );
    const file = this.row(id, fileId);
    if (file.resourceType !== "file")
      throw new DomainError(
        "VALIDATION_ERROR",
        "链接与文本条目不支持本地程序打开",
      );
    const path = this.resolveLocalPath(file);
    this.assertLocalFile(file, path);
    try {
      await launchSystemOpen(path);
    } catch (error) {
      throw new DomainError(
        "SYSTEM_OPEN_FAILED",
        systemOpenFailureMessage(error),
        500,
      );
    }
  }
  // 链接条目没有文件体，正文/二进制/保存类操作一律拒绝
  private assertContentable(file: RequirementFile) {
    if (file.resourceType === "link")
      throw new DomainError("VALIDATION_ERROR", "链接条目没有文件内容");
  }
  // 本地文件存在性检测：缺失时标记 missing（不删行，不删文件）
  private assertLocalFile(file: RequirementFile, path: string) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
      if (
        file.status !== "missing" &&
        assertRequirementAccess(this.db, file.requirementId).project_id === null
      )
        this.db
          .prepare(
            "UPDATE requirement_files SET status='missing', updated_at=? WHERE id=?",
          )
          .run(new Date().toISOString(), file.id);
      throw new DomainError("NOT_FOUND", "文件不存在或已被移动", 404);
    }
  }
  private rawRow(fileId: number) {
    const row = this.db
      .prepare("SELECT * FROM requirement_files WHERE id=?")
      .get(fileId) as FileRow;
    return row;
  }
  // 解析本地文件绝对路径：优先使用入库的相对路径；旧数据惰性回填
  private resolveLocalPath(file: RequirementFile) {
    if (file.relativePath) return this.tamperedSafePath(file);
    const legacy = this.legacyPath(file);
    const relativePath = relative(this.root, legacy).split(sep).join("/");
    if (
      assertRequirementAccess(this.db, file.requirementId).project_id === null
    )
      this.db
        .prepare("UPDATE requirement_files SET relative_path=? WHERE id=?")
        .run(relativePath, file.id);
    return legacy;
  }
  // 库中相对路径可能被篡改：必须仍在 Workspace 与该需求目录内，且不经过符号链接目录
  private tamperedSafePath(file: RequirementFile) {
    const target = resolveWorkspacePath(this.root, file.relativePath!);
    const requirementRoot = this.directories.tryResolveReadOnly(
      file.requirementId,
      "",
    );
    if (!requirementRoot)
      throw new DomainError("INVALID_PATH", "需求目录不存在或尚未初始化");
    const parent = dirname(target);
    const resolvedParent = existsSync(parent) ? realpathSync(parent) : parent;
    const distance = relative(requirementRoot, resolvedParent);
    if (distance.startsWith("..") || isAbsolute(distance))
      throw new DomainError("INVALID_PATH", "文件路径必须位于需求目录内");
    return target;
  }
  // 旧版推导规则：requirements/{id}/{phase}/{分类目录}/{file_name}
  private legacyPath(file: RequirementFile) {
    return this.directories.resolveReadOnly(
      file.requirementId,
      [file.phase, fileCategoryFolders[file.category], file.fileName].join("/"),
    );
  }
  private row(requirementId: number, fileId: number) {
    this.requirements.get(requirementId);
    const row = this.db
      .prepare("SELECT * FROM requirement_files WHERE id=? AND is_deleted=0")
      .get(fileId) as FileRow | undefined;
    if (!row || row.requirement_id !== requirementId)
      throw new DomainError("NOT_FOUND", "文件不存在", 404);
    return toFile(row);
  }
  private unmarkFinal(
    id: number,
    phase: Stage,
    category: FileCategory,
    name: string,
  ) {
    this.db
      .prepare(
        "UPDATE requirement_files SET is_final=0, status='draft', version=version+1, updated_at=? WHERE requirement_id=? AND phase=? AND category=? AND name=? AND is_final=1",
      )
      .run(new Date().toISOString(), id, phase, category, name);
  }
  private touch(fileId: number) {
    this.db
      .prepare(
        "UPDATE requirement_files SET version=version+1, updated_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), fileId);
  }
  private ensureScope(id: number, phase: Stage) {
    // 自动创建该阶段的固定单文档（目前仅分析记录），已存在则跳过
    for (const category of stageFileCategories[phase]) {
      const doc = categoryDefaultDocs[category];
      if (!doc) continue;
      const existing = this.db
        .prepare(
          "SELECT id FROM requirement_files WHERE requirement_id=? AND phase=? AND category=? AND name=? AND is_deleted=0",
        )
        .get(id, phase, category, doc.name) as { id: number } | undefined;
      if (existing) continue;
      const path = this.path(id, phase, category, doc.fileName);
      if (!existsSync(path)) writeFileSync(path, doc.template, "utf8");
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO requirement_files(user_id, requirement_id, phase, category, name, file_name, kind, link_url, is_final, resource_type, storage_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'file', NULL, 1, 'file', 'local', 'final', ?, ?)",
        )
        .run(
          currentUserScope()?.userId ?? 0,
          id,
          phase,
          category,
          doc.name,
          doc.fileName,
          now,
          now,
        );
    }
  }
  private path(
    id: number,
    phase: Stage,
    category: FileCategory,
    fileName: string,
  ) {
    // 旧文件仍按分类目录推导；该目录可能尚未创建（如手工迁移的数据）
    return join(
      this.directory(id, [phase, fileCategoryFolders[category]]),
      fileName,
    );
  }
  private directory(id: number, segments: string[]) {
    // 需求根目录由统一解析器给出（可读目录名），段内路径仍逐级校验符号链接与越界
    return this.directories.resolve(
      id,
      segments.join("/"),
      true,
      "artifact_write",
    );
  }
}

export function contentVersion(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
export function assertResourceVersion(
  db: Database.Database,
  requirementId: number,
  actual: number | string,
  expected: number | string | undefined,
  current?: unknown,
): void {
  const requirement = assertRequirementAccess(db, requirementId);
  if (expected === undefined && requirement.project_id !== null)
    throw new DomainError(
      "VERSION_REQUIRED",
      "共享资料保存时必须提供 expectedVersion",
      428,
    );
  if (expected !== undefined && expected !== actual)
    throw new DomainError(
      requirement.project_id === null ? "CONFLICT" : "VERSION_CONFLICT",
      "内容已被更新，请读取最新版本后重试",
      409,
      { currentVersion: actual, current },
    );
}

export function assertResourceWritable(
  db: Database.Database,
  requirementId: number,
  authorUserId: number,
  isFinal: boolean,
): void {
  const requirement = assertRequirementAccess(
    db,
    requirementId,
    "artifact_write",
  );
  const scope = currentUserScope();
  if (requirement.project_id === null || !scope) return;
  const roles = projectRolesFor(db, requirement.project_id, scope.userId);
  if (
    !roles.some((role) => role === "owner" || role === "product_owner") &&
    (authorUserId !== scope.userId || isFinal)
  )
    throw new DomainError("FORBIDDEN", "只能编辑自己创建且未确认的产物", 403);
}
