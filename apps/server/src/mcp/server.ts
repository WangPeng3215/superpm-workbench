import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mcpToolContracts, mcpWritePrepareInput } from "@superpm/shared";
import type { McpGateway } from "../services/mcp-gateway.js";

export const MCP_SERVER_NAME = "superpm";

export interface SystemInfo {
  name: string;
  version: string;
  schemaVersion: number;
  transport: "stdio";
  capabilities: {
    readonly: boolean;
    write: boolean;
  };
}

export interface CreateMcpServerOptions {
  version: string;
  getSystemInfo: () => SystemInfo;
  gateway: McpGateway;
  logError?: (message: string, error: unknown) => void;
}

const systemInfoSchema = {
  name: z.string(),
  version: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  transport: z.literal("stdio"),
  capabilities: z.object({
    readonly: z.boolean(),
    write: z.boolean(),
  }),
};

function toolError(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ error: { code, message } }) },
    ],
  };
}

/** MCP 客户端名称作为 AI 操作者标识；只保留安全字符并截断 */
function clientActorName(server: McpServer) {
  const raw = server.server.getClientVersion()?.name ?? "unknown";
  const safe = raw
    .replace(/[^\p{L}\p{N}_.:@ -]/gu, "")
    .trim()
    .slice(0, 80);
  return safe || "unknown";
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const logError =
    options.logError ??
    ((message: string, error: unknown) =>
      console.error(`[superpm-mcp] ${message}`, error));
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: options.version,
  });
  const runTool = async (
    name: string,
    input: unknown,
  ): Promise<CallToolResult> => {
    try {
      const result = options.gateway.call(name, input, {
        actorName: clientActorName(server),
      });
      if (!result.ok) return toolError(result.error.code, result.error.message);
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
        structuredContent: result.data as unknown as Record<string, unknown>,
      };
    } catch (error) {
      logError(`工具 ${name} 执行失败`, error);
      return toolError("INTERNAL_ERROR", "工具执行失败");
    }
  };
  server.registerTool(
    "system.info",
    {
      title: "系统信息",
      description:
        "返回 superPM MCP 服务的版本、数据库 schema 版本与能力开关，不包含本地路径。",
      outputSchema: systemInfoSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (): Promise<CallToolResult> => {
      try {
        const info = options.getSystemInfo();
        return {
          content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
          structuredContent: info as unknown as Record<string, unknown>,
        };
      } catch (error) {
        logError("system.info 执行失败", error);
        return toolError("INTERNAL_ERROR", "工具执行失败");
      }
    },
  );
  for (const contract of mcpToolContracts) {
    if (contract.kind === "mutating" && !options.gateway.writeEnabled) continue;
    server.registerTool(
      contract.name,
      {
        title: contract.name,
        description: contract.description,
        inputSchema: contract.input,
        annotations: {
          readOnlyHint: contract.kind === "readonly",
          destructiveHint: false,
          idempotentHint: contract.kind === "readonly",
          openWorldHint: false,
        },
      },
      async (input: unknown): Promise<CallToolResult> =>
        runTool(contract.name, input),
    );
  }
  if (options.gateway.writeEnabled) {
    server.registerTool(
      "write.prepare",
      {
        title: "申请写入确认令牌",
        description:
          "为写操作申请一次性确认令牌。令牌绑定工具、解析后的参数与 idempotencyKey，默认 5 分钟过期且只能使用一次；随后把 confirmationToken 传给对应的写工具。",
        inputSchema: mcpWritePrepareInput,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input: unknown): Promise<CallToolResult> =>
        runTool("write.prepare", input),
    );
  }
  return server;
}
