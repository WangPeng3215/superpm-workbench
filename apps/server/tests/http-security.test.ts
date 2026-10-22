import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";
import { SCHEMA_VERSION } from "../src/db/migrate";

/** M4：本机路径属于敏感信息，未认证调用者不得读取 /api/system。 */
describe("HTTP 敏感端点鉴权", () => {
  let app: FastifyInstance;
  let directory: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-http-security-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
  });

  afterEach(async () => {
    if (app) await app.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("未登录访问 /api/system 返回 401，且不泄露数据库或工作区路径", async () => {
    const health = await app.inject("/api/health");
    expect(health.statusCode).toBe(200);

    const system = await app.inject("/api/system");
    expect(system.statusCode).toBe(401);
    expect(system.json()).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "未登录或登录已过期，请重新登录",
      },
    });
    expect(system.body).not.toContain(directory);
    expect(system.body).not.toContain("databasePath");
    expect(system.body).not.toContain("workspacePath");
  });

  it("登录后可读取系统信息", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "admin123" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
    const system = await app.inject({
      method: "GET",
      url: "/api/system",
      headers: { cookie },
    });
    expect(system.statusCode).toBe(200);
    expect(system.json()).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
    });
  });
});
