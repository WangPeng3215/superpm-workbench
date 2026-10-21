import Database from "better-sqlite3";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { projectRoot } from "../config/index.js";

export const SCHEMA_VERSION = 9;
const defaultMigrationsDir = join(projectRoot, "apps/server/drizzle");

export function migrate(
  db: Database.Database,
  migrationsDir: string = defaultMigrationsDir,
  // 提供时在本轮首次应用迁移 0009 后，把存量问题正文引导落盘为 md 文件
  workspacePath?: string,
) {
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
  // 0009 首次落地时才执行正文引导（幂等：已存在的 md 文件不覆盖）
  const needsIssueMarkdown = !applied.has(9);
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
  if (needsIssueMarkdown && workspacePath)
    bootstrapIssueMarkdown(db, workspacePath);
}

// 迁移 0009 配套引导：把存量问题正文写入工作区 md 文件（description_html 优先，缺失回退纯文本）。
// 逐级解析路径并拒绝符号链接与越界（与 artifacts 服务同一套防护）；单行失败跳过，不阻断迁移。
function bootstrapIssueMarkdown(db: Database.Database, workspacePath: string) {
  const hasIssuesTable = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='issues'",
    )
    .get();
  if (!hasIssuesTable) return;
  if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true });
  const root = realpathSync(workspacePath);
  const rows = db
    .prepare(
      "SELECT id, requirement_id, description, description_html FROM issues WHERE is_deleted=0",
    )
    .all() as {
    id: number;
    requirement_id: number;
    description: string;
    description_html: string;
  }[];
  for (const row of rows) {
    let current = root;
    let invalid = false;
    for (const segment of ["requirements", String(row.requirement_id), "issues"]) {
      current = join(current, segment);
      try {
        if (!existsSync(current)) mkdirSync(current);
        if (lstatSync(current).isSymbolicLink()) {
          invalid = true;
          break;
        }
        const resolved = realpathSync(current);
        const distance = relative(root, resolved);
        if (distance.startsWith("..") || isAbsolute(distance)) {
          invalid = true;
          break;
        }
      } catch {
        invalid = true;
        break;
      }
    }
    if (invalid) continue;
    const file = join(current, `${row.id}.md`);
    if (existsSync(file)) continue;
    writeFileSync(file, row.description_html || row.description, "utf8");
  }
}
