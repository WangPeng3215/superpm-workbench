#!/usr/bin/env node
// 独立数据根迁移助手：停服、复制、校验、切换配置指针并重启；失败时保留源数据并回滚。
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  resolveDataRoot,
  writeDataRootConfig,
  writeHomeMarker,
  writeMovedMarker,
} from "@superpm/shared/data-root";

const SPACE_RESERVE_BYTES = 256 * 1024 * 1024;
const MAX_TARGET_LENGTH = 200;
const CLEANUP_PATHS = ["data", "workspace", "backups", ".env"];
const isWindows = process.platform === "win32";

function parseArgs(argv) {
  const options = { job: undefined };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === "--job") options.job = argv[++index];
    else if (item === "--help" || item === "-h") options.help = true;
    else throw new Error(`未知参数：${item}`);
  }
  return options;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function samePath(left, right) {
  return isWindows
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function isInside(base, target) {
  const distance = relative(resolve(base), resolve(target));
  return (
    distance === "" ||
    (!distance.startsWith(`..${isWindows ? "\\" : "/"}`) &&
      distance !== ".." &&
      !isAbsolute(distance))
  );
}

function normalizeRelative(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function fileEntry(path) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return { type: "link", size: 0 };
    if (info.isDirectory()) return { type: "directory", size: 0 };
    return { type: "file", size: info.size };
  } catch {
    return null;
  }
}

function walk(root, base = root, skip = new Set(), result = []) {
  let names;
  try {
    names = readdirSync(root).sort();
  } catch {
    return result;
  }
  for (const name of names) {
    const full = join(root, name);
    if (skip.has(resolve(full))) continue;
    const info = fileEntry(full);
    if (!info) continue;
    const path = normalizeRelative(relative(base, full));
    result.push({ path, ...info });
    if (info.type === "directory") walk(full, base, skip, result);
  }
  return result;
}

function totalOf(entries) {
  return {
    files: entries.filter((entry) => entry.type !== "directory").length,
    bytes: entries.reduce((total, entry) => total + entry.size, 0),
  };
}

function isEmptyDirectory(path) {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function nearestExisting(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function freeBytesAt(path) {
  try {
    const stats = statfsSync(nearestExisting(path));
    return stats.bavail * stats.bsize;
  } catch {
    return 0;
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function describeError(error) {
  const parts = [];
  let current = error;
  while (current) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join("；原因：");
}

function killTree(pid, log) {
  if (!Number.isInteger(pid) || pid === process.pid) return;
  log(`强制结束进程树 ${pid}`);
  if (isWindows)
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程可能已退出
    }
  }
}

function readUpdateLock(home) {
  const path = join(home, "runtime", "update.lock");
  const lock = readJson(path);
  if (!lock) {
    try {
      if (Date.now() - statSync(path).mtimeMs < 30 * 60 * 1000)
        return { pid: 0, createdAt: "未知" };
    } catch {
      return null;
    }
    rmSync(path, { force: true });
    return null;
  }
  if (isAlive(lock.pid)) return lock;
  rmSync(path, { force: true });
  return null;
}

function liveMcpProcesses(home) {
  const directory = join(home, "runtime", "mcp");
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const result = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readJson(join(directory, name));
    if (!record || !Number.isInteger(record.pid) || !isAlive(record.pid))
      continue;
    result.push(record);
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`superPM 数据根迁移助手

用法：move-home.mjs --job <任务文件>`);
    return;
  }
  if (!options.job) throw new Error("缺少 --job 参数");

  const jobPath = resolve(options.job);
  const configDir = resolve(process.env.SUPERPM_CONFIG_DIR || dirname(jobPath));
  const jobRaw = readJson(jobPath);
  if (!jobRaw || typeof jobRaw !== "object")
    throw new Error(`无法读取迁移任务：${jobPath}`);
  const schemaVersion = Number(jobRaw.schemaVersion);
  const jobId = String(jobRaw.jobId ?? "");
  const fromHome = resolve(String(jobRaw.fromHome ?? ""));
  const toHome = resolve(String(jobRaw.toHome ?? ""));
  const installRoot = resolve(
    String(jobRaw.installRoot || process.env.SUPERPM_INSTALL_ROOT || ""),
  );
  if (
    schemaVersion !== 1 ||
    !jobId ||
    !isAbsolute(fromHome) ||
    !isAbsolute(toHome) ||
    !isAbsolute(installRoot)
  )
    throw new Error("迁移任务格式无效");

  const logsDir = join(configDir, "logs");
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const logPath = join(
    logsDir,
    `move-home-${new Date().toISOString().slice(0, 10)}.log`,
  );
  const log = (message, error) => {
    const detail =
      error === undefined
        ? ""
        : `\n    ${describeError(error)}${
            error instanceof Error && error.stack ? `\n${error.stack}` : ""
          }`;
    try {
      writeFileSync(
        logPath,
        `${new Date().toISOString()} [${jobId}] ${message}${detail}\n`,
        { flag: "a", mode: 0o600 },
      );
    } catch {
      // 日志失败不阻断迁移
    }
    console.error(`[move-home] ${message}${detail}`);
  };

  const moveHomePaths = {
    statePath: join(configDir, "move-home.json"),
    lockPath: join(configDir, "operation.lock"),
  };
  const readState = () => readJson(moveHomePaths.statePath);
  const readLock = () => readJson(moveHomePaths.lockPath);

  let state = readState();
  let phase = state?.phase ?? "preparing";
  const startedAt = state?.startedAt ?? new Date().toISOString();
  const writeState = (patch) => {
    state = {
      schemaVersion: 1,
      jobId,
      fromHome,
      toHome,
      startedAt,
      cleanup: "none",
      ...(state ?? {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const temporary = `${moveHomePaths.statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, moveHomePaths.statePath);
  };
  const setPhase = (next) => {
    phase = next;
    writeState({ status: "running", phase: next });
  };
  const writeLock = (lock) => {
    const temporary = `${moveHomePaths.lockPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(lock, null, 2), { mode: 0o600 });
    renameSync(temporary, moveHomePaths.lockPath);
  };

  // 接管服务端创建的操作锁，或自行创建
  let lock = readLock();
  const stamp = new Date().toISOString();
  if (lock) {
    if (lock.jobId !== jobId)
      throw new Error(`已有其他迁移任务（${lock.jobId}），拒绝执行`);
    lock = {
      ...lock,
      pid: process.pid,
      heartbeatAt: stamp,
    };
    writeLock(lock);
  } else {
    lock = {
      schemaVersion: 1,
      kind: "move",
      jobId,
      pid: process.pid,
      startedAt,
      heartbeatAt: stamp,
    };
    try {
      writeFileSync(moveHomePaths.lockPath, JSON.stringify(lock, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      throw new Error(`无法创建迁移锁：${describeError(error)}`);
    }
  }
  const heartbeat = setInterval(() => {
    lock.heartbeatAt = new Date().toISOString();
    try {
      writeLock(lock);
    } catch {
      // 心跳失败不终止迁移
    }
  }, 5000);
  heartbeat.unref();

  let lockOwned = true;
  const releaseLock = () => {
    if (!lockOwned) return;
    lockOwned = false;
    clearInterval(heartbeat);
    const current = readLock();
    if (current && current.jobId !== jobId) return;
    rmSync(moveHomePaths.lockPath, { force: true });
  };

  let staging = null;
  let targetCreated = false;
  let pointerSwitched = false;
  let serverStopped = false;
  let previousRaw = null;
  let previousBackupRaw = null;
  let migratedContent = false;
  let oldVersion = "0.0.0";
  let sourceSchema = 0;
  let managedPaths = [];
  const appRoot = join(installRoot, "app");
  const runtimeNode = join(
    installRoot,
    "runtime",
    isWindows ? "node.exe" : "node",
  );
  const node = existsSync(runtimeNode) ? runtimeNode : process.execPath;
  const launcher = join(installRoot, "bin", "launcher.mjs");
  const configPath = join(configDir, "config.json");

  const startLauncher = () => {
    const env = {
      ...process.env,
      SUPERPM_INSTALL_ROOT: installRoot,
      SUPERPM_CONFIG_DIR: configDir,
      SUPERPM_MOVE_RESTART_JOB: jobId,
    };
    delete env.SUPERPM_HOME;
    delete env.SUPERPM_HOME_SOURCE;
    const child = spawn(node, [launcher], {
      cwd: installRoot,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  };

  const waitForHealth = async (home, expectedVersion, expectedSchema) => {
    const deadline = Date.now() + 60000;
    let lastError = "服务未写入运行状态";
    while (Date.now() < deadline) {
      const server = readJson(join(home, "runtime", "server.json"));
      if (server && isAlive(server.pid) && Number.isInteger(server.port)) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${server.port}/api/health`,
            { signal: AbortSignal.timeout(1200) },
          );
          if (!response.ok) lastError = `健康检查 HTTP ${response.status}`;
          else {
            const health = await response.json();
            if (health.status !== "ok" || health.database !== "ok")
              lastError = `健康检查未通过：${JSON.stringify(health)}`;
            else if (health.pid !== server.pid)
              lastError = `服务 PID 不一致（${health.pid} ≠ ${server.pid}）`;
            else if (expectedVersion && health.version !== expectedVersion)
              lastError = `服务版本为 ${health.version}，期望 ${expectedVersion}`;
            else if (
              expectedSchema != null &&
              health.schemaVersion !== expectedSchema
            )
              lastError = `数据库版本为 ${health.schemaVersion}，期望 ${expectedSchema}`;
            else return { health, server };
          }
        } catch (error) {
          lastError = describeError(error);
        }
      }
      await sleep(500);
    }
    throw new Error(`服务未在 60 秒内就绪：${lastError}`);
  };

  const stopServer = async (home) => {
    const server = readJson(join(home, "runtime", "server.json"));
    if (!server || !isAlive(server.pid)) return false;
    log(`正在请求服务停止（PID ${server.pid}）`);
    try {
      await fetch(`http://127.0.0.1:${server.port}/api/shutdown`, {
        method: "POST",
        headers: { "x-superpm-shutdown-token": server.shutdownToken },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      log("服务未响应停止请求，等待进程退出");
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!isAlive(server.pid)) return true;
      await sleep(250);
    }
    log(`服务未在 15 秒内退出（PID ${server.pid}），强制结束进程树`);
    killTree(server.pid, log);
    for (let index = 0; index < 40 && isAlive(server.pid); index++)
      await sleep(250);
    if (isAlive(server.pid))
      throw new Error(`无法结束旧服务进程 ${server.pid}`);
    return true;
  };

  const stopServerFromNewHome = async () => {
    const server = readJson(join(toHome, "runtime", "server.json"));
    if (!server || !isAlive(server.pid)) return;
    try {
      await fetch(`http://127.0.0.1:${server.port}/api/shutdown`, {
        method: "POST",
        headers: { "x-superpm-shutdown-token": server.shutdownToken },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // 直接结束
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isAlive(server.pid)) await sleep(250);
    if (isAlive(server.pid)) killTree(server.pid, log);
  };

  const restorePreviousConfig = () => {
    if (previousRaw !== null) {
      const temporary = `${configPath}.restore-${process.pid}`;
      writeFileSync(temporary, previousRaw, { mode: 0o600 });
      renameSync(temporary, configPath);
      if (previousBackupRaw !== null)
        writeFileSync(`${configPath}.bak`, previousBackupRaw);
      else rmSync(`${configPath}.bak`, { force: true });
    } else {
      rmSync(configPath, { force: true });
    }
  };

  const inspectDatabase = (path) => {
    const require = createRequire(join(appRoot, "package.json"));
    const Database = require("better-sqlite3");
    const db = new Database(path, { fileMustExist: true });
    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok")
        throw new Error(`数据库完整性检查失败：${integrity}`);
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      const counts = {};
      for (const table of tables) {
        const row = db
          .prepare(`SELECT COUNT(*) AS count FROM "${table.name}"`)
          .get();
        counts[table.name] = row.count;
      }
      const hasMigrations = tables.some(
        (table) => table.name === "schema_migrations",
      );
      const schemaVersion = hasMigrations
        ? db
            .prepare(
              "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
            )
            .get().version
        : 0;
      return { integrity, schemaVersion, tables: counts };
    } finally {
      db.close();
    }
  };

  const copyTree = (source, target, counters, skip = new Set()) => {
    const info = lstatSync(source);
    if (info.isSymbolicLink()) {
      mkdirSync(dirname(target), { recursive: true });
      const link = readlinkSync(source);
      try {
        symlinkSync(link, target, isWindows ? "junction" : undefined);
      } catch {
        symlinkSync(link, target, isWindows ? "file" : undefined);
      }
      counters.files += 1;
      return;
    }
    if (info.isDirectory()) {
      mkdirSync(target, { recursive: true });
      for (const name of readdirSync(source).sort())
        copyTree(join(source, name), join(target, name), counters, skip);
      return;
    }
    if (skip.has(resolve(source))) return;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    counters.files += 1;
    counters.bytes += info.size;
  };

  const compareEntries = (label, expected, actual) => {
    const left = JSON.stringify(
      expected.map((entry) => [entry.path, entry.type, entry.size]),
    );
    const right = JSON.stringify(
      actual.map((entry) => [entry.path, entry.type, entry.size]),
    );
    if (left !== right)
      throw new Error(`${label}校验失败：复制结果与源清单不一致`);
  };

  try {
    // 1. 校验任务与来源
    setPhase("preparing");
    log(`开始迁移 ${fromHome} → ${toHome}`);
    const appManifest = readJson(join(appRoot, "package.json"));
    if (!appManifest || typeof appManifest.version !== "string")
      throw new Error(`安装目录不完整：缺少 ${join(appRoot, "package.json")}`);
    if (!existsSync(launcher)) throw new Error(`安装目录缺少 ${launcher}`);
    oldVersion = appManifest.version;

    const cleanEnv = { ...process.env };
    delete cleanEnv.SUPERPM_HOME;
    delete cleanEnv.SUPERPM_HOME_SOURCE;
    const resolution = resolveDataRoot({
      env: cleanEnv,
      packaged: true,
      developmentRoot: installRoot,
    });
    if (!samePath(resolution.home, fromHome))
      throw new Error(
        `当前数据根已变化：任务记录 ${fromHome}，实际 ${resolution.home}`,
      );

    const updateLock = readUpdateLock(fromHome);
    if (updateLock)
      throw new Error(
        `检测到更新任务（PID ${updateLock.pid}，开始于 ${updateLock.createdAt}），请等待更新完成`,
      );
    const mcp = liveMcpProcesses(fromHome);
    if (mcp.length > 0)
      throw new Error(
        `仍有 MCP 进程运行（PID ${mcp.map((item) => item.pid).join(", ")}），请关闭客户端后重试`,
      );

    // 2. 重新校验目标
    const targetRoot = parse(toHome).root;
    if (toHome.startsWith("\\\\") || toHome.startsWith("//"))
      throw new Error("不支持 UNC 网络路径");
    if (toHome.length > MAX_TARGET_LENGTH)
      throw new Error(`目标路径过长（${toHome.length} 个字符）`);
    if (samePath(targetRoot, toHome)) throw new Error("目标不能是盘符根目录");
    if (samePath(toHome, fromHome)) throw new Error("目标就是当前数据根");
    if (isInside(fromHome, toHome)) throw new Error("目标位于当前数据根内部");
    if (isInside(toHome, fromHome)) throw new Error("目标包含当前数据根");
    if (isInside(installRoot, toHome) || isInside(toHome, installRoot))
      throw new Error("目标与安装目录不能互相包含");
    if (isInside(configDir, toHome))
      throw new Error("目标不能位于配置目录内部");
    if (
      !existsSync(dirname(toHome)) ||
      !statSync(dirname(toHome)).isDirectory()
    )
      throw new Error("目标父目录不存在");
    if (existsSync(toHome)) {
      if (!statSync(toHome).isDirectory())
        throw new Error("目标路径已存在同名文件");
      if (!isEmptyDirectory(toHome)) throw new Error("目标目录已存在且非空");
    }

    // 3. 源快照
    const settings = {
      data: process.env.SUPERPM_DATA_DIR?.trim() || "data",
      workspace: process.env.SUPERPM_WORKSPACE_DIR?.trim() || "workspace",
    };
    if (isAbsolute(settings.data) || isAbsolute(settings.workspace))
      throw new Error("数据目录或工作区使用了绝对路径，无法迁移");
    const dataDir = resolve(fromHome, settings.data);
    const workspaceDir = resolve(fromHome, settings.workspace);
    if (!isInside(fromHome, dataDir) || !isInside(fromHome, workspaceDir))
      throw new Error("数据目录或工作区不在当前数据根内");
    const database = join(dataDir, "superpm.sqlite");
    const databaseExists = existsSync(database);
    const skip = new Set(
      [database, `${database}-wal`, `${database}-shm`].map((path) =>
        resolve(path),
      ),
    );
    const dataEntries = walk(dataDir, dataDir, skip);
    const workspaceEntries = walk(workspaceDir);
    const backupEntries = walk(join(fromHome, "backups"));
    const envPath = join(fromHome, ".env");
    const envExists = existsSync(envPath);
    const envSize = envExists ? statSync(envPath).size : 0;
    const dbBytes = databaseExists
      ? [database, `${database}-wal`, `${database}-shm`].reduce(
          (total, path) => {
            try {
              return total + statSync(path).size;
            } catch {
              return total;
            }
          },
          0,
        )
      : 0;
    const dataTotals = totalOf(dataEntries);
    const workspaceTotals = totalOf(workspaceEntries);
    const backupTotals = totalOf(backupEntries);
    const totalBytes =
      dbBytes +
      dataTotals.bytes +
      workspaceTotals.bytes +
      backupTotals.bytes +
      envSize;
    const totalFiles =
      (databaseExists ? 1 : 0) +
      dataTotals.files +
      workspaceTotals.files +
      backupTotals.files +
      (envExists ? 1 : 0);
    migratedContent =
      databaseExists ||
      workspaceEntries.some(
        (entry) => entry.type === "file" || entry.type === "link",
      );
    if (!databaseExists && migratedContent)
      throw new Error("数据库缺失但工作区仍有文件，已拒绝迁移");
    if (totalBytes * 1.15 + SPACE_RESERVE_BYTES > freeBytesAt(toHome))
      throw new Error("目标可用空间不足");

    let databaseSnapshot = null;
    if (databaseExists) {
      databaseSnapshot = inspectDatabase(database);
      sourceSchema = databaseSnapshot.schemaVersion;
    }

    const progress = {
      copiedBytes: 0,
      totalBytes,
      copiedFiles: 0,
      totalFiles,
    };
    let progressAt = 0;
    const flushProgress = (force = false) => {
      if (!force && Date.now() - progressAt < 200) return;
      progressAt = Date.now();
      writeState({ status: "running", phase, progress: { ...progress } });
    };

    // 4. 停服
    setPhase("stopping");
    // 等待发起迁移的 202 响应写入完成，避免停服时前端读不到任务状态。
    await sleep(500);
    serverStopped = await stopServer(fromHome);
    if (serverStopped) log("旧服务已停止");

    // 5. 暂存与复制
    staging = join(dirname(toHome), `.superPM-staging-${jobId}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    setPhase("copying");
    const dataTarget = join(staging, relative(fromHome, dataDir));
    const workspaceTarget = join(staging, relative(fromHome, workspaceDir));
    if (databaseExists) {
      mkdirSync(dataTarget, { recursive: true });
      const require = createRequire(join(appRoot, "package.json"));
      const Database = require("better-sqlite3");
      const db = new Database(database);
      try {
        await db.backup(join(dataTarget, "superpm.sqlite"));
      } finally {
        db.close();
      }
      progress.copiedFiles = 1;
      progress.copiedBytes = dbBytes;
      flushProgress(true);
    }
    const counters = { files: 0, bytes: 0 };
    if (existsSync(dataDir)) copyTree(dataDir, dataTarget, counters, skip);
    progress.copiedFiles = (databaseExists ? 1 : 0) + counters.files;
    progress.copiedBytes = dbBytes + counters.bytes;
    flushProgress(true);
    counters.files = 0;
    counters.bytes = 0;
    if (existsSync(workspaceDir))
      copyTree(workspaceDir, workspaceTarget, counters);
    progress.copiedFiles =
      (databaseExists ? 1 : 0) + dataTotals.files + counters.files;
    progress.copiedBytes = dbBytes + dataTotals.bytes + counters.bytes;
    flushProgress(true);
    counters.files = 0;
    counters.bytes = 0;
    if (envExists) {
      copyFileSync(envPath, join(staging, ".env"));
      counters.files += 1;
      counters.bytes += envSize;
    }
    if (existsSync(join(fromHome, "backups")))
      copyTree(join(fromHome, "backups"), join(staging, "backups"), counters);
    progress.copiedFiles =
      (databaseExists ? 1 : 0) +
      dataTotals.files +
      workspaceTotals.files +
      counters.files;
    progress.copiedBytes =
      dbBytes + dataTotals.bytes + workspaceTotals.bytes + counters.bytes;
    flushProgress(true);
    log(
      `复制完成：${progress.copiedFiles}/${totalFiles} 个文件，${progress.copiedBytes}/${totalBytes} 字节`,
    );

    // 6. 校验
    setPhase("verifying");
    if (databaseSnapshot) {
      const targetSnapshot = inspectDatabase(
        join(dataTarget, "superpm.sqlite"),
      );
      if (
        targetSnapshot.integrity !== "ok" ||
        JSON.stringify(targetSnapshot.tables) !==
          JSON.stringify(databaseSnapshot.tables) ||
        targetSnapshot.schemaVersion !== databaseSnapshot.schemaVersion
      )
        throw new Error("目标数据库校验失败：表结构或行数与源不一致");
    }
    compareEntries(
      "数据目录",
      dataEntries,
      walk(
        dataTarget,
        dataTarget,
        new Set([resolve(join(dataTarget, "superpm.sqlite"))]),
      ),
    );
    compareEntries("工作区", workspaceEntries, walk(workspaceTarget));
    compareEntries("备份", backupEntries, walk(join(staging, "backups")));
    if (envExists) {
      const targetEnv = join(staging, ".env");
      if (
        !existsSync(targetEnv) ||
        sha256File(targetEnv) !== sha256File(envPath) ||
        statSync(targetEnv).size !== envSize
      )
        throw new Error(".env 校验失败");
    }
    if (freeBytesAt(toHome) < SPACE_RESERVE_BYTES)
      throw new Error("目标剩余空间不足，迁移已中止");
    log("复制结果校验通过");

    // 7. 切换
    setPhase("switching");
    writeHomeMarker(staging, {
      schemaVersion: 1,
      home: toHome,
      movedFrom: fromHome,
      jobId,
      createdAt: new Date().toISOString(),
    });
    if (existsSync(toHome)) rmdirSync(toHome);
    renameSync(staging, toHome);
    staging = null;
    targetCreated = true;
    writeMovedMarker(fromHome, {
      schemaVersion: 1,
      to: toHome,
      jobId,
      movedAt: new Date().toISOString(),
    });
    log("暂存目录已切换到目标");

    previousRaw = existsSync(configPath) ? readFileSync(configPath) : null;
    previousBackupRaw = existsSync(`${configPath}.bak`)
      ? readFileSync(`${configPath}.bak`)
      : null;
    writeDataRootConfig(
      {
        schemaVersion: 1,
        home: toHome,
        previousHome: fromHome,
        updatedAt: new Date().toISOString(),
      },
      { configDir },
    );
    pointerSwitched = true;
    log(`配置指针已切换到 ${toHome}`);

    // 8. 重启并验证
    setPhase("restarting");
    startLauncher();
    const { health } = await waitForHealth(toHome, oldVersion, sourceSchema);
    log(`新服务已就绪：v${health.version}，PID ${health.pid}`);

    managedPaths = CLEANUP_PATHS.filter((path) =>
      existsSync(join(fromHome, path)),
    );
    writeState({
      status: "completed",
      phase: "completed",
      progress: { ...progress },
      cleanup: migratedContent ? "pending" : "none",
      ...(migratedContent
        ? {
            oldHome: fromHome,
            managedPaths,
            movedAt: new Date().toISOString(),
          }
        : {}),
    });
    releaseLock();
    log(
      `迁移完成：${fromHome} → ${toHome}${
        migratedContent
          ? "；旧数据待用户确认处理"
          : "；无数据库/工作区内容，仅切换配置"
      }`,
    );
  } catch (error) {
    const failedPhase = phase;
    log(`迁移失败（阶段 ${failedPhase}）`, error);
    let rollback = "not-needed";
    let detail = describeError(error);
    if (pointerSwitched) {
      try {
        await stopServerFromNewHome();
        restorePreviousConfig();
        log("已恢复旧配置指针");
        if (serverStopped) {
          startLauncher();
          const { health } = await waitForHealth(
            fromHome,
            oldVersion,
            sourceSchema,
          );
          log(`旧服务已恢复运行：v${health.version}，PID ${health.pid}`);
        }
        rollback = "restored-old";
      } catch (failure) {
        rollback = "failed";
        detail += `；回滚失败：${describeError(failure)}。请手动启动 ${launcher}`;
        log("回滚失败", failure);
      }
    } else {
      if (staging) rmSync(staging, { recursive: true, force: true });
      if (serverStopped) {
        try {
          startLauncher();
          const { health } = await waitForHealth(
            fromHome,
            oldVersion,
            sourceSchema,
          );
          log(`旧服务已恢复运行：v${health.version}，PID ${health.pid}`);
        } catch (failure) {
          rollback = "failed";
          detail += `；旧服务恢复失败：${describeError(failure)}`;
          log("旧服务恢复失败", failure);
        }
      }
    }
    if (targetCreated) detail += `；目标目录已保留：${toHome}`;
    try {
      writeState({
        status: "failed",
        phase: "failed",
        error: { message: detail, phase: failedPhase, rollback },
      });
    } catch (stateError) {
      log("无法写入失败状态", stateError);
    }
    if (rollback !== "failed") releaseLock();
    else clearInterval(heartbeat);
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
  }
}

main().catch((error) => {
  console.error(`[move-home] 迁移助手异常退出：${describeError(error)}`);
  process.exit(1);
});
