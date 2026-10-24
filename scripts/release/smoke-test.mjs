#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === "--install") options.install = resolve(argv[++index]);
    else if (item === "--json") options.json = true;
    else if (item === "--keep-home") options.keepHome = true;
    else if (item === "--help" || item === "-h") options.help = true;
    else throw new Error(`未知参数：${item}`);
  }
  return options;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
}

function waitExit(child, timeoutMs) {
  return new Promise((done, fail) => {
    if (child.exitCode != null) return done(child.exitCode);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("子进程未在限定时间内退出"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(300);
  }
  throw new Error(`等待超时：${label}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "用法：node scripts/release/smoke-test.mjs --install <安装目录> [--json]",
    );
    return;
  }
  if (!options.install) throw new Error("缺少 --install");
  const install = options.install;
  const report = { ok: false, install, steps: [] };
  const step = (name, detail) => {
    report.steps.push({ name, ...detail });
    if (!options.json) console.log(`[smoke] ${name}`);
    else console.error(`[smoke] ${name}`);
  };

  const appManifest = readJson(join(install, "app", "package.json"));
  const node = join(install, "runtime", "node.exe");
  const launcher = join(install, "bin", "launcher.mjs");
  for (const path of [
    node,
    launcher,
    join(install, "bin", "updater.mjs"),
    join(install, "bin", "move-home.mjs"),
    join(install, "runtime", "LICENSE"),
    join(install, "SuperPM.cmd"),
    join(install, "Update.cmd"),
    join(install, "app", "apps", "web", "dist", "index.html"),
    join(install, "app", "node_modules", "better-sqlite3", "package.json"),
  ])
    if (!existsSync(path)) throw new Error(`安装包缺少文件：${path}`);

  const home = mkdtempSync(join(tmpdir(), "superpm-smoke-home-"));
  const port = await freePort();
  const env = {
    ...process.env,
    SUPERPM_HOME: home,
    SUPERPM_INSTALL_ROOT: install,
    SUPERPM_LEGACY_ROOT: install,
    PORT: String(port),
  };
  const launcherProcess = spawn(node, [launcher], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let launcherOutput = "";
  launcherProcess.stdout.on("data", (chunk) => (launcherOutput += chunk));
  launcherProcess.stderr.on("data", (chunk) => (launcherOutput += chunk));

  try {
    let health;
    await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(800),
          });
          if (!response.ok) return false;
          health = await response.json();
          return health.status === "ok";
        } catch {
          return false;
        }
      },
      45000,
      "服务健康检查",
    );
    if (health.version !== appManifest.version)
      throw new Error(
        `服务版本 ${health.version} 与安装包 ${appManifest.version} 不一致`,
      );
    if (health.database !== "ok") throw new Error("健康检查数据库状态异常");
    step("launcher-health", {
      version: health.version,
      schema: health.schemaVersion,
    });

    const serverState = readJson(join(home, "runtime", "server.json"));
    if (serverState.pid !== health.pid)
      throw new Error("server.json 记录的 PID 与健康检查不一致");
    if (typeof serverState.shutdownToken !== "string")
      throw new Error("server.json 缺少停止令牌");
    if (
      existsSync(join(install, "data")) ||
      existsSync(join(install, "workspace"))
    )
      throw new Error("运行数据写入了安装目录");
    step("runtime-state", { pid: serverState.pid, port: serverState.port });

    const mcpEnv = { ...env };
    const mcp = spawn(
      node,
      [join(install, "app", "apps", "server", "dist", "mcp", "stdio.js")],
      { env: mcpEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let mcpOut = "";
    let mcpErr = "";
    mcp.stdout.on("data", (chunk) => (mcpOut += chunk));
    mcp.stderr.on("data", (chunk) => (mcpErr += chunk));
    mcp.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "smoke-test", version: "1.0.0" },
        },
      })}\n`,
    );
    await waitFor(
      () => existsSync(join(home, "runtime", "mcp", `${mcp.pid}.json`)),
      8000,
      "MCP 注册",
    );
    await waitFor(
      () => {
        try {
          const response = JSON.parse(mcpOut.split("\n")[0]);
          return response.result?.serverInfo?.version === appManifest.version;
        } catch {
          return false;
        }
      },
      8000,
      "MCP initialize",
    );
    mcp.stdin.end();
    await waitExit(mcp, 8000);
    if (existsSync(join(home, "runtime", "mcp", `${mcp.pid}.json`)))
      throw new Error("MCP 退出后未注销运行时记录");
    step("mcp-stdio", { pid: mcp.pid, stderr: mcpErr.trim().slice(0, 200) });

    writeFileSync(
      join(home, "runtime", "update.lock"),
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        reason: "smoke-test",
      }),
    );
    const blocked = spawn(
      node,
      [join(install, "app", "apps", "server", "dist", "mcp", "stdio.js")],
      { env: mcpEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let blockedErr = "";
    blocked.stderr.on("data", (chunk) => (blockedErr += chunk));
    const blockedCode = await waitExit(blocked, 8000);
    rmSync(join(home, "runtime", "update.lock"), { force: true });
    if (blockedCode !== 0 || !blockedErr.includes("更新锁"))
      throw new Error(`更新锁未阻止 MCP 启动（exit ${blockedCode}）`);
    step("update-lock-refusal", { exitCode: blockedCode });

    const backup = spawn(
      node,
      [
        join(install, "app", "apps", "server", "dist", "backup-cli.js"),
        "create",
        "--reason",
        "smoke",
        "--json",
      ],
      {
        env: mcpEnv,
        cwd: join(install, "app"),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let backupOut = "";
    let backupErr = "";
    backup.stdout.on("data", (chunk) => (backupOut += chunk));
    backup.stderr.on("data", (chunk) => (backupErr += chunk));
    const backupCode = await waitExit(backup, 60000);
    if (backupCode !== 0)
      throw new Error(`备份命令失败：${backupErr || backupOut}`);
    const backupResult = JSON.parse(backupOut.trim().split("\n").pop());
    if (!backupResult.ok) throw new Error("备份未返回成功结果");
    const verify = spawn(
      node,
      [
        join(install, "app", "apps", "server", "dist", "backup-cli.js"),
        "verify",
        backupResult.backup.id,
        "--json",
      ],
      {
        env: mcpEnv,
        cwd: join(install, "app"),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let verifyOut = "";
    verify.stdout.on("data", (chunk) => (verifyOut += chunk));
    const verifyCode = await waitExit(verify, 60000);
    if (verifyCode !== 0 || !JSON.parse(verifyOut.trim()).ok)
      throw new Error("备份校验失败");
    step("backup", { id: backupResult.backup.id });

    const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      headers: {
        "x-superpm-shutdown-token": serverState.shutdownToken,
      },
      signal: AbortSignal.timeout(3000),
    });
    if (response.status !== 202)
      throw new Error(`优雅停止失败：HTTP ${response.status}`);
    await waitExit(launcherProcess, 15000);
    if (existsSync(join(home, "runtime", "server.json")))
      throw new Error("服务退出后未清理 server.json");
    step("graceful-shutdown", { port });

    if (!options.keepHome) rmSync(home, { recursive: true, force: true });
    report.ok = true;
    report.home = options.keepHome ? home : undefined;
    if (options.json) console.log(JSON.stringify(report));
    else console.log("[smoke] 全部通过");
  } catch (error) {
    launcherProcess.kill("SIGKILL");
    report.error = error.message;
    report.output = launcherOutput.slice(-2000);
    report.home = home;
    if (options.json) console.log(JSON.stringify(report));
    console.error(`[smoke] 失败：${error.message}`);
    process.exitCode = 1;
  }
}

await main();
