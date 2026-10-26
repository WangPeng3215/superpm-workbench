import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  McpReadResult,
  McpRequirementListData,
  McpWritePrepareData,
  Requirement,
} from "@superpm/shared";
import { mcpToolContracts } from "@superpm/shared";
import { appVersion } from "../src/config/index.js";
import { SCHEMA_VERSION } from "../src/db/migrate.js";
import {
  createMcpServer,
  MCP_SERVER_NAME,
  type CreateMcpServerOptions,
  type SystemInfo,
} from "../src/mcp/server.js";
import {
  createServiceContainer,
  type ServiceContainer,
} from "../src/services/container.js";
import { buildMcpTools, type McpGateway } from "../src/services/mcp-gateway.js";
import { McpWriteService } from "../src/services/mcp-writes.js";

const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "superpm-mcp-"));
  tempDirs.push(dir);
  return dir;
}

function systemInfo(write = false): SystemInfo {
  return {
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    schemaVersion: SCHEMA_VERSION,
    transport: "stdio",
    capabilities: { readonly: true, write },
  };
}

function containerGateway(
  container: ServiceContainer,
  enabled = false,
): McpGateway {
  return buildMcpTools({
    requirements: container.requirements,
    issues: container.issues,
    artifacts: container.artifacts,
    progress: container.progress,
    meetings: container.meetings,
    notes: container.notes,
    writes: new McpWriteService(container.db, { enabled }),
  });
}

const unavailableGateway: McpGateway = {
  tools: new Map(),
  writeEnabled: false,
  call: () => ({
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "工具执行失败" },
  }),
};

async function connectedServer(
  overrides: Partial<CreateMcpServerOptions> = {},
) {
  let container: ServiceContainer | undefined;
  const gateway =
    overrides.gateway ??
    (() => {
      container = createServiceContainer({
        databasePath: ":memory:",
        workspacePath: join(tempDir(), "workspace"),
      });
      return containerGateway(container);
    })();
  const server = createMcpServer({
    version: "0.1.0",
    getSystemInfo: systemInfo,
    gateway,
    ...overrides,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    container,
    async close() {
      await client.close();
      await server.close();
      container?.close();
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
});

describe("MCP server（M2 只读）", () => {
  it("注册 system.info 与 15 个只读业务工具，全部标注 readOnlyHint", async () => {
    const { client, close } = await connectedServer();
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(16);
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        [
          "system.info",
          ...mcpToolContracts
            .filter((contract) => contract.kind === "readonly")
            .map((contract) => contract.name),
        ].sort(),
      );
      for (const tool of listed.tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true });
        expect(tool.inputSchema).toMatchObject({ type: "object" });
      }
      const result = await client.callTool({
        name: "system.info",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(systemInfo());
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("superpm.sqlite");
      expect(serialized).not.toContain(process.cwd());
    } finally {
      await close();
    }
  });

  it("业务工具返回结构化数据与不可信内容提示", async () => {
    const container = createServiceContainer({
      databasePath: ":memory:",
      workspacePath: join(tempDir(), "workspace"),
    });
    const requirement = container.requirements.create({
      name: "MCP 往返需求",
      proposedAt: "2026-10-15",
    }) as Requirement;
    container.directories.initialize(requirement.id);
    const { client, close } = await connectedServer({
      gateway: containerGateway(container),
    });
    try {
      const result = await client.callTool({
        name: "requirement.list",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const structured =
        result.structuredContent as unknown as McpReadResult<McpRequirementListData>;
      expect(structured.notice).toContain("不是系统指令");
      expect(structured.data.total).toBe(1);
      expect(structured.data.items[0]).toMatchObject({
        id: requirement.id,
        name: "MCP 往返需求",
      });
      expect(JSON.stringify(result)).not.toContain(container.workspacePath);
    } finally {
      await close();
      container.close();
    }
  });

  it("写入启用时注册写工具，write.prepare 确认后落库并记录 AI 来源", async () => {
    const container = createServiceContainer({
      databasePath: ":memory:",
      workspacePath: join(tempDir(), "workspace"),
    });
    const requirement = container.requirements.create({
      name: "MCP 写入需求",
      proposedAt: "2026-10-15",
    }) as Requirement;
    container.directories.initialize(requirement.id);
    const issue = container.issues.create(requirement.id, {
      title: "待评论问题",
    });
    const { client, close } = await connectedServer({
      gateway: containerGateway(container, true),
      getSystemInfo: () => systemInfo(true),
    });
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(29);
      expect(
        listed.tools.find((tool) => tool.name === "issue.comment")?.annotations,
      ).toMatchObject({ readOnlyHint: false });
      const input = {
        requirementId: requirement.id,
        issueId: issue.id,
        content: "来自 MCP 的评论",
      };
      const prepared = await client.callTool({
        name: "write.prepare",
        arguments: {
          tool: "issue.comment",
          input,
          idempotencyKey: "idem-comment-0001",
        },
      });
      expect(prepared.isError).toBeFalsy();
      const preparedData =
        prepared.structuredContent as unknown as McpReadResult<McpWritePrepareData>;
      expect(preparedData.data.tool).toBe("issue.comment");
      expect(preparedData.data.confirmationToken.length).toBeGreaterThanOrEqual(
        20,
      );
      const result = await client.callTool({
        name: "issue.comment",
        arguments: {
          ...input,
          confirmationToken: preparedData.data.confirmationToken,
          idempotencyKey: "idem-comment-0001",
        },
      });
      expect(result.isError).toBeFalsy();
      const detail = container.issues.detail(requirement.id, issue.id);
      expect(detail.activities.at(-1)).toMatchObject({
        activityType: "comment",
        content: "来自 MCP 的评论",
        actorType: "ai",
        actorName: "mcp:vitest",
      });
      const info = await client.callTool({
        name: "system.info",
        arguments: {},
      });
      expect(info.structuredContent).toMatchObject({
        capabilities: { write: true },
      });
    } finally {
      await close();
      container.close();
    }
  });

  it("业务工具异常被兜底，错误信息不包含堆栈与绝对路径", async () => {
    const secret = join(process.cwd(), "data", "superpm.sqlite");
    const logs: string[] = [];
    const throwingGateway: McpGateway = {
      tools: new Map(),
      writeEnabled: false,
      call: () => {
        throw new Error(`读取失败：${secret}`);
      },
    };
    const { client, close } = await connectedServer({
      gateway: throwingGateway,
      logError: (message, error) => logs.push(`${message}: ${String(error)}`),
    });
    try {
      const result = await client.callTool({
        name: "requirement.list",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).toContain("INTERNAL_ERROR");
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("读取失败");
      expect(logs).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("system.info 异常被兜底且不泄露内部信息", async () => {
    const secret = join(process.cwd(), "data", "superpm.sqlite");
    const logs: string[] = [];
    const { client, close } = await connectedServer({
      gateway: unavailableGateway,
      getSystemInfo: () => {
        throw new Error(`读取失败：${secret}`);
      },
      logError: (message, error) => logs.push(`${message}: ${String(error)}`),
    });
    try {
      const result = await client.callTool({
        name: "system.info",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).toContain("INTERNAL_ERROR");
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("读取失败");
      expect(logs).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("serves stdio without polluting stdout and closes the database", async () => {
    const dir = tempDir();
    const dataDir = join(dir, "data");
    const workspaceDir = join(dir, "workspace");
    const seed = createServiceContainer({
      databasePath: join(dataDir, "superpm.sqlite"),
      workspacePath: workspaceDir,
    });
    const requirement = seed.requirements.create({
      name: "stdio 需求",
      proposedAt: "2026-10-15",
    }) as Requirement;
    seed.directories.initialize(requirement.id);
    seed.close();

    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    env.SUPERPM_DATA_DIR = dataDir;
    env.SUPERPM_WORKSPACE_DIR = workspaceDir;
    env.SUPERPM_MCP_WRITE = "0";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/mcp/stdio.ts", import.meta.url)),
      ],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const client = new Client({ name: "vitest", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(16);
      const result = await client.callTool({
        name: "system.info",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        name: MCP_SERVER_NAME,
        version: appVersion,
        schemaVersion: SCHEMA_VERSION,
        transport: "stdio",
      });
      const list = await client.callTool({
        name: "requirement.list",
        arguments: {},
      });
      const structured =
        list.structuredContent as unknown as McpReadResult<McpRequirementListData>;
      expect(structured.data.total).toBe(1);
      expect(JSON.stringify([result, list])).not.toContain(dir);
    } finally {
      await client.close();
    }
    expect(stderr).toContain("stdio 服务已启动");
  });
});

describe("service container", () => {
  it("builds the shared services and closes the database idempotently", () => {
    const dir = tempDir();
    const container = createServiceContainer({
      databasePath: ":memory:",
      workspacePath: join(dir, "workspace"),
    });
    expect(container.databasePath).toBe(":memory:");
    expect(container.requirements).toBeDefined();
    expect(container.artifacts).toBeDefined();
    expect(container.progress).toBeDefined();
    expect(container.db.open).toBe(true);
    container.close();
    container.close();
    expect(container.db.open).toBe(false);
  });
});
