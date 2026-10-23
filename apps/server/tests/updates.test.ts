import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { UpdateManifest } from "@superpm/shared";
import { createApp } from "../src/app";
import { SCHEMA_VERSION } from "../src/db/migrate";
import { DomainError } from "../src/services/requirements";
import {
  UpdateService,
  compareVersions,
  type LaunchUpdaterInput,
  type UpdateServiceOptions,
} from "../src/services/updates";
import { registerMcpProcess } from "../src/runtime/state";
import { authedInject } from "./auth-helper";

const directories: string[] = [];
const apps: FastifyInstance[] = [];

function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "superpm-updates-"));
  directories.push(directory);
  return directory;
}

function packagedInstall(directory: string) {
  const installRoot = join(directory, "install");
  const appRoot = join(installRoot, "app");
  mkdirSync(join(installRoot, "bin"), { recursive: true });
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(
    join(appRoot, "package.json"),
    JSON.stringify({ name: "superpm-workbench", version: "0.2.0" }),
  );
  writeFileSync(join(installRoot, "bin", "updater.mjs"), "// stub\n");
  writeFileSync(
    join(installRoot, "install.json"),
    JSON.stringify({ updaterVersion: "1.0.0" }),
  );
  return { installRoot, appRoot };
}

function createService(
  directory: string,
  overrides: Partial<UpdateServiceOptions> = {},
) {
  const { installRoot, appRoot } = packagedInstall(directory);
  return new UpdateService({
    home: join(directory, "home"),
    installRoot,
    appRoot,
    currentVersion: "0.2.0",
    schemaVersion: 12,
    isPackaged: true,
    platform: "win32-x64",
    manifestUrl:
      "https://github.com/WangPeng3215/superpm-workbench/releases/latest/download/update-manifest.json",
    ...overrides,
  });
}

const archiveBytes = Buffer.from("superpm update archive bytes");
const archiveDigest = createHash("sha256").update(archiveBytes).digest("hex");
const artifactUrl =
  "https://github.com/WangPeng3215/superpm-workbench/releases/download/v0.3.0/superpm-workbench-0.3.0-update-win-x64.zip";

function manifest(overrides: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    manifestVersion: 1,
    name: "superpm-workbench",
    version: "0.3.0",
    platform: "win32-x64",
    releasedAt: "2026-10-23T08:00:00.000Z",
    schemaVersion: 12,
    minUpdaterVersion: "1.0.0",
    notes: "本次更新说明",
    update: {
      file: "superpm-workbench-0.3.0-update-win-x64.zip",
      url: artifactUrl,
      sha256: archiveDigest,
      size: archiveBytes.length,
    },
    ...overrides,
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function routeFetch(value: UpdateManifest, artifact = archiveBytes) {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("update-manifest.json")) return jsonResponse(value);
    if (url.endsWith(".zip")) return new Response(artifact, { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}

async function waitFor<T>(
  read: () => T | null | undefined,
  timeout = 5000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("等待更新状态超时");
}

async function expectDomainError(
  run: () => unknown,
  code: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`应抛出 ${code}`);
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

describe("版本比较", () => {
  it("比较主版本、补丁与预发布版本", () => {
    expect(compareVersions("0.3.0", "0.2.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBe(-1);
    expect(compareVersions("0.3.0-beta.1", "0.3.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  });
});

describe("更新检查", () => {
  it("读取并缓存 GitHub 清单，返回可用更新", async () => {
    const directory = tempDirectory();
    const { fetchImpl } = routeFetch(manifest());
    const service = createService(directory, { fetchImpl });
    const result = await service.check();
    expect(result).toMatchObject({
      currentVersion: "0.2.0",
      latestVersion: "0.3.0",
      available: true,
      installable: true,
      blockedReason: null,
      notes: "本次更新说明",
      updateSize: archiveBytes.length,
    });
    const cache = JSON.parse(
      readFileSync(
        join(directory, "home", "updates", "available-manifest.json"),
        "utf8",
      ),
    );
    expect(cache.manifest.version).toBe("0.3.0");
    expect(cache.source).toBe(result.source);
  });

  it("当前已是最新版本时不提供安装", async () => {
    const directory = tempDirectory();
    const { fetchImpl } = routeFetch(manifest({ version: "0.2.0" }));
    const service = createService(directory, { fetchImpl });
    const result = await service.check();
    expect(result.available).toBe(false);
    expect(result.installable).toBe(false);
  });

  it("拒绝非白名单主机与非 HTTPS 地址", async () => {
    const directory = tempDirectory();
    let called = 0;
    const fetchImpl = async () => {
      called += 1;
      return jsonResponse(manifest());
    };
    const outside = createService(directory, {
      fetchImpl,
      manifestUrl: "https://evil.example.com/update-manifest.json",
    });
    await expectDomainError(() => outside.check(), "UPDATE_SOURCE_INVALID");
    const insecure = createService(directory, {
      fetchImpl,
      manifestUrl: "http://github.com/update-manifest.json",
    });
    await expectDomainError(() => insecure.check(), "UPDATE_SOURCE_INVALID");
    expect(called).toBe(0);
  });

  it("拒绝重定向到白名单以外的主机", async () => {
    const directory = tempDirectory();
    let called = 0;
    const fetchImpl = async () => {
      called += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.com/update-manifest.json" },
      });
    };
    const service = createService(directory, { fetchImpl });
    await expectDomainError(() => service.check(), "UPDATE_SOURCE_FAILED");
    expect(called).toBe(1);
  });

  it("拒绝平台、数据库版本不匹配的清单", async () => {
    const directory = tempDirectory();
    const platform = createService(directory, {
      fetchImpl: async () =>
        jsonResponse(
          manifest({ platform: "linux-x64" as UpdateManifest["platform"] }),
        ),
    });
    await expectDomainError(() => platform.check(), "UPDATE_MANIFEST_INVALID");
    const schema = createService(directory, {
      fetchImpl: async () => jsonResponse(manifest({ schemaVersion: 11 })),
    });
    await expectDomainError(() => schema.check(), "UPDATE_MANIFEST_INVALID");
  });

  it("最低更新器版本不足时标记为不可安装", async () => {
    const directory = tempDirectory();
    const service = createService(directory, {
      fetchImpl: async () =>
        jsonResponse(manifest({ minUpdaterVersion: "1.1.0" })),
    });
    const result = await service.check();
    expect(result.available).toBe(true);
    expect(result.installable).toBe(false);
    expect(result.blockedReason).toContain("完整安装包");

    rmSync(join(directory, "install", "install.json"), { force: true });
    const unknown = await service.check();
    expect(unknown.installable).toBe(false);
    expect(unknown.blockedReason).toContain("更新器版本");
  });
});

describe("更新安装", () => {
  it("未检查、版本变化或版本未升高时拒绝安装", async () => {
    const directory = tempDirectory();
    const { fetchImpl } = routeFetch(manifest());
    const service = createService(directory, {
      fetchImpl,
      launchUpdater: () => ({ pid: 1 }),
    });
    await expectDomainError(
      () => service.startInstall({ version: "0.3.0", force: false }),
      "UPDATE_NOT_CHECKED",
    );
    await service.check();
    await expectDomainError(
      () => service.startInstall({ version: "0.3.1", force: false }),
      "UPDATE_VERSION_CHANGED",
    );

    const sameVersion = createService(directory, {
      fetchImpl: routeFetch(manifest({ version: "0.2.0" })).fetchImpl,
      launchUpdater: () => ({ pid: 1 }),
    });
    await sameVersion.check();
    await expectDomainError(
      () => sameVersion.startInstall({ version: "0.2.0", force: false }),
      "UPDATE_NOT_AVAILABLE",
    );
  });

  it("下载校验后写入本地清单并启动独立更新器", async () => {
    const directory = tempDirectory();
    const { calls, fetchImpl } = routeFetch(manifest());
    const launched: LaunchUpdaterInput[] = [];
    const service = createService(directory, {
      fetchImpl,
      launchUpdater: (input) => {
        launched.push(input);
        return { pid: 4321 };
      },
    });
    await service.check();
    expect(service.startInstall({ version: "0.3.0", force: false })).toEqual({
      accepted: true,
    });
    await waitFor(() =>
      service.status().install?.status === "installing" ? true : null,
    );
    expect(calls.filter((url) => url.endsWith(".zip"))).toHaveLength(1);
    expect(launched).toHaveLength(1);
    expect(launched[0].node).toBe(process.execPath);
    expect(launched[0].args).toContain("--manifest");
    expect(launched[0].args).toContain("--install-root");
    expect(launched[0].args).not.toContain("--force");
    expect(launched[0].env.SUPERPM_HOME).toBe(join(directory, "home"));

    const localManifest = JSON.parse(
      readFileSync(
        join(directory, "home", "updates", "install-manifest.json"),
        "utf8",
      ),
    );
    expect(localManifest.update.url).toMatch(/^file:/);
    const archivePath = fileURLToPath(localManifest.update.url);
    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(archivePath).equals(archiveBytes)).toBe(true);
  });

  it("摘要不一致时删除下载文件且不启动更新器", async () => {
    const directory = tempDirectory();
    const { fetchImpl } = routeFetch(
      manifest(),
      Buffer.alloc(archiveBytes.length, 0x41),
    );
    let launches = 0;
    const service = createService(directory, {
      fetchImpl,
      launchUpdater: () => {
        launches += 1;
        return { pid: 1 };
      },
    });
    await service.check();
    service.startInstall({ version: "0.3.0", force: false });
    const install = await waitFor(() => {
      const state = service.status().install;
      return state?.status === "failed" ? state : null;
    });
    expect(install.error).toContain("摘要不一致");
    expect(launches).toBe(0);
    expect(existsSync(join(directory, "home", "updates", "downloads"))).toBe(
      true,
    );
    expect(
      existsSync(
        join(directory, "home", "updates", "downloads", "0.3.0", "update.zip"),
      ),
    ).toBe(false);
  });

  it("有 MCP 进程时阻止安装，强制后可继续", async () => {
    const directory = tempDirectory();
    const home = join(directory, "home");
    const { fetchImpl } = routeFetch(manifest());
    const service = createService(directory, {
      home,
      fetchImpl,
      launchUpdater: () => ({ pid: 1 }),
    });
    await service.check();
    const registration = registerMcpProcess(home, {
      version: "0.2.0",
      schemaVersion: 12,
      writeEnabled: false,
    });
    try {
      expect(service.status().mcpProcesses).toHaveLength(1);
      await expectDomainError(
        () => service.startInstall({ version: "0.3.0", force: false }),
        "UPDATE_MCP_RUNNING",
      );
      service.startInstall({ version: "0.3.0", force: true });
      await waitFor(() =>
        service.status().install?.status === "installing" ? true : null,
      );
      const launched = readFileSync(
        join(home, "updates", "install-manifest.json"),
        "utf8",
      );
      expect(JSON.parse(launched).version).toBe("0.3.0");
    } finally {
      registration.close();
    }
  });
});

describe("更新状态", () => {
  it("读取更新器进度与最近一次更新结果", async () => {
    const directory = tempDirectory();
    const home = join(directory, "home");
    mkdirSync(join(home, "updates"), { recursive: true });
    writeFileSync(
      join(home, "updates", "update-progress.json"),
      JSON.stringify({
        status: "running",
        phase: "download",
        percent: 42,
        message: "正在下载更新包",
        updatedAt: "2026-10-23T08:00:00.000Z",
      }),
    );
    writeFileSync(
      join(home, "updates", "last-update.json"),
      JSON.stringify({
        ok: true,
        status: "updated",
        from: "0.2.0",
        to: "0.3.0",
      }),
    );
    const service = createService(directory, { home, isPackaged: false });
    const status = service.status();
    expect(status.installSupported).toBe(false);
    expect(status.unsupportedReason).toContain("开发环境");
    expect(status.updaterVersion).toBe("1.0.0");
    expect(status.progress).toMatchObject({ status: "running", percent: 42 });
    expect(status.lastUpdate).toMatchObject({ status: "updated", to: "0.3.0" });
  });
});

describe("更新接口", () => {
  it("要求登录，并在开发环境拒绝安装", async () => {
    const directory = tempDirectory();
    const app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
      update: { home: join(directory, "home"), isPackaged: false },
    });
    apps.push(app);
    const unauthorized = await app.inject("/api/update/status");
    expect(unauthorized.statusCode).toBe(401);

    await authedInject(app);
    const status = await app.inject("/api/update/status");
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      installSupported: false,
      currentVersion: expect.any(String),
    });
    const install = await app.inject({
      method: "POST",
      url: "/api/update/install",
      payload: { version: "0.3.0", force: false },
    });
    expect(install.statusCode).toBe(409);
    expect(install.json().error.code).toBe("UPDATE_UNSUPPORTED");
  });

  it("检查更新返回清单摘要", async () => {
    const directory = tempDirectory();
    const value = manifest({
      version: "0.2.0",
      platform: `${process.platform}-${process.arch}`,
      schemaVersion: SCHEMA_VERSION,
    });
    const app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
      update: {
        home: join(directory, "home"),
        isPackaged: false,
        fetchImpl: async () => jsonResponse(value),
      },
    });
    apps.push(app);
    await authedInject(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/update/check",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      latestVersion: "0.2.0",
      available: true,
      installable: false,
      blockedReason: expect.stringContaining("开发环境"),
    });
  });
});
