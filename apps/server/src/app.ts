import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import Database from "better-sqlite3";
import { ZodError, z } from "zod";
import { StageWorkspaceService } from "./services/stage-workspace.js";
import { RequirementFileService } from "./services/requirement-files.js";
import { IssueService } from "./services/issues.js";
import { ArtifactService } from "./services/artifacts.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultPaths, ensurePaths, projectRoot, allowSystemOpen } from "./config/index.js";
import { migrate, SCHEMA_VERSION } from "./db/migrate.js";
import { RequirementService, DomainError } from "./services/requirements.js";
import {
  AuthService,
  parseAuthCookie,
  serializeAuthCookie,
  serializeClearAuthCookie,
} from "./services/auth.js";
import { stages } from "@superpm/shared";

// 认证中间件写入的当前用户 ID（由 Token 校验产生）
declare module "fastify" {
  interface FastifyRequest {
    authUserId?: number;
  }
}

export interface CreateAppOptions {
  databasePath?: string;
  workspacePath?: string;
  logger?: boolean;
  serveWeb?: boolean;
}
// 登录与改密请求体校验
const loginSchema = z
  .object({
    username: z.string().trim().min(1, "请输入账号").max(100),
    password: z.string().min(1, "请输入密码").max(200),
  })
  .strict();
const changePasswordSchema = z
  .object({
    oldPassword: z.string().min(1, "请输入原密码").max(200),
    newPassword: z
      .string()
      .min(6, "新密码至少 6 位")
      .max(100, "新密码最多 100 位"),
  })
  .strict();
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
    migrate(db, undefined, paths.workspacePath);
  } catch (error) {
    db.close();
    throw error;
  }
  const service = new RequirementService(db);
  const authService = new AuthService(db);
  authService.ensureSeed();
  const workspaceService = new StageWorkspaceService(
    db,
    paths.workspacePath,
    service,
  );
  const fileService = new RequirementFileService(
    db,
    paths.workspacePath,
    service,
  );
  const issueService = new IssueService(db, service, paths.workspacePath);
  const artifactService = new ArtifactService(db, paths.workspacePath, service);
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
  // 认证中间件：除公开端点外，全部 /api/* 均需有效会话 Cookie
  const publicApiPaths = new Set(["/api/health", "/api/system", "/api/auth/login"]);
  // 编辑器内容以 <img src="/api/..."> 引用阶段工作区图片，图片 raw 读取保持公开
  const publicImagePattern = /^\/api\/requirements\/\d+\/images\/[^/]+$/;
  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0];
    if (!pathname.startsWith("/api/")) return;
    if (publicApiPaths.has(pathname) || publicImagePattern.test(pathname)) return;
    const token = parseAuthCookie(request.headers.cookie);
    const userId = token ? authService.verifyToken(token) : null;
    if (!userId)
      return reply.status(401).send({
        error: { code: "UNAUTHORIZED", message: "未登录或登录已过期，请重新登录" },
      });
    request.authUserId = userId;
  });
  app.get("/api/system", async () => ({
    version,
    ...paths,
    schemaVersion: SCHEMA_VERSION,
    systemOpenAvailable: allowSystemOpen,
    modules: [
      { key: "requirements", name: "需求管理", status: "available" },
      {
        key: "issues",
        name: roadmap.issues,
        status: "available",
      },
      ...Object.entries(roadmap)
        .filter(([key]) => key !== "issues")
        .map(([key, name]) => ({
          key,
          name,
          status: "planned",
        })),
    ],
  }));
  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const { user, token } = authService.login(body.username, body.password);
    reply.header(
      "set-cookie",
      serializeAuthCookie(token, authService.tokenMaxAgeSeconds),
    );
    return user;
  });
  app.get("/api/auth/me", async (request) =>
    authService.getUser(request.authUserId as number),
  );
  app.post("/api/auth/change-password", async (request) => {
    const body = changePasswordSchema.parse(request.body);
    authService.changePassword(
      request.authUserId as number,
      body.oldPassword,
      body.newPassword,
    );
    return { ok: true };
  });
  app.post("/api/auth/logout", async (_request, reply) => {
    reply.header("set-cookie", serializeClearAuthCookie());
    return { ok: true };
  });
  app.get("/api/requirements", async (request) =>
    service.list(request.query ?? {}),
  );
  app.post("/api/requirements", async (request, reply) => {
    const created = service.create(request.body);
    // 新建需求立即初始化需求记忆模板（文档 4.3）；磁盘异常不阻断建需，仅记录日志
    try {
      artifactService.ensureMemory(created.id);
    } catch (error) {
      app.log.error(error, "初始化需求记忆失败");
    }
    return reply.status(201).send(created);
  });
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
  app.get<{ Params: { id: string } }>(
    "/api/requirements/:id/relations",
    async (request) => service.relations(parseId(request.params.id)),
  );
  const fileListQuery = z.object({
    phase: z
      .union([z.enum(stages), z.literal("all")])
      .default("analysis"),
    all: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  });
  app.get<{ Params: { id: string } }>(
    "/api/requirements/:id/files",
    async (request) => {
      const query = fileListQuery.parse(request.query ?? {});
      return fileService.list(
        parseId(request.params.id),
        query.phase,
        query.all,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/files",
    async (request, reply) =>
      reply
        .status(201)
        .send(fileService.create(parseId(request.params.id), request.body)),
  );
  app.get<{ Params: { id: string; fileId: string } }>(
    "/api/requirements/:id/files/:fileId/content",
    async (request) =>
      fileService.content(
        parseId(request.params.id),
        parseId(request.params.fileId),
      ),
  );
  app.put<{ Params: { id: string; fileId: string } }>(
    "/api/requirements/:id/files/:fileId/content",
    async (request) =>
      fileService.saveContent(
        parseId(request.params.id),
        parseId(request.params.fileId),
        request.body,
      ),
  );
  app.get<{ Params: { id: string; fileId: string } }>(
    "/api/requirements/:id/files/:fileId/raw",
    async (request, reply) => {
      const raw = fileService.raw(
        parseId(request.params.id),
        parseId(request.params.fileId),
      );
      return reply
        .header("X-Content-Type-Options", "nosniff")
        .type(raw.mime)
        .send(raw.data);
    },
  );
  // 本地默认程序打开（补充文档 5.4）：路由层与服务层双重开关约束
  app.post<{ Params: { id: string; fileId: string } }>(
    "/api/requirements/:id/files/:fileId/open",
    async (request, reply) => {
      if (!allowSystemOpen)
        return reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "本地程序打开功能未启用（需设置 SUPERPM_ALLOW_SYSTEM_OPEN=1）",
          },
        });
      fileService.openAsset(
        parseId(request.params.id),
        parseId(request.params.fileId),
      );
      return reply.status(204).send();
    },
  );
  app.patch<{ Params: { id: string; fileId: string } }>(
    "/api/requirements/:id/files/:fileId",
    async (request) =>
      fileService.update(
        parseId(request.params.id),
        parseId(request.params.fileId),
        request.body,
      ),
  );
  app.delete<{ Params: { id: string; fileId: string } }>(
    "/api/requirements/:id/files/:fileId",
    async (request, reply) => {
      fileService.remove(
        parseId(request.params.id),
        parseId(request.params.fileId),
      );
      return reply.status(204).send();
    },
  );
  const issueListQuery = z.object({
    phase: z.enum(["design", "development", "testing"]).optional(),
    status: z
      .enum(["pending", "processing", "testing", "resolved"])
      .optional(),
  });
  app.get<{ Params: { id: string } }>(
    "/api/requirements/:id/issues",
    async (request) => {
      const query = issueListQuery.parse(request.query ?? {});
      return issueService.list(
        parseId(request.params.id),
        query.phase,
        query.status,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/issues",
    async (request, reply) =>
      reply
        .status(201)
        .send(issueService.create(parseId(request.params.id), request.body)),
  );
  app.get<{ Params: { id: string; issueId: string } }>(
    "/api/requirements/:id/issues/:issueId",
    async (request) =>
      issueService.detail(
        parseId(request.params.id),
        parseId(request.params.issueId),
      ),
  );
  app.patch<{ Params: { id: string; issueId: string } }>(
    "/api/requirements/:id/issues/:issueId",
    async (request) =>
      issueService.update(
        parseId(request.params.id),
        parseId(request.params.issueId),
        request.body,
      ),
  );
  // 问题正文（md 文件）直读/直写：面板自动保存走 PATCH 更新，此端点供外部工具与同步使用
  app.get<{ Params: { id: string; issueId: string } }>(
    "/api/requirements/:id/issues/:issueId/description",
    async (request) =>
      issueService.getDescription(
        parseId(request.params.id),
        parseId(request.params.issueId),
      ),
  );
  app.put<{ Params: { id: string; issueId: string } }>(
    "/api/requirements/:id/issues/:issueId/description",
    async (request) =>
      issueService.saveDescription(
        parseId(request.params.id),
        parseId(request.params.issueId),
        request.body,
      ),
  );
  app.post<{ Params: { id: string; issueId: string } }>(
    "/api/requirements/:id/issues/:issueId/activities",
    async (request) =>
      issueService.comment(
        parseId(request.params.id),
        parseId(request.params.issueId),
        request.body,
      ),
  );
  app.delete<{ Params: { id: string; issueId: string } }>(
    "/api/requirements/:id/issues/:issueId",
    async (request, reply) => {
      issueService.remove(
        parseId(request.params.id),
        parseId(request.params.issueId),
      );
      return reply.status(204).send();
    },
  );
  // 问题与产出物关联
  app.get<{ Params: { id: string; issueId: string } }>(
    "/api/requirements/:id/issues/:issueId/assets",
    async (request) =>
      issueService.listAssets(
        parseId(request.params.id),
        parseId(request.params.issueId),
      ),
  );
  app.post<{ Params: { id: string; issueId: string } }>(
    "/api/requirements/:id/issues/:issueId/assets",
    async (request, reply) =>
      reply
        .status(201)
        .send(
          issueService.linkAsset(
            parseId(request.params.id),
            parseId(request.params.issueId),
            request.body,
          ),
        ),
  );
  app.delete<{ Params: { id: string; issueId: string; assetId: string } }>(
    "/api/requirements/:id/issues/:issueId/assets/:assetId",
    async (request, reply) => {
      issueService.unlinkAsset(
        parseId(request.params.id),
        parseId(request.params.issueId),
        parseId(request.params.assetId),
      );
      return reply.status(204).send();
    },
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
  // ===== 需求知识库（artifact_nodes / artifact_links，迁移 0007；文档管理 tab 使用）=====
  app.get<{ Params: { id: string } }>(
    "/api/requirements/:id/artifacts",
    async (request) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const parentIdRaw = typeof query.parentId === "string" ? query.parentId : "";
      const parentId = /^[1-9]\d*$/.test(parentIdRaw) ? Number(parentIdRaw) : null;
      const keyword = typeof query.q === "string" ? query.q.slice(0, 200) : "";
      return artifactService.listNodes(parseId(request.params.id), parentId, keyword);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/artifacts/folders",
    async (request, reply) =>
      reply
        .status(201)
        .send(artifactService.createFolder(parseId(request.params.id), request.body)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/artifacts/files",
    async (request, reply) =>
      reply
        .status(201)
        .send(artifactService.createFile(parseId(request.params.id), request.body)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/artifacts/refresh",
    async (request) =>
      artifactService.refreshDirectory(parseId(request.params.id), request.body ?? {}),
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/artifacts/links",
    async (request, reply) =>
      reply
        .status(201)
        .send(artifactService.createLink(parseId(request.params.id), request.body)),
  );
  app.patch<{ Params: { linkId: string } }>(
    "/api/artifacts/links/:linkId",
    async (request) =>
      artifactService.updateLink(parseId(request.params.linkId), request.body),
  );
  app.delete<{ Params: { linkId: string } }>(
    "/api/artifacts/links/:linkId",
    async (request, reply) => {
      artifactService.deleteLink(parseId(request.params.linkId));
      return reply.status(204).send();
    },
  );
  app.get<{ Params: { nodeId: string } }>(
    "/api/artifacts/nodes/:nodeId",
    async (request) => artifactService.getNodeDetails(parseId(request.params.nodeId)),
  );
  app.patch<{ Params: { nodeId: string } }>(
    "/api/artifacts/nodes/:nodeId",
    async (request) =>
      artifactService.renameNode(parseId(request.params.nodeId), request.body),
  );
  app.post<{ Params: { nodeId: string } }>(
    "/api/artifacts/nodes/:nodeId/move",
    async (request) =>
      artifactService.moveNode(parseId(request.params.nodeId), request.body),
  );
  app.delete<{ Params: { nodeId: string } }>(
    "/api/artifacts/nodes/:nodeId",
    async (request, reply) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const recursive = query.recursive === "1" || query.recursive === "true";
      artifactService.deleteNode(parseId(request.params.nodeId), recursive);
      return reply.status(204).send();
    },
  );
  app.get<{ Params: { nodeId: string } }>(
    "/api/artifacts/nodes/:nodeId/content",
    async (request) => artifactService.readText(parseId(request.params.nodeId)),
  );
  app.put<{ Params: { nodeId: string } }>(
    "/api/artifacts/nodes/:nodeId/content",
    async (request) =>
      artifactService.saveText(parseId(request.params.nodeId), request.body),
  );
  // raw 读取：图片预览 / PDF 预览 / 下载（download=1 时按附件返回）
  app.get<{ Params: { nodeId: string } }>(
    "/api/artifacts/nodes/:nodeId/raw",
    async (request, reply) => {
      const raw = artifactService.raw(parseId(request.params.nodeId));
      const query = (request.query ?? {}) as Record<string, unknown>;
      if (query.download === "1" || query.download === "true") {
        reply.header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(raw.fileName)}`,
        );
      }
      return reply
        .header("X-Content-Type-Options", "nosniff")
        .type(raw.mime)
        .send(raw.data);
    },
  );
  // 本地默认程序打开（复用 SUPERPM_ALLOW_SYSTEM_OPEN 总开关）
  app.post<{ Params: { nodeId: string } }>(
    "/api/artifacts/nodes/:nodeId/open",
    async (request, reply) => {
      if (!allowSystemOpen)
        return reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "本地程序打开功能未启用（需设置 SUPERPM_ALLOW_SYSTEM_OPEN=1）",
          },
        });
      artifactService.openSystem(parseId(request.params.nodeId));
      return reply.status(204).send();
    },
  );
  // 需求记忆：读取（懒初始化）与元数据刷新
  app.get<{ Params: { id: string } }>(
    "/api/requirements/:id/memory",
    async (request) => artifactService.ensureMemory(parseId(request.params.id)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/memory/refresh",
    async (request) => artifactService.refreshMemory(parseId(request.params.id)),
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
