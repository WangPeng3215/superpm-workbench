import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  DATA_ROOT_SCHEMA_VERSION,
  dataRootConfigSchema,
  dataRootSources,
  homeMarkerSchema,
  homeMoveJobSchema,
  homeMoveStateSchema,
  movedMarkerSchema,
  operationLockSchema,
  type DataRootConfig,
  type DataRootResolution,
  type DataRootSource,
  type HomeMarker,
  type HomeMoveJob,
  type HomeMoveState,
  type MovedMarker,
  type OperationLock,
} from "./data-root-contract.js";

export type {
  DataRootConfig,
  DataRootResolution,
  DataRootSource,
  HomeMarker,
  HomeMoveJob,
  HomeMoveState,
  MovedMarker,
  OperationLock,
} from "./data-root-contract.js";

export type DataRootErrorCode =
  "CONFIG_INVALID" | "CONFIG_HOME_MISSING" | "CONFIG_HOME_EMPTY";

export class DataRootConfigError extends Error {
  constructor(
    message: string,
    public code: DataRootErrorCode,
  ) {
    super(message);
    this.name = "DataRootConfigError";
  }
}

export interface ResolveDataRootInput {
  env?: NodeJS.ProcessEnv;
  /** 当前是否为发布包；开发仓库为 false */
  packaged: boolean;
  /** 开发模式使用的仓库根 */
  developmentRoot: string;
  /** 更新器 --home 等显式命令行覆盖，优先于所有配置 */
  overrideHome?: string;
  platform?: NodeJS.Platform;
}

export interface ConfigLocationOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** 仅供测试或迁移助手覆盖配置目录 */
  configDir?: string;
}

export interface ReadDataRootConfigResult {
  config: DataRootConfig;
  path: string;
  usedBackup: boolean;
  warning?: string;
}

function readManifest(directory: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 发布包程序目录固定为 <安装目录>/app；清单形状兜底目录被改名的情况。 */
export function isPackagedRoot(directory: string): boolean {
  if (basename(directory) === "app") return true;
  const manifest = readManifest(directory);
  return (
    manifest !== null &&
    manifest.name === "superpm-workbench" &&
    !("workspaces" in manifest)
  );
}

export function defaultDataHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32")
    return join(
      env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"),
      "superPM",
    );
  if (platform === "darwin")
    return join(homedir(), "Library", "Application Support", "superPM");
  return join(
    env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"),
    "superpm",
  );
}

export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.SUPERPM_CONFIG_DIR?.trim();
  if (override) return resolve(override);
  if (platform === "win32")
    return join(
      env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming"),
      "superPM",
    );
  if (platform === "darwin")
    return join(homedir(), "Library", "Application Support", "superPM");
  return join(
    env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
    "superpm",
  );
}

function samePath(left: string, right: string, platform: NodeJS.Platform) {
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isNetworkPath(home: string, platform: NodeJS.Platform) {
  return platform === "win32" && /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(home);
}

function configError(value: unknown): string | undefined {
  const parsed = dataRootConfigSchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "格式无效";
  if (parsed.data.schemaVersion > DATA_ROOT_SCHEMA_VERSION)
    return `配置版本 ${parsed.data.schemaVersion} 高于当前支持的 ${DATA_ROOT_SCHEMA_VERSION}`;
  if (!isAbsolute(parsed.data.home)) return "数据根必须是绝对路径";
  return undefined;
}

function parseConfigFile(
  path: string,
):
  | { config: DataRootConfig; error?: undefined }
  | { config?: undefined; error: string } {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const error = configError(value);
    if (error) return { error };
    return { config: value as DataRootConfig };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 读取配置指针；文件不存在返回 null，损坏且备份也不可用时抛错。 */
export function readDataRootConfig(
  options: ConfigLocationOptions = {},
): ReadDataRootConfigResult | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configDir = options.configDir ?? resolveConfigDir(env, platform);
  const path = join(configDir, "config.json");
  if (!existsSync(path)) return null;

  const primary = parseConfigFile(path);
  if (primary.config)
    return { config: primary.config, path, usedBackup: false };

  const backupPath = `${path}.bak`;
  if (existsSync(backupPath)) {
    const backup = parseConfigFile(backupPath);
    if (backup.config)
      return {
        config: backup.config,
        path,
        usedBackup: true,
        warning: `配置文件 ${path} 不可用（${primary.error}），已改用备份 ${backupPath}。`,
      };
    throw new DataRootConfigError(
      `配置文件不可用：${path}（${primary.error}）；备份 ${backupPath} 也无法使用（${backup.error}）。请检查文件内容或将其改名以恢复默认数据根。`,
      "CONFIG_INVALID",
    );
  }
  throw new DataRootConfigError(
    `配置文件不可用：${path}（${primary.error}）。请检查文件内容或将其改名以恢复默认数据根。`,
    "CONFIG_INVALID",
  );
}

function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** 原子写入配置指针，并把旧配置保留为 config.json.bak。 */
export function writeDataRootConfig(
  config: DataRootConfig,
  options: ConfigLocationOptions = {},
): string {
  const error = configError(config);
  if (error)
    throw new DataRootConfigError(`配置指针无效：${error}`, "CONFIG_INVALID");
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configDir = options.configDir ?? resolveConfigDir(env, platform);
  const path = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeJsonAtomic(path, config);
  return path;
}

export function resolveDataRoot(
  options: ResolveDataRootInput,
): DataRootResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configDir = resolveConfigDir(env, platform);
  const configPath = join(configDir, "config.json");
  const explicitHome = options.overrideHome?.trim() || env.SUPERPM_HOME?.trim();
  let home: string;
  let source: DataRootSource;
  let warning: string | undefined;

  if (options.overrideHome?.trim()) {
    home = resolve(options.overrideHome.trim());
    source = "env";
  } else if (explicitHome) {
    home = resolve(explicitHome);
    const claimed = env.SUPERPM_HOME_SOURCE?.trim();
    const known = dataRootSources.includes(claimed as DataRootSource);
    source = known ? (claimed as DataRootSource) : "env";
    if (!options.packaged) source = "env";
    if (options.packaged && source === "config") {
      const pointer = readDataRootConfig({ env, platform, configDir });
      if (!pointer)
        throw new DataRootConfigError(
          `启动来源标记为配置文件，但未找到配置指针：${configPath}`,
          "CONFIG_INVALID",
        );
      if (!samePath(resolve(pointer.config.home), home, platform))
        throw new DataRootConfigError(
          `启动参数与配置指针不一致：${home} ≠ ${pointer.config.home}（${configPath}）`,
          "CONFIG_INVALID",
        );
      warning = pointer.warning;
    }
  } else if (!options.packaged) {
    home = resolve(options.developmentRoot);
    source = "development";
  } else {
    const pointer = readDataRootConfig({ env, platform, configDir });
    if (pointer) {
      home = resolve(pointer.config.home);
      source = "config";
      warning = pointer.warning;
    } else {
      home = defaultDataHome(env, platform);
      source = "default";
    }
  }

  if (!warning && isNetworkPath(home, platform))
    warning = `数据根位于网络路径：${home}。迁移后需要保持该盘连接，连接不可用时应用将拒绝启动。`;

  return {
    home,
    source,
    configDir,
    configPath,
    markerPath: join(home, ".superpm-home.json"),
    warning,
  };
}

export function expectedDatabasePath(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const setting = env.SUPERPM_DATA_DIR?.trim() || "data";
  return join(
    isAbsolute(setting) ? resolve(setting) : resolve(home, setting),
    "superpm.sqlite",
  );
}

/**
 * 配置指针指定的数据根必须已存在，且包含数据库或数据根标记。
 * 避免网络盘或移动硬盘未挂载时把空目录当成新数据根并静默建空库。
 */
export function assertDataRootAvailable(
  resolution: DataRootResolution,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (resolution.source !== "config") return;
  let isDirectory = false;
  try {
    isDirectory = statSync(resolution.home).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory)
    throw new DataRootConfigError(
      `数据根不可用：${resolution.home}（配置：${resolution.configPath}）。请检查移动硬盘或网络盘是否已连接；如需改回默认目录，请关闭应用后将 config.json 改名。`,
      "CONFIG_HOME_MISSING",
    );
  if (
    existsSync(expectedDatabasePath(resolution.home, env)) ||
    existsSync(resolution.markerPath)
  )
    return;
  throw new DataRootConfigError(
    `数据根为空且未发现数据库或数据根标记：${resolution.home}（配置：${resolution.configPath}）。为避免在空挂载目录中新建空库，已拒绝启动。`,
    "CONFIG_HOME_EMPTY",
  );
}

function readMarker<T>(
  path: string,
  parse: (value: unknown) => T | null,
): T | null {
  try {
    return parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export function readHomeMarker(home: string): HomeMarker | null {
  return readMarker(join(home, ".superpm-home.json"), (value) => {
    const parsed = homeMarkerSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
}

export function writeHomeMarker(home: string, marker: HomeMarker): string {
  const path = join(home, ".superpm-home.json");
  writeJsonAtomic(path, marker);
  return path;
}

export function readMovedMarker(oldHome: string): MovedMarker | null {
  return readMarker(join(oldHome, ".superpm-moved.json"), (value) => {
    const parsed = movedMarkerSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
}

export function writeMovedMarker(oldHome: string, marker: MovedMarker): string {
  const path = join(oldHome, ".superpm-moved.json");
  writeJsonAtomic(path, marker);
  return path;
}

export function moveHomePaths(configDir: string) {
  return {
    statePath: join(configDir, "move-home.json"),
    jobPath: join(configDir, "move-home-job.json"),
    lockPath: join(configDir, "operation.lock"),
    logsDir: join(configDir, "logs"),
  };
}

export function readMoveHomeState(configDir: string): HomeMoveState | null {
  return readMarker(moveHomePaths(configDir).statePath, (value) => {
    const parsed = homeMoveStateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
}

export function writeMoveHomeState(
  configDir: string,
  state: HomeMoveState,
): string {
  const path = moveHomePaths(configDir).statePath;
  writeJsonAtomic(path, state);
  return path;
}

export function readHomeMoveJob(configDir: string): HomeMoveJob | null {
  return readMarker(moveHomePaths(configDir).jobPath, (value) => {
    const parsed = homeMoveJobSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
}

export function writeHomeMoveJob(configDir: string, job: HomeMoveJob): string {
  const path = moveHomePaths(configDir).jobPath;
  writeJsonAtomic(path, job);
  return path;
}

export function readOperationLock(configDir: string): OperationLock | null {
  return readMarker(moveHomePaths(configDir).lockPath, (value) => {
    const parsed = operationLockSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 返回仍有效的迁移操作锁；持有进程已退出或心跳超时会清理陈旧锁。 */
export function activeOperationLock(configDir: string): OperationLock | null {
  const path = moveHomePaths(configDir).lockPath;
  const lock = readOperationLock(configDir);
  if (!lock) {
    try {
      const stat = statSync(path);
      if (Date.now() - stat.mtimeMs > 30 * 60 * 1000)
        rmSync(path, { force: true });
    } catch {
      // 文件不存在或不可读：视为无锁
    }
    return null;
  }
  if (!isProcessAlive(lock.pid)) {
    rmSync(path, { force: true });
    return null;
  }
  const heartbeat = Date.parse(lock.heartbeatAt ?? lock.startedAt);
  if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 30 * 60 * 1000) {
    rmSync(path, { force: true });
    return null;
  }
  return lock;
}

/** 独占创建操作锁；已有活跃锁时抛错。 */
export function acquireOperationLock(
  configDir: string,
  lock: OperationLock,
): string {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const path = moveHomePaths(configDir).lockPath;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = activeOperationLock(configDir);
      if (existing)
        throw new Error(
          `已有迁移正在进行（PID ${existing.pid}，任务 ${existing.jobId}）`,
        );
      rmSync(path, { force: true });
    }
  }
  throw new Error("无法创建迁移操作锁");
}

/** 迁移助手接管锁时使用，原子覆盖 PID 与心跳。 */
export function writeOperationLock(
  configDir: string,
  lock: OperationLock,
): string {
  const path = moveHomePaths(configDir).lockPath;
  writeJsonAtomic(path, lock);
  return path;
}

export function releaseOperationLock(
  configDir: string,
  jobId?: string,
): boolean {
  const lock = readOperationLock(configDir);
  if (jobId && lock && lock.jobId !== jobId) return false;
  rmSync(moveHomePaths(configDir).lockPath, { force: true });
  return true;
}

/** 用户选择的父目录名称已是 superPM 时直接使用，否则创建 superPM 子目录。 */
export function targetHomeForParent(parent: string): string {
  const resolved = resolve(parent);
  return basename(resolved).toLowerCase() === "superpm"
    ? resolved
    : join(resolved, "superPM");
}

export function isPathInside(
  base: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const distance = relative(resolve(base), resolve(target));
  if (distance === "") return true;
  const inside =
    !distance.startsWith(`..${platform === "win32" ? "\\" : "/"}`) &&
    distance !== ".." &&
    !isAbsolute(distance);
  return inside;
}
