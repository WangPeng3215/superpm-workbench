import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SCHEMA_VERSION } from "../db/migrate.js";
import { createServiceContainer } from "../services/container.js";
import { buildMcpTools } from "../services/mcp-gateway.js";
import { McpWriteService } from "../services/mcp-writes.js";
import { createMcpServer, MCP_SERVER_NAME, type SystemInfo } from "./server.js";

// stdout 只属于 MCP 协议；所有日志必须走 stderr，否则 Harness 会解析失败。
function log(message: string, error?: unknown) {
  if (error === undefined) {
    console.error(`[superpm-mcp] ${message}`);
    return;
  }
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[superpm-mcp] ${message}`, detail);
}

function readVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch (error) {
    log("读取版本号失败，使用 0.0.0", error);
    return "0.0.0";
  }
}

const version = readVersion();

async function main() {
  const container = createServiceContainer();
  // 写入默认关闭；只有显式设置 SUPERPM_MCP_WRITE=1 才注册写工具。
  const writeEnabled = process.env.SUPERPM_MCP_WRITE === "1";
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
      writes,
    }),
    logError: log,
  });
  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
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
    }
    process.exit(exitCode);
  };
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
      `stdio 服务已启动，schema ${SCHEMA_VERSION}，写入${writeEnabled ? "已启用（需确认令牌）" : "未启用"}`,
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
