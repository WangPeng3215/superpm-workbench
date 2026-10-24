import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  UPDATE_DEFAULT_MANIFEST_URL,
  updateAllowedHosts,
  updateManifestSchema,
  type UpdateCheckResult,
  type UpdateInstallState,
  type UpdateLastResult,
  type UpdateManifest,
  type UpdateMcpProcessInfo,
  type UpdateProgress,
  type UpdateStatus,
} from "@superpm/shared";
import { activeUpdateLock, listMcpProcesses } from "../runtime/state.js";
import { DomainError } from "./requirements.js";

const ALLOWED_HOSTS = new Set<string>(updateAllowedHosts);
const MANIFEST_MAX_BYTES = 1024 * 1024;
const ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;
const CHECK_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export type UpdateFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface LaunchUpdaterInput {
  node: string;
  updater: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type LaunchUpdater = (
  input: LaunchUpdaterInput,
) => { pid?: number } | Promise<{ pid?: number }>;

export interface UpdateServiceOptions {
  home: string;
  installRoot: string;
  appRoot: string;
  currentVersion: string;
  schemaVersion: number;
  isPackaged: boolean;
  manifestUrl?: string;
  fetchImpl?: UpdateFetch;
  launchUpdater?: LaunchUpdater;
  platform?: string;
}

interface CachedManifest {
  source: string;
  checkedAt: string;
  manifest: UpdateManifest;
}

const progressFileSchema = z.object({
  status: z.enum([
    "starting",
    "running",
    "up-to-date",
    "updated",
    "failed",
    "rolled-back",
    "rollback-failed",
  ]),
  phase: z.string().max(100).default(""),
  percent: z.number().min(0).max(100).default(0),
  message: z.string().max(1000).default(""),
  from: z.string().max(50).optional(),
  to: z.string().max(50).optional(),
  received: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
  pid: z.number().int().positive().optional(),
  startedAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100),
  error: z.string().max(2000).optional(),
});

const lastUpdateSchema = z.object({
  ok: z.boolean(),
  status: z.string().max(50),
  from: z.string().max(50).optional(),
  to: z.string().max(50).optional(),
  version: z.string().max(50).optional(),
  error: z.string().max(2000).optional(),
  rollbackError: z.string().max(2000).optional(),
  restartError: z.string().max(2000).optional(),
  backupId: z.string().max(200).optional(),
  schemaVersion: z.number().int().nonnegative().optional(),
  port: z.number().int().positive().optional(),
  finishedAt: z.string().max(100).optional(),
  logs: z.array(z.string().max(2000)).max(1000).optional(),
});

const cacheFileSchema = z.object({
  source: z.string().max(2000),
  checkedAt: z.string().max(100),
  manifest: updateManifestSchema,
});

function parseVersion(value: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(
    String(value ?? "").trim(),
  );
  if (!match) throw new Error(`版本号无效：${value}`);
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? "",
  };
}

export function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index])
      return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease === b.prerelease
    ? 0
    : a.prerelease > b.prerelease
      ? 1
      : -1;
}

function readJson<T>(path: string, schema: z.ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

async function launchDetached(input: LaunchUpdaterInput) {
  const child = spawn(input.node, [input.updater, ...input.args], {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  return new Promise<{ pid?: number }>((done, fail) => {
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      done({ pid: child.pid });
    });
  });
}

export class UpdateService {
  private readonly home: string;
  private readonly installRoot: string;
  private readonly appRoot: string;
  private readonly currentVersion: string;
  private readonly schemaVersion: number;
  private readonly isPackaged: boolean;
  private readonly manifestUrl: string;
  private readonly platform: string;
  private readonly fetchImpl: UpdateFetch;
  private readonly launchUpdater: LaunchUpdater;
  private installState: UpdateInstallState | null = null;
  private installTask: Promise<void> | null = null;
  private checkTask: Promise<UpdateCheckResult> | null = null;

  constructor(options: UpdateServiceOptions) {
    this.home = resolve(options.home);
    this.installRoot = resolve(options.installRoot);
    this.appRoot = resolve(options.appRoot);
    this.currentVersion = options.currentVersion;
    this.schemaVersion = options.schemaVersion;
    this.isPackaged = options.isPackaged;
    this.manifestUrl =
      options.manifestUrl?.trim() || UPDATE_DEFAULT_MANIFEST_URL;
    this.platform = options.platform ?? `${process.platform}-${process.arch}`;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.launchUpdater = options.launchUpdater ?? launchDetached;
  }

  private updatesDir() {
    return join(this.home, "updates");
  }
  private cachePath() {
    return join(this.updatesDir(), "available-manifest.json");
  }
  private installManifestPath() {
    return join(this.updatesDir(), "install-manifest.json");
  }
  private progressPath() {
    return join(this.updatesDir(), "update-progress.json");
  }
  private lastUpdatePath() {
    return join(this.updatesDir(), "last-update.json");
  }
  private downloadRoot() {
    return join(this.updatesDir(), "downloads");
  }
  private runtimeNode() {
    return join(
      this.installRoot,
      "runtime",
      this.platform.startsWith("win32") ? "node.exe" : "node",
    );
  }
  private updaterPath() {
    return join(this.installRoot, "bin", "updater.mjs");
  }

  private support(): { supported: boolean; reason: string | null } {
    if (!this.isPackaged)
      return {
        supported: false,
        reason:
          "当前未检测到发布安装布局（程序目录应为安装目录下的 app/），应用内更新不可用；请使用 Update.cmd 或完整安装包。",
      };
    if (!existsSync(join(this.appRoot, "package.json")))
      return { supported: false, reason: "当前程序目录不完整，无法执行更新。" };
    if (!existsSync(this.updaterPath()))
      return { supported: false, reason: "安装目录缺少 bin/updater.mjs。" };
    if (resolve(this.appRoot) !== resolve(this.installRoot, "app"))
      return {
        supported: false,
        reason: "程序目录不属于当前安装目录，无法执行更新。",
      };
    return { supported: true, reason: null };
  }

  private readUpdaterVersion(): string | null {
    try {
      const manifest = JSON.parse(
        readFileSync(join(this.installRoot, "install.json"), "utf8"),
      ) as { updaterVersion?: unknown };
      return typeof manifest.updaterVersion === "string"
        ? manifest.updaterVersion
        : null;
    } catch {
      return null;
    }
  }

  private liveMcpProcesses(): UpdateMcpProcessInfo[] {
    return listMcpProcesses(this.home)
      .filter((item) => item.alive)
      .map((item) => ({
        pid: item.record.pid,
        version: item.record.version,
        startedAt: item.record.startedAt,
        heartbeatAt: item.record.heartbeatAt,
        stale: item.stale,
      }));
  }

  status(): UpdateStatus {
    const support = this.support();
    const lock = activeUpdateLock(this.home);
    return {
      currentVersion: this.currentVersion,
      schemaVersion: this.schemaVersion,
      dataRoot: this.home,
      manifestUrl: this.manifestUrl,
      installSupported: support.supported,
      unsupportedReason: support.reason,
      updaterVersion: this.readUpdaterVersion(),
      updateLock: lock
        ? {
            pid: lock.pid,
            createdAt: lock.createdAt,
            ...(lock.version ? { version: lock.version } : {}),
          }
        : null,
      mcpProcesses: this.liveMcpProcesses(),
      install: this.installState ? { ...this.installState } : null,
      progress: readJson<UpdateProgress>(
        this.progressPath(),
        progressFileSchema as z.ZodType<UpdateProgress>,
      ),
      lastUpdate: readJson<UpdateLastResult>(
        this.lastUpdatePath(),
        lastUpdateSchema as z.ZodType<UpdateLastResult>,
      ),
    };
  }

  check(): Promise<UpdateCheckResult> {
    if (!this.checkTask)
      this.checkTask = this.performCheck().finally(() => {
        this.checkTask = null;
      });
    return this.checkTask;
  }

  private async performCheck(): Promise<UpdateCheckResult> {
    const source = this.allowedUrl(this.manifestUrl);
    const manifest = await this.fetchManifest(source);
    this.assertCompatible(manifest);
    const checkedAt = new Date().toISOString();
    writeJsonAtomic(this.cachePath(), {
      source,
      checkedAt,
      manifest,
    } satisfies CachedManifest);
    const available =
      compareVersions(manifest.version, this.currentVersion) > 0;
    const blockedReason = available ? this.installBlockReason(manifest) : null;
    return {
      checkedAt,
      source,
      currentVersion: this.currentVersion,
      latestVersion: manifest.version,
      available,
      installable: available && !blockedReason,
      blockedReason,
      notes: manifest.notes ?? "",
      releasedAt: manifest.releasedAt,
      schemaVersion: manifest.schemaVersion,
      minUpdaterVersion: manifest.minUpdaterVersion ?? null,
      updateFile: manifest.update.file,
      updateSize: manifest.update.size,
    };
  }

  startInstall(request: { version: string; force: boolean }): {
    accepted: true;
  } {
    const support = this.support();
    if (!support.supported)
      throw new DomainError(
        "UPDATE_UNSUPPORTED",
        support.reason ?? "当前环境不支持应用内更新",
        409,
      );
    if (this.installTask)
      throw new DomainError(
        "UPDATE_BUSY",
        "已有更新任务正在进行，请稍候。",
        409,
      );
    if (
      this.installState?.status === "installing" &&
      Date.now() - Date.parse(this.installState.updatedAt) < 120000
    )
      throw new DomainError(
        "UPDATE_BUSY",
        "更新器已启动，请等待服务重启。",
        409,
      );
    const lock = activeUpdateLock(this.home);
    if (lock)
      throw new DomainError(
        "UPDATE_BUSY",
        `已有更新正在进行（PID ${lock.pid}，开始于 ${lock.createdAt}），请稍候。`,
        409,
      );
    const cached = readJson<CachedManifest>(this.cachePath(), cacheFileSchema);
    if (!cached)
      throw new DomainError(
        "UPDATE_NOT_CHECKED",
        "尚未获取可安装的更新清单，请先检查更新。",
        409,
      );
    if (cached.manifest.version !== request.version)
      throw new DomainError(
        "UPDATE_VERSION_CHANGED",
        `发布源版本已变化（当前为 v${cached.manifest.version}），请重新检查更新。`,
        409,
      );
    this.assertCompatible(cached.manifest);
    if (compareVersions(cached.manifest.version, this.currentVersion) <= 0)
      throw new DomainError(
        "UPDATE_NOT_AVAILABLE",
        `目标版本 v${cached.manifest.version} 不高于当前版本 v${this.currentVersion}。`,
        409,
      );
    const blockedReason = this.installBlockReason(cached.manifest);
    if (blockedReason)
      throw new DomainError("UPDATE_BLOCKED", blockedReason, 409);
    const live = this.liveMcpProcesses();
    if (live.length > 0 && !request.force)
      throw new DomainError(
        "UPDATE_MCP_RUNNING",
        `检测到 ${live.length} 个 MCP 进程正在运行（PID ${live
          .map((item) => item.pid)
          .join(", ")}）。请关闭 MCP 客户端后重试，或选择强制更新。`,
        409,
      );

    const target = cached.manifest.version;
    const downloadDir = join(this.downloadRoot(), target);
    rmSync(this.downloadRoot(), { recursive: true, force: true });
    mkdirSync(downloadDir, { recursive: true });
    const archivePath = join(downloadDir, "update.zip");
    writeJsonAtomic(this.installManifestPath(), {
      ...cached.manifest,
      update: {
        ...cached.manifest.update,
        url: pathToFileURL(archivePath).href,
      },
    });
    const startedAt = new Date().toISOString();
    this.installState = {
      status: "downloading",
      percent: 0,
      received: 0,
      total: cached.manifest.update.size,
      message: "正在下载更新包",
      version: target,
      startedAt,
      updatedAt: startedAt,
    };
    this.installTask = this.runInstall({
      manifest: cached.manifest,
      source: cached.source,
      archivePath,
      force: request.force,
    }).finally(() => {
      this.installTask = null;
    });
    return { accepted: true };
  }

  private async runInstall(input: {
    manifest: UpdateManifest;
    source: string;
    archivePath: string;
    force: boolean;
  }): Promise<void> {
    try {
      const artifactUrl = this.allowedUrl(
        new URL(input.manifest.update.url, input.source).toString(),
      );
      await this.downloadArtifact(
        artifactUrl,
        input.archivePath,
        input.manifest.update,
      );
      this.setInstallState({
        status: "verifying",
        percent: 97,
        message: "更新包校验通过，准备启动更新器",
      });
      const live = this.liveMcpProcesses();
      if (live.length > 0 && !input.force)
        throw new Error(
          `检测到 ${live.length} 个 MCP 进程正在运行，请关闭客户端后重试，或选择强制更新。`,
        );
      const runtimeNode = this.runtimeNode();
      const node = existsSync(runtimeNode) ? runtimeNode : process.execPath;
      this.setInstallState({
        status: "launching",
        percent: 99,
        message: "正在启动独立更新器",
      });
      await this.launchUpdater({
        node,
        updater: this.updaterPath(),
        args: [
          "--manifest",
          this.installManifestPath(),
          "--install-root",
          this.installRoot,
          "--home",
          this.home,
          ...(input.force ? ["--force"] : []),
        ],
        cwd: this.installRoot,
        env: {
          ...process.env,
          SUPERPM_HOME: this.home,
          SUPERPM_INSTALL_ROOT: this.installRoot,
        },
      });
      this.setInstallState({
        status: "installing",
        percent: 100,
        message: "更新器已启动，服务即将重启",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新失败";
      this.installState = {
        ...(this.installState ?? {
          status: "failed",
          percent: 0,
          received: 0,
          total: 0,
          version: input.manifest.version,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message,
        }),
        status: "failed",
        message,
        error: message,
        updatedAt: new Date().toISOString(),
      };
      rmSync(input.archivePath, { force: true });
    }
  }

  private setInstallState(patch: Partial<UpdateInstallState>) {
    if (!this.installState) return;
    this.installState = {
      ...this.installState,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  private async downloadArtifact(
    url: string,
    target: string,
    artifact: { size: number; sha256: string },
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchWithRedirects(url, {
        headers: { "user-agent": "superpm-updater/1.0.0" },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DomainError(
        "UPDATE_DOWNLOAD_FAILED",
        `无法下载更新包：${error instanceof Error ? error.message : "网络异常"}`,
        502,
      );
    }
    if (!response.body)
      throw new DomainError("UPDATE_DOWNLOAD_FAILED", "更新包响应为空。", 502);
    const hash = createHash("sha256");
    let received = 0;
    let percent = 0;
    const total = artifact.size;
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        if (received > ARTIFACT_MAX_BYTES) {
          callback(new Error("更新包超过大小限制"));
          return;
        }
        hash.update(chunk);
        const next = Math.min(94, Math.floor((received / total) * 94));
        if (next !== percent) {
          percent = next;
          this.setInstallState({
            status: "downloading",
            percent: next,
            received,
            total,
            message: "正在下载更新包",
          });
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream<Uint8Array>,
        ),
        counter,
        createWriteStream(target, { mode: 0o600 }),
      );
    } catch (error) {
      rmSync(target, { force: true });
      throw new DomainError(
        "UPDATE_DOWNLOAD_FAILED",
        `下载更新包失败：${error instanceof Error ? error.message : "网络异常"}`,
        502,
      );
    }
    this.setInstallState({
      status: "verifying",
      percent: 95,
      received,
      total,
      message: "正在校验更新包摘要",
    });
    if (received !== artifact.size) {
      rmSync(target, { force: true });
      throw new DomainError(
        "UPDATE_DOWNLOAD_FAILED",
        `更新包大小不一致：期望 ${artifact.size}，实际 ${received}。`,
        502,
      );
    }
    const digest = hash.digest("hex");
    if (digest.toLowerCase() !== artifact.sha256.toLowerCase()) {
      rmSync(target, { force: true });
      throw new DomainError(
        "UPDATE_DOWNLOAD_FAILED",
        "更新包摘要不一致，已删除下载文件。",
        502,
      );
    }
    this.setInstallState({
      status: "verifying",
      percent: 97,
      received,
      total,
      message: "更新包摘要校验通过",
    });
  }

  private assertCompatible(manifest: UpdateManifest) {
    if (manifest.platform !== this.platform)
      throw new DomainError(
        "UPDATE_MANIFEST_INVALID",
        `更新包平台不匹配：需要 ${this.platform}，清单为 ${manifest.platform}。`,
        502,
      );
    if (manifest.schemaVersion < this.schemaVersion)
      throw new DomainError(
        "UPDATE_MANIFEST_INVALID",
        `目标数据库版本 ${manifest.schemaVersion} 低于当前 ${this.schemaVersion}，不允许降级。`,
        502,
      );
  }

  private installBlockReason(manifest: UpdateManifest): string | null {
    const support = this.support();
    if (!support.supported) return support.reason;
    if (manifest.minUpdaterVersion) {
      const local = this.readUpdaterVersion();
      if (!local) return "无法确认本地更新器版本，请重新下载完整安装包。";
      if (compareVersions(local, manifest.minUpdaterVersion) < 0)
        return `需要更新器 v${manifest.minUpdaterVersion}，当前为 v${local}，请下载完整安装包。`;
    }
    return null;
  }

  private allowedUrl(raw: string, base?: string): string {
    let parsed: URL;
    try {
      parsed = new URL(raw, base);
    } catch {
      throw new DomainError(
        "UPDATE_SOURCE_INVALID",
        `更新源地址无效：${raw}`,
        502,
      );
    }
    if (parsed.protocol !== "https:")
      throw new DomainError(
        "UPDATE_SOURCE_INVALID",
        `更新源必须使用 HTTPS：${parsed.hostname}`,
        502,
      );
    if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase()))
      throw new DomainError(
        "UPDATE_SOURCE_INVALID",
        `更新源主机不在允许列表：${parsed.hostname}`,
        502,
      );
    if (parsed.username || parsed.password)
      throw new DomainError(
        "UPDATE_SOURCE_INVALID",
        "更新源地址不允许包含账号信息。",
        502,
      );
    if (parsed.port && parsed.port !== "443")
      throw new DomainError(
        "UPDATE_SOURCE_INVALID",
        `更新源端口不允许：${parsed.port}`,
        502,
      );
    return parsed.toString();
  }

  private async fetchWithRedirects(
    url: string,
    init: RequestInit,
    redirects = 0,
  ): Promise<Response> {
    const safe = this.allowedUrl(url);
    const response = await this.fetchImpl(safe, {
      ...init,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("更新源返回重定向但缺少 Location");
      if (redirects >= 5) throw new Error("更新源重定向次数过多");
      await response.body?.cancel();
      return this.fetchWithRedirects(
        new URL(location, safe).toString(),
        init,
        redirects + 1,
      );
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`更新源返回 HTTP ${response.status}`);
    }
    return response;
  }

  private async fetchManifest(source: string): Promise<UpdateManifest> {
    let buffer: Buffer;
    try {
      const response = await this.fetchWithRedirects(source, {
        headers: { "user-agent": "superpm-updater/1.0.0" },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new DomainError(
        "UPDATE_SOURCE_FAILED",
        `无法读取更新源：${error instanceof Error ? error.message : "网络异常"}`,
        502,
      );
    }
    if (buffer.length > MANIFEST_MAX_BYTES)
      throw new DomainError(
        "UPDATE_MANIFEST_INVALID",
        "更新清单超过大小限制。",
        502,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new DomainError(
        "UPDATE_MANIFEST_INVALID",
        "更新清单不是有效的 JSON。",
        502,
      );
    }
    const result = updateManifestSchema.safeParse(parsed);
    if (!result.success)
      throw new DomainError(
        "UPDATE_MANIFEST_INVALID",
        `更新清单无效：${result.error.issues[0]?.message ?? "格式错误"}`,
        502,
      );
    return result.data;
  }
}

export function createUpdateService(options: UpdateServiceOptions) {
  return new UpdateService(options);
}
