import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
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
    db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as {
      version: number;
    }[]
  ).map((row) => row.version);
}
const migrationsDir = join(projectRoot, "apps/server/drizzle");
const ALL_VERSIONS = Array.from(
  { length: SCHEMA_VERSION },
  (_, index) => index + 1,
);
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
function insertLegacyFileRow(
  db: Database.Database,
  kind: string,
  isFinal: number,
) {
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
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
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
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('users','app_meta')",
        )
        .get(),
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
    expect(tableColumns(db, "issues")).toContain("description_html");
    expect(tableColumns(db, "issue_artifact_links")).toEqual([
      "issue_id",
      "artifact_id",
      "relation_type",
      "created_at",
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='issue_artifact_links_artifact_idx'",
        )
        .all() as { name: string }[],
    ).toHaveLength(1);
    // 重复迁移不报错、不重复
    migrate(db);
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
  });
  it("存量映射：closed→resolved 补解决时间；design→ui、bug→defect→testing", () => {
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
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
    const rows = db
      .prepare(
        "SELECT title, issue_type, status, resolved_at FROM issues ORDER BY id",
      )
      .all() as {
      title: string;
      issue_type: string;
      status: string;
      resolved_at: string | null;
    }[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      issue_type: "ui",
      status: "resolved",
      resolved_at: now,
    });
    // open 状态随后被 0009 映射为 pending
    expect(rows[1]).toMatchObject({
      issue_type: "development",
      status: "pending",
    });
    expect(rows[2]).toMatchObject({ issue_type: "testing", status: "pending" });
    // 新列默认空串
    expect(
      (
        db.prepare("SELECT description_html FROM issues").all() as {
          description_html: string;
        }[]
      ).every((row) => row.description_html === ""),
    ).toBe(true);
  });
});

describe("migrations 0005（资产与问题管理）", () => {
  it("新库初始化：全部版本可执行且结构完整", () => {
    migrate(db);
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
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
        "stage",
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
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
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
        "INSERT INTO issues(requirement_id, stage, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(1, "design", "关联保持示例", now, now);
    const issueId = Number(issue.lastInsertRowid);
    db.prepare(
      "INSERT INTO issue_assets(issue_id, asset_id, relation_type, created_at) VALUES (?, ?, 'evidence', ?)",
    ).run(issueId, fileRow, now);
    // 重复执行迁移：数据行数与关联均不丢失、不重复
    migrate(db);
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
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
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
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
        "INSERT INTO issues(requirement_id, stage, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        1,
        "design",
        "示例问题",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    const issueId = Number(issue.lastInsertRowid);
    const asset = db
      .prepare(
        "INSERT INTO requirement_files(requirement_id, phase, category, name, file_name, resource_type, storage_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'file', 'local', 'draft', ?, ?)",
      )
      .run(
        1,
        "design",
        "uiAssets",
        "截图",
        "x.png",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    const assetId = Number(asset.lastInsertRowid);
    const link = db.prepare(
      "INSERT INTO issue_assets(issue_id, asset_id, relation_type, created_at) VALUES (?, ?, 'evidence', ?)",
    );
    link.run(issueId, assetId, "2026-01-01T00:00:00.000Z");
    // 同一问题与产出物的重复关联被联合主键拒绝
    expect(() =>
      link.run(issueId, assetId, "2026-01-01T00:00:00.000Z"),
    ).toThrowError(/UNIQUE/i);
  });
  it("外键约束生效：非法引用被拒绝", () => {
    migrate(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO issues(requirement_id, stage, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          999,
          "design",
          "悬空问题",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ),
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
    expect(SCHEMA_VERSION).toBe(14);
    expect(appliedVersions(db)).toHaveLength(SCHEMA_VERSION);
  });
});

describe("migrations 0009（问题枚举整备与正文 md 落盘）", () => {
  // 模拟已应用 0001-0008 的旧库
  function seedThrough0008(db: Database.Database) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const mark = db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, '2026-01-01T00:00:00.000Z')",
    );
    const files = [
      "0001_initial.sql",
      "0002_stage_workspace.sql",
      "0003_requirement_files.sql",
      "0004_file_entry_kinds.sql",
      "0005_assets_and_issues.sql",
      "0006_users.sql",
      "0007_artifacts.sql",
      "0008_issues_md_and_artifact_links.sql",
    ];
    for (const [index, file] of files.entries()) {
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      mark.run(index + 1);
    }
  }
  function insertLegacyIssue(
    db: Database.Database,
    fields: {
      title: string;
      description: string;
      descriptionHtml?: string;
      issueType?: string | null;
      status: string;
      isDeleted?: number;
    },
  ) {
    const result = db
      .prepare(
        "INSERT INTO issues(requirement_id, phase, title, description, description_html, issue_type, status, created_at, updated_at, is_deleted) VALUES (1, 'design', ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        fields.title,
        fields.description,
        fields.descriptionHtml ?? "",
        fields.issueType ?? null,
        fields.status,
        "2026-01-02T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        fields.isDeleted ?? 0,
      );
    return Number(result.lastInsertRowid);
  }

  it("存量映射：分类 testing/requirement/other 经 0009/0011 收敛，状态 open/in_progress/closed→pending/processing/resolved", () => {
    seedThrough0008(db);
    insertRequirement(db);
    insertLegacyIssue(db, {
      title: "旧测试问题",
      description: "纯文本",
      issueType: "testing",
      status: "open",
    });
    insertLegacyIssue(db, {
      title: "旧需求问题",
      description: "",
      issueType: "requirement",
      status: "in_progress",
    });
    insertLegacyIssue(db, {
      title: "旧其他问题",
      description: "",
      issueType: "other",
      status: "closed",
    });
    insertLegacyIssue(db, {
      title: "取值不变",
      description: "",
      issueType: "ui",
      status: "resolved",
    });
    migrate(db);
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
    const rows = db
      .prepare("SELECT issue_type, status, resolved_at FROM issues ORDER BY id")
      .all() as {
      issue_type: string | null;
      status: string;
      resolved_at: string | null;
    }[];
    expect(rows).toHaveLength(4);
    // testing→defect（0009）→testing（0011），最终与当前枚举一致
    expect(rows[0]).toMatchObject({ issue_type: "testing", status: "pending" });
    expect(rows[1]).toMatchObject({
      issue_type: "other",
      status: "processing",
    });
    // closed→resolved：解决时间以更新时间兜底；0011 对已解决行保留解决时间
    expect(rows[2]).toMatchObject({
      issue_type: "other",
      status: "resolved",
      resolved_at: "2026-01-02T00:00:00.000Z",
    });
    expect(rows[3]).toMatchObject({ issue_type: "ui", status: "resolved" });
  });
  it("正文引导：md 文件生成且优先取 description_html，软删行与已存在文件不受影响", () => {
    seedThrough0008(db);
    insertRequirement(db);
    insertLegacyIssue(db, {
      title: "富文本问题",
      description: "纯文本正文",
      descriptionHtml: "<p>富文本正文</p>",
      issueType: "ui",
      status: "open",
    });
    const plainId = insertLegacyIssue(db, {
      title: "纯文本问题",
      description: "仅纯文本正文",
      issueType: "ui",
      status: "open",
    });
    const deletedId = insertLegacyIssue(db, {
      title: "已删除问题",
      description: "已删除正文",
      issueType: "ui",
      status: "open",
      isDeleted: 1,
    });
    const workspace = join(workdir, "workspace");
    const issuesDir = join(workspace, "requirements", "1", "issues");
    mkdirSync(issuesDir, { recursive: true });
    writeFileSync(join(issuesDir, "1.md"), "外部已有内容", "utf8");
    migrate(db, migrationsDir, workspace);
    // description_html 优先，缺失回退纯文本；软删行不落盘
    expect(readFileSync(join(issuesDir, "1.md"), "utf8")).toBe("外部已有内容");
    expect(readFileSync(join(issuesDir, `${plainId}.md`), "utf8")).toBe(
      "仅纯文本正文",
    );
    expect(existsSync(join(issuesDir, `${deletedId}.md`))).toBe(false);
    // 重复迁移：不重写、不报错
    migrate(db, migrationsDir, workspace);
    expect(readFileSync(join(issuesDir, "1.md"), "utf8")).toBe("外部已有内容");
  });
});

describe("migrations 0012（MCP 写入确认与审计）", () => {
  it("确认令牌与审计表结构齐备，唯一约束与结果枚举生效", () => {
    migrate(db);
    expect(tableColumns(db, "mcp_write_confirmations")).toEqual([
      "id",
      "token_hash",
      "tool",
      "requirement_id",
      "target_type",
      "target_id",
      "params_hash",
      "idempotency_key",
      "expires_at",
      "used_at",
      "created_at",
    ]);
    expect(tableColumns(db, "mcp_audit")).toEqual([
      "id",
      "tool",
      "requirement_id",
      "target_type",
      "target_id",
      "params_hash",
      "idempotency_key",
      "confirmation_id",
      "actor_name",
      "outcome",
      "error_code",
      "result_summary",
      "created_at",
    ]);
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "mcp_write_confirmations_expires_idx",
        "mcp_audit_requirement_created_idx",
      ]),
    );
    const now = "2026-01-01T00:00:00.000Z";
    const expiresAt = "2026-01-01T00:05:00.000Z";
    const insertConfirmation = db.prepare(
      "INSERT INTO mcp_write_confirmations(token_hash, tool, requirement_id, target_type, target_id, params_hash, idempotency_key, expires_at, created_at) VALUES (?, 'issue.comment', 1, 'issue', '1', 'hash', ?, ?, ?)",
    );
    insertConfirmation.run("token-a", "idem-a", expiresAt, now);
    expect(() =>
      insertConfirmation.run("token-a", "idem-b", expiresAt, now),
    ).toThrowError(/UNIQUE/i);
    expect(() =>
      insertConfirmation.run("token-b", "idem-a", expiresAt, now),
    ).toThrowError(/UNIQUE/i);

    const insertAudit = db.prepare(
      "INSERT INTO mcp_audit(tool, requirement_id, target_type, target_id, params_hash, idempotency_key, confirmation_id, actor_name, outcome, result_summary, created_at) VALUES ('issue.comment', 1, 'issue', '1', 'hash', ?, 1, 'mcp:test', 'success', 'issue.comment #1', ?)",
    );
    insertAudit.run("idem-audit", now);
    expect(() => insertAudit.run("idem-audit", now)).toThrowError(/UNIQUE/i);
    expect(() =>
      db
        .prepare(
          "INSERT INTO mcp_audit(tool, params_hash, outcome, created_at) VALUES ('issue.comment', 'hash', 'unknown', ?)",
        )
        .run(now),
    ).toThrowError(/CHECK/i);
  });
});

describe("migrations 0011（问题记录模型）", () => {
  // 模拟已应用 0001-0010 的旧库
  function seedThrough0010(db: Database.Database) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const mark = db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, '2026-01-01T00:00:00.000Z')",
    );
    const files = [
      "0001_initial.sql",
      "0002_stage_workspace.sql",
      "0003_requirement_files.sql",
      "0004_file_entry_kinds.sql",
      "0005_assets_and_issues.sql",
      "0006_users.sql",
      "0007_artifacts.sql",
      "0008_issues_md_and_artifact_links.sql",
      "0009_issue_enum_and_md.sql",
      "0010_requirement_directories.sql",
    ];
    for (const [index, file] of files.entries()) {
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      mark.run(index + 1);
    }
  }
  const legacyNow = "2026-01-02T00:00:00.000Z";
  function insertLegacyIssue(
    db: Database.Database,
    fields: {
      title: string;
      stage?: string;
      issueType?: string | null;
      status: string;
      resolvedAt?: string | null;
    },
  ) {
    const result = db
      .prepare(
        "INSERT INTO issues(requirement_id, phase, title, description, issue_type, status, resolved_at, created_at, updated_at) VALUES (1, ?, ?, '旧正文', ?, ?, ?, ?, ?)",
      )
      .run(
        fields.stage ?? "design",
        fields.title,
        fields.issueType ?? null,
        fields.status,
        fields.resolvedAt ?? null,
        legacyNow,
        legacyNow,
      );
    return Number(result.lastInsertRowid);
  }

  it("阶段列改为 stage；类型 defect→testing、change/question→other；状态与解决时间收敛", () => {
    seedThrough0010(db);
    insertRequirement(db);
    const ui = insertLegacyIssue(db, {
      title: "UI 问题",
      stage: "design",
      issueType: "ui",
      status: "pending",
    });
    const opened = insertLegacyIssue(db, {
      title: "待处理开发问题",
      stage: "development",
      issueType: "development",
      status: "open",
      resolvedAt: legacyNow,
    });
    const testing = insertLegacyIssue(db, {
      title: "测试中问题",
      stage: "development",
      issueType: "defect",
      status: "testing",
    });
    const change = insertLegacyIssue(db, {
      title: "变更问题",
      stage: "analysis",
      issueType: "change",
      status: "resolved",
      resolvedAt: legacyNow,
    });
    const question = insertLegacyIssue(db, {
      title: "提问",
      issueType: "question",
      status: "resolved",
    });
    const uncategorized = insertLegacyIssue(db, {
      title: "无分类问题",
      issueType: null,
      status: "pending",
    });
    db.prepare(
      "INSERT INTO issue_activities(issue_id, activity_type, content, old_status, new_status, created_at) VALUES (?, 'status_change', '', 'open', 'testing', ?)",
    ).run(ui, legacyNow);
    migrate(db);
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
    expect(tableColumns(db, "issues")).toContain("stage");
    expect(tableColumns(db, "issues")).not.toContain("phase");
    const rows = db
      .prepare(
        "SELECT id, stage, issue_type, status, resolved_at, description FROM issues ORDER BY id",
      )
      .all() as {
      id: number;
      stage: string;
      issue_type: string | null;
      status: string;
      resolved_at: string | null;
      description: string;
    }[];
    expect(rows).toHaveLength(6);
    // 阶段值原样保留
    expect(rows[0]).toMatchObject({
      id: ui,
      stage: "design",
      issue_type: "ui",
      status: "pending",
      resolved_at: null,
    });
    // open→pending，非已解决行清除解决时间
    expect(rows[1]).toMatchObject({
      id: opened,
      stage: "development",
      issue_type: "development",
      status: "pending",
      resolved_at: null,
    });
    expect(rows[2]).toMatchObject({
      id: testing,
      issue_type: "testing",
      status: "processing",
    });
    expect(rows[3]).toMatchObject({
      id: change,
      stage: "analysis",
      issue_type: "other",
      status: "resolved",
      resolved_at: legacyNow,
    });
    expect(rows[4]).toMatchObject({
      id: question,
      issue_type: "other",
      status: "resolved",
      resolved_at: null,
    });
    expect(rows[5]).toMatchObject({
      id: uncategorized,
      issue_type: null,
      status: "pending",
    });
    // 正文列不被迁移改写
    expect(rows.every((row) => row.description === "旧正文")).toBe(true);
    // 活动里的旧状态同步为新枚举
    expect(
      db
        .prepare(
          "SELECT old_status, new_status FROM issue_activities WHERE issue_id=?",
        )
        .get(ui),
    ).toEqual({ old_status: "pending", new_status: "processing" });
    // 列表索引就位
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='issues_requirement_updated_idx'",
        )
        .all(),
    ).toHaveLength(1);
    // 重复迁移不报错、版本不重复
    migrate(db);
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
  });
});

describe("migrations 0013（文件与链接最终版标记）", () => {
  it("两类记录新增 is_final，默认 0", () => {
    migrate(db);
    for (const table of ["artifact_nodes", "artifact_links"]) {
      const column = (
        db.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
          dflt_value: string | null;
        }[]
      ).find((item) => item.name === "is_final");
      expect(column).toMatchObject({ name: "is_final", dflt_value: "0" });
    }
  });
});

describe("migrations 0014（每日任务与工时）", () => {
  it("创建任务、工时与修正审计表，并限制单条活动计时", () => {
    migrate(db);
    for (const table of [
      "daily_tasks",
      "daily_time_entries",
      "daily_time_entry_audits",
    ])
      expect(tableColumns(db, table).length).toBeGreaterThan(0);
    expect(tableColumns(db, "daily_tasks")).toEqual(
      expect.arrayContaining([
        "plan_date",
        "estimated_minutes",
        "status",
        "sort_order",
        "deleted_at",
      ]),
    );
    expect(tableColumns(db, "daily_time_entries")).toEqual(
      expect.arrayContaining([
        "task_id",
        "started_at",
        "ended_at",
        "duration_seconds",
        "end_reason",
      ]),
    );
    // plan_date 索引与活动计时部分唯一索引就位
    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('daily_tasks','daily_time_entries')",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_daily_tasks_plan_date",
        "idx_daily_time_entries_active",
      ]),
    );
    const timestamp = "2026-10-24T01:00:00.000Z";
    db.prepare(
      `INSERT INTO daily_tasks
        (title, description, plan_date, estimated_minutes, status, sort_order, created_at, updated_at)
       VALUES ('任务', '', '2026-10-24', 60, 'pending', 0, ?, ?)`,
    ).run(timestamp, timestamp);
    const insertEntry = db.prepare(
      `INSERT INTO daily_time_entries
        (task_id, started_at, duration_seconds, status, created_at, updated_at)
       VALUES (1, ?, 0, 'active', ?, ?)`,
    );
    insertEntry.run(timestamp, timestamp, timestamp);
    expect(() => insertEntry.run(timestamp, timestamp, timestamp)).toThrow();
  });
});
