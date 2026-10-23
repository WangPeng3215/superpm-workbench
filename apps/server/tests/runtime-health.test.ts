import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";
import { SCHEMA_VERSION } from "../src/db/migrate";

describe("健康检查与优雅停止", () => {
  let directory: string;
  let app: FastifyInstance;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "superpm-runtime-health-"));
  });

  afterEach(async () => {
    if (app) await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("健康检查确认数据库可读并返回进程号", async () => {
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    const response = await app.inject("/api/health");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      version: expect.any(String),
      schemaVersion: SCHEMA_VERSION,
      database: "ok",
      pid: process.pid,
    });
  });

  it("停止端点校验回环地址与一次性令牌", async () => {
    let shutdowns = 0;
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
      shutdownToken: "secret-token",
      onShutdownRequested: () => {
        shutdowns += 1;
      },
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/api/shutdown",
      headers: { "x-superpm-shutdown-token": "wrong" },
    });
    expect(wrong.statusCode).toBe(403);
    const remote = await app.inject({
      method: "POST",
      url: "/api/shutdown",
      remoteAddress: "10.1.2.3",
      headers: { "x-superpm-shutdown-token": "secret-token" },
    });
    expect(remote.statusCode).toBe(403);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/shutdown",
      headers: { "x-superpm-shutdown-token": "secret-token" },
    });
    expect(accepted.statusCode).toBe(202);
    await new Promise((done) => setImmediate(done));
    expect(shutdowns).toBe(1);
  });

  it("未配置停止令牌时不注册停止端点", async () => {
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/shutdown",
    });
    expect(response.statusCode).toBe(404);
  });
});
