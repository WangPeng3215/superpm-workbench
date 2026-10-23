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
import { buildSystemOpenCommand } from "../src/services/system-open";
import { authedInject } from "./auth-helper";
import { requirementRootPath } from "./workspace-helper";

// 真实 spawn 会弹出资源管理器，测试里拦截并断言命令拼装
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ unref: () => {} })),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

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

// 总开关关闭时：打开目录与定位文件只做展示，应始终可用；仅文件默认程序打开被拒绝
describe("physical folder open with SUPERPM_ALLOW_SYSTEM_OPEN unset", () => {
  let app: FastifyInstance;
  let directory: string;
  let requirementId: number;
  let rootPath: string;
  let folderPath: string;
  let filePath: string;
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
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("opens a folder in the file manager", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${folderId}/open`,
    });
    expect(response.statusCode, response.body).toBe(204);
    const [command, args] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    if (process.platform === "win32") {
      expect(command).toBe("cmd");
      expect(args).toEqual(["/c", "start", "", folderPath]);
    } else if (process.platform === "darwin") {
      expect(command).toBe("open");
      expect(args).toEqual([folderPath]);
    } else {
      expect(command).toBe("xdg-open");
      expect(args).toEqual([folderPath]);
    }
  });

  it("reveals a file in its folder", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${fileId}/open?reveal=1`,
    });
    expect(response.statusCode, response.body).toBe(204);
    const [command, args] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    if (process.platform === "win32") {
      expect(command).toBe("explorer.exe");
      expect(args).toEqual(["/select,", filePath]);
    } else if (process.platform === "darwin") {
      expect(command).toBe("open");
      expect(args).toEqual(["-R", filePath]);
    } else {
      expect(command).toBe("xdg-open");
      expect(args).toEqual([dirname(filePath)]);
    }
  });

  it("opens the current requirement directory", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/directory/open`,
      payload: { relativePath: "" },
    });
    expect(response.statusCode, response.body).toBe(204);
    const [command, args] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    const opened = process.platform === "win32" ? args[3] : args[0];
    expect(opened).toBe(rootPath);
    expect(command).toBeTruthy();
  });

  it("rejects opening a file with its default program", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${fileId}/open`,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects a directory path escaping the requirement root", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/directory/open`,
      payload: { relativePath: "../outside" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_PATH");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
