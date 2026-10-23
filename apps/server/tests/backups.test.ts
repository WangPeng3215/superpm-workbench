import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, migrate } from "../src/db/migrate.js";
import { inspectDatabase } from "../src/db/inspect.js";
import {
  createBackup,
  listBackups,
  resolveBackupDir,
  restoreBackup,
  verifyBackup,
} from "../src/services/backups.js";
import type { BackupMeta } from "../src/services/backups.js";

let base: string;
let homePath: string;
let databasePath: string;
let workspacePath: string;

function insertUser(username: string) {
  const db = new Database(databasePath);
  try {
    db.prepare(
      "INSERT INTO users(username, display_name, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, 'h', 's', '2026-01-01', '2026-01-01')",
    ).run(username, username);
  } finally {
    db.close();
  }
}

async function createTestBackup(reason = "test"): Promise<BackupMeta> {
  return createBackup({
    homePath,
    databasePath,
    workspacePath,
    version: "0.2.0",
    reason,
  });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "superpm-backup-"));
  homePath = join(base, "home");
  databasePath = join(homePath, "data", "superpm.sqlite");
  workspacePath = join(homePath, "workspace");
  mkdirSync(join(homePath, "data"), { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  const db = new Database(databasePath);
  migrate(db);
  db.close();
  insertUser("admin");
  writeFileSync(join(workspacePath, "a.md"), "# A", "utf8");
  writeFileSync(join(homePath, ".env"), "PORT=3001\n", "utf8");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("数据备份、校验与恢复", () => {
  it("创建完整备份并写入可复核的元数据", async () => {
    const meta = await createTestBackup();
    expect(meta.id).toMatch(/-test$/);
    expect(meta).toMatchObject({
      version: "0.2.0",
      schemaVersion: SCHEMA_VERSION,
      reason: "test",
      configFile: true,
      workspace: { files: 1 },
    });
    expect(meta.database.integrity).toBe("ok");
    expect(meta.database.tables.users).toBe(1);
    expect(meta.database.sha256).toMatch(/^[a-f0-9]{64}$/);
    const backupDir = resolveBackupDir(homePath, meta.id);
    expect(existsSync(join(backupDir, "data", "superpm.sqlite"))).toBe(true);
    expect(existsSync(join(backupDir, "workspace", "a.md"))).toBe(true);
    expect(readFileSync(join(backupDir, "config.env"), "utf8")).toContain(
      "PORT=3001",
    );
    expect(listBackups(homePath).map((item) => item.id)).toEqual([meta.id]);
    await expect(verifyBackup(backupDir)).resolves.toMatchObject({
      id: meta.id,
    });
  });

  it("备份数据库被篡改或缺失时校验失败", async () => {
    const meta = await createTestBackup("tamper");
    const backupDir = resolveBackupDir(homePath, meta.id);
    appendFileSync(join(backupDir, "data", "superpm.sqlite"), "tampered");
    await expect(verifyBackup(backupDir)).rejects.toThrow(/摘要不一致/);

    const missing = await createTestBackup("missing");
    const missingDir = resolveBackupDir(homePath, missing.id);
    rmSync(join(missingDir, "data", "superpm.sqlite"));
    await expect(verifyBackup(missingDir)).rejects.toThrow(/数据库缺失/);
  });

  it("恢复数据库与工作区，并自动保留恢复前数据", async () => {
    const meta = await createTestBackup("restore");
    const db = new Database(databasePath);
    try {
      db.prepare("DELETE FROM users").run();
    } finally {
      db.close();
    }
    writeFileSync(join(workspacePath, "b.md"), "# B", "utf8");

    const result = await restoreBackup({
      backupDir: resolveBackupDir(homePath, meta.id),
      homePath,
      databasePath,
      workspacePath,
      version: "0.2.0",
    });

    expect(inspectDatabase(databasePath).tables.users).toBe(1);
    const users = new Database(databasePath);
    try {
      expect(users.prepare("SELECT username FROM users").all()).toEqual([
        { username: "admin" },
      ]);
    } finally {
      users.close();
    }
    expect(readFileSync(join(workspacePath, "a.md"), "utf8")).toBe("# A");
    expect(existsSync(join(workspacePath, "b.md"))).toBe(false);
    expect(result.preRestoreBackupId).toBeTruthy();
    expect(result.workspaceAsidePath).toBeTruthy();
    expect(readFileSync(join(result.workspaceAsidePath!, "b.md"), "utf8")).toBe(
      "# B",
    );
    // 恢复前备份记录的是被覆盖前的状态
    const safety = inspectDatabase(
      join(
        resolveBackupDir(homePath, result.preRestoreBackupId!),
        "data",
        "superpm.sqlite",
      ),
    );
    expect(safety.tables.users).toBe(0);
    expect(listBackups(homePath)).toHaveLength(2);
  });

  it("拒绝越界备份 ID 与元数据路径", async () => {
    expect(() => resolveBackupDir(homePath, "../escape")).toThrow(
      /非法备份 ID/,
    );
    const meta = await createTestBackup("escape");
    const backupDir = resolveBackupDir(homePath, meta.id);
    const raw = JSON.parse(
      readFileSync(join(backupDir, "meta.json"), "utf8"),
    ) as BackupMeta;
    raw.database.file = "../../outside.sqlite";
    writeFileSync(join(backupDir, "meta.json"), JSON.stringify(raw));
    await expect(verifyBackup(backupDir)).rejects.toThrow(/超出备份目录/);
  });

  it("备份目标不存在时给出明确错误", async () => {
    await expect(
      createBackup({
        homePath,
        databasePath: join(homePath, "data", "missing.sqlite"),
        workspacePath,
        version: "0.2.0",
      }),
    ).rejects.toThrow(/数据库不存在/);
  });
});
