import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";

// 注册开关与账号状态：公网部署时不能默认把注册入口敞开给任何人。
describe("注册开关与账号状态", () => {
  let directory: string;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "superpm-register-"));
  });

  afterEach(async () => {
    delete process.env.SUPERPM_ALLOW_REGISTRATION;
    if (app) await app.close();
    app = undefined;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows 下文件句柄可能延迟释放
    }
  });

  function options() {
    return {
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    };
  }

  it("默认开放注册，并可通过配置端点告知前端", async () => {
    app = await createApp(options());
    const config = await app.inject({
      method: "GET",
      url: "/api/auth/config",
    });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toEqual({ registrationEnabled: true });

    const created = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "teammate", password: "secret123" },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      username: "teammate",
      isAdmin: false,
    });
  });

  it("关闭开关后注册接口直接拒绝", async () => {
    process.env.SUPERPM_ALLOW_REGISTRATION = "off";
    app = await createApp(options());
    const config = await app.inject({
      method: "GET",
      url: "/api/auth/config",
    });
    expect(config.json()).toEqual({ registrationEnabled: false });

    const created = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "blocked", password: "secret123" },
    });
    expect(created.statusCode).toBe(403);
    expect(created.json().error.code).toBe("REGISTRATION_DISABLED");
  });

  it("停用账号无法登录，且已签发的会话立即失效", async () => {
    app = await createApp(options());
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "leaver", password: "secret123" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const cookie = created.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");

    // 停用前会话可用
    const before = await app.inject({
      method: "GET",
      url: "/api/requirements",
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    // 直接改库：模拟管理员在数据库层停用账号
    const db = new Database(options().databasePath);
    db.prepare("UPDATE users SET status = 'disabled' WHERE username = ?").run(
      "leaver",
    );
    db.close();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "leaver", password: "secret123" },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe("ACCOUNT_DISABLED");

    // 旧 Cookie 也不再生效（每次请求都会重新校验账号状态）
    const after = await app.inject({
      method: "GET",
      url: "/api/requirements",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});
