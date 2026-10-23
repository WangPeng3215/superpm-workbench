import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildSystemOpenCommand } from "../src/services/system-open";
import { authedInject } from "./auth-helper";

describe("buildSystemOpenCommand", () => {
  const path = "D:/workspace/requirements/REQ-0001/demo/a.txt";

  it("opens a folder with the platform default handler", () => {
    expect(buildSystemOpenCommand(path, { platform: "win32" })).toEqual({
      command: "cmd",
      args: ["/c", "start", "", path],
    });
    expect(buildSystemOpenCommand(path, { platform: "darwin" })).toEqual({
      command: "open",
      args: [path],
    });
    expect(buildSystemOpenCommand(path, { platform: "linux" })).toEqual({
      command: "xdg-open",
      args: [path],
    });
  });

  it("reveals a file in its folder", () => {
    expect(
      buildSystemOpenCommand(path, { platform: "win32", reveal: true }),
    ).toEqual({ command: "explorer.exe", args: ["/select,", path] });
    expect(
      buildSystemOpenCommand(path, { platform: "darwin", reveal: true }),
    ).toEqual({ command: "open", args: ["-R", path] });
    // Linux 无统一选中协议，退化为打开父目录
    expect(
      buildSystemOpenCommand(path, { platform: "linux", reveal: true }),
    ).toEqual({
      command: "xdg-open",
      args: ["D:/workspace/requirements/REQ-0001/demo"],
    });
  });
});

// 总开关关闭时，目录打开与 reveal 都必须在路由层被拒绝，且不会触碰子进程
describe("artifact open endpoint with SUPERPM_ALLOW_SYSTEM_OPEN unset", () => {
  let app: FastifyInstance;
  let directory: string;
  let requirementId: number;
  let folderId: number;
  let fileId: number;

  beforeAll(async () => {
    delete process.env.SUPERPM_ALLOW_SYSTEM_OPEN;
    const { createApp } = await import("../src/app");
    directory = mkdtempSync(join(tmpdir(), "superpm-open-disabled-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
    });
    await authedInject(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { name: "打开目录需求", proposedAt: "2026-10-23" },
    });
    requirementId = created.json().id;
    const folder = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/folders`,
      payload: { parentId: null, name: "资料" },
    });
    folderId = folder.json().id;
    const file = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/files`,
      payload: { parentId: null, name: "说明.txt" },
    });
    fileId = file.json().id;
  });

  afterAll(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects opening a folder", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${folderId}/open`,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("rejects revealing a file", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${fileId}/open?reveal=1`,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });
});
