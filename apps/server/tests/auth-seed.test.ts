import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";

// 服务器部署常直接暴露公网，首启口令必须可配：默认 admin123 只适合本机安装。
describe("种子账号口令", () => {
  let directory: string;
  let app: FastifyInstance | undefined;

  function options() {
    return {
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    };
  }

  async function login(password: string) {
    const target = app!;
    return target.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password },
    });
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "superpm-auth-seed-"));
  });

  afterEach(async () => {
    delete process.env.SUPERPM_ADMIN_PASSWORD;
    if (app) await app.close();
    app = undefined;
    // 启动即失败的用例里数据库句柄随进程存活，Windows 上删除会 EBUSY，交给系统回收
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("未配置环境变量时沿用默认口令 admin123", async () => {
    app = await createApp(options());
    expect((await login("admin123")).statusCode).toBe(200);
  });

  it("配置 SUPERPM_ADMIN_PASSWORD 后首启即用该口令，默认口令失效", async () => {
    process.env.SUPERPM_ADMIN_PASSWORD = "  Server-Pass-2026  ";
    app = await createApp(options());
    expect((await login("admin123")).statusCode).toBe(401);
    expect((await login("Server-Pass-2026")).statusCode).toBe(200);
  });

  it("配置过短时拒绝启动，而不是悄悄回退默认口令", async () => {
    process.env.SUPERPM_ADMIN_PASSWORD = "abc";
    await expect(createApp(options())).rejects.toThrow(/至少 6 位/);
  });
});
