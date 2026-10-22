import type Database from "better-sqlite3";
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
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DomainError, RequirementService } from "./requirements.js";
import { RequirementDirectoryResolver } from "./requirement-directory.js";
import { allowSystemOpen } from "../config/index.js";

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
    if (phase !== "all") this.ensureScope(id, phase);
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
    this.requirements.get(id);
    const data = requirementFileCreateSchema.parse(input);
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
            "INSERT INTO requirement_files(requirement_id, phase, category, name, file_name, kind, link_url, is_final, resource_type, storage_type, text_content, status, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'text', NULL, ?, 'text', 'database', ?, ?, ?, ?)",
          )
          .run(
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
            "INSERT INTO requirement_files(requirement_id, phase, category, name, file_name, kind, link_url, is_final, resource_type, storage_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'link', ?, ?, 'link', 'external', ?, ?, ?)",
          )
          .run(
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
        throw new DomainError("VALIDATION_ERROR", "文件大小应为 1 字节至 5 MB");
      const fileName = `${randomUUID()}${extensionFor(data.name, data.mime)}`;
      const directory = this.directory(id, ["files"]);
      const path = join(directory, fileName);
      writeFileSync(path, buffer, { flag: "wx" });
      // 相对路径由目录映射推导，保证与实际落盘的物理目录名一致
      const relativePath = `${this.directories.relativeRoot(id)}/files/${fileName}`;
      const result = this.db
        .prepare(
          "INSERT INTO requirement_files(requirement_id, phase, category, name, file_name, kind, link_url, is_final, resource_type, storage_type, relative_path, mime_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'file', NULL, ?, 'file', 'local', ?, ?, ?, ?, ?)",
        )
        .run(
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
        content: row.text_content,
      };
    }
    const path = this.resolveLocalPath(file);
    this.assertLocalFile(file, path);
    return { file, content: readFileSync(path, "utf8") };
  }
  saveContent(id: number, fileId: number, input: unknown) {
    const file = this.row(id, fileId);
    this.assertContentable(file);
    const { content } = requirementFileContentSchema.parse(input);
    if (file.resourceType === "text") {
      this.db
        .prepare(
          "UPDATE requirement_files SET text_content=?, updated_at=? WHERE id=?",
        )
        .run(content, new Date().toISOString(), fileId);
      return this.row(id, fileId);
    }
    const path = this.resolveLocalPath(file);
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new DomainError("INVALID_PATH", "文件不能是符号链接");
    writeFileSync(path, content, "utf8");
    this.touch(fileId);
    return this.row(id, fileId);
  }
  update(id: number, fileId: number, input: unknown) {
    const file = this.row(id, fileId);
    const patch = requirementFileUpdateSchema.parse(input);
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
          "UPDATE requirement_files SET name=?, description=?, status=?, is_final=?, updated_at=? WHERE id=?",
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
  }
  remove(id: number, fileId: number) {
    // 软删除：仅标记索引行，不触碰磁盘文件；关联关系随索引一并失效
    this.row(id, fileId);
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE requirement_files SET is_deleted=1, updated_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), fileId);
      this.db.prepare("DELETE FROM issue_assets WHERE asset_id=?").run(fileId);
    })();
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
  // 本地默认程序打开（补充文档 5.4）：总开关默认关闭，仅文件资源可触发
  openAsset(id: number, fileId: number) {
    if (!allowSystemOpen)
      throw new DomainError(
        "FORBIDDEN",
        "本地程序打开功能未启用（需设置 SUPERPM_ALLOW_SYSTEM_OPEN=1）",
      );
    const file = this.row(id, fileId);
    if (file.resourceType !== "file")
      throw new DomainError(
        "VALIDATION_ERROR",
        "链接与文本条目不支持本地程序打开",
      );
    const path = this.resolveLocalPath(file);
    this.assertLocalFile(file, path);
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
  // 链接条目没有文件体，正文/二进制/保存类操作一律拒绝
  private assertContentable(file: RequirementFile) {
    if (file.resourceType === "link")
      throw new DomainError("VALIDATION_ERROR", "链接条目没有文件内容");
  }
  // 本地文件存在性检测：缺失时标记 missing（不删行，不删文件）
  private assertLocalFile(file: RequirementFile, path: string) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
      if (file.status !== "missing")
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
    if (file.relativePath) return join(this.root, file.relativePath);
    const legacy = this.legacyPath(file);
    const relativePath = relative(this.root, legacy).split(sep).join("/");
    this.db
      .prepare("UPDATE requirement_files SET relative_path=? WHERE id=?")
      .run(relativePath, file.id);
    return legacy;
  }
  // 旧版推导规则：requirements/{id}/{phase}/{分类目录}/{file_name}
  private legacyPath(file: RequirementFile) {
    return this.path(
      file.requirementId,
      file.phase,
      file.category,
      file.fileName,
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
        "UPDATE requirement_files SET is_final=0, status='draft', updated_at=? WHERE requirement_id=? AND phase=? AND category=? AND name=? AND is_final=1",
      )
      .run(new Date().toISOString(), id, phase, category, name);
  }
  private touch(fileId: number) {
    this.db
      .prepare("UPDATE requirement_files SET updated_at=? WHERE id=?")
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
          "INSERT INTO requirement_files(requirement_id, phase, category, name, file_name, kind, link_url, is_final, resource_type, storage_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'file', NULL, 1, 'file', 'local', 'final', ?, ?)",
        )
        .run(id, phase, category, doc.name, doc.fileName, now, now);
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
    return this.directories.resolve(id, segments.join("/"), true);
  }
}
