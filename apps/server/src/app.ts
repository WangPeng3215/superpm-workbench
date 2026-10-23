import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import fastifyStatic from "@fastify/static";
import { ZodError, z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  projectRoot,
  allowSystemOpen,
  appVersion,
  homePath,
  installRoot,
  isPackagedInstall,
} from "./config/index.js";
import { SCHEMA_VERSION } from "./db/migrate.js";
import { DomainError } from "./services/requirements.js";
import {
  createServiceContainer,
  type ServiceContainerOptions,
} from "./services/container.js";
import {
  createUpdateService,
  type UpdateServiceOptions,
} from "./services/updates.js";
import {
  parseAuthCookie,
  serializeAuthCookie,
  serializeClearAuthCookie,
} from "./services/auth.js";
import {
  artifactUploadMaxBytes,
  artifactUploadMaxLabel,
  stages,
  updateInstallRequestSchema,
} from "@superpm/shared";

// 认证中间件写入的当前用户 ID（由 Token 校验产生）
declare module "fastify" {
  interface FastifyRequest {
    authUserId?: number;
  }
}

export interface CreateAppOptions extends ServiceContainerOptions {
  logger?: FastifyServerOptions["logger"];
  serveWeb?: boolean;
  /** 更新器通过本机回环地址请求优雅停止时使用的一次性令牌 */
  shutdownToken?: string;
  onShutdownRequested?: () => void;
  /** 测试或嵌入场景覆盖更新服务配置 */
  update?: Partial<UpdateServiceOptions>;
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
const version = appVersion;
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
  const container = createServiceContainer(options);
  const {
    databasePath,
    workspacePath,
    requirements: service,
    auth: authService,
    directories,
    workspace: workspaceService,
    files: fileService,
    issues: issueService,
    artifacts: artifactService,
  } = container;
  const paths = { databasePath, workspacePath };
  const updates = createUpdateService({
    home: homePath,
    installRoot,
    appRoot: projectRoot,
    currentVersion: version,
    schemaVersion: SCHEMA_VERSION,
    isPackaged: isPackagedInstall,
    manifestUrl: process.env.SUPERPM_UPDATE_MANIFEST_URL,
    ...options.update,
  });
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 8 * 1024 * 1024,
  });
  // 文档上传以原始二进制提交，单独放宽到单文件上限；其它接口仍保持 8 MB
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: artifactUploadMaxBytes },
    (_request, body, done) => done(null, body),
  );
  app.addHook("onClose", async () => container.close());
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
      "code" in error &&
      error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
    )
      return reply.status(413).send({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: `单个文件不能超过 ${artifactUploadMaxLabel}`,
        },
      });
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
  app.get("/api/health", async (_request, reply) => {
    let database: "ok" | "error" = "ok";
    try {
      container.db.prepare("SELECT 1").get();
    } catch {
      database = "error";
    }
    if (database !== "ok") reply.status(503);
    return {
      status: database === "ok" ? "ok" : "degraded",
      version,
      schemaVersion: SCHEMA_VERSION,
      database,
      pid: process.pid,
    };
  });
  // 更新器停止服务的唯一 HTTP 入口：只接受回环地址与运行时目录中的一次性令牌。
  if (options.shutdownToken && options.onShutdownRequested) {
    const expected = Buffer.from(options.shutdownToken);
    app.post("/api/shutdown", async (request, reply) => {
      if (!isLoopbackAddress(request.socket.remoteAddress))
        return reply.status(403).send({
          error: { code: "FORBIDDEN", message: "仅允许本机停止服务" },
        });
      const provided = request.headers["x-superpm-shutdown-token"];
      if (
        typeof provided !== "string" ||
        Buffer.byteLength(provided) !== expected.length ||
        !timingSafeEqual(Buffer.from(provided), expected)
      )
        return reply.status(403).send({
          error: { code: "FORBIDDEN", message: "停止令牌无效" },
        });
      await reply.status(202).send({ ok: true });
      setImmediate(() => options.onShutdownRequested?.());
    });
  }
  // 认证中间件：除公开端点外，全部 /api/* 均需有效会话 Cookie
  const publicApiPaths = new Set([
    "/api/health",
    "/api/auth/login",
    "/api/shutdown",
  ]);
  // 编辑器内容以 <img src="/api/..."> 引用阶段工作区图片，图片 raw 读取保持公开
  const publicImagePattern = /^\/api\/requirements\/\d+\/images\/[^/]+$/;
  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0];
    if (!pathname.startsWith("/api/")) return;
    if (publicApiPaths.has(pathname) || publicImagePattern.test(pathname))
      return;
    const token = parseAuthCookie(request.headers.cookie);
    const userId = token ? authService.verifyToken(token) : null;
    if (!userId)
      return reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "未登录或登录已过期，请重新登录",
        },
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
      { key: "updates", name: "版本与更新", status: "available" },
      ...Object.entries(roadmap)
        .filter(([key]) => key !== "issues")
        .map(([key, name]) => ({
          key,
          name,
          status: "planned",
        })),
    ],
  }));
  app.get("/api/update/status", async () => updates.status());
  app.post("/api/update/check", async () => updates.check());
  app.post("/api/update/install", async (request, reply) => {
    const body = updateInstallRequestSchema.parse(request.body);
    return reply.status(202).send(updates.startInstall(body));
  });
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
    // 新建需求立即初始化物理目录与默认资源（文档 §12.1/§12.5）。
    // 初始化失败不阻断建需：状态落库为 failed 并记录阶段，前端可见并可重试。
    try {
      directories.initialize(created.id);
    } catch (error) {
      app.log.error(error, "初始化需求目录失败");
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
    phase: z.union([z.enum(stages), z.literal("all")]).default("analysis"),
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
            message:
              "本地程序打开功能未启用（需设置 SUPERPM_ALLOW_SYSTEM_OPEN=1）",
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
    stage: z.enum(["analysis", "design", "development", "testing"]).optional(),
    status: z
      .enum(["pending", "to_confirm", "processing", "resolved", "wont_fix"])
      .optional(),
    type: z
      .enum(["analysis", "ui", "development", "testing", "other"])
      .optional(),
    q: z.string().trim().max(200).optional(),
  });
  app.get<{ Params: { id: string } }>(
    "/api/requirements/:id/issues",
    async (request) =>
      issueService.list(
        parseId(request.params.id),
        issueListQuery.parse(request.query ?? {}),
      ),
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
  // legacy：阶段工作区 JSON 接口，Web 已不再调用；进度以需求字段、阶段历史与问题/产出物统计为准。
  // 图片接口仍在用（富文本描述上传），与旧工作区 JSON 共用 workspaceService。
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
      const parentIdRaw =
        typeof query.parentId === "string" ? query.parentId : "";
      const parentId = /^[1-9]\d*$/.test(parentIdRaw)
        ? Number(parentIdRaw)
        : null;
      const keyword = typeof query.q === "string" ? query.q.slice(0, 200) : "";
      return artifactService.listNodes(
        parseId(request.params.id),
        parentId,
        keyword,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/artifacts/folders",
    async (request, reply) =>
      reply
        .status(201)
        .send(
          artifactService.createFolder(
            parseId(request.params.id),
            request.body,
          ),
        ),
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/artifacts/files",
    async (request, reply) =>
      reply
        .status(201)
        .send(
          artifactService.createFile(parseId(request.params.id), request.body),
        ),
  );
  // 本地文件上传：原始二进制 + 查询参数携带目标目录与文件名
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/artifacts/upload",
    { bodyLimit: artifactUploadMaxBytes },
    async (request, reply) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const parentIdRaw =
        typeof query.parentId === "string" ? query.parentId : "";
      if (parentIdRaw && !/^[1-9]\d*$/.test(parentIdRaw))
        throw new DomainError("VALIDATION_ERROR", "父目录参数无效");
      const name = typeof query.name === "string" ? query.name : "";
      if (!name) throw new DomainError("VALIDATION_ERROR", "缺少文件名");
      if (!Buffer.isBuffer(request.body))
        throw new DomainError("VALIDATION_ERROR", "缺少文件内容");
      return reply
        .status(201)
        .send(
          artifactService.uploadFile(
            parseId(request.params.id),
            parentIdRaw ? Number(parentIdRaw) : null,
            name,
            request.body,
          ),
        );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/artifacts/refresh",
    async (request) =>
      artifactService.refreshDirectory(
        parseId(request.params.id),
        request.body ?? {},
      ),
  );
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/artifacts/links",
    async (request, reply) =>
      reply
        .status(201)
        .send(
          artifactService.createLink(parseId(request.params.id), request.body),
        ),
  );
  app.patch<{ Params: { linkId: string } }>(
    "/api/artifacts/links/:linkId",
    async (request) =>
      artifactService.updateLink(parseId(request.params.linkId), request.body),
  );
  app.patch<{ Params: { linkId: string } }>(
    "/api/artifacts/links/:linkId/final",
    async (request) =>
      artifactService.setLinkFinal(
        parseId(request.params.linkId),
        request.body,
      ),
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
    async (request) =>
      artifactService.getNodeDetails(parseId(request.params.nodeId)),
  );
  app.patch<{ Params: { nodeId: string } }>(
    "/api/artifacts/nodes/:nodeId",
    async (request) =>
      artifactService.renameNode(parseId(request.params.nodeId), request.body),
  );
  app.patch<{ Params: { nodeId: string } }>(
    "/api/artifacts/nodes/:nodeId/final",
    async (request) =>
      artifactService.setNodeFinal(
        parseId(request.params.nodeId),
        request.body,
      ),
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
  // 打开物理位置：目录与 reveal 始终可用；文件默认程序打开由服务层总开关约束
  app.post<{ Params: { nodeId: string }; Querystring: { reveal?: string } }>(
    "/api/artifacts/nodes/:nodeId/open",
    async (request, reply) => {
      artifactService.openSystem(parseId(request.params.nodeId), {
        reveal: request.query.reveal === "1",
      });
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
    async (request) =>
      artifactService.refreshMemory(parseId(request.params.id)),
  );
  // ===== 需求物理目录初始化与系统级资源（文档 §12）=====
  // 初始化状态：目录名、初始化结果、失败阶段与磁盘缺失资源（供前端提示与重试入口）
  app.get<{ Params: { id: string } }>(
    "/api/requirements/:id/directory",
    async (request) => directories.state(parseId(request.params.id)),
  );
  // 重新初始化：幂等，已存在的文件与目录不覆盖
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/directory/initialize",
    async (request) => directories.initialize(parseId(request.params.id)),
  );
  // 修复默认结构：显式补建缺失的系统级资源与默认目录（普通刷新不会重建）
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/directory/repair",
    async (request) => directories.repair(parseId(request.params.id)),
  );
  // 打开物理目录：relativePath 为空时打开需求根目录，便于从当前浏览位置直达磁盘
  app.post<{
    Params: { id: string };
    Body: { relativePath?: string } | undefined;
  }>("/api/requirements/:id/directory/open", async (request, reply) => {
    artifactService.openDirectory(
      parseId(request.params.id),
      request.body?.relativePath ?? "",
    );
    return reply.status(204).send();
  });
  // 图片上传：落盘到需求根目录 images/，返回按文档目录计算的相对路径（文档 §12.4）
  app.post<{ Params: { id: string } }>(
    "/api/requirements/:id/artifacts/images",
    async (request, reply) =>
      reply
        .status(201)
        .send(
          artifactService.uploadImage(parseId(request.params.id), request.body),
        ),
  );
  // 图片读取：按文档相对路径解析（../images/a.png），供 Markdown 图片预览
  app.get<{
    Params: { id: string };
    Querystring: { path?: string; nodeId?: string };
  }>("/api/requirements/:id/artifacts/image", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const relativePath = typeof query.path === "string" ? query.path : "";
    if (!relativePath)
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "缺少图片路径" },
      });
    const nodeId =
      typeof query.nodeId === "string" && query.nodeId
        ? parseId(query.nodeId)
        : null;
    const image = artifactService.imageByPath(
      parseId(request.params.id),
      nodeId,
      relativePath,
    );
    return reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, max-age=300")
      .type(image.mime)
      .send(image.data);
  });
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
function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}
function parseId(value: string) {
  if (!/^[1-9]\d*$/.test(value))
    throw new DomainError("VALIDATION_ERROR", "需求 ID 无效");
  const id = Number(value);
  if (!Number.isSafeInteger(id))
    throw new DomainError("VALIDATION_ERROR", "需求 ID 无效");
  return id;
}
