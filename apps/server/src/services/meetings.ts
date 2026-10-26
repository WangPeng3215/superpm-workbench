import type Database from "better-sqlite3";
import {
  meetingCreateSchema,
  meetingListSchema,
  meetingUpdateSchema,
  type Meeting,
  type MeetingRequirementRef,
  type MeetingSummary,
  type MeetingType,
} from "@superpm/shared";
import { DomainError } from "./requirements.js";

interface MeetingRow {
  id: number;
  title: string;
  meeting_type: string;
  meeting_time: string;
  content_html: string;
  created_at: string;
  updated_at: string;
}

interface MeetingRequirementRow {
  meeting_id: number;
  id: number;
  requirement_no: string;
  name: string;
}

const selectColumns = `id, title, meeting_type, meeting_time, content_html,
  created_at, updated_at`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

// 列表摘要只保留纯文本，避免把整段富文本传给列表接口。
function htmlSummary(html: string, maxLength = 120): string {
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export class MeetingService {
  constructor(private readonly db: Database.Database) {}

  list(input: unknown): MeetingSummary[] {
    const query = meetingListSchema.parse(input);
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.q) {
      clauses.push("title LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(query.q)}%`);
    }
    if (query.type) {
      clauses.push("meeting_type = ?");
      params.push(query.type);
    }
    const rows = this.db
      .prepare(
        `SELECT ${selectColumns} FROM meetings
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY meeting_time DESC, id DESC`,
      )
      .all(...params) as MeetingRow[];
    const refs = this.requirementsFor(rows.map((row) => row.id));
    return rows.map((row) => this.summary(row, refs.get(row.id) ?? []));
  }

  get(id: number): Meeting {
    const row = this.row(id);
    const refs = this.requirementsFor([id]).get(id) ?? [];
    return { ...this.summary(row, refs), contentHtml: row.content_html };
  }

  create(input: unknown): Meeting {
    const parsed = meetingCreateSchema.parse(input);
    const id = this.db.transaction(() => {
      this.assertRequirements(parsed.requirementIds);
      const timestamp = new Date().toISOString();
      const result = this.db
        .prepare(
          `INSERT INTO meetings
            (title, meeting_type, meeting_time, content_html, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.title,
          parsed.type,
          parsed.meetingTime,
          parsed.contentHtml,
          timestamp,
          timestamp,
        );
      const meetingId = Number(result.lastInsertRowid);
      this.replaceRequirements(meetingId, parsed.requirementIds, timestamp);
      return meetingId;
    })();
    return this.get(id);
  }

  update(id: number, input: unknown): Meeting {
    const parsed = meetingUpdateSchema.parse(input);
    this.db.transaction(() => {
      this.row(id);
      if (parsed.requirementIds !== undefined)
        this.assertRequirements(parsed.requirementIds);
      const assignments: string[] = [];
      const values: (string | number)[] = [];
      const set = (column: string, value: string | number) => {
        assignments.push(`${column} = ?`);
        values.push(value);
      };
      if (parsed.title !== undefined) set("title", parsed.title);
      if (parsed.type !== undefined) set("meeting_type", parsed.type);
      if (parsed.meetingTime !== undefined)
        set("meeting_time", parsed.meetingTime);
      if (parsed.contentHtml !== undefined)
        set("content_html", parsed.contentHtml);
      const timestamp = new Date().toISOString();
      set("updated_at", timestamp);
      this.db
        .prepare(`UPDATE meetings SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...values, id);
      if (parsed.requirementIds !== undefined)
        this.replaceRequirements(id, parsed.requirementIds, timestamp);
    })();
    return this.get(id);
  }

  remove(id: number): void {
    this.row(id);
    this.db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
  }

  private row(id: number): MeetingRow {
    const row = this.db
      .prepare(`SELECT ${selectColumns} FROM meetings WHERE id = ?`)
      .get(id) as MeetingRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "会议记录不存在", 404);
    return row;
  }

  private summary(
    row: MeetingRow,
    requirements: MeetingRequirementRef[],
  ): MeetingSummary {
    return {
      id: row.id,
      title: row.title,
      type: row.meeting_type as MeetingType,
      meetingTime: row.meeting_time,
      summary: htmlSummary(row.content_html),
      requirementCount: requirements.length,
      requirements,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private requirementsFor(
    meetingIds: number[],
  ): Map<number, MeetingRequirementRef[]> {
    const map = new Map<number, MeetingRequirementRef[]>(
      meetingIds.map((id) => [id, []]),
    );
    if (!meetingIds.length) return map;
    const placeholders = meetingIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT mr.meeting_id, r.id, r.requirement_no, r.name
         FROM meeting_requirements mr
         JOIN requirements r ON r.id = mr.requirement_id
         WHERE mr.meeting_id IN (${placeholders}) AND r.deleted_at IS NULL
         ORDER BY mr.created_at ASC, r.id ASC`,
      )
      .all(...meetingIds) as MeetingRequirementRow[];
    for (const row of rows) {
      map.get(row.meeting_id)?.push({
        id: row.id,
        requirementNo: row.requirement_no,
        name: row.name,
      });
    }
    return map;
  }

  private assertRequirements(ids: number[]) {
    if (!ids.length) return;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id FROM requirements
         WHERE deleted_at IS NULL AND id IN (${placeholders})`,
      )
      .all(...ids) as { id: number }[];
    if (rows.length !== ids.length)
      throw new DomainError(
        "VALIDATION_ERROR",
        "关联的需求不存在或已被删除，请重新选择",
      );
  }

  private replaceRequirements(
    meetingId: number,
    ids: number[],
    timestamp: string,
  ) {
    this.db
      .prepare("DELETE FROM meeting_requirements WHERE meeting_id = ?")
      .run(meetingId);
    const insert = this.db.prepare(
      `INSERT INTO meeting_requirements (meeting_id, requirement_id, created_at)
       VALUES (?, ?, ?)`,
    );
    for (const requirementId of ids)
      insert.run(meetingId, requirementId, timestamp);
  }
}
