import type Database from "better-sqlite3";
import {
  onlineToolCreateSchema,
  onlineToolOrderSchema,
  onlineToolUpdateSchema,
  type OnlineTool,
  type OnlineToolCategory,
  type OnlineToolIconKey,
} from "@superpm/shared";
import { DomainError } from "./requirements.js";

interface OnlineToolRow {
  id: number;
  name: string;
  url: string;
  icon: string | null;
  category: string;
  description: string;
  enabled: number;
  is_favorite: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const selectColumns = `id, name, url, icon, category, description, enabled,
  is_favorite, sort_order, created_at, updated_at`;

function toOnlineTool(row: OnlineToolRow): OnlineTool {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    icon: row.icon as OnlineToolIconKey | null,
    category: row.category as OnlineToolCategory,
    description: row.description,
    enabled: row.enabled === 1,
    isFavorite: row.is_favorite === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OnlineToolService {
  constructor(private readonly db: Database.Database) {}

  list(): OnlineTool[] {
    const rows = this.db
      .prepare(
        `SELECT ${selectColumns} FROM online_tools
         ORDER BY is_favorite DESC, sort_order ASC, id ASC`,
      )
      .all() as OnlineToolRow[];
    return rows.map(toOnlineTool);
  }

  favorites(): OnlineTool[] {
    const rows = this.db
      .prepare(
        `SELECT ${selectColumns} FROM online_tools
         WHERE enabled = 1 AND is_favorite = 1
         ORDER BY sort_order ASC, id ASC`,
      )
      .all() as OnlineToolRow[];
    return rows.map(toOnlineTool);
  }

  get(id: number): OnlineTool {
    return toOnlineTool(this.row(id));
  }

  create(input: unknown): OnlineTool {
    const parsed = onlineToolCreateSchema.parse(input);
    this.assertNameAvailable(parsed.name);
    const timestamp = new Date().toISOString();
    const id = this.db.transaction(() => {
      const next = this.db
        .prepare(
          "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM online_tools",
        )
        .get() as { next: number };
      const result = this.db
        .prepare(
          `INSERT INTO online_tools
            (name, url, icon, category, description, enabled, is_favorite,
             sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.name,
          parsed.url,
          parsed.icon,
          parsed.category,
          parsed.description,
          parsed.enabled ? 1 : 0,
          parsed.isFavorite ? 1 : 0,
          next.next,
          timestamp,
          timestamp,
        );
      return Number(result.lastInsertRowid);
    })();
    return this.get(id);
  }

  update(id: number, input: unknown): OnlineTool {
    const parsed = onlineToolUpdateSchema.parse(input);
    return this.db.transaction(() => {
      const existing = this.row(id);
      if (parsed.name !== undefined && parsed.name !== existing.name)
        this.assertNameAvailable(parsed.name, id);
      const assignments: string[] = [];
      const values: (string | number | null)[] = [];
      const set = (column: string, value: string | number | null) => {
        assignments.push(`${column} = ?`);
        values.push(value);
      };
      if (parsed.name !== undefined) set("name", parsed.name);
      if (parsed.url !== undefined) set("url", parsed.url);
      if (parsed.icon !== undefined) set("icon", parsed.icon);
      if (parsed.category !== undefined) set("category", parsed.category);
      if (parsed.description !== undefined)
        set("description", parsed.description);
      if (parsed.enabled !== undefined) set("enabled", parsed.enabled ? 1 : 0);
      if (parsed.isFavorite !== undefined)
        set("is_favorite", parsed.isFavorite ? 1 : 0);
      if (parsed.sortOrder !== undefined) set("sort_order", parsed.sortOrder);
      set("updated_at", new Date().toISOString());
      this.db
        .prepare(
          `UPDATE online_tools SET ${assignments.join(", ")} WHERE id = ?`,
        )
        .run(...values, id);
      return this.get(id);
    })();
  }

  remove(id: number): void {
    this.row(id);
    this.db.prepare("DELETE FROM online_tools WHERE id = ?").run(id);
  }

  reorder(input: unknown): { ok: true } {
    const parsed = onlineToolOrderSchema.parse(input);
    this.db.transaction(() => {
      const statement = this.db.prepare(
        "SELECT id, is_favorite FROM online_tools WHERE id = ?",
      );
      for (const id of parsed.ids) {
        const row = statement.get(id) as
          { id: number; is_favorite: number } | undefined;
        if (!row) throw new DomainError("NOT_FOUND", "在线工具不存在", 404);
        if (row.is_favorite !== 1)
          throw new DomainError(
            "VALIDATION_ERROR",
            "只能调整快捷工具箱中工具的排序",
          );
      }
      const update = this.db.prepare(
        "UPDATE online_tools SET sort_order = ?, updated_at = ? WHERE id = ?",
      );
      const timestamp = new Date().toISOString();
      parsed.ids.forEach((id, index) => update.run(index, timestamp, id));
    })();
    return { ok: true };
  }

  private row(id: number): OnlineToolRow {
    const row = this.db
      .prepare(`SELECT ${selectColumns} FROM online_tools WHERE id = ?`)
      .get(id) as OnlineToolRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "在线工具不存在", 404);
    return row;
  }

  private assertNameAvailable(name: string, exceptId?: number) {
    const row = this.db
      .prepare("SELECT id FROM online_tools WHERE name = ?")
      .get(name) as { id: number } | undefined;
    if (row && row.id !== exceptId)
      throw new DomainError("CONFLICT", "工具名称已存在，请换一个名称", 409);
  }
}
