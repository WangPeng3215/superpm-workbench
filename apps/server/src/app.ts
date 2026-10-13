import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import Database from "better-sqlite3";
import { ZodError, z } from "zod";
import { StageWorkspaceService } from "./services/stage-workspace.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultPaths, ensurePaths, projectRoot } from "./config/index.js";
import { migrate, SCHEMA_VERSION } from "./db/migrate.js";
import { RequirementService, DomainError } from "./services/requirements.js";

export interface CreateAppOptions {
  databasePath?: string;
  workspacePath?: string;
  logger?: boolean;
  serveWeb?: boolean;
}
const version = "0.1.0";
const roadmap = {
  files: "文件与版本",
  issues: "问题、决策与跟进",
  testing: "测试闭环",
  tasks: "每日任务",
  search: "全文检索与上下文",
  backup: "备份与恢复",
  mcp: "MCP 适配层",
};

export async function createApp(
  options: CreateAppOptions = {},
): Promise<FastifyInstance> {
  const defaults = defaultPaths();
  const databasePath = options.databasePath ?? defaults.databasePath;
  const paths = {
    databasePath:
      databasePath === ":memory:" ? databasePath : resolve(databasePath),
    workspacePath: resolve(options.workspacePath ?? defaults.workspacePath),
  };
  ensurePaths(paths.databasePath, paths.workspacePath);
  const db = new Database(paths.databasePath);
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const service = new RequirementService(db);
  const workspaceService = new StageWorkspaceService(
    db,
    paths.workspacePath,
    service,
  );
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 8 * 1024 * 1024,
  });
  app.addHook("onClose", async () => db.close());
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "请求参数校验失败",
          details: error.flatten(),
        },
      });
    }
    if (error instanceof DomainError)
      return reply
        .status(error.status)
        .send({ error: { code: error.code, message: error.message } });
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply.status(error.statusCode).send({
        error: { code: "VALIDATION_ERROR", message: "请求格式或内容无效" },
      });
    }
    app.log.error(error);
    return reply
      .status(500)
      .send({ error: { code: "INTERNAL_ERROR", message: "服务器内部错误" } });
  });
  app.get("/api/health", async () => ({ status: "ok", version }));
  app.get("/api/system", async () => ({
    version,
    ...paths,
    schemaVersion: SCHEMA_VERSION,
    modules: [
      { key: "requirements", name: "需求管理", status: "available" },
      ...Object.entries(roadmap).map(([key, name]) => ({
        key,
        name,
        status: "planned",
      })),
    ],
  }));
  app.get("/api/requirements", async (request) =>
    service.list(request.query ?? {}),
  );
  app.post("/api/requirements", async (request, reply) =>
    reply.status(201).send(service.create(request.body)),
  );
  app.get<{ Params: { id: string } }>(
    "/api/requirements/:id",
    async (request) => service.get(parseId(request.params.id)),
  );
  app.patch<{ Params: { id: string } }>(
    "/api/requirements/:id",
    async (request) => service.update(parseId(request.params.id), request.body),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/requirements/:id",
    async (request, reply) => {
      service.remove(parseId(request.params.id));
      return reply.status(204).send();
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/requirements/:id/history",
    async (request) => service.history(parseId(request.params.id)),
  );
  const webRoot = join(projectRoot, "apps", "web", "dist");
  app.get<{ Params: { id: string } }>(
    "/api/requirements/:id/workspace",
    async (request) => workspaceService.get(parseId(request.params.id)),
  );
  app.put<{ Params: { id: string } }>(
    "/api/requirements/:id/workspace",
    async (request) =>
      workspaceService.save(parseId(request.params.id), request.body),
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/images",
    async (request) =>
      workspaceService.upload(
        parseId(request.params.id),
        z
          .object({ data: z.string().max(7 * 1024 * 1024), mime: z.string() })
          .strict()
          .parse(request.body),
      ),
  );
  app.get<{ Params: { id: string; filename: string } }>(
    "/api/requirements/:id/images/:filename",
    async (request, reply) => {
      const image = workspaceService.image(
        parseId(request.params.id),
        request.params.filename,
      );
      return reply
        .header("X-Content-Type-Options", "nosniff")
        .type(image.mime)
        .send(image.data);
    },
  );
  const webAvailable =
    options.serveWeb && existsSync(join(webRoot, "index.html"));
  try {
    if (webAvailable) await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      const pathname = request.url.split("?")[0];
      if (pathname === "/api" || pathname.startsWith("/api/"))
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "接口不存在" } });
      if (
        webAvailable &&
        request.method === "GET" &&
        !pathname.split("/").pop()?.includes(".")
      )
        return reply.sendFile("index.html");
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "资源不存在" } });
    });
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
function parseId(value: string) {
  if (!/^[1-9]\d*$/.test(value))
    throw new DomainError("VALIDATION_ERROR", "需求 ID 无效");
  const id = Number(value);
  if (!Number.isSafeInteger(id))
    throw new DomainError("VALIDATION_ERROR", "需求 ID 无效");
  return id;
}
