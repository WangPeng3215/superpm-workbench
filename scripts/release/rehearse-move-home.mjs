#!/usr/bin/env node
// 使用真实发布包演练数据根迁移、旧数据处理与 0.3.3 → 0.4.0 完整包 bootstrap。
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
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
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import yauzl from "yauzl";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readJsonSafe = (path) => {
  try {
    return readJson(path);
  } catch {
    return null;
  }
};

function parseArgs(argv) {
  const options = {
    version: "0.4.0",
    scenarios: ["move", "bootstrap"],
    json: false,
    keep: false,
    timeoutMs: 180000,
    runtimeSource: "download",
    from033Url:
      "https://github.com/WangPeng3215/superpm-workbench/releases/download/v0.3.3/superpm-workbench-0.3.3-win-x64.zip",
  };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === "--from") options.from = resolve(argv[++index]);
    else if (item === "--manifest") options.manifest = resolve(argv[++index]);
    else if (item === "--from-033") options.from033 = resolve(argv[++index]);
    else if (item === "--from-033-url") options.from033Url = argv[++index];
    else if (item === "--version") options.version = argv[++index];
    else if (item === "--work") options.work = resolve(argv[++index]);
    else if (item === "--scenarios")
      options.scenarios = argv[++index].split(",").filter(Boolean);
    else if (item === "--timeout")
      options.timeoutMs = Number(argv[++index]) * 1000;
    else if (item === "--runtime-source") options.runtimeSource = argv[++index];
    else if (item === "--json") options.json = true;
    else if (item === "--keep") options.keep = true;
    else if (item === "--help" || item === "-h") options.help = true;
    else throw new Error(`未知参数：${item}`);
  }
  return options;
}

function run(command, args, env = process.env) {
  const windows = process.platform === "win32";
  const result = spawnSync(
    windows && command === "npm" ? "npm.cmd" : command,
    args,
    {
      cwd: repoRoot,
      stdio: "inherit",
      env,
      shell: windows && command === "npm",
    },
  );
  if (result.error)
    throw new Error(
      `命令启动失败（${command} ${args.join(" ")}）：${result.error.message}`,
    );
  if (result.status !== 0)
    throw new Error(
      `命令失败（${result.status}）：${command} ${args.join(" ")}`,
    );
}

async function downloadFile(url, target) {
  const response = await fetch(url, {
    headers: { "user-agent": "superpm-move-home-rehearsal/1.0" },
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`下载失败：${url} HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(target));
}

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

async function unpackPackage(zipPath, targetRoot) {
  await extractZip(zipPath, targetRoot);
  const folders = readdirSync(targetRoot).filter((item) => {
    try {
      return statSync(join(targetRoot, item)).isDirectory();
    } catch {
      return false;
    }
  });
  if (folders.length !== 1)
    throw new Error(`完整安装包根目录结构异常：${zipPath}`);
  return join(targetRoot, folders[0]);
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
    signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
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
  try {
    const response = await request(`http://127.0.0.1:${port}/api/health`, {
      timeoutMs: 1500,
    });
    return response.status === 200 ? response.body : null;
  } catch {
    return null;
  }
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.SUPERPM_HOME;
  delete env.SUPERPM_HOME_SOURCE;
  delete env.SUPERPM_CONFIG_DIR;
  delete env.SUPERPM_DATA_DIR;
  delete env.SUPERPM_WORKSPACE_DIR;
  delete env.SUPERPM_MOVE_RESTART_JOB;
  delete env.SUPERPM_UPDATE_TESTING;
  delete env.SUPERPM_UPDATE_FAIL_AT;
  return Object.assign(env, extra);
}

function startLauncher(install, env, output) {
  const child = spawn(
    join(install, "runtime", "node.exe"),
    [join(install, "bin", "launcher.mjs")],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  return child;
}

async function waitServer(home, expectedVersion, label) {
  let port = null;
  const state = await waitFor(
    async () => {
      const value = readJsonSafe(join(home, "runtime", "server.json"));
      if (!value || !Number.isInteger(value.port)) return null;
      const status = await health(value.port);
      if (status?.status !== "ok") return null;
      if (expectedVersion && status.version !== expectedVersion)
        throw new Error(`运行版本 ${status.version}，期望 ${expectedVersion}`);
      port = value.port;
      return { state: value, health: status };
    },
    60000,
    label,
  );
  return { port, ...state };
}

async function shutdown(home) {
  const state = readJsonSafe(join(home, "runtime", "server.json"));
  if (!state) return;
  try {
    await request(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: "POST",
      headers: { "x-superpm-shutdown-token": state.shutdownToken },
      timeoutMs: 3000,
    });
  } catch {
    // 服务可能已退出
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!existsSync(join(home, "runtime", "server.json"))) return;
    await sleep(250);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label}不存在：${path}`);
}

function packageVersion(appRoot) {
  return readJson(join(appRoot, "package.json")).version;
}

async function createSampleData(port, cookie, home, marker) {
  const created = await request(`http://127.0.0.1:${port}/api/requirements`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: marker, proposedAt: "2026-10-24" }),
  });
  assert(created.status === 201, `创建需求失败：HTTP ${created.status}`);
  writeFileSync(join(home, "workspace", "rehearsal-marker.txt"), marker);
  mkdirSync(join(home, "data", "attachments"), { recursive: true });
  writeFileSync(join(home, "data", "attachments", "sample.txt"), `${marker}\n`);
  mkdirSync(join(home, "backups", "rehearsal-backup"), { recursive: true });
  writeFileSync(
    join(home, "backups", "rehearsal-backup", "meta.json"),
    `${JSON.stringify({ name: marker }, null, 2)}\n`,
  );
  return created.body.id;
}

async function assertDataIntact(port, cookie, requirementId, expectedName) {
  const response = await request(
    `http://127.0.0.1:${port}/api/requirements/${requirementId}`,
    { headers: { cookie } },
  );
  assert(response.status === 200, "迁移后业务数据读取失败");
  assert(
    response.body.name === expectedName,
    `迁移后需求内容变化：${response.body.name}`,
  );
}

function readMoveState(configDir) {
  return readJsonSafe(join(configDir, "move-home.json"));
}

async function waitMoveState(configDir, timeoutMs) {
  const state = await waitFor(
    () => {
      const value = readMoveState(configDir);
      if (!value) return null;
      return value.status === "completed" || value.status === "failed"
        ? value
        : null;
    },
    timeoutMs,
    "迁移任务完成",
  );
  if (state.status !== "completed")
    throw new Error(
      `迁移失败（阶段 ${state.phase}）：${state.error?.message ?? "未知错误"}`,
    );
  return state;
}

async function moveTo({ port, cookie, configDir, parent, timeoutMs }) {
  const validation = await request(
    `http://127.0.0.1:${port}/api/system/home/validate`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ parent }),
    },
  );
  assert(validation.status === 200, `目标校验失败：HTTP ${validation.status}`);
  assert(
    validation.body.blockedReasons.length === 0,
    `目标校验被阻断：${validation.body.blockedReasons.join("；")}`,
  );
  const started = await request(
    `http://127.0.0.1:${port}/api/system/home/move`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        parent,
        confirmTarget: validation.body.targetHome,
      }),
    },
  );
  assert(started.status === 202, `启动迁移失败：HTTP ${started.status}`);
  assert(started.body.status === "started", "迁移任务未启动");
  const state = await waitMoveState(configDir, timeoutMs);
  assert(
    state.toHome.toLowerCase() === validation.body.targetHome.toLowerCase(),
    "迁移目标与校验结果不一致",
  );
  return { validation: validation.body, started: started.body, state };
}

async function runMoveScenario(options, context) {
  const root = join(context.work, "move");
  const extractRoot = join(root, "extract");
  const configDir = join(root, "config");
  const homeA = join(root, "data-a");
  const targetB = join(root, "target-b");
  const targetC = join(root, "target-c");
  const targetD = join(root, "target-d");
  for (const directory of [configDir, homeA, targetB, targetC, targetD])
    mkdirSync(directory, { recursive: true });

  const install = await unpackPackage(context.fullZip, extractRoot);
  assert(
    packageVersion(join(install, "app")) === context.version,
    `发布包版本不是 ${context.version}`,
  );
  const installInfo = readJson(join(install, "install.json"));
  assert(
    installInfo.updaterVersion === "1.1.0",
    `install.json 更新器版本为 ${installInfo.updaterVersion}`,
  );

  writeFileSync(
    join(homeA, ".superpm-home.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        home: homeA,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(configDir, "config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        home: homeA,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  const port = await freePort();
  writeFileSync(join(homeA, ".env"), `PORT=${port}\n`);

  const output = [];
  const env = cleanEnv({
    SUPERPM_CONFIG_DIR: configDir,
    SUPERPM_INSTALL_ROOT: install,
    SUPERPM_LEGACY_ROOT: install,
  });
  let launcher = startLauncher(install, env, output);
  const details = { name: "move", install, configDir };
  let currentHome = homeA;
  let currentPort = port;
  let cookie = null;
  try {
    const initial = await waitServer(homeA, context.version, "初始服务启动");
    currentPort = initial.port;
    cookie = await login(currentPort);
    const system = await request(`http://127.0.0.1:${currentPort}/api/system`, {
      headers: { cookie },
    });
    assert(system.status === 200, "读取系统信息失败");
    assert(system.body.homeSource === "config", "初始数据根来源不是配置文件");
    assert(system.body.homePath === homeA, "初始数据根路径不一致");
    assert(system.body.dataRootEditable === true, "初始数据根应可编辑");
    const requirementId = await createSampleData(
      currentPort,
      cookie,
      homeA,
      "迁移演练-初始数据",
    );
    details.requirementId = requirementId;

    // 第一次迁移：A -> B，随后删除旧数据
    const first = await moveTo({
      port: currentPort,
      cookie,
      configDir,
      parent: targetB,
      timeoutMs: options.timeoutMs,
    });
    const homeB = join(targetB, "superPM");
    currentHome = homeB;
    details.first = {
      jobId: first.state.jobId,
      from: homeA,
      to: homeB,
    };
    for (const relative of ["data/superpm.sqlite", "workspace"])
      assertFile(join(homeB, relative), `迁移后 ${relative}`);
    assert(
      readFileSync(join(homeB, "workspace", "rehearsal-marker.txt"), "utf8") ===
        "迁移演练-初始数据",
      "迁移后工作区文件内容变化",
    );
    assertFile(
      join(homeB, "data", "attachments", "sample.txt"),
      "迁移后数据附件",
    );
    assertFile(
      join(homeB, "backups", "rehearsal-backup", "meta.json"),
      "迁移后备份",
    );
    const pointerAfterFirst = readJson(join(configDir, "config.json"));
    assert(pointerAfterFirst.home === homeB, "配置指针未切换到新数据根");
    assert(
      pointerAfterFirst.previousHome === homeA,
      "配置指针缺少 previousHome",
    );
    const moved = readJson(join(homeA, ".superpm-moved.json"));
    assert(moved?.jobId === first.state.jobId, "旧数据根缺少迁移标记");
    assert(moved.to === homeB, "旧数据根标记目标不一致");
    assert(first.state.cleanup === "pending", "迁移后旧数据未标记待处理");
    assert(!existsSync(join(configDir, "operation.lock")), "迁移锁未释放");
    assert(
      readdirSync(join(configDir, "logs")).some((name) =>
        name.startsWith("move-home-"),
      ),
      "缺少迁移日志",
    );

    const restarted = await waitServer(
      homeB,
      context.version,
      "迁移后服务启动",
    );
    currentPort = restarted.port;
    cookie = await login(currentPort);
    await assertDataIntact(
      currentPort,
      cookie,
      requirementId,
      "迁移演练-初始数据",
    );
    const stateView = await request(
      `http://127.0.0.1:${currentPort}/api/system/home/move`,
      { headers: { cookie } },
    );
    assert(stateView.status === 200, "读取迁移状态失败");
    assert(stateView.body.status === "completed", "接口迁移状态不是 completed");
    assert(stateView.body.phase === "completed", "接口迁移阶段不是 completed");
    const pendingInfo = await request(
      `http://127.0.0.1:${currentPort}/api/system`,
      { headers: { cookie } },
    );
    assert(
      pendingInfo.body.pendingOldData?.oldHome === homeA,
      "系统信息缺少待处理旧数据",
    );
    assert(
      pendingInfo.body.pendingOldData?.jobId === first.state.jobId,
      "待处理旧数据任务不一致",
    );

    const deleted = await request(
      `http://127.0.0.1:${currentPort}/api/system/home/cleanup`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          action: "delete",
          jobId: first.state.jobId,
          oldHome: homeA,
          confirm: true,
        }),
      },
    );
    assert(deleted.status === 200, `删除旧数据失败：HTTP ${deleted.status}`);
    assert(
      deleted.body.deletedPaths.length > 0 &&
        deleted.body.failedPaths === undefined,
      "删除旧数据结果不完整",
    );
    for (const relative of ["data", "workspace", "backups", ".env"])
      assert(!existsSync(join(homeA, relative)), `旧数据 ${relative} 仍未删除`);
    assertFile(join(homeA, ".superpm-moved.json"), "旧数据根迁移标记");
    const afterCleanup = readMoveState(configDir);
    assert(afterCleanup.cleanup === "deleted", "旧数据处理状态未记录");
    const systemAfterCleanup = await request(
      `http://127.0.0.1:${currentPort}/api/system`,
      { headers: { cookie } },
    );
    assert(
      systemAfterCleanup.body.pendingOldData === undefined,
      "删除旧数据后仍提示待处理",
    );

    // 第二次迁移（反向）：B -> C，随后保留旧数据
    const second = await moveTo({
      port: currentPort,
      cookie,
      configDir,
      parent: targetC,
      timeoutMs: options.timeoutMs,
    });
    const homeC = join(targetC, "superPM");
    currentHome = homeC;
    details.second = { jobId: second.state.jobId, from: homeB, to: homeC };
    assert(
      readMoveState(configDir).oldHome.toLowerCase() === homeB.toLowerCase(),
      "反向迁移旧数据根记录不正确",
    );
    const pointerAfterSecond = readJson(join(configDir, "config.json"));
    assert(pointerAfterSecond.home === homeC, "反向迁移配置指针不正确");
    assert(
      pointerAfterSecond.previousHome === homeB,
      "反向迁移 previousHome 不正确",
    );
    assertFile(join(homeB, "data", "superpm.sqlite"), "保留的旧数据库");
    assertFile(
      join(homeB, "workspace", "rehearsal-marker.txt"),
      "保留的旧工作区",
    );
    const restartedC = await waitServer(
      homeC,
      context.version,
      "反向迁移后服务",
    );
    currentPort = restartedC.port;
    cookie = await login(currentPort);
    const kept = await request(
      `http://127.0.0.1:${currentPort}/api/system/home/cleanup`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          action: "keep",
          jobId: second.state.jobId,
          oldHome: homeB,
        }),
      },
    );
    assert(kept.status === 200, `保留旧数据失败：HTTP ${kept.status}`);
    assertFile(join(homeB, "data", "superpm.sqlite"), "保留后旧数据库");
    assert(readMoveState(configDir).cleanup === "kept", "保留状态未记录");

    // 第三次迁移：C -> D，覆盖保留旧数据后再次迁移
    const third = await moveTo({
      port: currentPort,
      cookie,
      configDir,
      parent: targetD,
      timeoutMs: options.timeoutMs,
    });
    const homeD = join(targetD, "superPM");
    currentHome = homeD;
    details.third = { jobId: third.state.jobId, from: homeC, to: homeD };
    const restartedD = await waitServer(
      homeD,
      context.version,
      "再次迁移后服务",
    );
    currentPort = restartedD.port;
    cookie = await login(currentPort);
    await assertDataIntact(
      currentPort,
      cookie,
      requirementId,
      "迁移演练-初始数据",
    );
    assertFile(
      join(homeD, "backups", "rehearsal-backup", "meta.json"),
      "再次迁移后备份",
    );
    const finalPointer = readJson(join(configDir, "config.json"));
    assert(finalPointer.home === homeD, "最终配置指针不正确");
    assert(finalPointer.previousHome === homeC, "最终 previousHome 不正确");
    const finalSystem = await request(
      `http://127.0.0.1:${currentPort}/api/system`,
      { headers: { cookie } },
    );
    assert(finalSystem.body.homeSource === "config", "最终数据根来源不正确");
    assert(finalSystem.body.homePath === homeD, "最终数据根路径不正确");
    assert(finalSystem.body.dataRootEditable === true, "最终数据根不可编辑");
    details.final = { home: homeD, version: finalSystem.body.version };
    details.ok = true;
    return details;
  } catch (error) {
    details.ok = false;
    details.error = error.message;
    details.output = output.join("").slice(-3000);
    throw Object.assign(error, { details });
  } finally {
    await shutdown(currentHome);
    if (launcher && launcher.exitCode == null) launcher.kill("SIGKILL");
  }
}

function updaterManifest(source, updateZip) {
  const manifest = { ...source };
  const update = { ...manifest.update, file: pathToFileURL(updateZip).href };
  delete update.url;
  return { ...manifest, update };
}

async function runBootstrapScenario(options, context) {
  const root = join(context.work, "bootstrap");
  const configDir = join(root, "config");
  const home = join(root, "home");
  const extract033 = join(root, "extract-033");
  const extract040 = join(root, "extract-040");
  for (const directory of [configDir, home, extract033, extract040])
    mkdirSync(directory, { recursive: true });

  const from033 =
    options.from033 ?? join(root, "superpm-workbench-0.3.3-win-x64.zip");
  if (!options.from033) {
    console.log("[rehearsal] 下载 0.3.3 完整安装包…");
    await downloadFile(options.from033Url, from033);
  }
  assertFile(from033, "0.3.3 完整安装包");

  const install033 = await unpackPackage(from033, extract033);
  assert(
    packageVersion(join(install033, "app")) === "0.3.3",
    "0.3.3 安装包版本不正确",
  );
  const install040 = await unpackPackage(context.fullZip, extract040);
  assert(
    packageVersion(join(install040, "app")) === context.version,
    `0.4.0 安装包版本不是 ${context.version}`,
  );
  const manifestSource = context.manifest;
  const manifestPath = join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(updaterManifest(manifestSource, context.updateZip), null, 2)}\n`,
  );

  const port = await freePort();
  writeFileSync(join(home, ".env"), `PORT=${port}\n`);

  const output = [];
  const env033 = cleanEnv({
    SUPERPM_HOME: home,
    SUPERPM_INSTALL_ROOT: install033,
    SUPERPM_LEGACY_ROOT: install033,
  });
  const details = { name: "bootstrap", home, from: from033 };
  let launcher = startLauncher(install033, env033, output);
  let currentPort = port;
  let cookie = null;
  try {
    const started = await waitServer(home, "0.3.3", "0.3.3 服务启动");
    currentPort = started.port;
    cookie = await login(currentPort);
    const requirementId = await createSampleData(
      currentPort,
      cookie,
      home,
      "bootstrap-0.3.3",
    );
    await shutdown(home);
    if (launcher && launcher.exitCode == null) launcher.kill("SIGKILL");
    launcher = null;

    // 0.3.3 自带的 1.0.0 更新器必须拒绝 0.4.0 增量升级
    const updater = spawn(
      join(install033, "runtime", "node.exe"),
      [
        join(install033, "bin", "updater.mjs"),
        "--manifest",
        manifestPath,
        "--install-root",
        install033,
        "--home",
        home,
        "--json",
      ],
      {
        env: cleanEnv({ SUPERPM_HOME: home }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let updaterOut = "";
    updater.stdout.on("data", (chunk) => (updaterOut += chunk));
    updater.stderr.on("data", (chunk) => (updaterOut += chunk));
    const updaterCode = await waitExit(updater, options.timeoutMs);
    const lastLine = updaterOut.trim().split("\n").pop();
    let updaterResult = null;
    try {
      updaterResult = JSON.parse(lastLine);
    } catch {
      updaterResult = null;
    }
    details.bootstrapRejection = {
      exitCode: updaterCode,
      status: updaterResult?.status,
      error: updaterResult?.error,
    };
    assert(updaterCode === 1, `0.3.3 更新器退出码 ${updaterCode}，期望 1`);
    assert(updaterResult?.status === "failed", "0.3.3 更新器状态不是 failed");
    assert(
      /更新器版本 1\.0\.0 低于要求 1\.1\.0/.test(updaterResult.error ?? ""),
      `0.3.3 更新器拒绝原因不正确：${updaterResult?.error}`,
    );
    assert(
      packageVersion(join(install033, "app")) === "0.3.3",
      "被拒绝的更新改变了程序版本",
    );
    assertFile(join(home, "data", "superpm.sqlite"), "被拒绝的更新后数据库");

    // 完整包覆盖安装（保留安装目录与数据根）
    rmSync(install033, { recursive: true, force: true });
    cpSync(install040, install033, { recursive: true, force: true });
    assert(
      packageVersion(join(install033, "app")) === context.version,
      "覆盖安装后程序版本不正确",
    );
    writeFileSync(
      join(configDir, "config.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          home,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    const env040 = cleanEnv({
      SUPERPM_CONFIG_DIR: configDir,
      SUPERPM_INSTALL_ROOT: install033,
      SUPERPM_LEGACY_ROOT: install033,
    });
    launcher = startLauncher(install033, env040, output);
    const restarted = await waitServer(
      home,
      context.version,
      "覆盖安装后 0.4.0 启动",
    );
    currentPort = restarted.port;
    cookie = await login(currentPort);
    await assertDataIntact(
      currentPort,
      cookie,
      requirementId,
      "bootstrap-0.3.3",
    );
    assert(
      readFileSync(join(home, "workspace", "rehearsal-marker.txt"), "utf8") ===
        "bootstrap-0.3.3",
      "覆盖安装后工作区文件变化",
    );
    assertFile(
      join(home, "data", "attachments", "sample.txt"),
      "覆盖安装后数据附件",
    );
    const system = await request(`http://127.0.0.1:${currentPort}/api/system`, {
      headers: { cookie },
    });
    assert(system.status === 200, "覆盖安装后读取系统信息失败");
    assert(system.body.version === context.version, "覆盖安装后系统版本不正确");
    assert(system.body.homePath === home, "覆盖安装后数据根变化");
    assert(system.body.homeSource === "config", "覆盖安装后数据根来源不正确");
    assert(system.body.dataRootEditable === true, "覆盖安装后数据根应可编辑");
    const updateStatus = await request(
      `http://127.0.0.1:${currentPort}/api/update/status`,
      { headers: { cookie } },
    );
    assert(updateStatus.status === 200, "读取更新状态失败");
    assert(
      updateStatus.body.updaterVersion === "1.1.0",
      `覆盖安装后更新器版本为 ${updateStatus.body.updaterVersion}`,
    );
    assert(
      updateStatus.body.installSupported === true,
      "覆盖安装后未识别为安装包环境",
    );
    details.install = install033;
    details.updaterVersion = updateStatus.body.updaterVersion;
    details.ok = true;
    return details;
  } catch (error) {
    details.ok = false;
    details.error = error.message;
    details.output = output.join("").slice(-3000);
    throw Object.assign(error, { details });
  } finally {
    await shutdown(home);
    if (launcher && launcher.exitCode == null) launcher.kill("SIGKILL");
  }
}

async function resolvePackage(options, work) {
  if (options.from) {
    const manifestPath = options.manifest;
    if (!manifestPath) throw new Error("使用 --from 时必须同时提供 --manifest");
    const manifest = readJson(manifestPath);
    const updateZip = resolve(
      dirname(manifestPath),
      manifest.update?.file ?? "",
    );
    assertFile(updateZip, "更新包");
    return {
      version: manifest.version,
      fullZip: options.from,
      updateZip,
      manifest,
      built: false,
    };
  }
  const out = join(work, "release");
  console.log(`[rehearsal] 构建 v${options.version} 发布包…`);
  run(process.execPath, [
    join(repoRoot, "scripts/release/build-release.mjs"),
    "--version",
    options.version,
    "--out",
    out,
    "--runtime-source",
    options.runtimeSource,
    "--no-smoke",
  ]);
  const fullZip = join(out, `superpm-workbench-${options.version}-win-x64.zip`);
  const manifestPath = join(out, "update-manifest.json");
  assertFile(fullZip, "发布完整包");
  assertFile(manifestPath, "发布清单");
  const manifest = readJson(manifestPath);
  const updateZip = join(out, manifest.update.file);
  assertFile(updateZip, "发布更新包");
  return {
    version: manifest.version,
    fullZip,
    updateZip,
    manifest,
    built: true,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`用法：node scripts/release/rehearse-move-home.mjs [选项]

  --from <完整包>        使用已有发布完整包（默认构建）
  --manifest <清单>      --from 时必填；默认构建时自动使用发布清单
  --from-033 <完整包>    0.3.3 完整安装包（默认从 GitHub Release 下载）
  --version <版本>       构建版本（默认 0.4.0）
  --scenarios <列表>     move,bootstrap（默认全部）
  --work <目录>          演练目录（默认系统临时目录）
  --timeout <秒>         单次迁移/更新超时（默认 180）
  --runtime-source <来源> download | local
  --json                输出 JSON 汇总
  --keep                保留演练目录`);
    return;
  }
  const work =
    options.work ?? mkdtempSync(join(tmpdir(), "superpm-move-rehearsal-"));
  mkdirSync(work, { recursive: true });
  const report = {
    ok: false,
    work,
    package: null,
    scenarios: [],
  };
  try {
    const context = { ...(await resolvePackage(options, work)), work };
    report.package = {
      version: context.version,
      full: context.fullZip,
      update: context.updateZip,
      built: context.built,
    };
    for (const name of options.scenarios) {
      if (!options.json) console.log(`[rehearsal] 场景 ${name}`);
      try {
        const runner =
          name === "move"
            ? runMoveScenario
            : name === "bootstrap"
              ? runBootstrapScenario
              : null;
        if (!runner) throw new Error(`未知场景：${name}`);
        const detail = await runner(options, context);
        report.scenarios.push(detail);
        if (!options.json) console.log(`[rehearsal] ${name} 通过`);
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

main().catch((error) => {
  console.error(`[rehearsal] 失败：${error.message}`);
  process.exitCode = 1;
});
