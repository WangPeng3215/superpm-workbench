import Database from "better-sqlite3";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { inspectDatabase, type DatabaseSnapshot } from "../db/inspect.js";
import {
  sameWorkspace,
  walkWorkspace,
  type WorkspaceSnapshot,
} from "../services/workspace-scan.js";
import { appHome, appVersion, legacyRoot } from "./index.js";
import { appendFileLog } from "./logging.js";

export interface HomeMigrationOptions {
  /** 旧数据所在目录；发布包为安装根，开发环境为仓库根 */
  legacyRoot: string;
  home: string;
  version?: string;
  /** 仅供测试注入；默认读取进程环境变量 */
  dataSetting?: string;
  workspaceSetting?: string;
  lockTimeoutMs?: number;
}

export interface HomeMigrationResult {
  status: "skipped" | "completed";
  reason?: string;
  home: string;
  reportPath?: string;
  stagingPath?: string;
  database?: DatabaseSnapshot;
  workspace?: Omit<WorkspaceSnapshot, "entries">;
}

interface Targets {
  dataDir: string;
  workspaceDir: string;
  databasePath: string;
}

function resolveTargets(
  home: string,
  dataSetting: string,
  workspaceSetting: string,
): Targets {
  const dataDir = resolve(home, dataSetting);
  const workspaceDir = resolve(home, workspaceSetting);
  return {
    dataDir,
    workspaceDir,
    databasePath: join(dataDir, "superpm.sqlite"),
  };
}

function isInside(base: string, target: string): boolean {
  const distance = relative(base, target);
  return (
    distance === "" || (!distance.startsWith("..") && !isAbsolute(distance))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sleep(ms: number) {
  await new Promise((done) => setTimeout(done, ms));
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        { flag: "wx" },
      );
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let startedAt = 0;
      try {
        const state = JSON.parse(readFileSync(lockPath, "utf8")) as {
          startedAt?: string;
        };
        startedAt = Date.parse(state.startedAt ?? "");
        if (!Number.isFinite(startedAt)) startedAt = statSync(lockPath).mtimeMs;
      } catch {
        startedAt = 0;
      }
      if (startedAt > 0 && Date.now() - startedAt > 60 * 60 * 1000) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error(`另一个进程正在执行数据迁移（锁文件：${lockPath}）`);
      await sleep(250);
    }
  }
}

function moveIntoPlace(source: string, target: string) {
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    if (readdirSync(target).length > 0)
      throw new Error(`迁移目标目录已存在且非空：${target}`);
    rmSync(target, { recursive: true, force: true });
  }
  renameSync(source, target);
}

/**
 * 一次性把安装目录内的旧数据迁移到固定数据根。
 * 只复制、不删除旧数据；目标已存在时跳过。供 HTTP、MCP 与 CLI 启动前调用。
 */
export async function prepareHomeIfConfigured(): Promise<
  HomeMigrationResult | undefined
> {
  if (!appHome) return undefined;
  return prepareHome({
    legacyRoot,
    home: appHome,
    version: appVersion,
  });
}

export async function prepareHome(
  options: HomeMigrationOptions,
): Promise<HomeMigrationResult> {
  const home = resolve(options.home);
  const project = resolve(options.legacyRoot);
  const dataSetting =
    (options.dataSetting ?? process.env.SUPERPM_DATA_DIR) || "data";
  const workspaceSetting =
    (options.workspaceSetting ?? process.env.SUPERPM_WORKSPACE_DIR) ||
    "workspace";
  const targets = resolveTargets(home, dataSetting, workspaceSetting);
  mkdirSync(home, { recursive: true });

  if (existsSync(targets.databasePath))
    return { status: "skipped", reason: "数据根已就绪", home };

  if (
    !isInside(home, targets.dataDir) ||
    !isInside(home, targets.workspaceDir)
  ) {
    appendFileLog(
      home,
      "migration.log",
      "SUPERPM_DATA_DIR/SUPERPM_WORKSPACE_DIR 指向数据根之外，跳过自动迁移",
    );
    return {
      status: "skipped",
      reason: "数据路径由环境变量显式指定在数据根之外",
      home,
    };
  }

  const legacyDatabase = join(project, "data", "superpm.sqlite");
  const legacyWorkspace = join(project, "workspace");
  const legacyEnv = join(project, ".env");
  if (!existsSync(legacyDatabase)) {
    appendFileLog(home, "migration.log", "未发现安装目录旧数据，跳过迁移");
    return { status: "skipped", reason: "未发现旧数据", home };
  }
  if (
    existsSync(targets.workspaceDir) &&
    readdirSync(targets.workspaceDir).length > 0
  )
    throw new Error(
      `数据根工作区已存在内容但数据库缺失，拒绝迁移以免覆盖：${targets.workspaceDir}`,
    );

  const lockPath = join(home, ".migration.lock");
  await acquireLock(lockPath, options.lockTimeoutMs ?? 15000);
  if (existsSync(targets.databasePath)) {
    rmSync(lockPath, { force: true });
    return { status: "skipped", reason: "数据根已就绪", home };
  }

  const staging = join(home, `.migration-staging-${Date.now()}`);
  const stagingData = join(staging, "data");
  const stagingWorkspace = join(staging, "workspace");
  const stagingEnv = join(staging, ".env");
  const statePath = join(home, "migration-state.json");
  mkdirSync(stagingData, { recursive: true });
  mkdirSync(stagingWorkspace, { recursive: true });

  try {
    const source = new Database(legacyDatabase);
    try {
      await source.backup(join(stagingData, "superpm.sqlite"));
    } finally {
      source.close();
    }

    if (existsSync(legacyWorkspace))
      cpSync(legacyWorkspace, stagingWorkspace, {
        recursive: true,
        force: true,
        dereference: false,
      });

    let envCopied = false;
    if (existsSync(legacyEnv) && !existsSync(join(home, ".env"))) {
      copyFileSync(legacyEnv, stagingEnv);
      envCopied = true;
    }

    const legacyDatabaseInfo = inspectDatabase(legacyDatabase);
    const backupDatabaseInfo = inspectDatabase(
      join(stagingData, "superpm.sqlite"),
    );
    if (
      JSON.stringify(legacyDatabaseInfo.tables) !==
      JSON.stringify(backupDatabaseInfo.tables)
    )
      throw new Error("数据库复制校验失败：新旧表行数不一致");
    const legacyWorkspaceInfo = walkWorkspace(legacyWorkspace);
    const backupWorkspaceInfo = walkWorkspace(stagingWorkspace);
    if (!sameWorkspace(legacyWorkspaceInfo, backupWorkspaceInfo))
      throw new Error("工作区复制校验失败：文件清单不一致");

    let dataMoved = false;
    let workspaceMoved = false;
    try {
      moveIntoPlace(stagingData, targets.dataDir);
      dataMoved = true;
      moveIntoPlace(stagingWorkspace, targets.workspaceDir);
      workspaceMoved = true;
    } catch (error) {
      if (workspaceMoved)
        renameSync(
          targets.workspaceDir,
          join(staging, "workspace-rolled-back"),
        );
      if (dataMoved)
        renameSync(targets.dataDir, join(staging, "data-rolled-back"));
      throw error;
    }
    if (envCopied && !existsSync(join(home, ".env")))
      renameSync(stagingEnv, join(home, ".env"));

    const report = {
      status: "completed" as const,
      migratedAt: new Date().toISOString(),
      version: options.version ?? "unknown",
      home,
      legacy: {
        projectRoot: project,
        databasePath: legacyDatabase,
        workspacePath: legacyWorkspace,
      },
      database: backupDatabaseInfo,
      workspace: {
        files: backupWorkspaceInfo.files,
        bytes: backupWorkspaceInfo.bytes,
      },
      envCopied,
    };
    writeFileSync(statePath, JSON.stringify(report, null, 2));
    appendFileLog(
      home,
      "migration.log",
      `迁移完成：数据库 ${Object.keys(backupDatabaseInfo.tables).length} 张表，文件 ${backupWorkspaceInfo.files} 个；旧数据保留在 ${project}`,
    );
    rmSync(staging, { recursive: true, force: true });
    return {
      status: "completed",
      home,
      reportPath: statePath,
      database: backupDatabaseInfo,
      workspace: report.workspace,
    };
  } catch (error) {
    const message = errorMessage(error);
    try {
      writeFileSync(
        statePath,
        JSON.stringify(
          {
            status: "failed",
            failedAt: new Date().toISOString(),
            home,
            legacy: {
              projectRoot: project,
              databasePath: legacyDatabase,
              workspacePath: legacyWorkspace,
            },
            stagingPath: staging,
            error: message,
          },
          null,
          2,
        ),
      );
    } catch {
      // 状态文件写入失败不应覆盖原始迁移错误
    }
    appendFileLog(home, "migration.log", `迁移失败：${message}；旧数据未改动`);
    throw new Error(
      `数据迁移失败：${message}（旧数据未改动，暂存目录：${staging}）`,
    );
  } finally {
    rmSync(lockPath, { force: true });
  }
}
