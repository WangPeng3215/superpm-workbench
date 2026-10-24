import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appVersion,
  isPackagedRoot,
  loadEnv,
  projectRoot,
} from "../src/config/index.js";
import { SCHEMA_VERSION } from "../src/db/migrate.js";

const directories: string[] = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), "superpm-version-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

describe("版本号与环境加载", () => {
  it("应用版本取自根 package.json，schema 版本取自迁移文件", () => {
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, "package.json"), "utf8"),
    ) as { version: string };
    expect(appVersion).toBe(manifest.version);
    const versions = readdirSync(join(projectRoot, "apps/server/drizzle"))
      .map((file) => /^(\d+)_.*\.sql$/.exec(file)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    expect(SCHEMA_VERSION).toBe(Math.max(...versions));
  });

  it("env 优先级：进程变量 > 数据根 .env > 项目根 .env", () => {
    const base = tempDir();
    const project = join(base, "install");
    const home = join(base, "home");
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(project, ".env"),
      `SUPERPM_HOME=${home}\nSUPERPM_WORKSPACE_DIR=from-project\nPORT=4001\n`,
      "utf8",
    );
    writeFileSync(
      join(home, ".env"),
      "SUPERPM_WORKSPACE_DIR=from-home\nPORT=4002\n",
      "utf8",
    );

    const fromFiles: NodeJS.ProcessEnv = {};
    expect(loadEnv(project, fromFiles)).toBe(home);
    expect(fromFiles.SUPERPM_WORKSPACE_DIR).toBe("from-home");
    expect(fromFiles.PORT).toBe("4002");

    const withProcess: NodeJS.ProcessEnv = {
      SUPERPM_HOME: home,
      SUPERPM_WORKSPACE_DIR: "from-process",
    };
    expect(loadEnv(project, withProcess)).toBe(home);
    expect(withProcess.SUPERPM_WORKSPACE_DIR).toBe("from-process");
    expect(withProcess.PORT).toBe("4002");
  });

  it("未配置数据根时返回 undefined，仅加载项目根 .env", () => {
    const base = tempDir();
    const project = join(base, "install");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".env"), "PORT=4100\n", "utf8");
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnv(project, env)).toBeUndefined();
    expect(env.PORT).toBe("4100");
  });

  it("发布模式按目录名或打包清单识别，开发仓库不被误判", () => {
    const base = tempDir();
    const packaged = join(base, "app");
    const renamed = join(base, "superPM");
    const workspace = join(base, "repo");
    for (const directory of [packaged, renamed, workspace])
      mkdirSync(directory, { recursive: true });
    // 打包脚本生成的 app/package.json：无 workspaces
    writeFileSync(
      join(renamed, "package.json"),
      JSON.stringify({
        name: "superpm-workbench",
        version: "0.3.1",
        private: true,
        dependencies: { "better-sqlite3": "12.11.1" },
      }),
      "utf8",
    );
    // 开发仓库根清单：带 workspaces
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({
        name: "superpm-workbench",
        version: "0.3.1",
        private: true,
        workspaces: ["apps/*", "packages/*"],
      }),
      "utf8",
    );

    expect(isPackagedRoot(packaged)).toBe(true);
    expect(isPackagedRoot(renamed)).toBe(true);
    expect(isPackagedRoot(workspace)).toBe(false);
    expect(isPackagedRoot(join(base, "empty"))).toBe(false);
  });

  it("发布包数据根读取配置指针并设置来源", () => {
    const base = tempDir();
    const configDir = join(base, "config");
    const home = join(base, "home");
    const appRoot = join(base, "app");
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(join(home, "data", "superpm.sqlite"), "");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ schemaVersion: 1, home }),
      "utf8",
    );
    const env: NodeJS.ProcessEnv = {
      SUPERPM_CONFIG_DIR: configDir,
      LOCALAPPDATA: join(base, "local"),
    };
    expect(loadEnv(appRoot, env)).toBe(home);
    expect(env.SUPERPM_HOME).toBe(home);
    expect(env.SUPERPM_HOME_SOURCE).toBe("config");
  });

  it("配置指针指向不可用目录时拒绝启动", () => {
    const base = tempDir();
    const configDir = join(base, "config");
    const appRoot = join(base, "app");
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ schemaVersion: 1, home: join(base, "offline") }),
      "utf8",
    );
    expect(() => loadEnv(appRoot, { SUPERPM_CONFIG_DIR: configDir })).toThrow(
      /数据根不可用/,
    );
  });

  it("defaultPaths 在数据根内解析相对路径", async () => {
    const home = tempDir();
    const saved = { ...process.env };
    vi.resetModules();
    process.env.SUPERPM_HOME = home;
    process.env.SUPERPM_DATA_DIR = "store";
    process.env.SUPERPM_WORKSPACE_DIR = "files";
    try {
      const config = await import("../src/config/index.js");
      const paths = config.defaultPaths();
      expect(paths.databasePath).toBe(join(home, "store", "superpm.sqlite"));
      expect(paths.workspacePath).toBe(join(home, "files"));
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      vi.resetModules();
    }
  });
});
