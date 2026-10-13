import type Database from "better-sqlite3";
import {
  analysisRecordName,
  fileCategories,
  fileCategoryFolders,
  fileCategoryLabels,
  requirementFileContentSchema,
  requirementFileCreateSchema,
  requirementFileUpdateSchema,
  type FileCategory,
  type RequirementFile,
  type RequirementFileList,
  type Stage,
} from "@superpm/shared";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError, RequirementService } from "./requirements.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const RECORD_FILE = "analysis-record.md";
const RECORD_TEMPLATE = [
  "# 需求分析记录",
  "",
  "## 背景",
  "",
  "## 目标",
  "",
  "## 范围与边界",
  "",
  "## 待确认事项",
  "",
].join("\n");
const MIME_BY_EXTENSION: Record<string, string> = {
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
};
interface FileRow {
  id: number;
  requirement_id: number;
  phase: Stage;
  category: FileCategory;
  name: string;
  file_name: string;
  is_final: number;
  created_at: string;
  updated_at: string;
}
function toFile(row: FileRow): RequirementFile {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    phase: row.phase,
    category: row.category,
    name: row.name,
    fileName: row.file_name,
    isFinal: row.is_final === 1,
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
  constructor(
    private db: Database.Database,
    private root: string,
    private requirements: RequirementService,
  ) {}
  list(id: number, phase: Stage, all: boolean): RequirementFileList {
    this.requirements.get(id);
    this.ensureScope(id, phase);
    const rows = this.db
      .prepare(
        "SELECT * FROM requirement_files WHERE requirement_id=? AND phase=? ORDER BY category, is_final DESC, updated_at DESC, id DESC",
      )
      .all(id, phase) as FileRow[];
    const files = rows.map(toFile);
    return {
      phase,
      all,
      groups: fileCategories.map((category) => {
        const scoped = files.filter((file) => file.category === category);
        return {
          category,
          label: fileCategoryLabels[category],
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
    const buffer = Buffer.from(data.data, "base64");
    if (!buffer.length || buffer.length > MAX_FILE_BYTES)
      throw new DomainError("VALIDATION_ERROR", "文件大小应为 1 字节至 5 MB");
    this.ensureScope(id, data.phase);
    const fileName = `${randomUUID()}${extensionFor(data.name, data.mime)}`;
    const path = this.path(id, data.phase, data.category, fileName);
    writeFileSync(path, buffer, { flag: "wx" });
    return this.db.transaction(() => {
      if (data.isFinal)
        this.unmarkFinal(id, data.phase, data.category, data.name);
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          "INSERT INTO requirement_files(requirement_id, phase, category, name, file_name, is_final, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          data.phase,
          data.category,
          data.name,
          fileName,
          data.isFinal ? 1 : 0,
          now,
          now,
        );
      return this.row(id, Number(result.lastInsertRowid));
    })();
  }
  content(id: number, fileId: number) {
    const file = this.row(id, fileId);
    const path = this.path(id, file.phase, file.category, file.fileName);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink())
      throw new DomainError("NOT_FOUND", "文件内容不存在", 404);
    return { file, content: readFileSync(path, "utf8") };
  }
  saveContent(id: number, fileId: number, input: unknown) {
    const file = this.row(id, fileId);
    const { content } = requirementFileContentSchema.parse(input);
    const path = this.path(id, file.phase, file.category, file.fileName);
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new DomainError("INVALID_PATH", "文件不能是符号链接");
    writeFileSync(path, content, "utf8");
    this.touch(fileId);
    return this.row(id, fileId);
  }
  update(id: number, fileId: number, input: unknown) {
    const file = this.row(id, fileId);
    const patch = requirementFileUpdateSchema.parse(input);
    return this.db.transaction(() => {
      if (patch.isFinal)
        this.unmarkFinal(
          id,
          file.phase,
          file.category,
          patch.name ?? file.name,
        );
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE requirement_files SET name=?, is_final=?, updated_at=? WHERE id=?",
        )
        .run(
          patch.name ?? file.name,
          patch.isFinal === undefined
            ? file.isFinal
              ? 1
              : 0
            : patch.isFinal
              ? 1
              : 0,
          now,
          fileId,
        );
      return this.row(id, fileId);
    })();
  }
  remove(id: number, fileId: number) {
    const file = this.row(id, fileId);
    const path = this.path(id, file.phase, file.category, file.fileName);
    if (existsSync(path) && !lstatSync(path).isSymbolicLink()) unlinkSync(path);
    this.db.prepare("DELETE FROM requirement_files WHERE id=?").run(fileId);
  }
  raw(id: number, fileId: number) {
    const file = this.row(id, fileId);
    const path = this.path(id, file.phase, file.category, file.fileName);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink())
      throw new DomainError("NOT_FOUND", "文件不存在", 404);
    const extension = extname(file.fileName).slice(1).toLowerCase();
    return {
      data: readFileSync(path),
      mime: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
    };
  }
  private row(requirementId: number, fileId: number) {
    this.requirements.get(requirementId);
    const row = this.db
      .prepare("SELECT * FROM requirement_files WHERE id=?")
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
        "UPDATE requirement_files SET is_final=0, updated_at=? WHERE requirement_id=? AND phase=? AND category=? AND name=? AND is_final=1",
      )
      .run(new Date().toISOString(), id, phase, category, name);
  }
  private touch(fileId: number) {
    this.db
      .prepare("UPDATE requirement_files SET updated_at=? WHERE id=?")
      .run(new Date().toISOString(), fileId);
  }
  private ensureScope(id: number, phase: Stage) {
    if (phase !== "analysis") {
      this.directory(id, [phase]);
      return;
    }
    for (const category of fileCategories)
      this.directory(id, [phase, fileCategoryFolders[category]]);
    const existing = this.db
      .prepare(
        "SELECT id FROM requirement_files WHERE requirement_id=? AND phase='analysis' AND category='record' AND name=?",
      )
      .get(id, analysisRecordName) as { id: number } | undefined;
    if (existing) return;
    const path = this.path(id, "analysis", "record", RECORD_FILE);
    if (!existsSync(path)) writeFileSync(path, RECORD_TEMPLATE, "utf8");
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO requirement_files(requirement_id, phase, category, name, file_name, is_final, created_at, updated_at) VALUES (?, 'analysis', 'record', ?, ?, 1, ?, ?)",
      )
      .run(id, analysisRecordName, RECORD_FILE, now, now);
  }
  private path(
    id: number,
    phase: Stage,
    category: FileCategory,
    fileName: string,
  ) {
    return join(
      this.directory(id, [phase, fileCategoryFolders[category]]),
      fileName,
    );
  }
  private directory(id: number, segments: string[]) {
    const root = realpathSync(this.root);
    let current = root;
    for (const segment of ["requirements", String(id), ...segments]) {
      current = join(current, segment);
      if (!existsSync(current)) mkdirSync(current);
      if (lstatSync(current).isSymbolicLink())
        throw new DomainError("INVALID_PATH", "工作区目录不能是符号链接");
      const resolved = realpathSync(current);
      const distance = relative(root, resolved);
      if (distance.startsWith("..") || isAbsolute(distance))
        throw new DomainError("INVALID_PATH", "工作区路径无效");
    }
    return current;
  }
}
