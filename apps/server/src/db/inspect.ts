import Database from "better-sqlite3";

export interface DatabaseSnapshot {
  integrity: string;
  schemaVersion: number;
  tables: Record<string, number>;
}

/** 打开数据库做完整性检查并统计各表行数，用于迁移/备份校验。 */
export function inspectDatabase(path: string): DatabaseSnapshot {
  const db = new Database(path);
  try {
    const integrity = db.pragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok")
      throw new Error(`数据库完整性检查失败（${path}）：${integrity}`);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM "${table.name}"`)
        .get() as { count: number };
      counts[table.name] = row.count;
    }
    const hasMigrations = tables.some(
      (table) => table.name === "schema_migrations",
    );
    const schemaVersion = hasMigrations
      ? (
          db
            .prepare(
              "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
            )
            .get() as { version: number }
        ).version
      : 0;
    return { integrity, schemaVersion, tables: counts };
  } finally {
    db.close();
  }
}
