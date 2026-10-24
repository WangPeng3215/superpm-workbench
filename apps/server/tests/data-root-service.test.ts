import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  acquireOperationLock,
  moveHomePaths,
  readHomeMoveJob,
  readMoveHomeState,
  readOperationLock,
  writeHomeMarker,
  writeMovedMarker,
  writeMoveHomeState,
  type DataRootSource,
  type HomeMoveState,
} from "@superpm/shared/data-root";
import { migrate } from "../src/db/migrate.js";
import { registerMcpProcess } from "../src/runtime/state.js";
import { acquireUpdateLock, releaseUpdateLock } from "../src/runtime/state.js";
import {
  createDataRootService,
  HomeMoveError,
  type DataRootServiceOptions,
} from "../src/services/data-root.js";
import { authedInject } from "./auth-helper.js";

const directories: string[] = [];

function tempDir(prefix = "superpm-data-root-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

interface SetupOptions {
  packaged?: boolean;
  homeSource?: DataRootSource;
  homeName?: string;
  withDatabase?: boolean;
  withWorkspaceFile?: boolean;
  withHelper?: boolean;
  env?: NodeJS.ProcessEnv;
  launchHelper?: DataRootServiceOptions["launchHelper"];
  probeNetworkDrive?: DataRootServiceOptions["probeNetworkDrive"];
}

function setup(options: SetupOptions = {}) {
  const base = tempDir();
  const installRoot = join(base, "install");
  const appRoot = join(installRoot, "app");
  mkdirSync(appRoot, { recursive: true });
  const home = join(base, options.homeName ?? "home");
  const configDir = join(base, "config");
  mkdirSync(home, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  if (options.withHelper !== false) {
    mkdirSync(join(installRoot, "bin"), { recursive: true });
    writeFileSync(join(installRoot, "bin", "move-home.mjs"), "// test\n");
  }
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true });
  const databasePath = join(dataDir, "superpm.sqlite");
  if (options.withDatabase !== false) {
    const db = new Database(databasePath);
    migrate(db);
    db.close();
  }
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  if (options.withWorkspaceFile !== false)
    writeFileSync(join(workspacePath, "note.md"), "# note\n");
  writeFileSync(join(home, ".env"), "PORT=4000\n");
  mkdirSync(join(home, "backups"), { recursive: true });
  const targetParent = join(base, "target");
  mkdirSync(targetParent, { recursive: true });
  const launchHelper =
    options.launchHelper ?? vi.fn(async () => ({ pid: 4242 }));
  const serviceFor = (
    env: NodeJS.ProcessEnv = options.env ?? {},
    overrides: Partial<DataRootServiceOptions> = {},
  ) =>
    createDataRootService({
      home,
      homeSource: options.homeSource ?? "config",
      configDir,
      installRoot,
      appRoot,
      isPackaged: options.packaged ?? true,
      databasePath,
      workspacePath,
      env,
      platform: process.platform,
      launchHelper,
      probeNetworkDrive: options.probeNetworkDrive ?? (() => false),
      ...overrides,
    });
  return {
    base,
    installRoot,
    appRoot,
    home,
    configDir,
    databasePath,
    workspacePath,
    targetParent,
    launchHelper,
    service: serviceFor(),
    serviceFor,
  };
}

function completedState(
  fromHome: string,
  toHome: string,
  overrides: Partial<HomeMoveState> = {},
): HomeMoveState {
  const stamp = "2026-10-24T08:00:00.000Z";
  return {
    schemaVersion: 1,
    jobId: "job-1",
    status: "completed",
    phase: "completed",
    fromHome,
    toHome,
    startedAt: stamp,
    updatedAt: stamp,
    cleanup: "pending",
    oldHome: fromHome,
    managedPaths: ["data", "workspace", "backups", ".env"],
    movedAt: stamp,
    ...overrides,
  };
}

describe("数据根目录校验", () => {
  it("拒绝相对路径与 UNC 路径", () => {
    const { service } = setup();
    expect(service.validate("relative/dir").blockedReasons).toContain(
      "请输入绝对路径",
    );
    expect(service.validate("\\\\server\\share").blockedReasons).toContain(
      "不支持 UNC 网络路径，请选择已映射的本地盘符",
    );
  });

  it("拒绝过长路径、缺失父目录、同名文件与非空目录", () => {
    const { service, base, targetParent } = setup();
    const longPath = join(base, "a".repeat(190), "b".repeat(20));
    expect(service.validate(longPath).blockedReasons.join()).toContain(
      "保存路径过长",
    );

    expect(service.validate(join(base, "missing")).blockedReasons).toContain(
      "父目录不存在或不是目录",
    );

    writeFileSync(join(targetParent, "superPM"), "file");
    expect(service.validate(targetParent).blockedReasons).toContain(
      "目标路径已存在同名文件",
    );

    rmSync(join(targetParent, "superPM"));
    mkdirSync(join(targetParent, "superPM"));
    writeFileSync(join(targetParent, "superPM", "leftover.txt"), "x");
    expect(service.validate(targetParent).blockedReasons).toContain(
      "目标目录已存在且非空，请选择其他位置",
    );
  });

  it("拒绝与当前数据根、安装目录和配置目录重叠的目标", () => {
    const { service, home, installRoot, configDir, base } = setup();
    const inner = join(home, "nested");
    mkdirSync(inner);
    expect(service.validate(inner).blockedReasons).toContain(
      "目标目录位于当前数据根内部",
    );

    const parentOfHome = join(base, "container");
    mkdirSync(join(parentOfHome, "superPM", "data"), { recursive: true });
    const containerService = createDataRootService({
      home: join(parentOfHome, "superPM", "data"),
      homeSource: "config",
      configDir,
      installRoot,
      appRoot: join(installRoot, "app"),
      isPackaged: true,
      databasePath: join(parentOfHome, "superPM", "data", "x.sqlite"),
      workspacePath: join(parentOfHome, "superPM", "data", "workspace"),
      env: {},
      platform: process.platform,
      launchHelper: vi.fn(async () => ({ pid: 1 })),
      probeNetworkDrive: () => false,
    });
    expect(containerService.validate(parentOfHome).blockedReasons).toContain(
      "目标目录包含当前数据根",
    );

    const insideInstall = join(installRoot, "extra");
    mkdirSync(insideInstall);
    expect(service.validate(insideInstall).blockedReasons).toContain(
      "目标目录与安装目录不能互相包含",
    );

    expect(service.validate(configDir).blockedReasons).toContain(
      "目标目录不能位于配置目录内部",
    );
  });

  it("拒绝绝对路径的数据/工作区设置与二者互相包含", () => {
    const { base, targetParent, serviceFor } = setup();
    expect(
      serviceFor({
        SUPERPM_DATA_DIR: join(base, "absolute-data"),
      }).validate(targetParent).blockedReasons,
    ).toContain(
      "SUPERPM_DATA_DIR 使用绝对路径指定了数据目录，请先改回相对路径",
    );

    expect(
      serviceFor({
        SUPERPM_WORKSPACE_DIR: join(base, "absolute-ws"),
      }).validate(targetParent).blockedReasons,
    ).toContain(
      "SUPERPM_WORKSPACE_DIR 使用绝对路径指定了工作区，请先改回相对路径",
    );

    expect(
      serviceFor({
        SUPERPM_DATA_DIR: "data",
        SUPERPM_WORKSPACE_DIR: "data/workspace",
      }).validate(targetParent).blockedReasons,
    ).toContain("数据目录与工作区目录不能互相包含");
  });

  it("数据库缺失但工作区仍有文件时拒绝迁移", () => {
    const { service, targetParent } = setup({
      withDatabase: false,
      withWorkspaceFile: true,
    });
    expect(service.validate(targetParent).blockedReasons).toContain(
      "数据库缺失但工作区仍有文件，数据不完整，已拒绝迁移",
    );
  });

  it("有效目标返回 superPM 子目录、统计与空间需求", () => {
    const { service, targetParent } = setup();
    const result = service.validate(targetParent);
    expect(result.blockedReasons).toEqual([]);
    expect(result.targetHome).toBe(join(targetParent, "superPM"));
    expect(result.exists).toBe(false);
    expect(result.writable).toBe(true);
    expect(result.databaseExists).toBe(true);
    expect(result.workspaceFiles).toBeGreaterThan(0);
    expect(result.sourceBytes).toBeGreaterThan(0);
    expect(result.requiredBytes).toBeGreaterThan(result.sourceBytes);
    expect(result.requiredBytes).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(result.freeBytes).toBeGreaterThan(0);
    expect(result.warnings.join()).toContain(
      "将在所选目录下创建 superPM 子目录",
    );
  });

  it("父目录本身就是 superPM 时不再追加子目录，并提示网络盘风险", () => {
    const { service, base } = setup({ probeNetworkDrive: () => true });
    const parent = join(base, "superPM");
    mkdirSync(parent);
    const result = service.validate(parent);
    expect(result.targetHome).toBe(parent);
    expect(result.warnings.join()).not.toContain("将在所选目录下创建");
    expect(result.warnings.join()).toContain("目标位于网络映射盘");
  });
});

describe("数据根可编辑状态与迁移状态", () => {
  it("按来源与发布布局判断是否允许修改", () => {
    expect(setup({ homeSource: "development" }).service.lockedReason()).toBe(
      "development",
    );
    expect(setup({ packaged: false }).service.lockedReason()).toBe(
      "not-packaged",
    );
    expect(setup({ homeSource: "env" }).service.lockedReason()).toBe(
      "environment",
    );
    expect(setup({ withHelper: false }).service.lockedReason()).toBe(
      "not-packaged",
    );
    expect(setup().service.lockedReason()).toBeUndefined();
  });

  it("info 返回待清理旧数据与进行中的迁移", () => {
    const { service, configDir, home, base } = setup();
    const oldHome = join(base, "old");
    writeMoveHomeState(configDir, completedState(oldHome, home));
    const info = service.info();
    expect(info.dataRootEditable).toBe(true);
    expect(info.pendingOldData).toMatchObject({
      jobId: "job-1",
      oldHome,
      managedPaths: ["data", "workspace", "backups", ".env"],
    });

    acquireOperationLock(configDir, {
      schemaVersion: 1,
      kind: "move",
      jobId: "job-2",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    expect(service.info().moveInProgress).toBe(true);
  });

  it("未打包时状态视图为 idle", () => {
    expect(setup({ packaged: false }).service.stateView()).toEqual({
      status: "idle",
    });
  });

  it("进程退出后按目标标记把运行中状态收敛为完成", () => {
    const { service, configDir, home, base } = setup();
    const oldHome = join(base, "old");
    const stamp = new Date().toISOString();
    writeHomeMarker(home, { schemaVersion: 1, home, jobId: "job-9" });
    writeMoveHomeState(configDir, {
      schemaVersion: 1,
      jobId: "job-9",
      status: "running",
      phase: "restarting",
      fromHome: oldHome,
      toHome: home,
      startedAt: stamp,
      updatedAt: stamp,
      cleanup: "none",
    });
    const view = service.stateView();
    expect(view.status).toBe("completed");
    expect(view.cleanup).toBe("pending");
    expect(view.oldHome).toBe(oldHome);
    expect(view.movedAt).toBeTruthy();
    expect(readMoveHomeState(configDir)?.status).toBe("completed");
  });

  it("目标未就绪时把运行中状态收敛为失败且无需回滚", () => {
    const { service, configDir, home, base } = setup();
    const stamp = new Date().toISOString();
    writeMoveHomeState(configDir, {
      schemaVersion: 1,
      jobId: "job-10",
      status: "running",
      phase: "copying",
      fromHome: home,
      toHome: join(base, "elsewhere"),
      startedAt: stamp,
      updatedAt: stamp,
      cleanup: "none",
    });
    const view = service.stateView();
    expect(view.status).toBe("failed");
    expect(view.error?.rollback).toBe("not-needed");
    expect(view.error?.phase).toBe("copying");
  });
});

describe("启动数据迁移", () => {
  it("校验通过后写入任务与锁并启动独立助手", async () => {
    const {
      service,
      configDir,
      home,
      installRoot,
      targetParent,
      launchHelper,
    } = setup({
      env: { SUPERPM_HOME: "/old/home", SUPERPM_HOME_SOURCE: "config" },
    });
    const targetHome = join(targetParent, "superPM");
    const result = await service.startMove(
      { parent: targetParent, confirmTarget: targetHome },
      7,
    );
    expect(result.status).toBe("started");
    expect(result.targetHome).toBe(targetHome);
    expect(result.jobId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);

    const job = readHomeMoveJob(configDir);
    expect(job).toMatchObject({
      jobId: result.jobId,
      fromHome: home,
      toHome: targetHome,
      installRoot,
      requestedBy: 7,
    });
    expect(readMoveHomeState(configDir)).toMatchObject({
      status: "running",
      phase: "preparing",
      cleanup: "none",
    });
    expect(readOperationLock(configDir)?.jobId).toBe(result.jobId);

    const launch = launchHelper as unknown as {
      mock: { calls: [Record<string, unknown>][] };
    };
    const input = launch.mock.calls[0][0] as {
      node: string;
      helper: string;
      jobPath: string;
      cwd: string;
      env: NodeJS.ProcessEnv;
    };
    expect(input.helper).toBe(join(installRoot, "bin", "move-home.mjs"));
    expect(input.jobPath).toBe(moveHomePaths(configDir).jobPath);
    expect(input.cwd).toBe(installRoot);
    expect(input.node).toBe(process.execPath);
    expect(input.env.SUPERPM_HOME).toBeUndefined();
    expect(input.env.SUPERPM_HOME_SOURCE).toBeUndefined();
    expect(input.env.SUPERPM_CONFIG_DIR).toBe(configDir);
    expect(input.env.SUPERPM_INSTALL_ROOT).toBe(installRoot);
  });

  it("目标校验失败或确认目录不一致时拒绝", async () => {
    const { service, targetParent } = setup();
    await expect(
      service.startMove({ parent: "relative", confirmTarget: "relative" }, 1),
    ).rejects.toMatchObject({
      code: "HOME_MOVE_INVALID",
      status: 400,
    });
    await expect(
      service.startMove(
        { parent: targetParent, confirmTarget: join(targetParent, "other") },
        1,
      ),
    ).rejects.toMatchObject({
      code: "HOME_MOVE_INVALID",
      status: 400,
    });
  });

  it("已有迁移锁、更新锁或 MCP 进程时拒绝启动", async () => {
    const withLock = setup();
    acquireOperationLock(withLock.configDir, {
      schemaVersion: 1,
      kind: "move",
      jobId: "running-job",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    await expect(
      withLock.service.startMove(
        {
          parent: withLock.targetParent,
          confirmTarget: join(withLock.targetParent, "superPM"),
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "HOME_MOVE_BUSY" });

    const withUpdate = setup();
    acquireUpdateLock(withUpdate.home, { pid: process.pid });
    await expect(
      withUpdate.service.startMove(
        {
          parent: withUpdate.targetParent,
          confirmTarget: join(withUpdate.targetParent, "superPM"),
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "HOME_MOVE_BUSY" });
    releaseUpdateLock(withUpdate.home, true);

    const withMcp = setup();
    const registration = registerMcpProcess(withMcp.home, {
      version: "0.3.3",
      schemaVersion: 1,
      writeEnabled: false,
    });
    try {
      await expect(
        withMcp.service.startMove(
          {
            parent: withMcp.targetParent,
            confirmTarget: join(withMcp.targetParent, "superPM"),
          },
          1,
        ),
      ).rejects.toMatchObject({ code: "HOME_MOVE_BUSY" });
    } finally {
      registration.close();
    }
  });

  it("开发环境或数据根由环境变量指定时不允许迁移", async () => {
    const dev = setup({ homeSource: "development" });
    await expect(
      dev.service.startMove(
        {
          parent: dev.targetParent,
          confirmTarget: join(dev.targetParent, "superPM"),
        },
        1,
      ),
    ).rejects.toMatchObject({
      code: "HOME_MOVE_NOT_AVAILABLE",
      status: 409,
    });
  });

  it("助手启动失败时回滚任务、状态与锁", async () => {
    const { service, configDir, targetParent } = setup({
      launchHelper: vi.fn(async () => {
        throw new Error("spawn denied");
      }),
    });
    await expect(
      service.startMove(
        { parent: targetParent, confirmTarget: join(targetParent, "superPM") },
        1,
      ),
    ).rejects.toMatchObject({
      code: "HOME_MOVE_SPAWN_FAILED",
      status: 500,
    });
    expect(existsSync(moveHomePaths(configDir).jobPath)).toBe(false);
    expect(existsSync(moveHomePaths(configDir).statePath)).toBe(false);
    expect(readOperationLock(configDir)).toBeNull();
  });

  it("HomeMoveError 携带错误码与状态", () => {
    const error = new HomeMoveError("HOME_MOVE_INVALID", "x", 400, {
      blockedReasons: ["y"],
    });
    expect(error.code).toBe("HOME_MOVE_INVALID");
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ blockedReasons: ["y"] });
  });
});

describe("旧数据清理", () => {
  function seedOldHome(
    base: string,
    home: string,
    configDir: string,
    overrides: Partial<HomeMoveState> = {},
  ) {
    const oldHome = join(base, "old-home");
    mkdirSync(join(oldHome, "data"), { recursive: true });
    writeFileSync(join(oldHome, "data", "superpm.sqlite"), "db");
    mkdirSync(join(oldHome, "workspace", "REQ-0001"), { recursive: true });
    writeFileSync(join(oldHome, "workspace", "REQ-0001", "a.md"), "# a");
    mkdirSync(join(oldHome, "backups"), { recursive: true });
    writeFileSync(join(oldHome, "backups", "b.zip"), "zip");
    writeFileSync(join(oldHome, ".env"), "A=1\n");
    writeFileSync(join(oldHome, "notes.txt"), "keep me");
    writeMovedMarker(oldHome, {
      schemaVersion: 1,
      to: home,
      jobId: "job-1",
      movedAt: "2026-10-24T08:00:00.000Z",
    });
    writeMoveHomeState(configDir, completedState(oldHome, home, overrides));
    return oldHome;
  }

  it("选择保留时只更新状态", () => {
    const { service, base, home, configDir } = setup();
    const oldHome = seedOldHome(base, home, configDir);
    expect(
      service.cleanup({ action: "keep", jobId: "job-1", oldHome }),
    ).toEqual({ action: "keep" });
    expect(readMoveHomeState(configDir)?.cleanup).toBe("kept");
    expect(existsSync(join(oldHome, "data", "superpm.sqlite"))).toBe(true);
  });

  it("删除需要二次确认，且只删除受管路径", () => {
    const { service, base, home, configDir } = setup();
    const oldHome = seedOldHome(base, home, configDir);
    expect(() =>
      service.cleanup({ action: "delete", jobId: "job-1", oldHome }),
    ).toThrowError(HomeMoveError);
    expect(existsSync(join(oldHome, "data"))).toBe(true);

    const result = service.cleanup({
      action: "delete",
      jobId: "job-1",
      oldHome,
      confirm: true,
    });
    expect(result.deletedPaths?.sort()).toEqual([
      ".env",
      "backups",
      "data",
      "workspace",
    ]);
    expect(result.failedPaths).toBeUndefined();
    expect(existsSync(join(oldHome, "data"))).toBe(false);
    expect(existsSync(join(oldHome, "workspace"))).toBe(false);
    expect(existsSync(join(oldHome, "backups"))).toBe(false);
    expect(existsSync(join(oldHome, ".env"))).toBe(false);
    expect(readFileSync(join(oldHome, "notes.txt"), "utf8")).toBe("keep me");
    expect(readMoveHomeState(configDir)?.cleanup).toBe("deleted");
  });

  it("拒绝任务、旧路径或标记不匹配的记录", () => {
    const { service, base, home, configDir } = setup();
    const oldHome = seedOldHome(base, home, configDir);
    expect(() =>
      service.cleanup({ action: "keep", jobId: "other", oldHome }),
    ).toThrowError(/待处理记录已变化/);
    expect(() =>
      service.cleanup({
        action: "keep",
        jobId: "job-1",
        oldHome: join(base, "different-old-home"),
      }),
    ).toThrowError(/待处理记录已变化/);
  });

  it("标记缺失或指向其他数据根时拒绝清理", () => {
    const { service, base, home, configDir } = setup();
    const oldHome = join(base, "no-marker");
    mkdirSync(join(oldHome, "data"), { recursive: true });
    writeMoveHomeState(configDir, completedState(oldHome, home));
    expect(() =>
      service.cleanup({ action: "keep", jobId: "job-1", oldHome }),
    ).toThrowError(/旧数据根标记缺失或不匹配/);

    writeMovedMarker(oldHome, {
      schemaVersion: 1,
      to: join(base, "elsewhere"),
      jobId: "job-1",
      movedAt: "2026-10-24T08:00:00.000Z",
    });
    expect(() =>
      service.cleanup({ action: "keep", jobId: "job-1", oldHome }),
    ).toThrowError(/旧数据根标记缺失或不匹配/);
  });

  it("拒绝越界或不在白名单内的清理路径", () => {
    const { service, base, home, configDir } = setup();
    const oldHome = seedOldHome(base, home, configDir, {
      managedPaths: ["../outside"],
    });
    expect(() =>
      service.cleanup({ action: "keep", jobId: "job-1", oldHome }),
    ).toThrowError(/不在允许范围/);

    const notAllowed = seedOldHome(base, home, configDir, {
      managedPaths: ["logs"],
    });
    expect(() =>
      service.cleanup({ action: "keep", jobId: "job-1", oldHome: notAllowed }),
    ).toThrowError(/不在允许范围/);
  });

  it("符号链接只删除链接本身，不触碰链接目标", () => {
    const { service, base, home, configDir } = setup();
    const oldHome = join(base, "old-home");
    mkdirSync(oldHome);
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "outside");
    try {
      symlinkSync(outside, join(oldHome, "data"), "junction");
    } catch {
      return;
    }
    writeMovedMarker(oldHome, {
      schemaVersion: 1,
      to: home,
      jobId: "job-1",
      movedAt: "2026-10-24T08:00:00.000Z",
    });
    writeMoveHomeState(
      configDir,
      completedState(oldHome, home, { managedPaths: ["data"] }),
    );
    expect(
      service.cleanup({
        action: "delete",
        jobId: "job-1",
        oldHome,
        confirm: true,
      }).deletedPaths,
    ).toEqual(["data"]);
    expect(existsSync(join(oldHome, "data"))).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("outside");
  });
});

describe("数据根接口", () => {
  async function createTestApp(options: SetupOptions = {}) {
    const seeded = setup(options);
    const { createApp } = await import("../src/app");
    const app = await createApp({
      databasePath: seeded.databasePath,
      workspacePath: seeded.workspacePath,
      logger: false,
      dataRoot: {
        home: seeded.home,
        homeSource: "config",
        configDir: seeded.configDir,
        installRoot: seeded.installRoot,
        appRoot: seeded.appRoot,
        isPackaged: true,
        databasePath: seeded.databasePath,
        workspacePath: seeded.workspacePath,
        env: {},
        platform: process.platform,
        launchHelper: seeded.launchHelper,
        probeNetworkDrive: () => false,
      },
    });
    await authedInject(app);
    return { app, ...seeded };
  }

  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length > 0) await apps.pop()?.close();
  });

  it("未登录访问数据根接口返回 401", async () => {
    const seeded = setup();
    const { createApp } = await import("../src/app");
    const app = await createApp({
      databasePath: seeded.databasePath,
      workspacePath: seeded.workspacePath,
      logger: false,
      dataRoot: {
        home: seeded.home,
        homeSource: "config",
        configDir: seeded.configDir,
        installRoot: seeded.installRoot,
        appRoot: seeded.appRoot,
        isPackaged: true,
        databasePath: seeded.databasePath,
        workspacePath: seeded.workspacePath,
        env: {},
        platform: process.platform,
        launchHelper: seeded.launchHelper,
        probeNetworkDrive: () => false,
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/system/home/validate",
      payload: { parent: seeded.targetParent },
    });
    expect(response.statusCode).toBe(401);
  });

  it("系统信息返回数据根来源与可编辑状态", async () => {
    const { app, home } = await createTestApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/system" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.homePath).toBe(home);
    expect(body.homeSource).toBe("config");
    expect(body.dataRootEditable).toBe(true);
    expect(body.moveInProgress).toBe(false);
  });

  it("校验接口返回目标子目录与阻断原因", async () => {
    const { app, targetParent } = await createTestApp();
    apps.push(app);
    const ok = await app.inject({
      method: "POST",
      url: "/api/system/home/validate",
      payload: { parent: targetParent },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      targetHome: join(targetParent, "superPM"),
      blockedReasons: [],
    });

    const bad = await app.inject({
      method: "POST",
      url: "/api/system/home/validate",
      payload: { parent: "relative" },
    });
    expect(bad.statusCode).toBe(200);
    expect(
      (bad.json() as { blockedReasons: string[] }).blockedReasons,
    ).toContain("请输入绝对路径");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/system/home/validate",
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("迁移接口返回 202 并启动助手，冲突时返回错误码", async () => {
    const { app, targetParent, launchHelper, configDir } =
      await createTestApp();
    apps.push(app);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/system/home/move",
      payload: {
        parent: targetParent,
        confirmTarget: join(targetParent, "superPM"),
      },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      status: "started",
      targetHome: join(targetParent, "superPM"),
    });
    expect(launchHelper).toHaveBeenCalledTimes(1);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/system/home/move",
      payload: {
        parent: targetParent,
        confirmTarget: join(targetParent, "superPM"),
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "HOME_MOVE_BUSY" },
    });
    expect(readOperationLock(configDir)?.jobId).toBe(
      (accepted.json() as { jobId: string }).jobId,
    );
  });

  it("清理接口在无待处理记录时返回 409", async () => {
    const { app, base } = await createTestApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/system/home/cleanup",
      payload: {
        action: "keep",
        jobId: "job-1",
        oldHome: join(base, "old"),
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "HOME_MOVE_INVALID" },
    });
  });

  it("迁移状态接口返回 idle 或当前进度", async () => {
    const { app, configDir, home, base } = await createTestApp();
    apps.push(app);
    const idle = await app.inject({
      method: "GET",
      url: "/api/system/home/move",
    });
    expect(idle.statusCode).toBe(200);
    expect(idle.json()).toEqual({ status: "idle" });

    const stamp = new Date().toISOString();
    writeMoveHomeState(configDir, {
      schemaVersion: 1,
      jobId: "job-3",
      status: "running",
      phase: "copying",
      fromHome: home,
      toHome: join(base, "elsewhere"),
      startedAt: stamp,
      updatedAt: stamp,
      cleanup: "none",
      progress: {
        copiedBytes: 10,
        totalBytes: 20,
        copiedFiles: 1,
        totalFiles: 2,
      },
    });
    const running = await app.inject({
      method: "GET",
      url: "/api/system/home/move",
    });
    expect(running.json()).toMatchObject({
      status: "failed",
      phase: "failed",
      error: { phase: "copying", rollback: "not-needed" },
      progress: { copiedBytes: 10, totalBytes: 20 },
    });
  });
});
