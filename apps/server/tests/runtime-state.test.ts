import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireUpdateLock,
  activeUpdateLock,
  listMcpProcesses,
  MCP_HEARTBEAT_MS,
  readServerState,
  registerMcpProcess,
  releaseUpdateLock,
  removeServerState,
  serverStatePath,
  updateLockPath,
  writeServerState,
} from "../src/runtime/state.js";

const directories: string[] = [];
function tempHome() {
  const directory = mkdtempSync(join(tmpdir(), "superpm-runtime-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

describe("MCP 运行时注册", () => {
  it("注册、心跳与注销", async () => {
    const home = tempHome();
    const registration = registerMcpProcess(home, {
      version: "0.2.0",
      schemaVersion: 12,
      writeEnabled: false,
    });
    const path = registration.path;
    const first = JSON.parse(readFileSync(path, "utf8"));
    expect(first.pid).toBe(process.pid);
    expect(first.version).toBe("0.2.0");

    await new Promise((done) => setTimeout(done, 20));
    registration.touch();
    const second = JSON.parse(readFileSync(path, "utf8"));
    expect(second.heartbeatAt >= first.heartbeatAt).toBe(true);
    expect(MCP_HEARTBEAT_MS).toBeGreaterThan(0);

    const listed = listMcpProcesses(home);
    expect(listed).toHaveLength(1);
    expect(listed[0].alive).toBe(true);
    expect(listed[0].stale).toBe(false);

    registration.close();
    expect(listMcpProcesses(home)).toHaveLength(0);
  });

  it("过滤已退出进程", () => {
    const home = tempHome();
    mkdirSync(join(home, "runtime", "mcp"), { recursive: true });
    writeFileSync(
      join(home, "runtime", "mcp", "99999999.json"),
      JSON.stringify({
        pid: 99999999,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        version: "0.1.0",
        schemaVersion: 12,
        writeEnabled: false,
      }),
    );
    expect(listMcpProcesses(home)[0].alive).toBe(false);
  });
});

describe("更新锁", () => {
  it("创建、互斥与释放", () => {
    const home = tempHome();
    const lock = acquireUpdateLock(home, {
      version: "0.2.0",
      reason: "test",
    });
    expect(lock.pid).toBe(process.pid);
    expect(activeUpdateLock(home)?.version).toBe("0.2.0");
    expect(() => acquireUpdateLock(home, {})).toThrow(/已有更新正在进行/);
    expect(releaseUpdateLock(home)).toBe(true);
    expect(activeUpdateLock(home)).toBeNull();
  });

  it("持有进程退出后清理残留锁", () => {
    const home = tempHome();
    mkdirSync(join(home, "runtime"), { recursive: true });
    writeFileSync(
      updateLockPath(home),
      JSON.stringify({
        pid: 99999999,
        createdAt: new Date().toISOString(),
      }),
    );
    expect(activeUpdateLock(home)).toBeNull();
    expect(() => acquireUpdateLock(home, {})).not.toThrow();
    releaseUpdateLock(home);
  });

  it("损坏锁文件在 30 分钟内保持阻断，过期后清理", () => {
    const home = tempHome();
    mkdirSync(join(home, "runtime"), { recursive: true });
    writeFileSync(updateLockPath(home), "not-json");
    const active = activeUpdateLock(home);
    expect(active?.pid).toBe(0);
    expect(() => acquireUpdateLock(home, {})).toThrow();

    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(updateLockPath(home), old, old);
    expect(activeUpdateLock(home)).toBeNull();
    expect(() => acquireUpdateLock(home, {})).not.toThrow();
    releaseUpdateLock(home);
  });
});

describe("服务运行状态", () => {
  it("写入、读取与按 PID 清理", () => {
    const home = tempHome();
    const record = {
      pid: process.pid,
      port: 3456,
      startedAt: new Date().toISOString(),
      version: "0.2.0",
      schemaVersion: 12,
      shutdownToken: "token-123",
    };
    writeServerState(home, record);
    expect(readServerState(home)).toMatchObject(record);

    removeServerState(home, process.pid + 1);
    expect(readServerState(home)).not.toBeNull();
    removeServerState(home, process.pid);
    expect(readServerState(home)).toBeNull();
    expect(serverStatePath(home)).toContain("server.json");
  });
});
