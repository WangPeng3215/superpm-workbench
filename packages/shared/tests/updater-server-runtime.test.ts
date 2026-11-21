import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

let base: string;
let updater: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "superpm-http-updater-"));
  updater = join(base, "updater.mjs");
  await build({
    entryPoints: [resolve("scripts/install/updater.mjs")],
    outfile: updater,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import{createRequire}from"node:module";const require=createRequire(import.meta.url);',
    },
  });
}, 45000);

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.kill("SIGKILL");
    });
  }
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

async function scenario(options: {
  entry?: boolean;
  stale?: boolean;
  invalidTime?: boolean;
  responds?: boolean;
  timeout?: number;
}) {
  const directory = mkdtempSync(join(base, "case-"));
  const installRoot = join(directory, "install");
  const app = join(installRoot, "app");
  const home = join(directory, "home");
  mkdirSync(join(app, "apps/server/drizzle"), { recursive: true });
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "superpm-workbench", version: "0.10.0" }),
  );
  writeFileSync(
    join(app, "apps/server/drizzle/0001_initial.sql"),
    "-- fixture",
  );
  const script = options.entry
    ? join(app, "apps/server/dist/index.js")
    : join(directory, "other-app.js");
  const requested = join(directory, "shutdown-requested");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(
    script,
    [
      'const {createServer}=require("node:http");',
      'const {writeFileSync}=require("node:fs");',
      "const server=createServer((req,res)=>{",
      "writeFileSync(" +
        JSON.stringify(requested) +
        ',"requested");res.end("ok");',
      options.responds ? "setImmediate(()=>process.exit(0));" : "",
      '});server.listen(0,"127.0.0.1",()=>process.stdout.write(String(server.address().port)));',
    ].join("\n"),
  );
  const victim = spawn(process.execPath, [script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(victim);
  const port = await new Promise<number>((done, fail) => {
    victim.once("error", fail);
    victim.stdout!.once("data", (data) => done(Number(String(data))));
  });
  writeFileSync(
    join(home, "runtime/server.json"),
    JSON.stringify({
      pid: victim.pid,
      port,
      startedAt: options.invalidTime
        ? "invalid"
        : options.stale
          ? "2000-01-01T00:00:00.000Z"
          : new Date().toISOString(),
      shutdownToken: "fixture-token",
      version: "0.10.0",
      schemaVersion: 1,
    }),
  );
  const manifest = join(directory, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      name: "superpm-workbench",
      version: "1.1.0",
      platform: process.platform + "-" + process.arch,
      schemaVersion: 1,
      update: {
        file: "intentionally-missing.zip",
        sha256: "0".repeat(64),
        size: 1,
      },
    }),
  );
  const child = spawn(
    process.execPath,
    [
      updater,
      "--manifest",
      manifest,
      "--install-root",
      installRoot,
      "--home",
      home,
      "--no-relocate",
      "--no-restart",
      "--force",
      "--timeout",
      String(options.timeout ?? 1),
      "--json",
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SUPERPM_HOME: home,
        SUPERPM_CONFIG_DIR: join(directory, "config"),
        SUPERPM_DATA_DIR: "data",
        SUPERPM_WORKSPACE_DIR: "workspace",
      },
    },
  );
  children.push(child);
  child.stdout!.resume();
  child.stderr!.resume();
  const code = await new Promise<number | null>((done, fail) => {
    child.once("error", fail);
    child.once("exit", done);
  });
  const result = JSON.parse(
    readFileSync(join(home, "updates/last-update.json"), "utf8"),
  );
  return { code, result, victim, requested };
}

describe("更新器 HTTP 服务进程身份", { timeout: 45000 }, () => {
  it("旧 PID 指向其他 Node 程序时不发送停止请求也不强杀", async () => {
    const { code, result, victim, requested } = await scenario({});
    expect(victim.exitCode === null && victim.signalCode === null).toBe(true);
    expect(existsSync(requested)).toBe(false);
    expect(code).toBe(1);
    expect(result.error).toContain("intentionally-missing.zip");
  });
  it("同一安装入口的新进程不能匹配旧登记", async () => {
    const { result, victim, requested } = await scenario({
      entry: true,
      stale: true,
    });
    expect(victim.exitCode === null && victim.signalCode === null).toBe(true);
    expect(existsSync(requested)).toBe(false);
    expect(result.error).toContain("intentionally-missing.zip");
  });
  it("身份时间无法核验时阻断更新并保留进程", async () => {
    const { result, victim, requested } = await scenario({
      entry: true,
      invalidTime: true,
    });
    expect(victim.exitCode === null && victim.signalCode === null).toBe(true);
    expect(existsSync(requested)).toBe(false);
    expect(result.error).toMatch(/无法核验.*服务进程/);
  });
  it("已核验服务可正常响应停止请求", async () => {
    const { result, victim, requested } = await scenario({
      entry: true,
      responds: true,
    });
    expect(existsSync(requested)).toBe(true);
    expect(victim.exitCode).toBe(0);
    expect(result.logs).toContain("服务与 MCP 已停止");
    expect(result.error).toContain("intentionally-missing.zip");
  });
  it("已核验服务不响应时仍可显式强制停止", async () => {
    const { result, victim } = await scenario({ entry: true, timeout: 0 });
    expect(victim.exitCode !== null || victim.signalCode !== null).toBe(true);
    expect(
      result.logs.some((line: string) => /强制结束.*进程/.test(line)),
    ).toBe(true);
    expect(result.error).toContain("intentionally-missing.zip");
  });
});
