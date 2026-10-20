import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCHEMA_VERSION, migrate } from "../src/db/migrate.js";
import { projectRoot } from "../src/config/index.js";

function tableColumns(db: Database.Database, table: string) {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((row) => row.name);
}
function appliedVersions(db: Database.Database) {
  return (
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
      version: number;
    }[]
  ).map((row) => row.version);
}
const migrationsDir = join(projectRoot, "apps/server/drizzle");
const LEGACY_FILES = [
  "0001_initial.sql",
  "0002_stage_workspace.sql",
  "0003_requirement_files.sql",
  "0004_file_entry_kinds.sql",
];
// 模拟"已有旧库"：手动执行 0001-0004 并补记 schema_migrations
function seedLegacyDatabase(db: Database.Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  for (const file of LEGACY_FILES)
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  const mark = db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
  );
  for (const version of [1, 2, 3, 4])
    mark.run(version, "2026-01-01T00:00:00.000Z");
}
function insertRequirement(db: Database.Database) {
  db.prepare(
    "INSERT INTO requirements(requirement_no, name, type, priority, description, description_html, status, current_stage, proposed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "REQ-0001",
    "示例需求",
    "feature",
    "medium",
    "",
    "",
    "draft",
    "analysis",
    "2026-01-01",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
}
function insertLegacyFileRow(db: Database.Database, kind: string, isFinal: number) {
  const result = db
    .prepare(
      "INSERT INTO requirement_files(requirement_id, phase, category, name, file_name, kind, link_url, is_final, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      1,
      "analysis",
      "record",
      "示例资源",
      "example.md",
      kind,
      kind === "link" ? "https://example.com" : null,
      isFinal,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  return Number(result.lastInsertRowid);
}

let workdir: string;
let db: Database.Database;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "superpm-migrate-"));
  db = new Database(join(workdir, "test.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

describe("migrations 0006（用户认证）", () => {
  it("新库初始化：users 与 app_meta 结构完整", () => {
    migrate(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tableColumns(db, "users")).toEqual([
      "id",
      "username",
      "display_name",
      "password_hash",
      "password_salt",
      "created_at",
      "updated_at",
    ]);
    expect(tableColumns(db, "app_meta")).toEqual(["key", "value"]);
  });
  it("重复迁移与旧库升级均不产生重复结构", () => {
    seedLegacyDatabase(db);
    migrate(db);
    migrate(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('users','app_meta')").get(),
    ).toEqual({ count: 2 });
  });
  it("username 唯一约束生效", () => {
    migrate(db);
    const now = "2026-01-01T00:00:00.000Z";
    const insert = db.prepare(
      "INSERT INTO users(username, display_name, password_hash, password_salt, created_at, updated_at) VALUES ('admin', '管理员', 'h', 's', ?, ?)",
    );
    insert.run(now, now);
    expect(() => insert.run(now, now)).toThrowError(/UNIQUE/i);
  });
});

describe("migrations 0008（问题正文富文本化与关联切换）", () => {
  it("新库：issues 含 description_html 列，issue_artifact_links 联合主键与索引齐备", () => {
    migrate(db);
    expect(SCHEMA_VERSION).toBe(8);
    expect(tableColumns(db, "issues")).toContain("description_html");
    expect(tableColumns(db, "issue_artifact_links")).toEqual([
      "issue_id",
      "artifact_id",
      "relation_type",
      "created_at",
    ]);
    expect(
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='issue_artifact_links_artifact_idx'",
          )
          .all() as { name: string }[]
      ),
    ).toHaveLength(1);
    // 重复迁移不报错、不重复
    migrate(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("存量映射：closed→resolved 补解决时间；design→ui、bug→defect", () => {
    // 模拟已应用 0001-0007 的旧库：写入旧枚举数据后再执行迁移
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const mark = db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, '2026-01-01T00:00:00.000Z')",
    );
    for (const [version, file] of [
      [1, "0001_initial.sql"],
      [2, "0002_stage_workspace.sql"],
      [3, "0003_requirement_files.sql"],
      [4, "0004_file_entry_kinds.sql"],
      [5, "0005_assets_and_issues.sql"],
      [6, "0006_users.sql"],
      [7, "0007_artifacts.sql"],
    ] as const) {
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      mark.run(version);
    }
    insertRequirement(db);
    const now = "2026-01-02T00:00:00.000Z";
    const insert = db.prepare(
      "INSERT INTO issues(requirement_id, phase, title, description, issue_type, status, created_at, updated_at) VALUES (1, 'design', ?, '', ?, ?, ?, ?)",
    );
    insert.run("旧设计问题", "design", "closed", now, now);
    insert.run("旧开发问题", "development", "open", now, now);
    insert.run("旧缺陷", "bug", "open", now, now);
    // 迁移：0008 落地并完成存量映射
    migrate(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const rows = db
      .prepare("SELECT title, issue_type, status, resolved_at FROM issues ORDER BY id")
      .all() as { title: string; issue_type: string; status: string; resolved_at: string | null }[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ issue_type: "ui", status: "resolved", resolved_at: now });
    expect(rows[1]).toMatchObject({ issue_type: "development", status: "open" });
    expect(rows[2]).toMatchObject({ issue_type: "defect", status: "open" });
    // 新列默认空串
    expect(
      (db.prepare("SELECT description_html FROM issues").all() as { description_html: string }[]).every(
        (row) => row.description_html === "",
      ),
    ).toBe(true);
  });
});

describe("migrations 0005（资产与问题管理）", () => {
  it("新库初始化：全部版本可执行且结构完整", () => {
    migrate(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tableColumns(db, "requirement_files")).toEqual(
      expect.arrayContaining([
        "resource_type",
        "storage_type",
        "relative_path",
        "text_content",
        "mime_type",
        "description",
        "status",
        "is_deleted",
      ]),
    );
    expect(tableColumns(db, "issues")).toEqual(
      expect.arrayContaining([
        "requirement_id",
        "phase",
        "issue_key",
        "title",
        "status",
        "description_html",
        "solution",
        "resolved_at",
        "closed_at",
        "is_deleted",
      ]),
    );
    expect(tableColumns(db, "issue_activities")).toEqual(
      expect.arrayContaining([
        "issue_id",
        "activity_type",
        "old_status",
        "new_status",
      ]),
    );
    expect(tableColumns(db, "issue_assets")).toEqual([
      "issue_id",
      "asset_id",
      "relation_type",
      "created_at",
    ]);
    expect(tableColumns(db, "issue_artifact_links")).toEqual([
      "issue_id",
      "artifact_id",
      "relation_type",
      "created_at",
    ]);
  });
  it("旧库升级：kind/is_final 正确映射为 resource_type/storage_type/status", () => {
    seedLegacyDatabase(db);
    insertRequirement(db);
    const fileRow = insertLegacyFileRow(db, "file", 1);
    const linkRow = insertLegacyFileRow(db, "link", 0);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4]);
    migrate(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const rows = db
      .prepare(
        "SELECT id, resource_type, storage_type, status FROM requirement_files ORDER BY id",
      )
      .all() as {
      id: number;
      resource_type: string;
      storage_type: string;
      status: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === fileRow)).toMatchObject({
      resource_type: "file",
      storage_type: "local",
      status: "final",
    });
    expect(rows.find((row) => row.id === linkRow)).toMatchObject({
      resource_type: "link",
      storage_type: "external",
      status: "draft",
    });
  });
  it("旧库升级后建立的关联在重复迁移时保持完整", () => {
    seedLegacyDatabase(db);
    insertRequirement(db);
    const fileRow = insertLegacyFileRow(db, "file", 1);
    const linkRow = insertLegacyFileRow(db, "link", 0);
    migrate(db);
    // 升级完成后建立 issue + asset 关联（issues/issue_assets 为 0005 新表，旧库不可能已有）
    const now = "2026-01-02T00:00:00.000Z";
    const issue = db
      .prepare(
        "INSERT INTO issues(requirement_id, phase, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(1, "design", "关联保持示例", now, now);
    const issueId = Number(issue.lastInsertRowid);
    db.prepare(
      "INSERT INTO issue_assets(issue_id, asset_id, relation_type, created_at) VALUES (?, ?, 'evidence', ?)",
    ).run(issueId, fileRow, now);
    // 重复执行迁移：数据行数与关联均不丢失、不重复
    migrate(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM requirement_files").get(),
    ).toEqual({ count: 2 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM issue_assets").get(),
    ).toEqual({ count: 1 });
    // 关联外键两侧记录仍可 JOIN 命中，旧行映射不受重复迁移影响
    const joined = db
      .prepare(
        "SELECT i.title, f.resource_type, f.status FROM issue_assets ia JOIN issues i ON i.id=ia.issue_id JOIN requirement_files f ON f.id=ia.asset_id",
      )
      .get() as {
      title: string;
      resource_type: string;
      status: string;
    };
    expect(joined).toEqual({
      title: "关联保持示例",
      resource_type: "file",
      status: "final",
    });
    expect(linkRow).toBeGreaterThan(0);
  });
  it("重复执行迁移不产生重复结构与记录", () => {
    migrate(db);
    const snapshot = tableColumns(db, "requirement_files");
    migrate(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tableColumns(db, "requirement_files")).toEqual(snapshot);
  });
  it("新索引与联合主键约束生效", () => {
    migrate(db);
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "assets_scope_idx",
        "issues_scope_idx",
        "activities_issue_idx",
        "issue_assets_asset_idx",
      ]),
    );
    insertRequirement(db);
    const issue = db
      .prepare(
        "INSERT INTO issues(requirement_id, phase, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(1, "design", "示例问题", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const issueId = Number(issue.lastInsertRowid);
    const asset = db
      .prepare(
        "INSERT INTO requirement_files(requirement_id, phase, category, name, file_name, resource_type, storage_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'file', 'local', 'draft', ?, ?)",
      )
      .run(1, "design", "uiAssets", "截图", "x.png", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const assetId = Number(asset.lastInsertRowid);
    const link = db.prepare(
      "INSERT INTO issue_assets(issue_id, asset_id, relation_type, created_at) VALUES (?, ?, 'evidence', ?)",
    );
    link.run(issueId, assetId, "2026-01-01T00:00:00.000Z");
    // 同一问题与产出物的重复关联被联合主键拒绝
    expect(() => link.run(issueId, assetId, "2026-01-01T00:00:00.000Z")).toThrowError(
      /UNIQUE/i,
    );
  });
  it("外键约束生效：非法引用被拒绝", () => {
    migrate(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO issues(requirement_id, phase, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(999, "design", "悬空问题", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    ).toThrowError(/FOREIGN KEY/i);
  });
  it("迁移失败明确报告且已完成部分可恢复", () => {
    // 注入临时迁移目录：0001 可执行，0002 非法 SQL
    const badDir = join(workdir, "drizzle");
    mkdirSync(badDir);
    writeFileSync(
      join(badDir, "0001_ok.sql"),
      "CREATE TABLE sample (id INTEGER PRIMARY KEY);",
    );
    writeFileSync(join(badDir, "0002_bad.sql"), "THIS IS NOT SQL;");
    expect(() => migrate(db, badDir)).toThrowError();
    // 0001 已提交；0002 回滚且未记录版本
    expect(appliedVersions(db)).toEqual([1]);
    const sample = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sample'",
      )
      .all();
    expect(sample).toHaveLength(1);
    // 修复后可从断点继续
    writeFileSync(
      join(badDir, "0002_bad.sql"),
      "CREATE TABLE sample2 (id INTEGER PRIMARY KEY);",
    );
    migrate(db, badDir);
    expect(appliedVersions(db)).toEqual([1, 2]);
  });
  it("SCHEMA_VERSION 与已应用迁移数一致", () => {
    migrate(db);
    expect(SCHEMA_VERSION).toBe(8);
    expect(appliedVersions(db)).toHaveLength(SCHEMA_VERSION);
  });
});
