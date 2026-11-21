import type Database from "better-sqlite3";
import { z } from "zod";
import { isSafeExternalUrl } from "@superpm/shared";
import { assertProjectAccess, currentActor } from "./project-access.js";
import { DomainError } from "./domain-error.js";
import { currentUserScope } from "../db/scope.js";

const documentKind = z.enum(["note", "decision", "meeting", "link"]);
const createSchema = z
  .object({
    kind: documentKind,
    title: z.string().trim().min(1).max(200),
    content: z.string().max(2_000_000).optional(),
    url: z.string().trim().max(4000).optional(),
    meetingTime: z.string().trim().max(100).optional(),
  })
  .strict();
const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().max(2_000_000).optional(),
    url: z.string().trim().max(4000).optional(),
    meetingTime: z.string().trim().max(100).nullable().optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
const copyMeetingSchema = z
  .object({
    meetingId: z.number().int().positive(),
    confirmed: z.literal(true),
  })
  .strict();

type DocumentKind = z.infer<typeof documentKind>;
type DocumentRow = {
  id: number;
  project_id: number;
  kind: DocumentKind;
  title: string;
  content: string;
  url: string | null;
  meeting_time: string | null;
  version: number;
  created_by: number;
  updated_by: number;
  created_at: string;
  updated_at: string;
};
type ArtifactItem = {
  id: number;
  kind: "file" | "link";
  requirementId: number;
  requirementNo: string;
  requirementName: string;
  name: string;
  relativePath?: string;
  url?: string;
  description?: string | null;
  version?: number;
  status?: string;
  isFinal?: boolean;
  updatedAt?: string;
};

const columns = `id, project_id, kind, title, content, url, meeting_time, version,
  created_by, updated_by, created_at, updated_at`;

function toDocument(row: DocumentRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    url: row.url,
    meetingTime: row.meeting_time,
    version: row.version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertUrl(url: string | undefined) {
  if (url !== undefined && !isSafeExternalUrl(url))
    throw new DomainError("VALIDATION_ERROR", "链接地址必须是安全的 http(s) 地址");
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export class ProjectDocumentService {
  constructor(private readonly db: Database.Database) {}

  list(projectId: number, input: unknown = {}) {
    assertProjectAccess(this.db, projectId, "read", true);
    const query = z
      .object({ kind: documentKind.optional(), q: z.string().trim().max(100).optional() })
      .strict()
      .parse(input);
    const predicates = ["project_id=?"];
    const params: unknown[] = [projectId];
    if (query.kind) {
      predicates.push("kind=?");
      params.push(query.kind);
    }
    if (query.q) {
      predicates.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
      const q = `%${escapeLike(query.q)}%`;
      params.push(q, q);
    }
    const rows = this.db
      .prepare(`SELECT ${columns} FROM project_documents WHERE ${predicates.join(" AND ")} ORDER BY updated_at DESC, id DESC`)
      .all(...params) as DocumentRow[];
    return { items: rows.map(toDocument) };
  }

  get(projectId: number, documentId: number) {
    assertProjectAccess(this.db, projectId, "read", true);
    const row = this.row(projectId, documentId);
    return toDocument(row);
  }

  create(projectId: number, input: unknown) {
    const access = this.writer(projectId);
    const data = createSchema.parse(input);
    assertUrl(data.url);
    if (data.kind === "link" && !data.url)
      throw new DomainError("VALIDATION_ERROR", "外部链接必须填写 URL");
    if (data.kind !== "link" && data.url !== undefined)
      throw new DomainError("VALIDATION_ERROR", "只有链接资料允许填写 URL");
    if (data.kind === "meeting" && !data.meetingTime)
      throw new DomainError("VALIDATION_ERROR", "会议纪要必须填写会议时间");
    if (data.kind !== "meeting" && data.meetingTime !== undefined)
      throw new DomainError("VALIDATION_ERROR", "只有会议纪要允许填写会议时间");
    const now = new Date().toISOString();
    const id = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO project_documents(project_id,kind,title,content,url,meeting_time,created_by,updated_by,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          projectId,
          data.kind,
          data.title,
          data.content ?? "",
          data.url ?? null,
          data.meetingTime ?? null,
          access.actor.id,
          access.actor.id,
          now,
          now,
        );
      const documentId = Number(result.lastInsertRowid);
      this.event(projectId, "project_document_created", { documentId, kind: data.kind });
      return documentId;
    })();
    return this.get(projectId, id);
  }

  update(projectId: number, documentId: number, input: unknown) {
    const access = this.writer(projectId);
    const data = updateSchema.parse(input);
    const current = this.row(projectId, documentId);
    if (current.version !== data.expectedVersion)
      throw new DomainError("VERSION_CONFLICT", "资料已被其他成员更新，请刷新后重试", 409, { current: toDocument(current) });
    assertUrl(data.url);
    if (current.kind === "link" && data.url === undefined && !current.url)
      throw new DomainError("VALIDATION_ERROR", "外部链接必须填写 URL");
    if (current.kind === "link" && data.content !== undefined)
      throw new DomainError("VALIDATION_ERROR", "链接资料不支持正文");
    if (current.kind !== "link" && data.url !== undefined)
      throw new DomainError("VALIDATION_ERROR", "只有链接资料允许填写 URL");
    if (current.kind === "meeting" && data.meetingTime === null)
      throw new DomainError("VALIDATION_ERROR", "会议纪要必须保留会议时间");
    if (current.kind !== "meeting" && data.meetingTime !== undefined)
      throw new DomainError("VALIDATION_ERROR", "只有会议纪要允许填写会议时间");
    const assignments: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => { assignments.push(`${column}=?`); values.push(value); };
    if (data.title !== undefined) set("title", data.title);
    if (data.content !== undefined) set("content", data.content);
    if (data.url !== undefined) set("url", data.url);
    if (data.meetingTime !== undefined) set("meeting_time", data.meetingTime);
    set("updated_by", access.actor.id);
    set("updated_at", new Date().toISOString());
    assignments.push("version=version+1");
    this.db.transaction(() => {
      const result = this.db
        .prepare(`UPDATE project_documents SET ${assignments.join(",")} WHERE id=? AND project_id=? AND version=?`)
        .run(...values, documentId, projectId, data.expectedVersion);
      if (result.changes !== 1) throw new DomainError("VERSION_CONFLICT", "资料已被其他成员更新，请刷新后重试", 409);
      this.event(projectId, "project_document_updated", { documentId });
    })();
    return this.get(projectId, documentId);
  }

  remove(projectId: number, documentId: number, input: unknown) {
    const access = this.writer(projectId);
    const data = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(input ?? {});
    const current = this.row(projectId, documentId);
    if (current.version !== data.expectedVersion)
      throw new DomainError("VERSION_CONFLICT", "资料已被其他成员更新，请刷新后重试", 409, { current: toDocument(current) });
    this.db.transaction(() => {
      const result = this.db.prepare("DELETE FROM project_documents WHERE id=? AND project_id=? AND version=?").run(documentId, projectId, data.expectedVersion);
      if (result.changes !== 1) throw new DomainError("VERSION_CONFLICT", "资料已被其他成员更新，请刷新后重试", 409);
      this.event(projectId, "project_document_deleted", { documentId });
    })();
    return undefined;
  }

  copyMeeting(projectId: number, input: unknown) {
    const access = this.writer(projectId);
    const data = copyMeetingSchema.parse(input);
    const scope = currentUserScope();
    const meeting = this.db
      .prepare(access.actor.isAdmin
        ? "SELECT id,title,meeting_time,content_html FROM meetings WHERE id=?"
        : "SELECT id,title,meeting_time,content_html FROM meetings WHERE id=? AND user_id=?")
      .get(...(access.actor.isAdmin ? [data.meetingId] : [data.meetingId, scope?.userId ?? -1])) as
      { id: number; title: string; meeting_time: string; content_html: string } | undefined;
    if (!meeting)
      throw new DomainError("NOT_FOUND", "会议记录不存在", 404);
    const now = new Date().toISOString();
    const id = this.db.transaction(() => {
      const result = this.db.prepare(
        `INSERT INTO project_documents(project_id,kind,title,content,meeting_time,created_by,updated_by,created_at,updated_at)
         VALUES(?, 'meeting', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(projectId, meeting.title, meeting.content_html, meeting.meeting_time, access.actor.id, access.actor.id, now, now);
      const documentId = Number(result.lastInsertRowid);
      this.event(projectId, "project_meeting_copied", { documentId });
      return documentId;
    })();
    return this.get(projectId, id);
  }

  artifacts(projectId: number) {
    assertProjectAccess(this.db, projectId, "read", true);
    const requirements = this.db.prepare(
      `SELECT id, requirement_no, name FROM requirements WHERE project_id=? AND deleted_at IS NULL ORDER BY id`,
    ).all(projectId) as { id: number; requirement_no: string; name: string }[];
    if (!requirements.length) return { items: [] as ArtifactItem[] };
    const ids = requirements.map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    const byRequirement = new Map(requirements.map((r) => [r.id, r]));
    const items: ArtifactItem[] = [];
    const files = this.db.prepare(
      `SELECT id,requirement_id,name,relative_path,version,status,is_final,updated_at FROM artifact_nodes WHERE requirement_id IN (${marks}) AND node_type='file' ORDER BY id`,
    ).all(...ids) as { id: number; requirement_id: number; name: string; relative_path: string; version: number; status: string; is_final: number; updated_at: string }[];
    for (const file of files) {
      const requirement = byRequirement.get(file.requirement_id);
      if (!requirement) continue;
      items.push({ id: file.id, kind: "file", requirementId: requirement.id, requirementNo: requirement.requirement_no, requirementName: requirement.name, name: file.name, relativePath: file.relative_path, version: file.version, status: file.status, isFinal: Boolean(file.is_final), updatedAt: file.updated_at });
    }
    const links = this.db.prepare(
      `SELECT id,requirement_id,name,url,description,version,is_final,updated_at FROM artifact_links WHERE requirement_id IN (${marks}) ORDER BY id`,
    ).all(...ids) as { id: number; requirement_id: number; name: string; url: string; description: string | null; version: number; is_final: number; updated_at: string }[];
    for (const link of links) {
      const requirement = byRequirement.get(link.requirement_id);
      if (!requirement) continue;
      items.push({ id: link.id, kind: "link", requirementId: requirement.id, requirementNo: requirement.requirement_no, requirementName: requirement.name, name: link.name, url: link.url, description: link.description, version: link.version, isFinal: Boolean(link.is_final), updatedAt: link.updated_at });
    }
    return { items };
  }

  private writer(projectId: number) {
    const access = assertProjectAccess(this.db, projectId, "read", true);
    if (!access.roles.includes("owner") && !access.roles.includes("product_owner"))
      throw new DomainError("FORBIDDEN", "当前项目角色不允许编辑资料", 403);
    if (access.project.archived_at || ["closed", "cancelled"].includes(access.project.status))
      throw new DomainError("PROJECT_READ_ONLY", "项目当前为只读状态", 409);
    return access;
  }

  private row(projectId: number, documentId: number): DocumentRow {
    const row = this.db.prepare(`SELECT ${columns} FROM project_documents WHERE id=? AND project_id=?`).get(documentId, projectId) as DocumentRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "项目资料不存在", 404);
    return row;
  }

  private event(projectId: number, action: string, payload: Record<string, unknown>) {
    const actor = currentActor(this.db);
    this.db.prepare(
      "INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES(?,?,?,?,?,?)",
    ).run(projectId, action, actor.id, actor.display_name || actor.username, JSON.stringify(payload), new Date().toISOString());
  }
}
