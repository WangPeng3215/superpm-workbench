import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { authedInject } from "./auth-helper";
import { requirementRootPath } from "./workspace-helper";

// 真实 spawn 会弹出资源管理器，测试里拦截并断言命令拼装
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ on: () => {}, unref: () => {} })),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

describe("artifact open endpoint with default system open policy", () => {
  let app: FastifyInstance;
  let directory: string;
  let requirementId: number;
  let rootPath: string;
  let folderPath: string;
  let filePath: string;
  let folderId: number;
  let fileId: number;

  beforeAll(async () => {
    vi.stubEnv("SUPERPM_ALLOW_SYSTEM_OPEN", "");
    const { createApp } = await import("../src/app");
    directory = mkdtempSync(join(tmpdir(), "superpm-open-enabled-"));
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
    expect(created.statusCode, created.body).toBe(201);
    requirementId = created.json().id;
    const workspacePath = (
      await app.inject({ method: "GET", url: "/api/system" })
    ).json().workspacePath as string;
    rootPath = await requirementRootPath(app, workspacePath, requirementId);
    const folder = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/folders`,
      payload: { parentId: null, name: "打开测试" },
    });
    expect(folder.statusCode, folder.body).toBe(201);
    folderId = folder.json().id;
    folderPath = join(rootPath, "打开测试");
    const file = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/files`,
      payload: { parentId: null, name: "说明.txt" },
    });
    expect(file.statusCode, file.body).toBe(201);
    fileId = file.json().id;
    filePath = join(rootPath, "说明.txt");
  });

  beforeEach(() => spawnMock.mockClear());

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("opens a folder in the file manager", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${folderId}/open`,
    });
    expect(response.statusCode, response.body).toBe(204);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
    if (process.platform === "win32") {
      expect(command).toBe("powershell.exe");
      expect(options.env?.SUPERPM_TARGET_PATH).toBe(folderPath);
    } else if (process.platform === "darwin") {
      expect(command).toBe("open");
      expect(args).toEqual([folderPath]);
    } else {
      expect(command).toBe("xdg-open");
      expect(args).toEqual([folderPath]);
    }
  });

  it("opens a file with its default handler", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${fileId}/open`,
    });
    expect(response.statusCode).toBe(204);
    const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { detached?: boolean; env?: NodeJS.ProcessEnv },
    ];
    // Windows 下 detached 会导致启动的 GUI 程序不显示
    expect(options.detached).not.toBe(true);
    if (process.platform === "win32") {
      expect(command).toBe("powershell.exe");
      expect(options.env?.SUPERPM_TARGET_PATH).toBe(filePath);
    } else if (process.platform === "darwin") {
      expect(command).toBe("open");
      expect(args).toEqual([filePath]);
    } else {
      expect(command).toBe("xdg-open");
      expect(args).toEqual([filePath]);
    }
  });

  it("reveals a file in its folder", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${fileId}/open?reveal=1`,
    });
    expect(response.statusCode).toBe(204);
    const [command, args] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    if (process.platform === "win32") {
      expect(command).toBe("explorer.exe");
      expect(args).toEqual([`/select,${filePath}`]);
    } else if (process.platform === "darwin") {
      expect(command).toBe("open");
      expect(args).toEqual(["-R", filePath]);
    } else {
      expect(command).toBe("xdg-open");
      expect(args).toEqual([dirname(filePath)]);
    }
  });

  it("rejects reveal on a folder", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${folderId}/open?reveal=1`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for an unknown node", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/artifacts/nodes/999999/open",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
