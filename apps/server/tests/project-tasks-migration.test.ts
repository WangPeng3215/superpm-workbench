import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate";

describe("project task schema", () => {
  let db: Database.Database | undefined;
  afterEach(() => db?.close());

  it("adds immutable task history and explicit daily project-source references", () => {
    db = new Database(":memory:");
    migrate(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get("project_tasks")).toBeTruthy();
    const columns = (table: string) => (db!.prepare("PRAGMA table_info(" + table + ")").all() as { name: string }[]).map((x) => x.name);
    expect(columns("daily_tasks")).toContain("project_task_id");
    expect(columns("daily_time_entries")).toEqual(expect.arrayContaining(["project_id", "project_task_id"]));
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='daily_tasks'").all() as { name: string; sql: string }[];
    expect(indexes.some((index) => index.sql?.includes("project_task_id") && index.sql.includes("UNIQUE"))).toBe(true);
  });
});
