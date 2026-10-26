import type Database from "better-sqlite3";
import {
  noteCreateSchema,
  noteListSchema,
  noteQuerySchema,
  noteSearchSchema,
  noteUpdateSchema,
  type Note,
  type NoteColor,
  type NoteConvertedTask,
  type NoteConvertResult,
  type NoteQueryResult,
  type NoteSummary,
  type NoteType,
} from "@superpm/shared";
import { DomainError } from "./requirements.js";
import { businessDate } from "./business-time.js";
import type { DailyTaskService } from "./daily-tasks.js";

interface NoteRow {
  id: number;
  title: string;
  content: string;
  type: NoteType;
  color: NoteColor;
  is_pinned: number;
  is_archived: number;
  converted_task_id: number | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  task_title: string | null;
  task_plan_date: string | null;
  task_deleted_at: string | null;
}

export interface NoteServiceOptions {
  now?: () => Date;
}

const selectColumns = `n.id, n.title, n.content, n.type, n.color, n.is_pinned,
  n.is_archived, n.converted_task_id, n.created_at, n.updated_at, n.archived_at,
  t.title AS task_title, t.plan_date AS task_plan_date, t.deleted_at AS task_deleted_at`;

const fromClause = `FROM notes n
  LEFT JOIN daily_tasks t ON t.id = n.converted_task_id`;

function taskTitleFallback(title: string, content: string) {
  const heading = title.trim();
  if (heading) return heading.slice(0, 200);
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.slice(0, 200) || "便签任务";
}

const NOTE_PREVIEW_CHARS = 120;

function notePreview(content: string): string {
  const text = content.replace(/\s+/g, " ").trim();
  return text.length > NOTE_PREVIEW_CHARS
    ? `${text.slice(0, NOTE_PREVIEW_CHARS)}…`
    : text;
}

function convertedTaskOf(row: NoteRow): NoteConvertedTask | null {
  return row.converted_task_id !== null && row.task_title !== null
    ? {
        id: row.converted_task_id,
        title: row.task_title,
        planDate: row.task_plan_date ?? "",
        exists: row.task_deleted_at === null,
      }
    : null;
}

function toNoteSummary(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    preview: notePreview(row.content),
    contentLength: row.content.length,
    type: row.type,
    color: row.color,
    isPinned: row.is_pinned === 1,
    isArchived: row.is_archived === 1,
    convertedTaskId: row.converted_task_id,
    convertedTask: convertedTaskOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toNote(row: NoteRow): Note {
  const { preview, contentLength, ...summary } = toNoteSummary(row);
  return { ...summary, content: row.content };
}

export class NoteService {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database.Database,
    private readonly dailyTasks: DailyTaskService,
    options: NoteServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  list(input: unknown): Note[] {
    const query = noteListSchema.parse(input);
    const rows = this.db
      .prepare(
        `SELECT ${selectColumns} ${fromClause}
         WHERE n.is_archived = ?
         ORDER BY n.is_pinned DESC, n.created_at DESC, n.id DESC`,
      )
      .all(query.archived ? 1 : 0) as NoteRow[];
    return rows.map(toNote);
  }

  /** MCP 分页列表：关键词只匹配标题，默认排除归档，返回不含正文的摘要投影。 */
  query(input: unknown): NoteQueryResult {
    return this.paginate(noteQuerySchema.parse(input), false);
  }

  /** MCP 全文检索：关键词同时匹配标题与正文，默认排除归档。 */
  search(input: unknown): NoteQueryResult {
    return this.paginate(noteSearchSchema.parse(input), true);
  }

  private paginate(
    query: {
      q: string;
      type?: NoteType;
      isPinned?: boolean;
      isArchived: boolean | "all";
      page: number;
      pageSize: number;
    },
    searchContent: boolean,
  ): NoteQueryResult {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.q) {
      const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
      if (searchContent) {
        clauses.push(
          "(n.title LIKE ? ESCAPE '\\' OR n.content LIKE ? ESCAPE '\\')",
        );
        params.push(pattern, pattern);
      } else {
        clauses.push("n.title LIKE ? ESCAPE '\\'");
        params.push(pattern);
      }
    }
    if (query.type) {
      clauses.push("n.type = ?");
      params.push(query.type);
    }
    if (query.isPinned !== undefined) {
      clauses.push("n.is_pinned = ?");
      params.push(query.isPinned ? 1 : 0);
    }
    if (query.isArchived !== "all") {
      clauses.push("n.is_archived = ?");
      params.push(query.isArchived ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM notes n ${where}`)
        .get(...params) as { count: number }
    ).count;
    const offset = (query.page - 1) * query.pageSize;
    const rows = this.db
      .prepare(
        `SELECT ${selectColumns} ${fromClause} ${where}
         ORDER BY n.is_pinned DESC, n.created_at DESC, n.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, offset) as NoteRow[];
    return {
      items: rows.map(toNoteSummary),
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasMore: offset + rows.length < total,
    };
  }

  get(id: number): Note {
    return toNote(this.row(id));
  }

  create(input: unknown): Note {
    const parsed = noteCreateSchema.parse(input);
    const timestamp = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO notes
          (title, content, type, color, is_pinned, is_archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        parsed.title,
        parsed.content,
        parsed.type,
        parsed.color,
        parsed.isPinned ? 1 : 0,
        timestamp,
        timestamp,
      );
    return this.get(Number(result.lastInsertRowid));
  }

  update(id: number, input: unknown): Note {
    const parsed = noteUpdateSchema.parse(input);
    return this.db.transaction(() => {
      this.row(id);
      const assignments: string[] = [];
      const values: (string | number | null)[] = [];
      const set = (column: string, value: string | number | null) => {
        assignments.push(`${column} = ?`);
        values.push(value);
      };
      if (parsed.title !== undefined) set("title", parsed.title);
      if (parsed.content !== undefined) set("content", parsed.content);
      if (parsed.type !== undefined) set("type", parsed.type);
      if (parsed.color !== undefined) set("color", parsed.color);
      if (parsed.isPinned !== undefined)
        set("is_pinned", parsed.isPinned ? 1 : 0);
      const timestamp = this.now().toISOString();
      if (parsed.isArchived !== undefined) {
        set("is_archived", parsed.isArchived ? 1 : 0);
        set("archived_at", parsed.isArchived ? timestamp : null);
      }
      set("updated_at", timestamp);
      this.db
        .prepare(`UPDATE notes SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...values, id);
      return this.get(id);
    })();
  }

  remove(id: number): void {
    this.row(id);
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  }

  /** 重复转换在目标仍存在时返回原任务，不重复创建；目标任务被删后可再次转换。 */
  convert(id: number): NoteConvertResult {
    return this.db.transaction(() => {
      const note = this.get(id);
      if (note.convertedTask?.exists)
        return {
          note,
          task: {
            id: note.convertedTask.id,
            title: note.convertedTask.title,
            planDate: note.convertedTask.planDate,
          },
          created: false,
        };
      const task = this.dailyTasks.create({
        title: taskTitleFallback(note.title, note.content),
        description: note.content.slice(0, 4000),
        planDate: businessDate(this.now()),
        estimatedMinutes: 30,
      });
      this.db
        .prepare(
          "UPDATE notes SET converted_task_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(task.id, this.now().toISOString(), id);
      return {
        note: this.get(id),
        task: { id: task.id, title: task.title, planDate: task.planDate },
        created: true,
      };
    })();
  }

  private row(id: number): NoteRow {
    const row = this.db
      .prepare(`SELECT ${selectColumns} ${fromClause} WHERE n.id = ?`)
      .get(id) as NoteRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "便签不存在", 404);
    return row;
  }
}
