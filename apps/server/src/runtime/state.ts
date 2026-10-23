import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface UpdateLock {
  pid: number;
  createdAt: string;
  reason?: string;
  version?: string;
}

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

export interface ServerRuntimeRecord {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  schemaVersion: number;
  shutdownToken: string;
}

export const MCP_HEARTBEAT_MS = 5000;
export const MCP_STALE_MS = 30000;
const INVALID_LOCK_STALE_MS = 30 * 60 * 1000;

export function runtimeRoot(home: string) {
  return join(home, "runtime");
}
export function updateLockPath(home: string) {
  return join(runtimeRoot(home), "update.lock");
}
export function mcpRegistryDir(home: string) {
  return join(runtimeRoot(home), "mcp");
}
export function mcpRecordPath(home: string, pid: number) {
  return join(mcpRegistryDir(home), `${pid}.json`);
}
export function serverStatePath(home: string) {
  return join(runtimeRoot(home), "server.json");
}

export function ensureRuntimeRoot(home: string) {
  const root = runtimeRoot(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(mcpRegistryDir(home), { recursive: true, mode: 0o700 });
  return root;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeJsonAtomic(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

function parseJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 读取更新锁原值；不会自动清理。供更新器诊断与释放使用。 */
export function readUpdateLock(home: string): UpdateLock | null {
  const lock = parseJsonFile<UpdateLock>(updateLockPath(home));
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return null;
  return lock;
}

/**
 * 返回仍然有效的更新锁。持有进程已退出或文件损坏超过 30 分钟时视为残留并清理。
 */
export function activeUpdateLock(home: string): UpdateLock | null {
  const path = updateLockPath(home);
  const lock = readUpdateLock(home);
  if (!lock) {
    try {
      const stat = statSync(path);
      if (Date.now() - stat.mtimeMs < INVALID_LOCK_STALE_MS) {
        return {
          pid: 0,
          createdAt: new Date(stat.mtimeMs).toISOString(),
          reason: "锁文件格式无效",
        };
      }
      rmSync(path, { force: true });
    } catch {
      // 文件不存在或不可读：视为无锁
    }
    return null;
  }
  if (isProcessAlive(lock.pid)) return lock;
  rmSync(path, { force: true });
  return null;
}

export function acquireUpdateLock(
  home: string,
  options: { reason?: string; version?: string; pid?: number } = {},
): UpdateLock {
  ensureRuntimeRoot(home);
  const path = updateLockPath(home);
  const record: UpdateLock = {
    pid: options.pid ?? process.pid,
    createdAt: new Date().toISOString(),
    reason: options.reason,
    version: options.version,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(record, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = activeUpdateLock(home);
      if (existing)
        throw new Error(
          `已有更新正在进行（PID ${existing.pid}，开始于 ${existing.createdAt}）`,
        );
    }
  }
  throw new Error("无法创建更新锁");
}

/** 只允许锁持有者释放；force 仅供更新器回滚或人工恢复使用。 */
export function releaseUpdateLock(home: string, force = false) {
  const lock = readUpdateLock(home);
  if (!force && lock && lock.pid !== process.pid) return false;
  rmSync(updateLockPath(home), { force: true });
  return true;
}

export function registerMcpProcess(
  home: string,
  details: { version: string; schemaVersion: number; writeEnabled: boolean },
) {
  ensureRuntimeRoot(home);
  const record: McpProcessRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    version: details.version,
    schemaVersion: details.schemaVersion,
    writeEnabled: details.writeEnabled,
  };
  const path = mcpRecordPath(home, process.pid);
  writeJsonAtomic(path, record);
  let closed = false;
  const touch = () => {
    if (closed) return;
    record.heartbeatAt = new Date().toISOString();
    try {
      writeJsonAtomic(path, record);
    } catch {
      // 心跳失败不终止 MCP；更新器仍可通过进程存活与锁文件判断
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    rmSync(path, { force: true });
  };
  return { record, path, touch, close };
}

export function listMcpProcesses(home: string): McpProcessInfo[] {
  let names: string[];
  try {
    names = readdirSync(mcpRegistryDir(home));
  } catch {
    return [];
  }
  const result: McpProcessInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(mcpRegistryDir(home), name);
    const record = parseJsonFile<McpProcessRecord>(path);
    if (!record || !Number.isInteger(record.pid) || record.pid <= 0) continue;
    const alive = isProcessAlive(record.pid);
    const heartbeat = Date.parse(record.heartbeatAt);
    const stale =
      !alive ||
      !Number.isFinite(heartbeat) ||
      Date.now() - heartbeat > MCP_STALE_MS;
    result.push({ record, path, alive, stale });
  }
  return result.sort((left, right) => left.record.pid - right.record.pid);
}

export function unregisterMcpProcess(home: string, pid = process.pid) {
  rmSync(mcpRecordPath(home, pid), { force: true });
}

export function writeServerState(home: string, record: ServerRuntimeRecord) {
  ensureRuntimeRoot(home);
  writeJsonAtomic(serverStatePath(home), record);
}

export function readServerState(home: string): ServerRuntimeRecord | null {
  const record = parseJsonFile<ServerRuntimeRecord>(serverStatePath(home));
  if (
    !record ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.port !== "number" ||
    typeof record.shutdownToken !== "string"
  )
    return null;
  return record;
}

export function removeServerState(home: string, pid = process.pid) {
  const record = readServerState(home);
  if (record && record.pid !== pid) return;
  rmSync(serverStatePath(home), { force: true });
}
