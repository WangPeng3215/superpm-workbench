#!/usr/bin/env node
// 独立更新器：从安装目录复制到 TEMP 执行，负责下载、校验、停机、备份、替换、迁移、健康检查与回滚。
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { get } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeOperationLock,
  assertDataRootAvailable,
  resolveDataRoot,
} from "@superpm/shared/data-root";
import yauzl from "yauzl";

const UPDATER_VERSION = "1.1.0";
const MANIFEST_MAX_BYTES = 1024 * 1024;
const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
const ARCHIVE_MAX_ENTRIES = 200000;
const ALLOWED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "raw.githubusercontent.com",
]);
const PLATFORM = `${process.platform}-${process.arch}`;

function parseArgs(argv) {
  const options = {
    manifest: undefined,
    installRoot: process.env.SUPERPM_INSTALL_ROOT,
    home: undefined,
    force: false,
    json: false,
    restart: true,
    relocate: process.env.SUPERPM_UPDATE_SKIP_RELOCATE !== "1",
    timeoutMs: 15000,
  };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === "--manifest" || item === "--from")
      options.manifest = argv[++index];
    else if (item === "--install-root") options.installRoot = argv[++index];
    else if (item === "--home") options.home = argv[++index];
    else if (item === "--force") options.force = true;
    else if (item === "--json") options.json = true;
    else if (item === "--no-restart") options.restart = false;
    else if (item === "--no-relocate") options.relocate = false;
    else if (item === "--timeout")
      options.timeoutMs = Number(argv[++index] || options.timeoutMs) * 1000;
    else if (item === "--help" || item === "-h") options.help = true;
    else throw new Error(`未知参数：${item}`);
  }
  return options;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const isInside = (base, target) => {
  const distance = relative(resolve(base), resolve(target));
  return (
    distance === "" || (!distance.startsWith("..") && !isAbsolute(distance))
  );
};
const samePath = (left, right) =>
  process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);

function envFilePort(path) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?PORT\s*=\s*"?(\d+)"?\s*(?:#.*)?$/.exec(
        line,
      );
      if (match) return Number(match[1]);
    }
  } catch {
    // 没有可读的 .env 时使用默认端口
  }
  return null;
}

function resolvePort(context, serverState) {
  if (serverState && Number.isInteger(serverState.port))
    return serverState.port;
  const fromProcess = Number(process.env.PORT);
  if (Number.isInteger(fromProcess) && fromProcess > 0) return fromProcess;
  return (
    envFilePort(join(context.home, ".env")) ??
    envFilePort(join(context.installRoot, ".env")) ??
    3001
  );
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(
    String(value ?? "").trim(),
  );
  if (!match) throw new Error(`版本号无效：${value}`);
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? "",
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index])
      return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease === b.prerelease
    ? 0
    : a.prerelease > b.prerelease
      ? 1
      : -1;
}

function schemaVersionOf(appRoot) {
  try {
    const versions = readdirSync(join(appRoot, "apps", "server", "drizzle"))
      .map((file) => /^(\d+)_.*\.sql$/.exec(file)?.[1])
      .filter(Boolean)
      .map(Number);
    return versions.length ? Math.max(...versions) : 0;
  } catch {
    return 0;
  }
}

function activeUpdateLock(home) {
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

function acquireLock(home, version) {
  mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
  const path = join(home, "runtime", "update.lock");
  const record = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    reason: "update",
    version,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(record, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      return record;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = activeUpdateLock(home);
      if (existing)
        throw new Error(
          `已有更新正在进行（PID ${existing.pid}，开始于 ${existing.createdAt}）`,
        );
    }
  }
  throw new Error("无法创建更新锁");
}

function releaseLock(home) {
  const lock = readJson(join(home, "runtime", "update.lock"));
  if (lock && lock.pid !== process.pid) return;
  rmSync(join(home, "runtime", "update.lock"), { force: true });
}

function listMcpProcesses(home) {
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
    const path = join(directory, name);
    const record = readJson(path);
    if (!record || !Number.isInteger(record.pid)) continue;
    result.push({ ...record, alive: isAlive(record.pid), path });
  }
  return result.filter((item) => item.alive);
}

function appendUpdateLog(home, message) {
  try {
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(
      join(home, "logs", "update.log"),
      `${new Date().toISOString()} ${message}\n`,
      { flag: "a" },
    );
  } catch {
    // 日志失败不阻断更新
  }
}

async function stopServer(context, state, force) {
  if (!state || !isAlive(state.pid)) return false;
  context.log(`正在请求服务停止（PID ${state.pid}）`);
  try {
    await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: "POST",
      headers: { "x-superpm-shutdown-token": state.shutdownToken },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    context.log("服务未响应停止请求，等待进程退出");
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!isAlive(state.pid)) return true;
    await sleep(250);
  }
  if (!force)
    throw new Error(
      `服务进程 ${state.pid} 未在 10 秒内退出；可重试或加 --force 强制结束`,
    );
  killProcess(state.pid, context);
  for (let index = 0; index < 20 && isAlive(state.pid); index++)
    await sleep(150);
  if (isAlive(state.pid)) throw new Error(`无法结束服务进程 ${state.pid}`);
  return true;
}

function killProcess(pid, context) {
  if (pid === process.pid) return;
  context.log(`强制结束进程 ${pid}`);
  if (process.platform === "win32")
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

async function stopMcpProcesses(context) {
  const deadline = Date.now() + context.options.timeoutMs;
  while (Date.now() < deadline) {
    const live = listMcpProcesses(context.home);
    if (live.length === 0) return;
    await sleep(400);
  }
  const live = listMcpProcesses(context.home);
  if (live.length === 0) return;
  if (!context.options.force)
    throw new Error(
      `仍有 ${live.length} 个 MCP 进程运行（PID ${live
        .map((item) => item.pid)
        .join(", ")}）。关闭客户端后重试，或使用 --force 强制结束`,
    );
  for (const item of live) killProcess(item.pid, context);
  await sleep(1500);
  const remaining = listMcpProcesses(context.home);
  if (remaining.length > 0)
    throw new Error(
      `强制结束后仍有 MCP 进程存活（PID ${remaining
        .map((item) => item.pid)
        .join(", ")}）`,
    );
}

function validateRemoteUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:")
    throw new Error(`只允许 HTTPS 更新源：${url}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname))
    throw new Error(`更新源主机不在允许列表：${parsed.hostname}`);
  return parsed;
}

function httpGetBuffer(url, redirects = 0) {
  if (redirects > 5) throw new Error("更新源重定向次数过多");
  const parsed = validateRemoteUrl(url);
  return new Promise((done, fail) => {
    const request = get(
      parsed,
      {
        headers: { "user-agent": `superpm-updater/${UPDATER_VERSION}` },
        timeout: 30000,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          done(
            httpGetBuffer(
              new URL(response.headers.location, parsed).toString(),
              redirects + 1,
            ),
          );
          return;
        }
        if (status !== 200) {
          response.resume();
          fail(new Error(`更新源返回 HTTP ${status}：${url}`));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MANIFEST_MAX_BYTES) {
            request.destroy();
            fail(new Error("更新清单超过大小限制"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => done(Buffer.concat(chunks)));
        response.on("error", fail);
      },
    );
    request.on("timeout", () => request.destroy(new Error("更新源连接超时")));
    request.on("error", fail);
  });
}

function downloadFile(url, target, expected, redirects = 0, onProgress = null) {
  if (redirects > 5) throw new Error("更新包重定向次数过多");
  const parsed = validateRemoteUrl(url);
  return new Promise((done, fail) => {
    const request = get(
      parsed,
      {
        headers: { "user-agent": `superpm-updater/${UPDATER_VERSION}` },
        timeout: 30000,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          done(
            downloadFile(
              new URL(response.headers.location, parsed).toString(),
              target,
              expected,
              redirects + 1,
              onProgress,
            ),
          );
          return;
        }
        if (status !== 200) {
          response.resume();
          fail(new Error(`下载更新包失败：HTTP ${status}`));
          return;
        }
        const hash = createHash("sha256");
        let size = 0;
        let reported = -1;
        const stream = createWriteStream(target);
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > ARCHIVE_MAX_BYTES) {
            request.destroy();
            stream.destroy();
            fail(new Error("更新包超过大小限制"));
            return;
          }
          hash.update(chunk);
          if (onProgress) {
            const total = expected?.size ?? 0;
            const percent =
              total > 0 ? Math.min(100, Math.floor((size / total) * 100)) : 0;
            if (percent !== reported) {
              reported = percent;
              onProgress(size, total);
            }
          }
        });
        response.pipe(stream);
        stream.on("finish", () => {
          stream.close(() => {
            const digest = hash.digest("hex");
            if (expected?.size != null && size !== expected.size)
              fail(
                new Error(
                  `更新包大小不一致：期望 ${expected.size}，实际 ${size}`,
                ),
              );
            else if (
              expected?.sha256 &&
              digest.toLowerCase() !== expected.sha256.toLowerCase()
            )
              fail(
                new Error(
                  `更新包摘要不一致：期望 ${expected.sha256}，实际 ${digest}`,
                ),
              );
            else done({ size, sha256: digest });
          });
        });
        stream.on("error", fail);
        response.on("error", fail);
      },
    );
    request.on("timeout", () => request.destroy(new Error("下载更新包超时")));
    request.on("error", fail);
  });
}

async function loadManifest(source) {
  if (/^https:\/\//.test(source)) {
    const buffer = await httpGetBuffer(source);
    return { manifest: JSON.parse(buffer.toString("utf8")), base: source };
  }
  const path = resolve(
    /^file:\/\//.test(source) ? fileURLToPath(source) : source,
  );
  return {
    manifest: JSON.parse(readFileSync(path, "utf8")),
    base: path,
  };
}

function resolveArtifact(raw, base) {
  const value = String(raw ?? "");
  if (/^https:\/\//.test(value)) {
    validateRemoteUrl(value);
    return { kind: "http", url: value };
  }
  if (/^file:\/\//.test(value))
    return { kind: "file", path: fileURLToPath(value) };
  if (/^https?:/i.test(value))
    throw new Error(`更新包地址必须使用 HTTPS：${value}`);
  if (/^https:\/\//.test(base)) {
    const url = new URL(value, base);
    validateRemoteUrl(url.toString());
    return { kind: "http", url: url.toString() };
  }
  if (/^file:\/\//.test(base))
    return { kind: "file", path: resolve(dirname(fileURLToPath(base)), value) };
  return { kind: "file", path: resolve(dirname(base), value) };
}

function validateManifest(manifest, currentVersion, currentSchema) {
  if (!manifest || typeof manifest !== "object")
    throw new Error("更新清单格式无效");
  if (manifest.name !== "superpm-workbench")
    throw new Error(`更新清单产品不匹配：${manifest.name}`);
  if (manifest.platform !== PLATFORM)
    throw new Error(
      `更新包平台不匹配：需要 ${PLATFORM}，清单为 ${manifest.platform}`,
    );
  const target = parseVersion(manifest.version);
  if (compareVersions(manifest.version, currentVersion) <= 0)
    throw new Error(
      `目标版本 v${manifest.version} 不高于当前版本 v${currentVersion}`,
    );
  if (
    manifest.minUpdaterVersion &&
    compareVersions(UPDATER_VERSION, manifest.minUpdaterVersion) < 0
  )
    throw new Error(
      `更新器版本 ${UPDATER_VERSION} 低于要求 ${manifest.minUpdaterVersion}，请下载完整安装包`,
    );
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1)
    throw new Error("更新清单缺少有效 schemaVersion");
  if (manifest.schemaVersion < currentSchema)
    throw new Error(
      `目标数据库版本 ${manifest.schemaVersion} 低于当前 ${currentSchema}，不允许降级`,
    );
  const artifact = manifest.update;
  if (!artifact || typeof artifact !== "object")
    throw new Error("更新清单缺少 update 安装包信息");
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256 ?? ""))
    throw new Error("更新包 sha256 无效");
  if (!Number.isInteger(artifact.size) || artifact.size <= 0)
    throw new Error("更新包大小无效");
  return { target, artifact };
}

function extractArchive(zipPath, targetDir) {
  return new Promise((done, fail) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true, decodeStrings: true },
      (error, zip) => {
        if (error || !zip) return fail(error ?? new Error("无法读取更新包"));
        let entries = 0;
        let bytes = 0;
        const finish = (failure) => {
          try {
            zip.close();
          } catch {
            // 已关闭
          }
          failure ? fail(failure) : done();
        };
        zip.on("error", finish);
        zip.on("end", () => finish());
        zip.on("entry", (entry) => {
          entries += 1;
          bytes += entry.uncompressedSize;
          if (entries > ARCHIVE_MAX_ENTRIES)
            return finish(new Error("更新包条目数量超过限制"));
          if (bytes > ARCHIVE_MAX_BYTES)
            return finish(new Error("更新包解压后超过大小限制"));
          const normalized = String(entry.fileName).replace(/\\/g, "/");
          const segments = normalized.split("/").filter(Boolean);
          if (
            !normalized ||
            normalized.startsWith("/") ||
            /^[A-Za-z]:/.test(normalized) ||
            segments.some((segment) => segment === "..") ||
            normalized.includes("\0")
          )
            return finish(new Error(`更新包包含非法路径：${entry.fileName}`));
          if (normalized !== "app" && !normalized.startsWith("app/"))
            return finish(
              new Error(`更新包包含 app/ 之外的内容：${entry.fileName}`),
            );
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000)
            return finish(new Error(`更新包包含符号链接：${entry.fileName}`));
          const target = join(targetDir, ...segments);
          if (!isInside(targetDir, target))
            return finish(new Error(`更新包路径越界：${entry.fileName}`));
          const isDirectory = normalized.endsWith("/") || mode === 0o040000;
          if (isDirectory) {
            mkdirSync(target, { recursive: true });
            zip.readEntry();
            return;
          }
          mkdirSync(dirname(target), { recursive: true });
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream)
              return finish(streamError ?? new Error("无法读取更新包条目"));
            const output = createWriteStream(target);
            stream.on("error", finish);
            output.on("error", finish);
            output.on("finish", () => {
              output.close(() => zip.readEntry());
            });
            stream.pipe(output);
          });
        });
        zip.readEntry();
      },
    );
  });
}

function verifyStagedApp(stagingDir, manifest) {
  const appRoot = join(stagingDir, "app");
  const appManifest = readJson(join(appRoot, "package.json"));
  if (!appManifest) throw new Error("更新包缺少 app/package.json");
  if (appManifest.version !== manifest.version)
    throw new Error(
      `更新包版本不一致：清单 v${manifest.version}，包内 v${appManifest.version}`,
    );
  for (const required of [
    "apps/server/dist/index.js",
    "apps/server/dist/mcp/stdio.js",
    "apps/server/dist/backup-cli.js",
    "apps/server/dist/db/migrate-cli.js",
    "apps/server/drizzle",
    "apps/web/dist/index.html",
  ]) {
    const path = join(appRoot, ...required.split("/"));
    if (!existsSync(path)) throw new Error(`更新包不完整：缺少 ${required}`);
  }
  const stagedSchema = schemaVersionOf(appRoot);
  if (stagedSchema !== manifest.schemaVersion)
    throw new Error(
      `更新包数据库版本不一致：清单 ${manifest.schemaVersion}，包内 ${stagedSchema}`,
    );
  return appRoot;
}

function moveDirectory(source, target) {
  try {
    renameSync(source, target);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    cpSync(source, target, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
}

function runNode(context, script, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(context.node, [script, ...args], {
      cwd: options.cwd ?? dirname(script),
      env: context.childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`命令超时：${script}`));
    }, options.timeoutMs ?? 120000);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) done({ stdout, stderr });
      else
        fail(
          new Error(
            `命令失败（${code}）：${basename(script)}\n${stderr || stdout}`,
          ),
        );
    });
  });
}

function createBackup(context) {
  const database = join(context.home, "data", "superpm.sqlite");
  if (!existsSync(database)) return null;
  return runNode(
    context,
    join(context.appRoot, "apps", "server", "dist", "backup-cli.js"),
    ["create", "--reason", "pre-update", "--json"],
    { cwd: context.appRoot, timeoutMs: 180000 },
  ).then(({ stdout }) => {
    const output = JSON.parse(stdout.trim().split("\n").pop());
    if (!output?.ok || !output.backup?.id)
      throw new Error("更新前备份未返回有效结果");
    return {
      id: output.backup.id,
      directory: join(context.home, "backups", output.backup.id),
      meta: output.backup,
    };
  });
}

function restoreBackup(context, backup) {
  if (!backup) return;
  const meta = backup.meta;
  const sourceDatabase = join(
    backup.directory,
    ...String(meta.database.file).split("/"),
  );
  const database = join(context.home, "data", "superpm.sqlite");
  if (!existsSync(sourceDatabase))
    throw new Error(`更新前备份数据库缺失：${sourceDatabase}`);
  mkdirSync(dirname(database), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(`${database}${suffix}`, { force: true });
  copyFileSync(sourceDatabase, database);
  const workspace = join(context.home, "workspace");
  const backupWorkspace = join(backup.directory, "workspace");
  if (existsSync(backupWorkspace)) {
    if (existsSync(workspace)) {
      const aside = `${workspace}.update-failed-${Date.now()}`;
      renameSync(workspace, aside);
      context.log(`更新失败时的数据工作区已保留：${aside}`);
    }
    cpSync(backupWorkspace, workspace, {
      recursive: true,
      force: true,
      dereference: false,
    });
  }
  const config = join(backup.directory, "config.env");
  if (existsSync(config)) copyFileSync(config, join(context.home, ".env"));
  const restored = readJson(join(backup.directory, "meta.json"));
  if (
    restored?.database?.sha256 &&
    restored.database.sha256 !== meta.database.sha256
  )
    throw new Error("更新前备份元数据发生变化，拒绝恢复");
}

async function startServer(context, port) {
  const env = {
    ...context.childEnv,
    PORT: String(port),
    SUPERPM_HOME: context.home,
    ...(context.homeSource ? { SUPERPM_HOME_SOURCE: context.homeSource } : {}),
    SUPERPM_INSTALL_ROOT: context.installRoot,
    SUPERPM_LEGACY_ROOT: context.installRoot,
  };
  const child = spawn(
    context.node,
    [join(context.appRoot, "apps", "server", "dist", "index.js")],
    {
      cwd: context.appRoot,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  return child;
}

async function waitForHealth(context, port, expected) {
  const deadline = Date.now() + 60000;
  let lastError = "服务未响应";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1200),
      });
      if (response.ok) {
        const health = await response.json();
        if (health.status !== "ok" || health.database !== "ok")
          lastError = `健康检查未通过：${JSON.stringify(health)}`;
        else if (expected.pid != null && health.pid !== expected.pid)
          lastError = `端口 ${port} 被其他进程占用（PID ${health.pid}）`;
        else if (expected.version && health.version !== expected.version)
          lastError = `服务版本为 ${health.version}，期望 ${expected.version}`;
        else if (
          expected.schemaVersion != null &&
          health.schemaVersion !== expected.schemaVersion
        )
          lastError = `数据库版本为 ${health.schemaVersion}，期望 ${expected.schemaVersion}`;
        else return health;
      } else lastError = `健康检查 HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(500);
  }
  throw new Error(`新版本健康检查失败：${lastError}`);
}

function terminateChild(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  try {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else child.kill("SIGTERM");
  } catch {
    // 进程已退出
  }
}

async function stopStartedServer(home, child) {
  const state = readJson(join(home, "runtime", "server.json"));
  if (state && state.pid === child.pid && isAlive(state.pid)) {
    try {
      await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
        method: "POST",
        headers: { "x-superpm-shutdown-token": state.shutdownToken },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // 回滚时直接结束
    }
  }
  for (let index = 0; index < 20 && child.exitCode == null; index++)
    await sleep(250);
  terminateChild(child);
}

function portInUse(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(600, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function writeUpdateState(home, state) {
  try {
    mkdirSync(join(home, "updates"), { recursive: true });
    writeFileSync(
      join(home, "updates", "last-update.json"),
      JSON.stringify(state, null, 2),
    );
  } catch {
    // 状态文件失败不掩盖更新结果
  }
}

async function relocate(options) {
  if (!options.relocate || process.env.SUPERPM_UPDATER_RELOCATED === "1")
    return { relocated: false, options };
  const source = process.argv[1];
  if (!source) return { relocated: false, options };
  const directory = join(
    tmpdir(),
    `superpm-updater-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "updater.mjs");
  copyFileSync(source, target);
  const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
    env: {
      ...process.env,
      SUPERPM_UPDATER_RELOCATED: "1",
      SUPERPM_INSTALL_ROOT: options.installRoot,
      SUPERPM_HOME: options.home,
      ...(options.homeSource
        ? { SUPERPM_HOME_SOURCE: options.homeSource }
        : {}),
    },
    stdio: "inherit",
    windowsHide: true,
  });
  const code = await new Promise((done) => child.on("exit", done));
  rmSync(directory, { recursive: true, force: true });
  return { relocated: true, code: code ?? 1 };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`superPM 独立更新器 ${UPDATER_VERSION}

用法：
  updater.mjs --manifest <URL|文件> [--force] [--no-restart] [--json]

  --manifest   更新清单（HTTPS 或本地文件，供离线演练）
  --force      允许强制结束 15 秒内未退出的 MCP/服务进程
  --no-restart 更新后不启动服务（跳过健康检查）
  --home       数据根（默认 %LOCALAPPDATA%\\superPM）
  --install-root 安装目录`);
    return;
  }
  if (!options.manifest) throw new Error("缺少 --manifest 参数");
  let installRoot = options.installRoot
    ? resolve(options.installRoot)
    : resolve(dirname(process.argv[1]), "..");
  if (!existsSync(join(installRoot, "app", "package.json")))
    throw new Error(
      `未找到有效的安装目录（${installRoot}），请通过 --install-root 指定`,
    );
  let resolution;
  try {
    const base = resolveDataRoot({
      env: process.env,
      packaged: true,
      developmentRoot: installRoot,
    });
    // --home 与应用解析结果一致时沿用配置指针/默认目录来源，避免状态显示漂移。
    resolution =
      options.home && !samePath(options.home, base.home)
        ? resolveDataRoot({
            env: process.env,
            packaged: true,
            developmentRoot: installRoot,
            overrideHome: options.home,
          })
        : base;
    assertDataRootAvailable(resolution, process.env);
  } catch (error) {
    throw new Error(`无法确定数据根：${error.message}`);
  }
  const home = resolution.home;
  options.home = home;
  options.homeSource = resolution.source;
  options.installRoot = installRoot;

  const relocated = await relocate(options);
  if (relocated.relocated) process.exit(relocated.code ?? 1);

  const moveLock = activeOperationLock(resolution.configDir);
  if (moveLock)
    throw new Error(
      `正在迁移数据目录（任务 ${moveLock.jobId}，PID ${moveLock.pid}），请等待迁移完成后再更新`,
    );
  if (resolution.warning) console.error(`[updater] ${resolution.warning}`);

  const logs = [];
  const log = (message) => {
    logs.push(message);
    if (options.json) console.error(`[updater] ${message}`);
    else console.log(`[updater] ${message}`);
  };
  const context = {
    options,
    home,
    homeSource: resolution.source,
    installRoot,
    node: existsSync(
      join(
        installRoot,
        "runtime",
        process.platform === "win32" ? "node.exe" : "node",
      ),
    )
      ? join(
          installRoot,
          "runtime",
          process.platform === "win32" ? "node.exe" : "node",
        )
      : process.execPath,
    appRoot: join(installRoot, "app"),
    childEnv: {
      ...process.env,
      SUPERPM_HOME: home,
      ...(resolution.source ? { SUPERPM_HOME_SOURCE: resolution.source } : {}),
      SUPERPM_INSTALL_ROOT: installRoot,
      SUPERPM_LEGACY_ROOT: installRoot,
    },
    log,
  };

  const finish = (payload, exitCode = 0) => {
    writeProgress({
      status: payload.status,
      phase: payload.ok ? "done" : progress.phase,
      percent: payload.ok ? 100 : progress.percent,
      message: payload.ok
        ? payload.status === "up-to-date"
          ? "已是最新版本"
          : "更新完成"
        : payload.error || "更新失败",
      ...(payload.error ? { error: payload.error } : {}),
    });
    const state = { ...payload, logs, finishedAt: new Date().toISOString() };
    writeUpdateState(home, state);
    if (options.json) writeSync(1, `${JSON.stringify(state)}\n`);
    process.exit(exitCode);
  };

  // 阶段状态供应用内更新页面在服务重启后读取；失败不阻断更新流程。
  const progressPath = join(home, "updates", "update-progress.json");
  const progress = {
    status: "running",
    phase: "prepare",
    percent: 2,
    message: "更新器已启动",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: process.pid,
  };
  const writeProgress = (patch = {}) => {
    Object.assign(progress, patch, {
      updatedAt: new Date().toISOString(),
      pid: process.pid,
    });
    try {
      mkdirSync(join(home, "updates"), { recursive: true });
      const temporary = `${progressPath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(progress, null, 2), {
        mode: 0o600,
      });
      renameSync(temporary, progressPath);
    } catch {
      // 进度文件失败不掩盖更新结果
    }
  };
  writeProgress();

  let lock = null;
  let previousDir = null;
  let appSwapped = false;
  let serverStopped = false;
  let backup = null;
  let started = null;
  let port = 3001;
  let oldVersion = "0.0.0";
  let targetVersion = "unknown";
  let manifest;
  let schemaVersion;

  try {
    const appManifest = readJson(join(context.appRoot, "package.json"));
    if (!appManifest) throw new Error("当前安装缺少 app/package.json");
    oldVersion = appManifest.version;
    const currentSchema = schemaVersionOf(context.appRoot);
    log(`当前版本 v${oldVersion}，数据库 schema ${currentSchema}`);
    writeProgress({
      from: oldVersion,
      phase: "manifest",
      percent: 5,
      message: "正在校验更新信息",
    });

    const loaded = await loadManifest(options.manifest);
    manifest = loaded.manifest;
    if (
      manifest?.name === "superpm-workbench" &&
      manifest.platform === PLATFORM &&
      manifest.version === oldVersion
    ) {
      log(`已是最新版本 v${oldVersion}`);
      finish({ ok: true, status: "up-to-date", version: oldVersion });
    }
    const validated = validateManifest(manifest, oldVersion, currentSchema);
    targetVersion = manifest.version;
    schemaVersion = manifest.schemaVersion;
    log(`目标版本 v${targetVersion}，schema ${schemaVersion}`);
    writeProgress({
      to: targetVersion,
      phase: "lock",
      percent: 8,
      message: "正在准备更新",
    });

    const existingLock = activeUpdateLock(home);
    if (existingLock)
      throw new Error(
        `已有更新正在进行（PID ${existingLock.pid}，开始于 ${existingLock.createdAt}）`,
      );
    lock = acquireLock(home, targetVersion);
    log("已写入更新锁");
    writeProgress({
      phase: "stop",
      percent: 12,
      message: "正在停止服务与 MCP",
    });

    const serverState = readJson(join(home, "runtime", "server.json"));
    port = resolvePort(context, serverState);
    serverStopped = await stopServer(context, serverState, options.force);
    await stopMcpProcesses(context);
    if (options.restart && (await portInUse(port)))
      throw new Error(
        `端口 ${port} 仍被占用，无法安全启动新版本；请释放端口后重试`,
      );
    log("服务与 MCP 已停止");

    const updateDir = join(
      home,
      "updates",
      `${targetVersion}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    mkdirSync(updateDir, { recursive: true });
    const archivePath = join(updateDir, "update.zip");
    const artifact = resolveArtifact(
      validated.artifact.url ?? validated.artifact.file,
      loaded.base,
    );
    writeProgress({
      phase: "download",
      percent: 15,
      received: 0,
      total: validated.artifact.size,
      message: "正在下载更新包",
    });
    if (artifact.kind === "http") {
      log(`下载更新包：${artifact.url}`);
      await downloadFile(
        artifact.url,
        archivePath,
        validated.artifact,
        0,
        (received, total) => {
          writeProgress({
            phase: "download",
            percent: 15 + Math.floor((received / Math.max(1, total)) * 40),
            received,
            total,
            message: "正在下载更新包",
          });
        },
      );
    } else {
      log(`复制本地更新包：${artifact.path}`);
      copyFileSync(artifact.path, archivePath);
      const size = statSync(archivePath).size;
      const digest = createHash("sha256")
        .update(readFileSync(archivePath))
        .digest("hex");
      if (size !== validated.artifact.size)
        throw new Error(
          `更新包大小不一致：期望 ${validated.artifact.size}，实际 ${size}`,
        );
      if (digest !== validated.artifact.sha256.toLowerCase())
        throw new Error(
          `更新包摘要不一致：期望 ${validated.artifact.sha256}，实际 ${digest}`,
        );
      writeProgress({
        phase: "download",
        percent: 55,
        received: size,
        total: validated.artifact.size,
        message: "更新包已准备",
      });
    }
    if (
      process.env.SUPERPM_UPDATE_TESTING === "1" &&
      process.env.SUPERPM_UPDATE_FAIL_AT === "download"
    )
      throw new Error("注入测试失败：download");

    writeProgress({
      phase: "verify",
      percent: 58,
      message: "正在解压并校验更新包",
    });
    log("解压并校验更新包");
    const staging = join(updateDir, "staging");
    mkdirSync(staging, { recursive: true });
    await extractArchive(archivePath, staging);
    verifyStagedApp(staging, manifest);
    if (
      process.env.SUPERPM_UPDATE_TESTING === "1" &&
      process.env.SUPERPM_UPDATE_FAIL_AT === "verify"
    )
      throw new Error("注入测试失败：verify");

    writeProgress({
      phase: "backup",
      percent: 68,
      message: "正在创建更新前备份",
    });
    log("创建更新前备份");
    backup = await createBackup(context);
    if (backup) log(`备份完成：${backup.id}`);
    else log("数据库尚未创建，跳过更新前备份");
    if (
      process.env.SUPERPM_UPDATE_TESTING === "1" &&
      process.env.SUPERPM_UPDATE_FAIL_AT === "backup"
    )
      throw new Error("注入测试失败：backup");

    if (
      process.env.SUPERPM_UPDATE_TESTING === "1" &&
      process.env.SUPERPM_UPDATE_FAIL_AT === "swap"
    )
      throw new Error("注入测试失败：swap");

    writeProgress({
      phase: "swap",
      percent: 76,
      message: "正在替换程序文件",
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    previousDir = join(installRoot, "app.previous");
    if (existsSync(previousDir))
      renameSync(previousDir, join(installRoot, `app.previous-${stamp}`));
    renameSync(join(installRoot, "app"), previousDir);
    try {
      moveDirectory(join(staging, "app"), join(installRoot, "app"));
      appSwapped = true;
    } catch (error) {
      rmSync(join(installRoot, "app"), { recursive: true, force: true });
      renameSync(previousDir, join(installRoot, "app"));
      previousDir = null;
      throw error;
    }
    context.appRoot = join(installRoot, "app");
    log(`程序目录已替换为 v${targetVersion}`);

    writeProgress({
      phase: "migrate",
      percent: 84,
      message: "正在执行数据库迁移",
    });
    log("执行数据库迁移");
    await runNode(
      context,
      join(context.appRoot, "apps", "server", "dist", "db", "migrate-cli.js"),
      [],
      { cwd: context.appRoot, timeoutMs: 180000 },
    );
    if (
      process.env.SUPERPM_UPDATE_TESTING === "1" &&
      process.env.SUPERPM_UPDATE_FAIL_AT === "migrate"
    )
      throw new Error("注入测试失败：migrate");

    if (!options.restart) {
      log("已指定 --no-restart，跳过启动与健康检查");
    } else {
      writeProgress({
        phase: "restart",
        percent: 90,
        message: "正在启动新版本",
      });
      log("启动新版本并等待健康检查");
      started = await startServer(context, port);
      if (
        process.env.SUPERPM_UPDATE_TESTING === "1" &&
        process.env.SUPERPM_UPDATE_FAIL_AT === "health"
      )
        throw new Error("注入测试失败：health");
      writeProgress({
        phase: "health",
        percent: 94,
        message: "正在验证新版本健康状态",
      });
      const health = await waitForHealth(context, port, {
        pid: started.pid,
        version: targetVersion,
        schemaVersion,
      });
      started = null;
      log(
        `健康检查通过：v${health.version}，schema ${health.schemaVersion}，PID ${health.pid}`,
      );
    }

    writeProgress({
      phase: "cleanup",
      percent: 98,
      message: "正在清理更新临时文件",
    });

    const retired = readdirSync(installRoot).filter((name) =>
      /^app\.previous-/.test(name),
    );
    for (const name of retired)
      rmSync(join(installRoot, name), { recursive: true, force: true });
    rmSync(updateDir, { recursive: true, force: true });
    releaseLock(home);
    lock = null;
    appendUpdateLog(
      home,
      `更新成功：v${oldVersion} -> v${targetVersion}${backup ? `，更新前备份 ${backup.id}` : ""}`,
    );
    finish({
      ok: true,
      status: "updated",
      from: oldVersion,
      to: targetVersion,
      schemaVersion,
      backupId: backup?.id,
      port,
    });
  } catch (error) {
    log(`更新失败：${error.message}`);
    writeProgress({
      phase: appSwapped ? "rollback" : progress.phase,
      message: appSwapped
        ? "更新失败，正在恢复旧版本"
        : "更新失败，正在恢复服务",
      error: error.message,
    });
    let rollbackError = null;
    if (appSwapped && previousDir) {
      try {
        if (started) await stopStartedServer(home, started);
        rmSync(join(installRoot, "app"), { recursive: true, force: true });
        renameSync(previousDir, join(installRoot, "app"));
        context.appRoot = join(installRoot, "app");
        restoreBackup(context, backup);
        log("已恢复旧程序与更新前数据");
        writeProgress({
          phase: "rollback",
          percent: Math.max(progress.percent, 60),
          message: "已恢复旧程序与更新前数据",
          error: error.message,
        });
        if (options.restart) {
          started = await startServer(context, port);
          const health = await waitForHealth(context, port, {
            pid: started.pid,
            version: oldVersion,
            schemaVersion: schemaVersionOf(context.appRoot),
          });
          log(`旧版本已恢复运行：v${health.version}，PID ${health.pid}`);
          started = null;
        }
      } catch (failure) {
        rollbackError = failure;
        log(`回滚失败：${failure.message}`);
      }
    } else {
      if (started) await stopStartedServer(home, started);
      // 程序尚未替换，但服务已被更新器停止；恢复旧版本运行，避免更新失败后服务中断。
      if (serverStopped && options.restart) {
        try {
          started = await startServer(context, port);
          const health = await waitForHealth(context, port, {
            pid: started.pid,
            version: oldVersion,
            schemaVersion: schemaVersionOf(context.appRoot),
          });
          started = null;
          log(`旧版本已恢复运行：v${health.version}，PID ${health.pid}`);
        } catch (failure) {
          rollbackError = failure;
          log(`旧版本恢复运行失败：${failure.message}`);
        }
      }
    }
    if (rollbackError && appSwapped) {
      appendUpdateLog(
        home,
        `更新失败且回滚失败：${error.message}；回滚错误：${rollbackError.message}；更新锁保留`,
      );
      finish(
        {
          ok: false,
          status: "rollback-failed",
          error: error.message,
          rollbackError: rollbackError.message,
          from: oldVersion,
          to: targetVersion,
          backupId: backup?.id,
        },
        1,
      );
    }
    releaseLock(home);
    lock = null;
    appendUpdateLog(
      home,
      `更新失败${appSwapped ? "已回滚" : "（程序未替换）"}：${error.message}${
        backup ? `；更新前备份 ${backup.id}` : ""
      }${rollbackError ? `；旧版本恢复失败：${rollbackError.message}` : ""}`,
    );
    finish(
      {
        ok: false,
        status: appSwapped ? "rolled-back" : "failed",
        error: error.message,
        ...(rollbackError ? { restartError: rollbackError.message } : {}),
        from: oldVersion,
        to: targetVersion,
        backupId: backup?.id,
      },
      1,
    );
  } finally {
    if (lock) releaseLock(home);
  }
}

await main();
