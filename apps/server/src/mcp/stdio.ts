import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  activeOperationLock,
  resolveConfigDir,
} from "@superpm/shared/data-root";
import { appHome, appVersion, homePath } from "../config/index.js";
import { prepareHomeIfConfigured } from "../config/home-migration.js";
import { appendFileLog } from "../config/logging.js";
import { SCHEMA_VERSION } from "../db/migrate.js";
import {
  activeUpdateLock,
  MCP_HEARTBEAT_MS,
  registerMcpProcess,
} from "../runtime/state.js";
import { createServiceContainer } from "../services/container.js";
import { buildMcpTools } from "../services/mcp-gateway.js";
import { McpWriteService } from "../services/mcp-writes.js";
import { createMcpServer, MCP_SERVER_NAME, type SystemInfo } from "./server.js";

// stdout 只属于 MCP 协议；所有日志必须走 stderr，否则 Harness 会解析失败。
function log(message: string, error?: unknown) {
  let detail = "";
  if (error !== undefined)
    detail = ` ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }`;
  console.error(`[superpm-mcp] ${message}${detail}`);
  appendFileLog(appHome, "mcp.log", `${message}${detail}`);
}

const version = appVersion;

async function main() {
  try {
    await prepareHomeIfConfigured();
  } catch (error) {
    log("数据迁移失败，MCP 未启动；旧数据未改动", error);
    process.exit(1);
  }
  const lock = activeUpdateLock(homePath);
  if (lock) {
    log(
      `检测到更新锁（PID ${lock.pid}，开始于 ${lock.createdAt}），本次 MCP 连接已拒绝；更新完成后再重试`,
    );
    process.exit(0);
  }
  const moveLock = activeOperationLock(resolveConfigDir());
  if (moveLock) {
    log(
      `检测到数据目录迁移（任务 ${moveLock.jobId}，PID ${moveLock.pid}），本次 MCP 连接已拒绝；迁移完成后再重试`,
    );
    process.exit(0);
  }
  const container = createServiceContainer();
  // 写入默认关闭；只有显式设置 SUPERPM_MCP_WRITE=1 才注册写工具。
  const writeEnabled = process.env.SUPERPM_MCP_WRITE === "1";
  const registration = registerMcpProcess(homePath, {
    version,
    schemaVersion: SCHEMA_VERSION,
    writeEnabled,
  });
  process.once("exit", registration.close);
  const systemInfo = (): SystemInfo => ({
    name: MCP_SERVER_NAME,
    version,
    schemaVersion: SCHEMA_VERSION,
    transport: "stdio",
    capabilities: { readonly: true, write: writeEnabled },
  });
  const writes = new McpWriteService(container.db, { enabled: writeEnabled });
  const server = createMcpServer({
    version,
    getSystemInfo: systemInfo,
    gateway: buildMcpTools({
      requirements: container.requirements,
      issues: container.issues,
      artifacts: container.artifacts,
      progress: container.progress,
      meetings: container.meetings,
      notes: container.notes,
      writes,
    }),
    logError: log,
  });
  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    log(`正在关闭（${reason}）`);
    try {
      await server.close();
    } catch (error) {
      log("关闭 MCP 连接失败", error);
    }
    try {
      container.close();
    } catch (error) {
      log("关闭数据库失败", error);
      exitCode = 1;
    } finally {
      registration.close();
    }
    process.exit(exitCode);
  };
  // 更新锁出现后必须在 15 秒宽限期内主动退出，避免更新器强制结束进程。
  const heartbeat = setInterval(() => {
    const active = activeUpdateLock(homePath);
    if (active) {
      void shutdown(`检测到更新锁 PID ${active.pid}`, 0);
      return;
    }
    const moving = activeOperationLock(resolveConfigDir());
    if (moving) {
      void shutdown(`检测到数据目录迁移（任务 ${moving.jobId}）`, 0);
      return;
    }
    registration.touch();
  }, MCP_HEARTBEAT_MS);
  heartbeat.unref();
  transport.onclose = () => {
    void shutdown("客户端断开连接", 0);
  };
  process.once("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });
  try {
    await server.connect(transport);
    log(
      `stdio 服务已启动，schema ${SCHEMA_VERSION}，写入${writeEnabled ? "已启用（受确认写入需令牌，低风险文本写入自动审计）" : "未启用"}`,
    );
  } catch (error) {
    log("启动失败", error);
    container.close();
    process.exit(1);
  }
}

process.on("uncaughtException", (error) => log("未捕获异常", error));
process.on("unhandledRejection", (reason) =>
  log("未处理的 Promise 拒绝", reason),
);

void main().catch((error) => {
  log("服务异常退出", error);
  process.exit(1);
});
