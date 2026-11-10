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
import { dirname, isAbsolute, join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  buildSystemOpenCommand,
  resolveWindowsExplorer,
} from "../src/services/system-open";
import { authedInject } from "./auth-helper";
import { requirementRootPath } from "./workspace-helper";

// 真实 spawn 会弹出资源管理器，测试里拦截并断言命令拼装
const { spawnMock } = vi.hoisted(() => {
  interface FakeChild {
    once: (event: string, handler: (...args: unknown[]) => void) => FakeChild;
    on: () => FakeChild;
    unref: () => void;
  }
  const fakeChild = (event: string, payload?: unknown): FakeChild => {
    const child: FakeChild = {
      once: (name, handler) => {
        if (name === event) queueMicrotask(() => handler(payload));
        return child;
      },
      on: () => child,
      unref: () => {},
    };
    return child;
  };
  return { spawnMock: vi.fn(() => fakeChild("spawn")) };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

describe("buildSystemOpenCommand", () => {
  const path = "D:/workspace/requirements/REQ-0001/demo/a.txt";
  // explorer.exe 只认反斜杠，Windows 分支统一转换（正斜杠会被静默改成打开“文档”）
  const winPath = "D:\\workspace\\requirements\\REQ-0001\\demo\\a.txt";
  // Windows 分支自带引号（只有路径被引号包住，/select, 开关留在引号外）
  const winQuoted = `"${winPath}"`;

  it("opens a folder with the platform default handler", () => {
    expect(buildSystemOpenCommand(path, { platform: "win32" })).toEqual({
      command: "explorer.exe",
      args: [winQuoted],
      verbatim: true,
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

  it("normalizes Windows paths to backslashes", () => {
    expect(buildSystemOpenCommand(winPath, { platform: "win32" })).toEqual({
      command: "explorer.exe",
      args: [winQuoted],
      verbatim: true,
    });
  });

  it("passes the Windows path as a single argument", () => {
    const unsafe = "D:/workspace/a&b%PATH%.txt";
    const command = buildSystemOpenCommand(unsafe, { platform: "win32" });
    expect(command.command).toBe("explorer.exe");
    // 反斜杠 + 引号后由 CreateProcess 原样接收，& 与 % 不会被 shell 解释
    expect(command.args).toEqual(['"D:\\workspace\\a&b%PATH%.txt"']);
    expect(command.verbatim).toBe(true);
  });

  it("reveals a file in its folder", () => {
    expect(
      buildSystemOpenCommand(path, { platform: "win32", reveal: true }),
    ).toEqual({
      command: "explorer.exe",
      args: [`/select,${winQuoted}`],
      verbatim: true,
    });
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

  it("keeps the /select switch outside the quotes for paths with spaces", () => {
    // 回归保护：整段 `/select,<含空格路径>` 被引号包住时，explorer.exe 匹配不到开关，
    // 会退回默认目录（多为「文档」），表现为“在文件夹中显示”打开的位置不对。
    const spaced =
      "D:/workspace/requirements/REQ-0001 需求工作台/需求分析/a.md";
    const command = buildSystemOpenCommand(spaced, {
      platform: "win32",
      reveal: true,
    });
    expect(command.args).toHaveLength(1);
    expect(command.args[0]).toBe(
      '/select,"D:\\workspace\\requirements\\REQ-0001 需求工作台\\需求分析\\a.md"',
    );
    // 引号必须紧跟在 /select, 之后、路径之前
    expect(command.args[0].startsWith('/select,"')).toBe(true);
    expect(command.args[0].endsWith('"')).toBe(true);
  });

  it("does not quote a Windows root path that ends with a backslash", () => {
    // 尾部反斜杠会被命令行解析当作转义，驱动根目录保持不加引号
    expect(buildSystemOpenCommand("D:/", { platform: "win32" })).toEqual({
      command: "explorer.exe",
      args: ["D:\\"],
      verbatim: true,
    });
  });
});

describe("resolveWindowsExplorer", () => {
  it("uses the absolute path under the system root", () => {
    expect(
      resolveWindowsExplorer({ SystemRoot: "C:\\Windows" }, () => true),
    ).toBe("C:\\Windows\\explorer.exe");
    // 少数环境只有 windir
    expect(resolveWindowsExplorer({ windir: "D:\\Win" }, () => true)).toBe(
      "D:\\Win\\explorer.exe",
    );
  });

  it("falls back to C:\\Windows when the environment has no system root", () => {
    const seen: string[] = [];
    expect(
      resolveWindowsExplorer({}, (candidate) => {
        seen.push(candidate);
        return true;
      }),
    ).toBe("C:\\Windows\\explorer.exe");
    expect(seen).toEqual(["C:\\Windows\\explorer.exe"]);
  });

  it("falls back to the bare command name when the file is missing", () => {
    // 裸名依赖 PATH，属于最后的回退；正常环境不会走到这里
    expect(
      resolveWindowsExplorer({ SystemRoot: "C:\\Windows" }, () => false),
    ).toBe("explorer.exe");
  });
});

// 显式关闭时：打开目录与定位文件只做展示，应始终可用；仅文件默认程序打开被拒绝
describe("physical folder open with SUPERPM_ALLOW_SYSTEM_OPEN=0", () => {
  let app: FastifyInstance;
  let directory: string;
  let requirementId: number;
  let rootPath: string;
  let folderPath: string;
  let filePath: string;
  let folderId: number;
  let fileId: number;

  beforeAll(async () => {
    vi.stubEnv("SUPERPM_ALLOW_SYSTEM_OPEN", "0");
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
    const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      {
        detached?: boolean;
        windowsHide?: boolean;
        env?: NodeJS.ProcessEnv;
        windowsVerbatimArguments?: boolean;
      },
    ];
    // Windows 下 detached 会导致启动的 GUI 程序不显示
    expect(options.detached).not.toBe(true);
    // windowsHide 会把 SW_HIDE 传给 explorer，窗口不可见（“点了没反应”）
    expect(options.windowsHide).not.toBe(true);
    if (process.platform === "win32") {
      // 用绝对路径启动，精简 PATH 下也不会 ENOENT
      expect(command.toLowerCase().endsWith("explorer.exe")).toBe(true);
      expect(isAbsolute(command)).toBe(true);
      // 引号由服务端自带，交给 CreateProcess 原样拼接
      expect(args).toEqual([`"${folderPath}"`]);
      expect(options.windowsVerbatimArguments).toBe(true);
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
      // 用绝对路径启动，精简 PATH 下也不会 ENOENT
      expect(command.toLowerCase().endsWith("explorer.exe")).toBe(true);
      expect(isAbsolute(command)).toBe(true);
      // /select, 开关在引号外，只有路径被引号包住
      expect(args).toEqual([`/select,"${filePath}"`]);
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
    expect(command).toBeTruthy();
    expect(args[0]).toBe(
      process.platform === "win32" ? `"${rootPath}"` : rootPath,
    );
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
