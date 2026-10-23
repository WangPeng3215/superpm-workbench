#!/usr/bin/env node
// 稳定启动器：安装目录布局变化时保持入口不变，只替换 app/。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const installRoot = resolve(process.env.SUPERPM_INSTALL_ROOT || dirname(here));
const appRoot = join(installRoot, "app");
const runtimeNode = join(
  installRoot,
  "runtime",
  process.platform === "win32" ? "node.exe" : "node",
);
const serverEntry = join(appRoot, "apps", "server", "dist", "index.js");

function defaultHomePath() {
  if (process.platform === "win32")
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "superPM",
    );
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "superPM");
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "superpm",
  );
}

const home = resolve(process.env.SUPERPM_HOME || defaultHomePath());
process.env.SUPERPM_HOME = home;
process.env.SUPERPM_INSTALL_ROOT = installRoot;
process.env.SUPERPM_LEGACY_ROOT =
  process.env.SUPERPM_LEGACY_ROOT || installRoot;

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

function activeUpdateLock() {
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

const appManifest = readJson(join(appRoot, "package.json"));
if (!appManifest || typeof appManifest.version !== "string") {
  console.error(
    `[superpm] 安装不完整：缺少 ${join(appRoot, "package.json")}，请重新解压完整安装包。`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  console.log(appManifest.version);
  process.exit(0);
}
if (args.includes("--home")) {
  console.log(home);
  process.exit(0);
}

const lock = activeUpdateLock();
if (lock) {
  console.error(
    `[superpm] 正在更新（PID ${lock.pid}，开始于 ${lock.createdAt}），请等待更新完成后再启动。`,
  );
  process.exit(1);
}

if (!existsSync(serverEntry)) {
  console.error(`[superpm] 缺少服务入口：${serverEntry}`);
  process.exit(1);
}

const serverState = readJson(join(home, "runtime", "server.json"));
if (
  serverState &&
  isAlive(serverState.pid) &&
  typeof serverState.port === "number"
) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${serverState.port}/api/health`,
      { signal: AbortSignal.timeout(1200) },
    );
    if (response.ok) {
      console.log(
        `[superpm] 已在运行：http://127.0.0.1:${serverState.port}（PID ${serverState.pid}）`,
      );
      process.exit(0);
    }
  } catch {
    // 状态文件残留但服务未响应：继续启动，由端口占用检查兜底
  }
}

const node = existsSync(runtimeNode) ? runtimeNode : process.execPath;
if (!existsSync(runtimeNode))
  console.warn("[superpm] 未找到自带 Node 运行时，回退到系统 Node。");

console.log(
  `[superpm] 启动 v${appManifest.version}，安装目录 ${installRoot}，数据根 ${home}`,
);
const child = spawn(node, [serverEntry], {
  cwd: appRoot,
  env: process.env,
  stdio: "inherit",
  windowsHide: false,
});

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  const timer = setTimeout(() => {
    console.error("[superpm] 子进程未在 10 秒内退出，强制结束。");
    child.kill("SIGKILL");
  }, 10000);
  timer.unref();
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

child.on("error", (error) => {
  console.error(`[superpm] 启动失败：${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) console.error(`[superpm] 服务被信号 ${signal} 终止。`);
  process.exit(code ?? 1);
});
