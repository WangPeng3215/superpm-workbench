import {
  and,
  asc,
  desc,
  eq,
  isNull,
  inArray,
  gte,
  lte,
  type SQL,
} from "drizzle-orm";
import { dateFields } from "@superpm/shared";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import type Database from "better-sqlite3";
import type {
  RequirementCreateParsed,
  RequirementListParsed,
} from "@superpm/shared";
import { requirements, stageHistory, requirementAudit } from "../db/schema.js";
import { decodeDescription, encodeDescription } from "./description.js";

type MutableFields = Partial<RequirementCreateParsed>;
function decodeRequirement(row: typeof requirements.$inferSelect) {
  return {
    ...row,
    description: decodeDescription(row.description),
    descriptionHtml: row.descriptionHtml ?? "",
  };
}
export class RequirementsRepository {
  private readonly orm: BetterSQLite3Database;
  constructor(db: Database.Database) {
    this.orm = drizzle(db);
  }
  get(id: number) {
    const row = this.orm
      .select()
      .from(requirements)
      .where(and(eq(requirements.id, id), isNull(requirements.deletedAt)))
      .get();
    return row ? decodeRequirement(row) : undefined;
  }
  children(id: number) {
    return this.orm
      .select()
      .from(requirements)
      .where(and(eq(requirements.parentId, id), isNull(requirements.deletedAt)))
      .orderBy(asc(requirements.id))
      .all()
      .map(decodeRequirement);
  }
  references(ids: number[]) {
    if (!ids.length) return [];
    return this.orm
      .select({
        id: requirements.id,
        requirementNo: requirements.requirementNo,
        name: requirements.name,
        deletedAt: requirements.deletedAt,
      })
      .from(requirements)
      .where(inArray(requirements.id, ids))
      .all();
  }
  insert(data: RequirementCreateParsed) {
    const last = this.orm
      .select({ id: requirements.id, number: requirements.requirementNo })
      .from(requirements)
      .orderBy(desc(requirements.id))
      .limit(1)
      .get();
    const next = last ? Number(last.number.slice(4)) + 1 : 1;
    const now = new Date().toISOString();
    const row = this.orm
      .insert(requirements)
      .values({
        ...data,
        description: encodeDescription(data.description),
        descriptionHtml: data.descriptionHtml,
        requirementNo: `REQ-${String(next).padStart(4, "0")}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return decodeRequirement(row);
  }
  update(id: number, patch: MutableFields) {
    const storagePatch =
      patch.description === undefined
        ? patch
        : { ...patch, description: encodeDescription(patch.description) };
    const row = this.orm
      .update(requirements)
      .set({ ...storagePatch, updatedAt: new Date().toISOString() })
      .where(eq(requirements.id, id))
      .returning()
      .get();
    return decodeRequirement(row);
  }
  softDelete(id: number) {
    const now = new Date().toISOString();
    this.orm
      .update(requirements)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(requirements.id, id))
      .run();
  }
  list(query: RequirementListParsed) {
    // Determine matching IDs first; grouping happens before pagination, so a
    // matching child can bring its parent onto a page without being orphaned.
    const filters: SQL[] = [isNull(requirements.deletedAt)];
    for (const key of ["type", "priority", "status", "currentStage"] as const) {
      if (query[key]) filters.push(eq(requirements[key], query[key]!));
    }
    for (const key of dateFields) {
      const from = query[`${key}From`];
      const to = query[`${key}To`];
      if (from) filters.push(gte(requirements[key], from));
      if (to) filters.push(lte(requirements[key], to));
    }
    const candidates = this.orm
      .select()
      .from(requirements)
      .where(and(...filters))
      .all();
    const matched = candidates.filter(
      (item) =>
        !query.q ||
        `${item.requirementNo} ${item.name}`
          .toLocaleLowerCase()
          .includes(query.q.toLocaleLowerCase()),
    );
    const rootIds = [
      ...new Set(matched.map((item) => item.parentId ?? item.id)),
    ];
    if (!rootIds.length)
      return {
        items: [],
        total: 0,
        matchedCount: 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    const order = query.sortOrder === "asc" ? asc : desc;
    const roots = this.orm
      .select()
      .from(requirements)
      .where(
        and(inArray(requirements.id, rootIds), isNull(requirements.deletedAt)),
      )
      .orderBy(order(requirements[query.sortBy]), asc(requirements.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();
    const matchedIds = new Set(matched.map((item) => item.id));
    const pageIds = roots.map((item) => item.id);
    const children = pageIds.length
      ? this.orm
          .select()
          .from(requirements)
          .where(
            and(
              inArray(requirements.parentId, pageIds),
              isNull(requirements.deletedAt),
            ),
          )
          .orderBy(order(requirements[query.sortBy]), asc(requirements.id))
          .all()
      : [];
    const items = roots.map((root) => ({
      ...decodeRequirement(root),
      children: children
        .filter(
          (child) =>
            child.parentId === root.id &&
            (matchedIds.has(root.id) || matchedIds.has(child.id)),
        )
        .map(decodeRequirement),
    }));
    return {
      items,
      total: rootIds.length,
      matchedCount: matched.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  history(id: number) {
    return this.orm
      .select()
      .from(stageHistory)
      .where(eq(stageHistory.requirementId, id))
      .orderBy(asc(stageHistory.id))
      .all();
  }
  addHistory(record: typeof stageHistory.$inferInsert) {
    this.orm.insert(stageHistory).values(record).run();
  }
  audit(id: number, action: string, payload: unknown) {
    this.orm
      .insert(requirementAudit)
      .values({
        requirementId: id,
        action,
        payload: JSON.stringify(payload),
        createdAt: new Date().toISOString(),
      })
      .run();
  }
}
