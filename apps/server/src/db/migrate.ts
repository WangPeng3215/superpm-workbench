import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "../config/index.js";

export const SCHEMA_VERSION = 3;
const migrationsDir = join(projectRoot, "apps/server/drizzle");

export function migrate(db: Database.Database) {
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (
      db.prepare("SELECT version FROM schema_migrations").all() as {
        version: number;
      }[]
    ).map((x) => x.version),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (applied.has(version)) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(version, new Date().toISOString());
    })();
  }
}
