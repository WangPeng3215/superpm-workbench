// HTTP 服务和独立更新器共用 MCP 登记与进程身份规则，兼容旧版本登记文件。
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface McpProcessRecord {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  version: string;
  schemaVersion: number;
  writeEnabled: boolean;
}

export interface McpProcessInfo {
  record: McpProcessRecord;
  path: string;
  alive: boolean;
  stale: boolean;
}

interface ProcessIdentity {
  startedAt: string;
  executable: string | null;
  commandLine: string | null;
}

export const MCP_HEARTBEAT_MS = 5000;
export const MCP_STALE_MS = 30000;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** null 表示无法确认。心跳超时本身不能证明进程已退出。 */
export function matchesMcpProcess(
  record: McpProcessRecord,
  identity: ProcessIdentity | null,
): boolean | null {
  if (!identity) return null;
  const started = Date.parse(identity.startedAt);
  const registered = Date.parse(record.startedAt);
  // 登记在 MCP 初始化后写入。比登记还晚创建的进程一定不是原进程。
  if (
    Number.isFinite(started) &&
    Number.isFinite(registered) &&
    started > registered
  )
    return false;
  if (
    identity.executable &&
    !/^node(?:\.exe)?$/i.test(basename(identity.executable.replace(/\\/g, "/")))
  )
    return false;
  if (
    identity.commandLine &&
    !/(?:^|["'\s\\/])(?:dist[\\/]mcp[\\/]stdio\.js|src[\\/]mcp[\\/]stdio\.ts)(?=["'\s]|$)/i.test(
      identity.commandLine,
    )
  )
    return false;
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(registered) ||
    !identity.executable ||
    !identity.commandLine
  )
    return null;
  return true;
}

export function processIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      // 只查询指定 PID，不按进程名扫描或结束进程。不输出命令行（可能含客户端参数）。
      const output = execFileSync(
        join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | ForEach-Object { @{ startedAt = $_.CreationDate.ToUniversalTime().ToString('o'); executable = $_.ExecutablePath; commandLine = $_.CommandLine } } | ConvertTo-Json -Compress`,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          // Windows 冷启动 CIM 查询在高负载设备上可能超过 3 秒。
          timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return output.trim() ? JSON.parse(output.replace(/^\uFEFF/, "")) : null;
    }
    const options = {
      encoding: "utf8" as const,
      timeout: 3000,
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    };
    const startedAt = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      options,
    ).trim();
    const executable = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "comm="],
      options,
    ).trim();
    const commandLine = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "args="],
      options,
    ).trim();
    return { startedAt, executable, commandLine };
  } catch {
    // 权限不足、进程已退出或系统查询不可用：调用方必须保守阻断，不能盲目强杀。
    return null;
  }
}

export function listMcpProcesses(
  home: string,
  options: { verifyAll?: boolean } = {},
): McpProcessInfo[] {
  const directory = join(home, "runtime", "mcp");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const result: McpProcessInfo[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const path = join(directory, name);
    let record: McpProcessRecord;
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (
      !record ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      name !== `${record.pid}.json`
    )
      continue;
    let alive = isProcessAlive(record.pid);
    const heartbeat = Date.parse(record.heartbeatAt);
    const stale =
      !alive ||
      !Number.isFinite(heartbeat) ||
      Date.now() - heartbeat > MCP_STALE_MS;
    if (alive && (stale || options.verifyAll)) {
      const match = matchesMcpProcess(record, processIdentity(record.pid));
      if (match === false || !isProcessAlive(record.pid)) alive = false;
    }
    // 保留原登记供诊断；只排除已确认失效的身份，不删除可能仍在使用的文件。
    result.push({ record, path, alive, stale });
  }
  return result.sort((left, right) => left.record.pid - right.record.pid);
}

export async function stopMcpProcesses(context: {
  home: string;
  options: { timeoutMs: number; force: boolean };
  log: (message: string) => void;
}): Promise<void> {
  const live = () =>
    listMcpProcesses(context.home, { verifyAll: true }).filter(
      (item) => item.alive,
    );
  const deadline = Date.now() + context.options.timeoutMs;
  while (Date.now() < deadline) {
    if (listMcpProcesses(context.home).every((item) => !item.alive)) return;
    await sleep(400);
  }
  const remaining = live();
  if (!remaining.length) return;
  if (!context.options.force)
    throw new Error(
      `仍有 ${remaining.length} 个 MCP 进程运行（PID ${remaining.map((item) => item.record.pid).join(", ")}）。关闭客户端后重试，或使用 --force 强制结束`,
    );
  for (const { record } of remaining) {
    // 等待期间 PID 也可能退出、被复用；在发送结束命令前重新验证。
    if (!isProcessAlive(record.pid)) continue;
    const match = matchesMcpProcess(record, processIdentity(record.pid));
    if (match === false || !isProcessAlive(record.pid)) continue;
    if (match !== true || record.pid === process.pid)
      throw new Error(
        `无法核验 MCP 进程 ${record.pid} 的身份，未强制结束；请关闭对应 MCP 客户端后重试`,
      );
    context.log(
      `强制结束已核验的 MCP 进程 ${record.pid}（v${record.version}）`,
    );
    if (process.platform === "win32") {
      const result = spawnSync(
        join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(record.pid), "/T", "/F"],
        { windowsHide: true, encoding: "utf8", timeout: 5000 },
      );
      if ((result.error || result.status !== 0) && isProcessAlive(record.pid))
        throw new Error(
          `无法结束 MCP 进程 ${record.pid}：${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `taskkill 退出码 ${result.status}`}。请在对应 MCP 客户端中断开连接后重试`,
        );
    } else {
      try {
        process.kill(record.pid, "SIGKILL");
      } catch (error) {
        if (isProcessAlive(record.pid)) throw error;
      }
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const running = live();
    if (!running.length) return;
    await sleep(150);
  }
  throw new Error(
    `强制结束后仍有 MCP 进程存活（PID ${live()
      .map((item) => item.record.pid)
      .join(", ")}）；客户端可能重新拉起了进程，请先断开 MCP 连接`,
  );
}
