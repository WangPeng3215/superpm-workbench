#!/usr/bin/env node
// 使用真实发布包演练：安装 vA、写入数据、运行 MCP，再升级到 vB 并验证失败回滚。
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yauzl from "yauzl";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
  const options = {
    scenarios: [
      "happy",
      "digest",
      "download",
      "verify",
      "backup",
      "swap",
      "migrate",
      "health",
    ],
    json: false,
    keep: false,
    timeoutMs: 180000,
  };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === "--from") options.from = resolve(argv[++index]);
    else if (item === "--manifest") options.manifest = resolve(argv[++index]);
    else if (item === "--update") options.update = resolve(argv[++index]);
    else if (item === "--work") options.work = resolve(argv[++index]);
    else if (item === "--scenarios")
      options.scenarios = argv[++index].split(",").filter(Boolean);
    else if (item === "--timeout")
      options.timeoutMs = Number(argv[++index]) * 1000;
    else if (item === "--json") options.json = true;
    else if (item === "--keep") options.keep = true;
    else if (item === "--help" || item === "-h") options.help = true;
    else throw new Error(`未知参数：${item}`);
  }
  return options;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readJsonSafe = (path) => {
  try {
    return readJson(path);
  } catch {
    return null;
  }
};

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

function extractZip(zipPath, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  return new Promise((done, fail) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return fail(error ?? new Error("无法读取 zip"));
      zip.on("entry", (entry) => {
        const normalized = entry.fileName.replace(/\\/g, "/");
        const segments = normalized.split("/").filter(Boolean);
        if (
          normalized.startsWith("/") ||
          /^[A-Za-z]:/.test(normalized) ||
          segments.some((segment) => segment === "..")
        )
          return fail(new Error(`压缩包路径非法：${entry.fileName}`));
        const target = join(targetDir, ...segments);
        if (normalized.endsWith("/")) {
          mkdirSync(target, { recursive: true });
          zip.readEntry();
          return;
        }
        mkdirSync(dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError);
          const output = createWriteStream(target);
          stream.on("error", fail);
          output.on("error", fail);
          output.on("finish", () => output.close(() => zip.readEntry()));
          stream.pipe(output);
        });
      });
      zip.on("end", () => done());
      zip.on("error", fail);
      zip.readEntry();
    });
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(300);
  }
  throw new Error(`等待超时：${label}${last ? `（${last.message}）` : ""}`);
}

function waitExit(child, timeoutMs) {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((done, fail) => {
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

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

async function login(port) {
  const response = await request(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  if (response.status !== 200)
    throw new Error(`登录失败：HTTP ${response.status}`);
  const cookie = response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("登录响应缺少会话 Cookie");
  return cookie;
}

async function health(port) {
  const response = await request(`http://127.0.0.1:${port}/api/health`, {
    timeoutMs: 1500,
  });
  return response.status === 200 ? response.body : null;
}

async function shutdown(port, home) {
  const state = readJsonSafe(join(home, "runtime", "server.json"));
  if (!state) return;
  try {
    await request(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      headers: { "x-superpm-shutdown-token": state.shutdownToken },
      timeoutMs: 3000,
    });
  } catch {
    // 服务可能已退出
  }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (!existsSync(join(home, "runtime", "server.json"))) return;
    await sleep(250);
  }
}

function startServer(install, home, output) {
  const child = spawn(
    join(install, "runtime", "node.exe"),
    [join(install, "bin", "launcher.mjs")],
    {
      env: {
        ...process.env,
        SUPERPM_HOME: home,
        SUPERPM_INSTALL_ROOT: install,
        SUPERPM_LEGACY_ROOT: install,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  return child;
}

function startMcp(install, home, output) {
  const child = spawn(
    join(install, "runtime", "node.exe"),
    [join(install, "app", "apps", "server", "dist", "mcp", "stdio.js")],
    {
      env: {
        ...process.env,
        SUPERPM_HOME: home,
        SUPERPM_INSTALL_ROOT: install,
        SUPERPM_LEGACY_ROOT: install,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "update-rehearsal", version: "1.0.0" },
      },
    })}\n`,
  );
  return child;
}

function updaterManifest(source, updateZip) {
  const manifest = readJson(source);
  const update = { ...manifest.update, file: pathToFileURL(updateZip).href };
  delete update.url;
  return { ...manifest, update };
}

function packageVersion(appRoot) {
  return readJson(join(appRoot, "package.json")).version;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runScenario(name, options, context) {
  const scenarioRoot = join(context.work, name);
  const extractRoot = join(scenarioRoot, "extract");
  const home = join(scenarioRoot, "home");
  mkdirSync(home, { recursive: true });
  const output = [];
  const port = await freePort();
  const details = { name, port };
  let server = null;
  let mcp = null;
  let mcpExit = null;
  let updaterResult = null;
  let requirementId = null;
  let cookie = null;

  const updateZip =
    name === "digest"
      ? join(scenarioRoot, "tampered-update.zip")
      : context.updateZip;
  if (name === "digest") {
    const tampered = Buffer.from(readFileSync(context.updateZip));
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(updateZip, tampered);
  }
  const manifestPath = join(scenarioRoot, "manifest.json");
  const manifest = updaterManifest(context.manifest, updateZip);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  try {
    await extractZip(options.from, extractRoot);
    const folders = readdirSync(extractRoot).filter((item) =>
      statSync(join(extractRoot, item)).isDirectory(),
    );
    assert(folders.length === 1, "完整安装包根目录结构异常");
    const install = join(extractRoot, folders[0]);
    details.install = install;
    const versionA = packageVersion(join(install, "app"));
    // 0.2.0 自带的更新器没有 M3 进度写入；旧更新器升级只验证兼容与回退。
    const updaterSupportsProgress = readFileSync(
      join(install, "bin", "updater.mjs"),
      "utf8",
    ).includes("update-progress.json");
    details.progressSupported = updaterSupportsProgress;

    // 数据根 .env 提供端口，验证更新器在服务停止后仍能沿用它。
    writeFileSync(join(home, ".env"), `PORT=${port}\n`);

    server = startServer(install, home, output);
    const initialHealth = await waitFor(
      async () => {
        const value = await health(port);
        return value?.status === "ok" ? value : null;
      },
      45000,
      "旧版本启动",
    );
    assert(initialHealth.version === versionA, "旧版本健康检查版本不一致");

    cookie = await login(port);
    const created = await request(`http://127.0.0.1:${port}/api/requirements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: `升级演练-${name}`,
        proposedAt: "2026-10-23",
      }),
    });
    assert(created.status === 201, `创建需求失败：HTTP ${created.status}`);
    requirementId = created.body.id;
    const marker = `rehearsal-${name}`;
    writeFileSync(join(home, "workspace", "rehearsal-marker.txt"), marker);
    details.versionA = versionA;
    details.requirementId = requirementId;

    if (name === "happy") {
      mcp = startMcp(install, home, output);
      await waitFor(
        () => existsSync(join(home, "runtime", "mcp", `${mcp.pid}.json`)),
        8000,
        "MCP 注册",
      );
    }

    const updater = spawn(
      join(install, "runtime", "node.exe"),
      [
        join(install, "bin", "updater.mjs"),
        "--manifest",
        manifestPath,
        "--install-root",
        install,
        "--home",
        home,
        "--json",
      ],
      {
        env: {
          ...process.env,
          SUPERPM_UPDATE_TESTING:
            name === "happy" || name === "digest" ? "" : "1",
          SUPERPM_UPDATE_FAIL_AT:
            name === "happy" || name === "digest" ? "" : name,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let updaterOut = "";
    let updaterErr = "";
    updater.stdout.on("data", (chunk) => (updaterOut += chunk));
    updater.stderr.on("data", (chunk) => (updaterErr += chunk));
    const updaterCode = await waitExit(updater, options.timeoutMs);
    const lastLine = updaterOut.trim().split("\n").pop();
    updaterResult = JSON.parse(lastLine);
    details.updater = {
      exitCode: updaterCode,
      status: updaterResult.status,
      error: updaterResult.error,
    };

    if (mcp) {
      mcpExit = await waitExit(mcp, 10000);
      details.mcpExitCode = mcpExit;
      assert(mcpExit === 0, `MCP 未正常退出（exit ${mcpExit}）`);
      assert(
        !existsSync(join(home, "runtime", "mcp", `${mcp.pid}.json`)),
        "MCP 退出后运行时记录未清理",
      );
    }

    const appRoot = join(install, "app");
    let runningPort = port;
    const running = await waitFor(
      async () => {
        const state = readJsonSafe(join(home, "runtime", "server.json"));
        if (!state || !Number.isInteger(state.port)) return null;
        const value = await health(state.port);
        if (value?.status !== "ok") return null;
        runningPort = state.port;
        return value;
      },
      45000,
      "更新后服务健康检查",
    );
    cookie = await login(runningPort);
    const requirement = await request(
      `http://127.0.0.1:${runningPort}/api/requirements/${requirementId}`,
      { headers: { cookie } },
    );
    assert(requirement.status === 200, "升级后业务数据读取失败");
    assert(
      requirement.body.name === `升级演练-${name}`,
      "升级后业务数据内容发生变化",
    );
    assert(
      readFileSync(join(home, "workspace", "rehearsal-marker.txt"), "utf8") ===
        `rehearsal-${name}`,
      "升级后工作区文件发生变化",
    );

    const lockPath = join(home, "runtime", "update.lock");
    assert(!existsSync(lockPath), "更新结束后更新锁未释放");
    const state = readJsonSafe(join(home, "updates", "last-update.json"));
    const progress = readJsonSafe(
      join(home, "updates", "update-progress.json"),
    );
    const updateLog = readFileSync(join(home, "logs", "update.log"), "utf8");

    if (name === "happy") {
      const versionB = manifest.version;
      assert(updaterCode === 0, `正常更新退出码 ${updaterCode}`);
      assert(updaterResult.status === "updated", "正常更新状态异常");
      assert(running.version === versionB, "升级后运行版本不正确");
      assert(packageVersion(appRoot) === versionB, "升级后程序目录版本不正确");
      assert(
        packageVersion(join(install, "app.previous")) === versionA,
        "旧程序目录未保留",
      );
      assert(updaterResult.backupId, "正常更新缺少更新前备份");
      assert(
        existsSync(join(home, "backups", updaterResult.backupId, "meta.json")),
        "更新前备份目录不存在",
      );
      assert(state?.status === "updated", "last-update 状态不正确");
      assert(updateLog.includes("更新成功"), "update.log 缺少成功记录");
      if (updaterSupportsProgress) {
        assert(progress?.status === "updated", "更新进度终态不正确");
        assert(progress.phase === "done", "更新进度阶段不正确");
        assert(progress.percent === 100, "更新进度未完成");
        assert(
          progress.from === versionA && progress.to === versionB,
          "更新进度版本不正确",
        );
      } else {
        assert(progress === null, "旧版更新器不应写入更新进度");
      }
      const updateStatus = await request(
        `http://127.0.0.1:${runningPort}/api/update/status`,
        { headers: { cookie } },
      );
      assert(
        updateStatus.status === 200,
        `更新状态接口失败：HTTP ${updateStatus.status}`,
      );
      assert(
        updateStatus.body.currentVersion === versionB,
        "更新状态接口版本不一致",
      );
      assert(
        updateStatus.body.installSupported === true,
        "更新状态接口未识别安装包环境",
      );
      assert(
        updateStatus.body.updaterVersion === "1.1.0",
        "更新状态接口更新器版本不正确",
      );
      if (updaterSupportsProgress) {
        assert(
          updateStatus.body.progress?.status === "updated" &&
            updateStatus.body.progress.percent === 100,
          "更新状态接口未读取进度",
        );
        details.progressStatus = progress.status;
      } else {
        assert(
          updateStatus.body.progress === null,
          "旧版更新器升级后不应出现更新进度",
        );
      }
      assert(
        updateStatus.body.lastUpdate?.status === "updated",
        "更新状态接口未读取上次结果",
      );
      assert(updateStatus.body.updateLock === null, "更新状态接口仍报告更新锁");
      details.versionB = versionB;
      details.backupId = updaterResult.backupId;
    } else {
      const preSwap = [
        "digest",
        "download",
        "verify",
        "backup",
        "swap",
      ].includes(name);
      const expectedStatus = preSwap ? "failed" : "rolled-back";
      assert(updaterCode === 1, `失败演练退出码 ${updaterCode}，期望 1`);
      assert(
        updaterResult.status === expectedStatus,
        `失败演练状态 ${updaterResult.status}，期望 ${expectedStatus}`,
      );
      assert(running.version === versionA, "失败后运行版本不是旧版本");
      assert(
        packageVersion(appRoot) === versionA,
        "失败后程序目录未保持旧版本",
      );
      assert(
        !existsSync(join(install, "app.previous")),
        "失败后残留 app.previous",
      );
      assert(state?.status === expectedStatus, "失败状态未写入 last-update");
      if (updaterSupportsProgress) {
        assert(
          progress?.status === expectedStatus,
          `失败演练进度状态 ${progress?.status}，期望 ${expectedStatus}`,
        );
        assert(
          progress.from === versionA && progress.to === manifest.version,
          "失败演练进度版本不正确",
        );
        assert(
          typeof progress.error === "string" && progress.error.length > 0,
          "失败演练进度缺少错误信息",
        );
        details.progressStatus = progress.status;
      } else {
        assert(progress === null, "旧版更新器不应写入更新进度");
      }
      assert(updateLog.includes("更新失败"), "update.log 缺少失败记录");
      details.expectedStatus = expectedStatus;
    }
    details.runningVersion = running.version;
    details.ok = true;
    return details;
  } catch (error) {
    details.ok = false;
    details.error = error.message;
    details.output = output.join("").slice(-3000);
    throw Object.assign(error, { details });
  } finally {
    if (mcp && mcp.exitCode == null) mcp.kill("SIGKILL");
    await shutdown(port, home);
    if (server && server.exitCode == null) server.kill("SIGKILL");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`用法：node scripts/release/rehearse-update.mjs --from <vA 完整包> --manifest <vB 清单> [选项]

  --update <文件>       vB 更新包（默认取清单同目录下的 update.file）
  --scenarios <列表>    默认 happy,digest,download,verify,backup,swap,migrate,health
  --work <目录>         演练目录（默认系统临时目录）
  --timeout <秒>        单次更新超时（默认 180）
  --json                输出 JSON 汇总
  --keep                保留演练目录`);
    return;
  }
  if (!options.from) throw new Error("缺少 --from");
  if (!options.manifest) throw new Error("缺少 --manifest");
  const sourceManifest = readJson(options.manifest);
  const updateZip =
    options.update ??
    resolve(dirname(options.manifest), sourceManifest.update?.file ?? "");
  if (!existsSync(updateZip)) throw new Error(`更新包不存在：${updateZip}`);
  const work =
    options.work ?? mkdtempSync(join(tmpdir(), "superpm-update-rehearsal-"));
  mkdirSync(work, { recursive: true });
  const context = { work, updateZip };
  const report = {
    ok: false,
    from: options.from,
    update: updateZip,
    work,
    scenarios: [],
  };
  try {
    for (const name of options.scenarios) {
      if (!options.json) console.log(`[rehearsal] 场景 ${name}`);
      try {
        const detail = await runScenario(name, options, {
          ...context,
          manifest: options.manifest,
        });
        report.scenarios.push(detail);
        if (!options.json)
          console.log(
            `[rehearsal] ${name} 通过（v${detail.versionA} -> ${detail.runningVersion}）`,
          );
      } catch (error) {
        report.scenarios.push(error.details ?? { name, ok: false });
        throw error;
      }
    }
    report.ok = true;
    if (!options.json) console.log("[rehearsal] 全部场景通过");
  } finally {
    if (report.ok && !options.keep)
      rmSync(work, { recursive: true, force: true });
    else if (!options.json) console.log(`[rehearsal] 演练目录保留：${work}`);
    if (options.json) console.log(JSON.stringify(report));
  }
}

await main();
