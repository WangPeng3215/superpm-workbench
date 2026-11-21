import Database from "better-sqlite3";
import { parse as parseEnv } from "dotenv";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import yazl from "yazl";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bundleBanner = {
  js: 'import{createRequire as __superpmCreateRequire}from"node:module";const require=__superpmCreateRequire(import.meta.url);',
};
let bundleDirectory: string;
let updater: string;
let backupCli: Buffer;
let migrationCli: Buffer;
let pathProbe: Buffer;
const directories: string[] = [];

beforeAll(async () => {
  bundleDirectory = mkdtempSync(join(tmpdir(), "superpm-updater-path-bundle-"));
  updater = join(bundleDirectory, "updater.mjs");
  await Promise.all([
    build({
      entryPoints: [join(projectRoot, "scripts/install/updater.mjs")],
      outfile: updater,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: bundleBanner,
    }),
    build({
      entryPoints: [join(projectRoot, "apps/server/src/backup-cli.ts")],
      outfile: join(bundleDirectory, "backup-cli.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["better-sqlite3"],
      banner: bundleBanner,
    }),
    build({
      stdin: {
        contents: String.raw`
          import { DatabaseSync } from "node:sqlite";
          import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
          import { join } from "node:path";
          import { defaultPaths, homePath } from "./apps/server/src/config/index.ts";
          const { databasePath, workspacePath } = defaultPaths();
          mkdirSync(join(homePath, "runtime"), { recursive: true });
          writeFileSync(join(homePath, "runtime/path-settings.json"), JSON.stringify({
            SUPERPM_DATA_DIR: process.env.SUPERPM_DATA_DIR,
            SUPERPM_WORKSPACE_DIR: process.env.SUPERPM_WORKSPACE_DIR,
          }));
          const db = new DatabaseSync(databasePath);
          if (process.env.SUPERPM_FIXTURE_FAILURE_MODE === "fresh-database")
            db.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('before')");
          db.exec("UPDATE fixture SET value = 'migrated'");
          db.close();
          writeFileSync(join(workspacePath, "marker.txt"), "migrated");
          const failureMode = process.env.SUPERPM_FIXTURE_FAILURE_MODE;
          if (failureMode === "tampered-backup" || failureMode === "missing-workspace-file") {
            const backupRoot = join(homePath, "backups");
            const backupName = readdirSync(backupRoot).find(name => !name.startsWith("."));
            const backupDir = join(backupRoot, backupName);
            const meta = JSON.parse(readFileSync(join(backupDir, "meta.json"), "utf8"));
            if (failureMode === "tampered-backup")
              appendFileSync(join(backupDir, meta.database.file), "tampered");
            else rmSync(join(backupDir, "workspace/marker.txt"));
          }
          if (failureMode === "created-home-env")
            writeFileSync(join(homePath, ".env"), "SUPERPM_DATA_DIR=unexpected-next-start-data\nSUPERPM_WORKSPACE_DIR=unexpected-next-start-workspace\n");
          if (process.env.SUPERPM_FIXTURE_MIGRATION_FAIL === "1")
            throw new Error("fixture migration failed after changing data");
        `,
        resolveDir: projectRoot,
        sourcefile: "updater-fixture-migration.ts",
        loader: "ts",
      },
      outfile: join(bundleDirectory, "migrate-cli.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: bundleBanner,
    }),
    build({
      stdin: {
        contents: `
          import { defaultPaths } from "./apps/server/src/config/index.ts";
          console.info(JSON.stringify(defaultPaths()));
        `,
        resolveDir: projectRoot,
        sourcefile: "updater-fixture-path-probe.ts",
        loader: "ts",
      },
      outfile: join(bundleDirectory, "path-probe.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: bundleBanner,
    }),
  ]);
  backupCli = readFileSync(join(bundleDirectory, "backup-cli.js"));
  migrationCli = readFileSync(join(bundleDirectory, "migrate-cli.js"));
  pathProbe = readFileSync(join(bundleDirectory, "path-probe.js"));
}, 30000);

afterEach(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

afterAll(() => {
  if (bundleDirectory)
    rmSync(bundleDirectory, { recursive: true, force: true });
});

interface Settings {
  SUPERPM_DATA_DIR?: string;
  SUPERPM_WORKSPACE_DIR?: string;
}

interface PathCase {
  name: string;
  app?: Settings;
  home?: Settings;
  process?: Settings;
  absolute?: boolean;
  stagedEnv?: Settings;
  failureMode?:
    | "fresh-database"
    | "tampered-backup"
    | "missing-workspace-file"
    | "created-home-env";
}

const appSettings: Settings = {
  SUPERPM_DATA_DIR: "app-data",
  SUPERPM_WORKSPACE_DIR: "app-workspace",
};
const homeSettings: Settings = {
  SUPERPM_DATA_DIR: "home-data",
  SUPERPM_WORKSPACE_DIR: "home-workspace",
};
const processSettings: Settings = {
  SUPERPM_DATA_DIR: "process-data",
  SUPERPM_WORKSPACE_DIR: "process-workspace",
};
const pathCases: PathCase[] = [
  { name: "默认 data/workspace" },
  { name: "旧 app .env 的相对路径", app: appSettings },
  {
    name: "home .env 相对路径覆盖 app .env",
    app: appSettings,
    home: homeSettings,
  },
  {
    name: "home .env 绝对路径覆盖 app .env",
    app: appSettings,
    home: homeSettings,
    absolute: true,
  },
  {
    name: "home .env 已有空字符串保留默认路径",
    app: appSettings,
    home: { SUPERPM_DATA_DIR: "", SUPERPM_WORKSPACE_DIR: "" },
  },
  {
    name: "进程相对路径覆盖 home 与 app .env",
    app: appSettings,
    home: homeSettings,
    process: processSettings,
  },
  {
    name: "进程绝对路径覆盖 home 与 app .env",
    app: appSettings,
    home: homeSettings,
    process: processSettings,
    absolute: true,
  },
  { name: "无旧数据库时迁移建库后失败", failureMode: "fresh-database" },
  { name: "迁移期间备份数据库被篡改", failureMode: "tampered-backup" },
  {
    name: "新包 .env 改变旧默认路径",
    stagedEnv: {
      SUPERPM_DATA_DIR: "new-app-data",
      SUPERPM_WORKSPACE_DIR: "new-app-workspace",
    },
  },
  {
    name: "迁移期间备份工作区文件缺失",
    failureMode: "missing-workspace-file",
  },
  {
    name: "更新前无 home .env 而失败迁移新建配置",
    failureMode: "created-home-env",
  },
];

function envText(settings: Settings) {
  return Object.entries(settings)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n");
}

function databaseValue(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare("SELECT value FROM fixture").get() as { value: string })
      .value;
  } finally {
    db.close();
  }
}

async function writeUpdateZip(path: string, stagedEnv?: Settings) {
  const zip = new yazl.ZipFile();
  const files: Record<string, Buffer | string> = {
    "app/package.json": JSON.stringify({
      name: "superpm-workbench",
      version: "1.1.0",
      type: "module",
    }),
    "app/apps/server/drizzle/0001_initial.sql": "-- fixture",
    "app/apps/server/dist/index.js": pathProbe,
    "app/apps/server/dist/mcp/stdio.js": "// fixture",
    "app/apps/server/dist/backup-cli.js": backupCli,
    "app/apps/server/dist/db/migrate-cli.js": migrationCli,
    "app/apps/web/dist/index.html": "<!doctype html><title>fixture</title>",
  };
  if (stagedEnv) files["app/.env"] = envText(stagedEnv);
  for (const [name, contents] of Object.entries(files))
    zip.addBuffer(
      typeof contents === "string" ? Buffer.from(contents) : contents,
      name,
    );
  const output = createWriteStream(path);
  const finished = new Promise<void>((done, fail) => {
    output.on("close", done);
    output.on("error", fail);
    zip.outputStream.on("error", fail);
  });
  zip.outputStream.pipe(output);
  zip.end();
  await finished;
}

describe.each(pathCases)("独立更新器自定义数据路径：$name", (pathCase) => {
  it.each(pathCase.failureMode ? [true] : [false, true])(
    "迁移失败=%s 时备份并保留正确的数据路径",
    async (migrationFails) => {
      const directory = mkdtempSync(join(tmpdir(), "superpm-updater-path-"));
      directories.push(directory);
      const installRoot = join(directory, "install");
      const appRoot = join(installRoot, "app");
      const home = join(directory, "home");
      let homeEnv = pathCase.home;
      let processEnv = pathCase.process;
      if (pathCase.absolute) {
        const absoluteSettings = {
          SUPERPM_DATA_DIR: join(directory, "external-data"),
          SUPERPM_WORKSPACE_DIR: join(directory, "external-workspace"),
        };
        if (processEnv) processEnv = absoluteSettings;
        else homeEnv = absoluteSettings;
      }
      const effectiveSettings = {
        ...pathCase.app,
        ...homeEnv,
        ...processEnv,
      };
      const databasePath = join(
        resolve(home, effectiveSettings.SUPERPM_DATA_DIR || "data"),
        "superpm.sqlite",
      );
      const workspacePath = resolve(
        home,
        effectiveSettings.SUPERPM_WORKSPACE_DIR || "workspace",
      );
      mkdirSync(dirname(databasePath), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      mkdirSync(home, { recursive: true });
      const migrations = join(appRoot, "apps/server/drizzle");
      const backupCliPath = join(appRoot, "apps/server/dist/backup-cli.js");
      mkdirSync(migrations, { recursive: true });
      mkdirSync(dirname(backupCliPath), { recursive: true });
      writeFileSync(join(migrations, "0001_initial.sql"), "-- fixture");
      writeFileSync(
        join(appRoot, "package.json"),
        JSON.stringify({
          name: "superpm-workbench",
          version: "1.0.0",
          type: "module",
        }),
      );
      writeFileSync(backupCliPath, backupCli);
      symlinkSync(
        join(projectRoot, "node_modules"),
        join(appRoot, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      if (pathCase.app)
        writeFileSync(join(appRoot, ".env"), envText(pathCase.app));
      if (homeEnv) writeFileSync(join(home, ".env"), envText(homeEnv));
      if (pathCase.failureMode !== "fresh-database") {
        const db = new Database(databasePath);
        db.exec(
          "CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('before')",
        );
        db.close();
      }
      writeFileSync(join(workspacePath, "marker.txt"), "before");

      const archivePath = join(directory, "update.zip");
      // 正式更新 ZIP 不复制旧程序根的 .env。
      await writeUpdateZip(archivePath, pathCase.stagedEnv);
      const archive = readFileSync(archivePath);
      const manifestPath = join(directory, "manifest.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: "superpm-workbench",
          version: "1.1.0",
          platform: `${process.platform}-${process.arch}`,
          schemaVersion: 1,
          update: {
            file: "update.zip",
            size: archive.length,
            sha256: createHash("sha256").update(archive).digest("hex"),
          },
        }),
      );
      const env = { ...process.env };
      for (const key of [
        "SUPERPM_DATA_DIR",
        "SUPERPM_WORKSPACE_DIR",
        "SUPERPM_UPDATE_TESTING",
        "SUPERPM_UPDATE_FAIL_AT",
      ])
        delete env[key];
      Object.assign(env, processEnv, {
        SUPERPM_HOME: home,
        SUPERPM_HOME_SOURCE: "env",
        SUPERPM_CONFIG_DIR: join(directory, "config"),
        SUPERPM_FIXTURE_MIGRATION_FAIL: migrationFails ? "1" : "0",
        SUPERPM_FIXTURE_FAILURE_MODE: pathCase.failureMode || "",
      });
      const result = spawnSync(
        process.execPath,
        [
          updater,
          "--manifest",
          manifestPath,
          "--install-root",
          installRoot,
          "--home",
          home,
          "--no-relocate",
          "--no-restart",
          "--json",
        ],
        { encoding: "utf8", env, windowsHide: true, timeout: 15000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(migrationFails ? 1 : 0);
      const outcome = JSON.parse(
        readFileSync(join(home, "updates/last-update.json"), "utf8"),
      );
      if (migrationFails)
        expect(outcome.error, JSON.stringify(outcome)).toContain(
          "fixture migration failed after changing data",
        );
      const effectiveEnvironment = {
        ...parseEnv(envText(pathCase.app ?? {})),
        ...parseEnv(envText(homeEnv ?? {})),
        ...processEnv,
      };
      const pathSettingsFile = join(home, "runtime/path-settings.json");
      expect(existsSync(pathSettingsFile), JSON.stringify(outcome)).toBe(true);
      expect(JSON.parse(readFileSync(pathSettingsFile, "utf8"))).toEqual({
        SUPERPM_DATA_DIR: effectiveEnvironment.SUPERPM_DATA_DIR || "data",
        SUPERPM_WORKSPACE_DIR:
          effectiveEnvironment.SUPERPM_WORKSPACE_DIR || "workspace",
      });
      if (pathCase.failureMode && pathCase.failureMode !== "created-home-env") {
        expect(outcome.status, JSON.stringify(outcome)).toBe("rollback-failed");
        expect(databaseValue(databasePath)).toBe("migrated");
        expect(readFileSync(join(workspacePath, "marker.txt"), "utf8")).toBe(
          "migrated",
        );
        expect(outcome.logs).not.toContain("已恢复旧程序与更新前数据");
        expect(outcome.rollbackError).toMatch(/备份|恢复/);
        if (pathCase.failureMode === "tampered-backup")
          expect(outcome.rollbackError).toMatch(/摘要|校验/);
        return;
      }
      expect(outcome.status, JSON.stringify(outcome)).toBe(
        migrationFails ? "rolled-back" : "updated",
      );
      const expectedValue = migrationFails ? "before" : "migrated";
      expect(databaseValue(databasePath), JSON.stringify(outcome)).toBe(
        expectedValue,
      );
      expect(readFileSync(join(workspacePath, "marker.txt"), "utf8")).toBe(
        expectedValue,
      );
      expect(outcome.backupId, JSON.stringify(outcome)).toEqual(
        expect.any(String),
      );
      const backupRoot = join(home, "backups", outcome.backupId);
      expect(databaseValue(join(backupRoot, "data/superpm.sqlite"))).toBe(
        "before",
      );
      expect(
        readFileSync(join(backupRoot, "workspace/marker.txt"), "utf8"),
      ).toBe("before");
      expect(
        JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version,
      ).toBe(migrationFails ? "1.0.0" : "1.1.0");
      if (effectiveSettings.SUPERPM_DATA_DIR)
        expect(existsSync(join(home, "data/superpm.sqlite"))).toBe(false);
      if (effectiveSettings.SUPERPM_WORKSPACE_DIR)
        expect(existsSync(join(home, "workspace"))).toBe(false);
      if (migrationFails && !homeEnv)
        expect(existsSync(join(home, ".env"))).toBe(false);
      if (!migrationFails) {
        const storedSettings = existsSync(join(home, ".env"))
          ? parseEnv(readFileSync(join(home, ".env")))
          : {};
        const originalHomeSettings = parseEnv(envText(homeEnv ?? {}));
        const originalAppSettings = parseEnv(envText(pathCase.app ?? {}));
        for (const [key, fallback] of [
          ["SUPERPM_DATA_DIR", "data"],
          ["SUPERPM_WORKSPACE_DIR", "workspace"],
        ] as const) {
          if (Object.hasOwn(originalHomeSettings, key))
            expect(storedSettings[key]).toBe(originalHomeSettings[key]);
          else if (
            Object.hasOwn(originalAppSettings, key) ||
            Object.hasOwn(pathCase.stagedEnv ?? {}, key)
          )
            expect(storedSettings[key]).toBe(
              (originalAppSettings[key] || fallback).replaceAll("\\", "/"),
            );
          else expect(storedSettings[key]).toBeUndefined();
        }
        // 普通启动只获得 launcher 的环境，不继承更新器冻结的 childEnv。
        const startupEnv = { ...env };
        delete startupEnv.SUPERPM_DATA_DIR;
        delete startupEnv.SUPERPM_WORKSPACE_DIR;
        const probe = spawnSync(
          process.execPath,
          [join(appRoot, "apps/server/dist/index.js")],
          { encoding: "utf8", env: startupEnv, windowsHide: true },
        );
        expect(probe.status, probe.stderr).toBe(0);
        const nextStartupSettings = { ...pathCase.app, ...homeEnv };
        expect(JSON.parse(probe.stdout)).toEqual({
          databasePath: join(
            resolve(home, nextStartupSettings.SUPERPM_DATA_DIR || "data"),
            "superpm.sqlite",
          ),
          workspacePath: resolve(
            home,
            nextStartupSettings.SUPERPM_WORKSPACE_DIR || "workspace",
          ),
        });
      }
    },
    20000,
  );
});
