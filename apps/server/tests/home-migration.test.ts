import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHome } from "../src/config/home-migration.js";
import { migrate } from "../src/db/migrate.js";

const directories: string[] = [];

function tempDir(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

function seedLegacyProject() {
  const base = tempDir("superpm-home-migration-");
  const project = join(base, "install");
  const home = join(base, "user-data");
  mkdirSync(join(project, "data"), { recursive: true });
  mkdirSync(join(project, "workspace", "需求A"), { recursive: true });
  writeFileSync(
    join(project, "workspace", "需求A", "说明.md"),
    "# 说明",
    "utf8",
  );
  writeFileSync(join(project, ".env"), "PORT=3999\n", "utf8");
  const db = new Database(join(project, "data", "superpm.sqlite"));
  migrate(db);
  db.prepare(
    "INSERT INTO users(username, display_name, password_hash, password_salt, created_at, updated_at) VALUES ('admin','管理员','h','s','2026-01-01','2026-01-01')",
  ).run();
  db.close();
  return { base, project, home };
}

describe("数据根一次性迁移", () => {
  it("复制数据库、工作区与 .env，校验后保留旧数据并写入状态", async () => {
    const { project, home } = seedLegacyProject();
    const result = await prepareHome({
      legacyRoot: project,
      home,
      version: "0.2.0",
      lockTimeoutMs: 500,
    });
    expect(result.status).toBe("completed");
    expect(readFileSync(join(home, "data", "superpm.sqlite"))).toBeInstanceOf(
      Buffer,
    );
    expect(
      readFileSync(join(home, "workspace", "需求A", "说明.md"), "utf8"),
    ).toBe("# 说明");
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("PORT=3999");
    // 旧安装目录数据保留，不做删除或移动
    expect(existsSync(join(project, "data", "superpm.sqlite"))).toBe(true);
    expect(
      readFileSync(join(project, "workspace", "需求A", "说明.md"), "utf8"),
    ).toBe("# 说明");
    const report = JSON.parse(
      readFileSync(join(home, "migration-state.json"), "utf8"),
    ) as {
      status: string;
      version: string;
      envCopied: boolean;
      database: { tables: Record<string, number> };
      workspace: { files: number };
    };
    expect(report).toMatchObject({
      status: "completed",
      version: "0.2.0",
      envCopied: true,
      workspace: { files: 1 },
    });
    expect(report.database.tables.users).toBe(1);
    expect(readFileSync(join(home, "logs", "migration.log"), "utf8")).toContain(
      "迁移完成",
    );
    expect(
      readdirSync(home).filter((name) => name.startsWith(".migration-staging")),
    ).toEqual([]);

    const second = await prepareHome({
      legacyRoot: project,
      home,
      version: "0.2.0",
    });
    expect(second).toMatchObject({ status: "skipped", reason: "数据根已就绪" });
  });

  it("数据根已有 .env 时不覆盖，也不重复复制", async () => {
    const { project, home } = seedLegacyProject();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".env"), "PORT=4000\n", "utf8");
    const result = await prepareHome({ legacyRoot: project, home });
    expect(result.status).toBe("completed");
    expect(readFileSync(join(home, ".env"), "utf8")).toBe("PORT=4000\n");
    const report = JSON.parse(
      readFileSync(join(home, "migration-state.json"), "utf8"),
    ) as { envCopied: boolean };
    expect(report.envCopied).toBe(false);
  });

  it("数据路径被显式指向数据根之外时跳过自动迁移", async () => {
    const { base, project, home } = seedLegacyProject();
    const outside = join(base, "outside-data");
    const result = await prepareHome({
      legacyRoot: project,
      home,
      dataSetting: outside,
      lockTimeoutMs: 200,
    });
    expect(result).toMatchObject({ status: "skipped" });
    expect(result.reason).toContain("数据根之外");
    expect(existsSync(join(home, "data", "superpm.sqlite"))).toBe(false);
    expect(existsSync(join(project, "data", "superpm.sqlite"))).toBe(true);
  });

  it("目标工作区有内容但数据库缺失时拒绝迁移，避免覆盖", async () => {
    const { project, home } = seedLegacyProject();
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "workspace", "keep.txt"), "keep", "utf8");
    await expect(
      prepareHome({ legacyRoot: project, home, lockTimeoutMs: 200 }),
    ).rejects.toThrow(/工作区已存在内容/);
    expect(readFileSync(join(home, "workspace", "keep.txt"), "utf8")).toBe(
      "keep",
    );
    expect(readFileSync(join(project, ".env"), "utf8")).toContain("PORT=3999");
  });

  it("未发现旧数据时直接跳过", async () => {
    const base = tempDir("superpm-home-empty-");
    const project = join(base, "install");
    mkdirSync(project, { recursive: true });
    const result = await prepareHome({
      legacyRoot: project,
      home: join(base, "user-data"),
    });
    expect(result).toMatchObject({ status: "skipped", reason: "未发现旧数据" });
  });

  it("已有迁移锁时等待超时并明确报错", async () => {
    const { project, home } = seedLegacyProject();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, ".migration.lock"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    await expect(
      prepareHome({ legacyRoot: project, home, lockTimeoutMs: 250 }),
    ).rejects.toThrow(/正在执行数据迁移/);
    expect(existsSync(join(project, "data", "superpm.sqlite"))).toBe(true);
    expect(existsSync(join(home, "data", "superpm.sqlite"))).toBe(false);
  });
});
