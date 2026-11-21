import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate";
import { projectRoot } from "../src/config";

describe("delivery acceptance migration", () => {
  let db: Database.Database | undefined;
  let directory = "";

  afterEach(() => {
    db?.close();
    db = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("upgrades a 0024 database idempotently with constrained acceptance history tables", () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-delivery-acceptance-migration-"));
    db = new Database(join(directory, "old.sqlite"));
    const oldMigrations = join(directory, "migrations");
    mkdirSync(oldMigrations);
    const source = join(projectRoot, "apps/server/drizzle");
    for (const file of readdirSync(source).filter(
      (name) => name.endsWith(".sql") && Number(name.split("_")[0]) <= 24,
    ))
      copyFileSync(join(source, file), join(oldMigrations, file));

    migrate(db, oldMigrations);
    migrate(db);
    migrate(db);

    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    expect(names).toContain("delivery_acceptance_rounds");
    expect(names).toContain("delivery_acceptance_evidence");
    expect(names).toContain("delivery_acceptance_items");
    expect(
      (db.prepare("SELECT version FROM schema_migrations WHERE version=25").all() as unknown[]),
    ).toHaveLength(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(
      db.prepare("PRAGMA index_list('delivery_acceptance_rounds')").all(),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ unique: 1, partial: 1 })]),
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'delivery_acceptance_%'").all(),
    ).not.toHaveLength(0);
  });
});
