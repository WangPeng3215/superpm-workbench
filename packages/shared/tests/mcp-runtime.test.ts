import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listMcpProcesses,
  matchesMcpProcess,
  stopMcpProcesses,
  type McpProcessRecord,
} from "../src/mcp-runtime";

// OS 命令边界需模拟权限错误与 PID 复用竞态，其余用例运行真实子进程。
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

const directories: string[] = [];
const children: ChildProcess[] = [];
const old = "2026-01-01T00:00:00.000Z";

function record(pid: number): McpProcessRecord {
  return {
    pid,
    startedAt: old,
    heartbeatAt: old,
    version: "0.10.0",
    schemaVersion: 12,
    writeEnabled: false,
  };
}

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "superpm-mcp-runtime-"));
  directories.push(home);
  return home;
}

function writeRecord(home: string, value: McpProcessRecord) {
  const directory = join(home, "runtime", "mcp");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${value.pid}.json`), JSON.stringify(value));
}

async function spawnMcp(home: string) {
  const script = join(home, "app", "apps", "server", "dist", "mcp", "stdio.js");
  mkdirSync(join(script, ".."), { recursive: true });
  writeFileSync(
    script,
    "setInterval(() => {}, 1000); process.stdout.write('ready');",
  );
  const child = spawn(process.execPath, [script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await new Promise<void>((done, fail) => {
    child.once("error", fail);
    child.stdout!.once("data", () => done());
  });
  const value = { ...record(child.pid!), startedAt: new Date().toISOString() };
  writeRecord(home, value);
  return { child, value };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.kill("SIGKILL");
    });
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("MCP 进程身份核验", { timeout: 45000 }, () => {
  const identity = {
    startedAt: old,
    executable: "C:\\superPM\\runtime\\node.exe",
    commandLine:
      '"C:\\superPM\\runtime\\node.exe" "C:\\superPM\\app\\apps\\server\\dist\\mcp\\stdio.js"',
  };

  it("旧版本登记仍可匹配原 MCP 进程", () => {
    expect(matchesMcpProcess(record(123), identity)).toBe(true);
  });

  it.each([
    "node apps/server/dist/mcp/stdio.js",
    "node dist/mcp/stdio.js",
    "node src/mcp/stdio.ts",
  ])("兼容相对入口启动：%s", (commandLine) => {
    expect(matchesMcpProcess(record(123), { ...identity, commandLine })).toBe(
      true,
    );
  });

  it("同 PID 已启动新的 MCP 时，不匹配旧登记", () => {
    expect(
      matchesMcpProcess(record(123), {
        ...identity,
        startedAt: "2026-02-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("不把其他 Node 程序或非 Node 程序当作 MCP", () => {
    expect(
      matchesMcpProcess(record(123), {
        ...identity,
        commandLine: "node other-app.js",
      }),
    ).toBe(false);
    expect(
      matchesMcpProcess(record(123), {
        ...identity,
        executable: "C:\\Windows\\other.exe",
      }),
    ).toBe(false);
  });

  it("无法获取身份或登记时间无效时不批准强杀", () => {
    expect(matchesMcpProcess(record(123), null)).toBeNull();
    expect(
      matchesMcpProcess({ ...record(123), startedAt: "invalid" }, identity),
    ).toBeNull();
    expect(
      matchesMcpProcess(record(123), { ...identity, commandLine: null }),
    ).toBeNull();
  });

  it("真实 MCP 即使长时间没有心跳也保持阻断", async () => {
    const home = tempHome();
    const { value } = await spawnMcp(home);
    expect(listMcpProcesses(home)).toMatchObject([
      { alive: true, stale: true },
    ]);
    await expect(
      stopMcpProcesses({
        home,
        options: { timeoutMs: 0, force: false },
        log: () => {},
      }),
    ).rejects.toThrow(/MCP 进程运行/);
    expect(listMcpProcesses(home)[0].record.pid).toBe(value.pid);
  });

  it("强制更新只忽略复用的历史 PID，不终止当前测试进程", async () => {
    const home = tempHome();
    writeRecord(home, record(process.pid));
    await expect(
      stopMcpProcesses({
        home,
        options: { timeoutMs: 0, force: true },
        log: () => {},
      }),
    ).resolves.toBeUndefined();
    expect(listMcpProcesses(home)[0].alive).toBe(false);
    expect(
      existsSync(join(home, "runtime", "mcp", `${process.pid}.json`)),
    ).toBe(true);
  });

  it("心跳未过期时也在强杀前重新核验 PID 身份", async () => {
    const home = tempHome();
    writeRecord(home, {
      ...record(process.pid),
      heartbeatAt: new Date().toISOString(),
    });
    await expect(
      stopMcpProcesses({
        home,
        options: { timeoutMs: 0, force: true },
        log: () => {},
      }),
    ).resolves.toBeUndefined();
  });

  it("授权强制更新后结束确认为 MCP 的测试子进程", async () => {
    const home = tempHome();
    const { child } = await spawnMcp(home);
    await stopMcpProcesses({
      home,
      options: { timeoutMs: 0, force: true },
      log: () => {},
    });
    expect(listMcpProcesses(home)[0].alive).toBe(false);
    // 等待 Node 的子进程退出通知，确认不是仅忽略登记。
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((done) => child.once("exit", () => done()));
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it.skipIf(process.platform !== "win32")(
    "身份查询失败时保守阻断，不发送结束命令",
    async () => {
      const home = tempHome();
      writeRecord(home, record(process.pid));
      vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
        throw new Error("access denied");
      });
      const terminate = vi.spyOn(childProcess, "spawnSync");
      await expect(
        stopMcpProcesses({
          home,
          options: { timeoutMs: 0, force: true },
          log: () => {},
        }),
      ).rejects.toThrow(/无法核验.*未强制结束/);
      expect(terminate).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== "win32")(
    "Windows 结束失败时保留系统错误诊断",
    async () => {
      const home = tempHome();
      const { child } = await spawnMcp(home);
      vi.spyOn(childProcess, "spawnSync").mockReturnValue({
        status: 1,
        stderr: "Access is denied.",
        stdout: "",
        pid: 0,
        signal: null,
        output: [],
      });
      await expect(
        stopMcpProcesses({
          home,
          options: { timeoutMs: 0, force: true },
          log: () => {},
        }),
      ).rejects.toThrow(
        new RegExp(`无法结束 MCP 进程 ${child.pid}：Access is denied`),
      );
      expect(listMcpProcesses(home)[0].alive).toBe(true);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "强杀前 PID 已被复用时跳过结束命令",
    async () => {
      const home = tempHome();
      writeRecord(home, record(process.pid));
      const identity = {
        startedAt: old,
        executable: "C:\\superPM\\runtime\\node.exe",
        commandLine:
          'node "C:\\superPM\\app\\apps\\server\\dist\\mcp\\stdio.js"',
      };
      const inspect = vi
        .spyOn(childProcess, "execFileSync")
        .mockReturnValue(
          JSON.stringify({
            ...identity,
            startedAt: "2026-02-01T00:00:00.000Z",
          }),
        )
        .mockReturnValueOnce(JSON.stringify(identity));
      const terminate = vi.spyOn(childProcess, "spawnSync");
      await expect(
        stopMcpProcesses({
          home,
          options: { timeoutMs: 0, force: true },
          log: () => {},
        }),
      ).resolves.toBeUndefined();
      expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(terminate).not.toHaveBeenCalled();
    },
  );
});
