import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  activeOperationLock,
  acquireOperationLock,
  isPathInside,
  moveHomePaths,
  readHomeMarker,
  readMovedMarker,
  readMoveHomeState,
  releaseOperationLock,
  targetHomeForParent,
  writeHomeMoveJob,
  writeMoveHomeState,
  type DataRootSource,
  type HomeMoveJob,
  type HomeMoveState,
  type OperationLock,
} from "@superpm/shared/data-root";
import type {
  DataRootLockedReason,
  HomeCleanupRequest,
  HomeCleanupResult,
  HomeMoveErrorCode,
  HomeMoveStartResult,
  HomeMoveView,
  HomeValidationResult,
  PendingOldData,
} from "@superpm/shared/data-root-contract";
import {
  dataRootLockedReasonLabels,
  homeMoveJobSchema,
} from "@superpm/shared/data-root-contract";
import { inspectDatabase } from "../db/inspect.js";
import { activeUpdateLock, listMcpProcesses } from "../runtime/state.js";
import { DomainError } from "./requirements.js";
import { buildSystemOpenCommand } from "./system-open.js";
import { walkWorkspace } from "./workspace-scan.js";

const SPACE_FACTOR = 1.15;
const SPACE_RESERVE_BYTES = 256 * 1024 * 1024;
const MAX_TARGET_LENGTH = 200;
const CLEANUP_ALLOWED_PATHS = new Set(["data", "workspace", "backups", ".env"]);

export class HomeMoveError extends Error {
  constructor(
    public code: HomeMoveErrorCode,
    message: string,
    public status = 409,
    public details?: unknown,
  ) {
    super(message);
    this.name = "HomeMoveError";
  }
}

export interface DataRootHelperLaunchInput {
  node: string;
  helper: string;
  jobPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type LaunchDataRootHelper = (
  input: DataRootHelperLaunchInput,
) => Promise<{ pid?: number }> | { pid?: number };

export interface DataRootServiceOptions {
  home: string;
  homeSource: DataRootSource;
  configDir: string;
  installRoot: string;
  appRoot: string;
  isPackaged: boolean;
  databasePath: string;
  workspacePath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  launchHelper?: LaunchDataRootHelper;
  probeNetworkDrive?: (target: string) => boolean;
  now?: () => Date;
}

export interface DataRootInfo {
  dataRootEditable: boolean;
  dataRootLockedReason?: DataRootLockedReason;
  moveInProgress: boolean;
  pendingOldData?: PendingOldData;
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isEmptyDirectory(path: string) {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function samePath(left: string, right: string, platform: NodeJS.Platform) {
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function nearestExisting(path: string): string {
  let current = resolve(path);
  while (true) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function freeBytesAt(path: string): number {
  try {
    const stats = statfsSync(nearestExisting(path));
    return stats.bavail * stats.bsize;
  } catch {
    return 0;
  }
}

function canWriteTo(path: string): boolean {
  const probe = join(
    nearestExisting(path),
    `.superpm-write-probe-${process.pid}-${Date.now()}`,
  );
  try {
    writeFileSync(probe, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
}

function measureTree(root: string, skip: Set<string> = new Set()): number {
  if (!existsSync(root)) return 0;
  let total = 0;
  const visit = (current: string) => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of names) {
      const full = join(current, entry);
      if (skip.has(resolve(full))) continue;
      let info;
      try {
        info = lstatSync(full);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) visit(full);
      else total += info.size;
    }
  };
  visit(resolve(root));
  return total;
}

function fileBytes(path: string): number {
  try {
    const info = statSync(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

function detectNetworkDrive(target: string): boolean {
  if (process.platform !== "win32") return false;
  const root = parse(resolve(target)).root;
  const letter = /^([A-Za-z]):[\\/]$/.exec(root)?.[1];
  if (!letter) return false;
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'").DriveType`,
      ],
      { timeout: 1500, windowsHide: true, encoding: "utf8" },
    );
    return output.trim() === "4";
  } catch {
    return false;
  }
}

async function launchDetached(input: DataRootHelperLaunchInput) {
  const child = spawn(input.node, [input.helper, "--job", input.jobPath], {
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

function removePathSafely(target: string): void {
  let info;
  try {
    info = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    // junction / 符号链接只删除链接本身，绝不跟随到目标
    try {
      unlinkSync(target);
    } catch {
      rmdirSync(target);
    }
    return;
  }
  if (info.isDirectory()) {
    for (const name of readdirSync(target))
      removePathSafely(join(target, name));
    rmdirSync(target);
    return;
  }
  unlinkSync(target);
}

function formatJobId(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(
    date.getDate(),
  )}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(
    date.getSeconds(),
  )}-${randomBytes(3).toString("hex")}`;
}

export class DataRootService {
  private readonly home: string;
  private readonly homeSource: DataRootSource;
  private readonly configDir: string;
  private readonly installRoot: string;
  private readonly appRoot: string;
  private readonly isPackaged: boolean;
  private readonly databasePath: string;
  private readonly workspacePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly launchHelper: LaunchDataRootHelper;
  private readonly probeNetworkDrive: (target: string) => boolean;

  constructor(options: DataRootServiceOptions) {
    this.home = resolve(options.home);
    this.homeSource = options.homeSource;
    this.configDir = resolve(options.configDir);
    this.installRoot = resolve(options.installRoot);
    this.appRoot = resolve(options.appRoot);
    this.isPackaged = options.isPackaged;
    this.databasePath = options.databasePath;
    this.workspacePath = resolve(options.workspacePath);
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date());
    this.launchHelper = options.launchHelper ?? launchDetached;
    this.probeNetworkDrive =
      options.probeNetworkDrive ??
      ((target) =>
        (options.platform ?? process.platform) === "win32"
          ? detectNetworkDrive(target)
          : false);
  }

  private get paths() {
    return moveHomePaths(this.configDir);
  }

  private helperPath() {
    return join(this.installRoot, "bin", "move-home.mjs");
  }

  private runtimeNode() {
    const path = join(
      this.installRoot,
      "runtime",
      this.platform === "win32" ? "node.exe" : "node",
    );
    return existsSync(path) ? path : process.execPath;
  }

  private log(message: string) {
    try {
      const directory = join(this.configDir, "logs");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(
          directory,
          `move-home-${this.now().toISOString().slice(0, 10)}.log`,
        ),
        `${this.now().toISOString()} ${message}\n`,
        { flag: "a", mode: 0o600 },
      );
    } catch {
      // 配置目录日志不可写时不影响迁移判断
    }
  }

  private configDirWritable(): boolean {
    return canWriteTo(this.configDir);
  }

  location(): { home: string; source: DataRootSource } {
    return { home: this.home, source: this.homeSource };
  }

  openHome(): void {
    if (!isDirectory(this.home))
      throw new DomainError(
        "HOME_OPEN_FAILED",
        `数据根目录不存在：${this.home}`,
        404,
      );
    const { command, args } = buildSystemOpenCommand(this.home, {
      platform: this.platform,
    });
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  }

  lockedReason(): DataRootLockedReason | undefined {
    if (this.homeSource === "development") return "development";
    if (!this.isPackaged) return "not-packaged";
    if (this.homeSource === "env") return "environment";
    if (
      !samePath(this.appRoot, join(this.installRoot, "app"), this.platform) ||
      !existsSync(this.helperPath())
    )
      return "not-packaged";
    if (!this.configDirWritable()) return "config-unwritable";
    return undefined;
  }

  private readState(): HomeMoveState | null {
    const state = readMoveHomeState(this.configDir);
    if (!state) return null;
    if (state.status !== "running" || activeOperationLock(this.configDir))
      return state;
    return this.reconcile(state);
  }

  private reconcile(state: HomeMoveState): HomeMoveState {
    const marker = readHomeMarker(state.toHome);
    const reachedTarget =
      samePath(this.home, state.toHome, this.platform) &&
      marker?.jobId === state.jobId;
    const updatedAt = this.now().toISOString();
    const next: HomeMoveState = reachedTarget
      ? {
          ...state,
          status: "completed",
          phase: "completed",
          updatedAt,
          error: undefined,
          cleanup: state.cleanup === "none" ? "pending" : state.cleanup,
          oldHome: state.fromHome,
          managedPaths: state.managedPaths ?? [
            "data",
            "workspace",
            "backups",
            ".env",
          ],
          movedAt: updatedAt,
        }
      : {
          ...state,
          status: "failed",
          phase: "failed",
          updatedAt,
          error: {
            message:
              "迁移进程已退出，未完成数据切换；当前仍使用原数据根。请查看迁移日志后重试。",
            phase: state.phase,
            rollback: "not-needed",
          },
        };
    try {
      writeMoveHomeState(this.configDir, next);
      this.log(
        reachedTarget
          ? `收尾迁移任务 ${state.jobId}：已完成数据切换`
          : `收尾迁移任务 ${state.jobId}：进程中断，标记失败`,
      );
    } catch {
      // 状态无法写入时保留原状态，不阻断服务启动
    }
    return next;
  }

  /** 服务启动时收敛“进程在写完成状态前退出”的迁移任务。 */
  reconcileStartup(): void {
    if (!this.isPackaged) return;
    try {
      this.readState();
    } catch {
      // 状态文件损坏时界面回退为未知状态，不阻断启动
    }
  }

  info(): DataRootInfo {
    const reason = this.lockedReason();
    let state: HomeMoveState | null = null;
    try {
      state = this.readState();
    } catch {
      state = null;
    }
    const pending =
      state?.status === "completed" &&
      state.cleanup === "pending" &&
      state.oldHome &&
      state.movedAt
        ? {
            jobId: state.jobId,
            oldHome: state.oldHome,
            movedAt: state.movedAt,
            managedPaths: state.managedPaths ?? [],
          }
        : undefined;
    return {
      dataRootEditable: reason === undefined,
      ...(reason ? { dataRootLockedReason: reason } : {}),
      moveInProgress: activeOperationLock(this.configDir) !== null,
      ...(pending ? { pendingOldData: pending } : {}),
    };
  }

  stateView(): HomeMoveView {
    if (!this.isPackaged) return { status: "idle" };
    const state = this.readState();
    if (!state) return { status: "idle" };
    return {
      status: state.status,
      jobId: state.jobId,
      phase: state.phase,
      fromHome: state.fromHome,
      toHome: state.toHome,
      progress: state.progress,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      error: state.error,
      cleanup: state.cleanup,
      oldHome: state.oldHome,
      managedPaths: state.managedPaths,
      movedAt: state.movedAt,
    };
  }

  private sourceSettings() {
    return {
      data: this.env.SUPERPM_DATA_DIR?.trim() || "data",
      workspace: this.env.SUPERPM_WORKSPACE_DIR?.trim() || "workspace",
    };
  }

  validate(parentInput: string): HomeValidationResult {
    const parent = parentInput.trim();
    const result: HomeValidationResult = {
      targetHome: parent,
      exists: false,
      empty: true,
      writable: false,
      freeBytes: 0,
      requiredBytes: SPACE_RESERVE_BYTES,
      sourceBytes: 0,
      databaseExists: false,
      workspaceFiles: 0,
      warnings: [],
      blockedReasons: [],
    };
    const block = (reason: string) => {
      if (!result.blockedReasons.includes(reason))
        result.blockedReasons.push(reason);
    };

    if (!parent || !isAbsolute(parent)) {
      block("请输入绝对路径");
      return result;
    }
    if (parent.startsWith("\\\\") || parent.startsWith("//")) {
      block("不支持 UNC 网络路径，请选择已映射的本地盘符");
      return result;
    }
    const target = targetHomeForParent(parent);
    result.targetHome = target;
    if (target.length > MAX_TARGET_LENGTH) {
      block(`保存路径过长（${target.length} 个字符），请选择更短的目录`);
      return result;
    }
    if (samePath(parse(target).root, target, this.platform)) {
      block("不能直接使用盘符根目录或文件系统根目录");
      return result;
    }

    if (!isDirectory(parent)) {
      block("父目录不存在或不是目录");
      return result;
    }
    result.exists = existsSync(target);
    if (result.exists) {
      if (!isDirectory(target)) block("目标路径已存在同名文件");
      else if (!isEmptyDirectory(target))
        block("目标目录已存在且非空，请选择其他位置");
      else result.empty = true;
    }
    result.writable = canWriteTo(result.exists ? target : parent);

    const current = this.home;
    if (samePath(target, current, this.platform))
      block("目标目录就是当前数据根");
    else if (isPathInside(current, target, this.platform))
      block("目标目录位于当前数据根内部");
    else if (isPathInside(target, current, this.platform))
      block("目标目录包含当前数据根");
    if (
      isPathInside(this.installRoot, target, this.platform) ||
      isPathInside(target, this.installRoot, this.platform)
    )
      block("目标目录与安装目录不能互相包含");
    if (isPathInside(this.configDir, target, this.platform))
      block("目标目录不能位于配置目录内部");

    const settings = this.sourceSettings();
    if (isAbsolute(settings.data))
      block("SUPERPM_DATA_DIR 使用绝对路径指定了数据目录，请先改回相对路径");
    if (isAbsolute(settings.workspace))
      block("SUPERPM_WORKSPACE_DIR 使用绝对路径指定了工作区，请先改回相对路径");
    const dataDir = isAbsolute(settings.data)
      ? resolve(settings.data)
      : resolve(this.home, settings.data);
    const workspaceDir = isAbsolute(settings.workspace)
      ? resolve(settings.workspace)
      : resolve(this.home, settings.workspace);
    if (!isPathInside(this.home, dataDir, this.platform))
      block("数据目录不在当前数据根内");
    if (!isPathInside(this.home, workspaceDir, this.platform))
      block("工作区目录不在当前数据根内");
    if (
      isPathInside(dataDir, workspaceDir, this.platform) ||
      isPathInside(workspaceDir, dataDir, this.platform)
    )
      block("数据目录与工作区目录不能互相包含");

    const database =
      this.databasePath === ":memory:" ? null : resolve(this.databasePath);
    const workspace = walkWorkspace(this.workspacePath);
    result.workspaceFiles = workspace.files;
    result.databaseExists = database ? existsSync(database) : false;
    if (result.databaseExists && database) {
      try {
        const snapshot = inspectDatabase(database);
        result.databaseRows = Object.values(snapshot.tables).reduce(
          (total, count) => total + count,
          0,
        );
      } catch (error) {
        block(
          `数据库完整性检查失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (workspace.files > 0) {
      block("数据库缺失但工作区仍有文件，数据不完整，已拒绝迁移");
    }

    const skip = new Set<string>();
    let databaseBytes = 0;
    if (database) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const path = `${database}${suffix}`;
        skip.add(resolve(path));
        databaseBytes += fileBytes(path);
      }
    }
    const dataOtherBytes = measureTree(dataDir, skip);
    const envPath = join(this.home, ".env");
    result.sourceBytes =
      databaseBytes +
      dataOtherBytes +
      workspace.bytes +
      fileBytes(envPath) +
      measureTree(join(this.home, "backups"));
    result.requiredBytes = Math.ceil(
      result.sourceBytes * SPACE_FACTOR + SPACE_RESERVE_BYTES,
    );
    result.freeBytes = freeBytesAt(result.exists ? target : parent);
    if (result.freeBytes < result.requiredBytes)
      block(
        `目标可用空间不足：需要 ${Math.ceil(
          result.requiredBytes / 1024 / 1024,
        )} MB，当前可用 ${Math.floor(result.freeBytes / 1024 / 1024)} MB`,
      );
    if (!result.writable) block("没有写入目标目录的权限");

    try {
      if (this.probeNetworkDrive(target))
        result.warnings.push(
          "目标位于网络映射盘。迁移后需要保持该盘连接；连接不可用时应用将拒绝以空目录启动。",
        );
    } catch {
      // 探测失败不影响校验
    }
    if (target !== resolve(parent))
      result.warnings.push(`将在所选目录下创建 superPM 子目录：${target}`);
    return result;
  }

  private assertBusyFree() {
    if (activeOperationLock(this.configDir))
      throw new HomeMoveError(
        "HOME_MOVE_BUSY",
        "已有迁移任务正在进行，请稍候。",
        409,
      );
    if (activeUpdateLock(this.home))
      throw new HomeMoveError(
        "HOME_MOVE_BUSY",
        "更新任务正在进行，请先完成更新再修改保存位置。",
        409,
      );
    const liveMcp = listMcpProcesses(this.home).filter((item) => item.alive);
    if (liveMcp.length > 0)
      throw new HomeMoveError(
        "HOME_MOVE_BUSY",
        `检测到 ${liveMcp.length} 个 MCP 进程正在运行（PID ${liveMcp
          .map((item) => item.record.pid)
          .join(", ")}），请先关闭 MCP 客户端。`,
        409,
      );
  }

  async startMove(
    request: { parent: string; confirmTarget: string },
    requestedBy: number,
  ): Promise<HomeMoveStartResult> {
    const reason = this.lockedReason();
    if (reason)
      throw new HomeMoveError(
        "HOME_MOVE_NOT_AVAILABLE",
        dataRootLockedReasonLabels[reason],
        409,
      );
    const validation = this.validate(request.parent);
    if (validation.blockedReasons.length > 0)
      throw new HomeMoveError(
        "HOME_MOVE_INVALID",
        `目标目录不可用：${validation.blockedReasons.join("；")}`,
        400,
        {
          blockedReasons: validation.blockedReasons,
          warnings: validation.warnings,
        },
      );
    if (
      !samePath(
        validation.targetHome,
        request.confirmTarget.trim(),
        this.platform,
      )
    )
      throw new HomeMoveError(
        "HOME_MOVE_INVALID",
        "目标目录已变化，请重新检查保存位置。",
        400,
        { blockedReasons: ["确认的目标目录与当前校验结果不一致"] },
      );
    this.assertBusyFree();
    const currentState = this.readState();
    if (currentState?.status === "running")
      throw new HomeMoveError(
        "HOME_MOVE_BUSY",
        "已有迁移任务正在进行，请稍候。",
        409,
      );

    const now = this.now();
    const jobId = formatJobId(now);
    const createdAt = now.toISOString();
    const job: HomeMoveJob = {
      schemaVersion: 1,
      jobId,
      fromHome: this.home,
      toHome: validation.targetHome,
      installRoot: this.installRoot,
      requestedBy,
      createdAt,
    };
    homeMoveJobSchema.parse(job);
    const lock: OperationLock = {
      schemaVersion: 1,
      kind: "move",
      jobId,
      pid: process.pid,
      startedAt: createdAt,
      heartbeatAt: createdAt,
    };

    try {
      acquireOperationLock(this.configDir, lock);
    } catch (error) {
      throw new HomeMoveError(
        "HOME_MOVE_BUSY",
        error instanceof Error ? error.message : "无法创建迁移锁",
        409,
      );
    }
    try {
      writeHomeMoveJob(this.configDir, job);
      writeMoveHomeState(this.configDir, {
        schemaVersion: 1,
        jobId,
        status: "running",
        phase: "preparing",
        fromHome: this.home,
        toHome: validation.targetHome,
        startedAt: createdAt,
        updatedAt: createdAt,
        cleanup: "none",
      });
    } catch (error) {
      releaseOperationLock(this.configDir, jobId);
      rmSync(this.paths.jobPath, { force: true });
      throw new HomeMoveError(
        "HOME_MOVE_STATE_FAILED",
        `无法写入迁移任务：${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }

    const helperEnv: NodeJS.ProcessEnv = {
      ...this.env,
      SUPERPM_CONFIG_DIR: this.configDir,
      SUPERPM_INSTALL_ROOT: this.installRoot,
    };
    delete helperEnv.SUPERPM_HOME;
    delete helperEnv.SUPERPM_HOME_SOURCE;
    try {
      await this.launchHelper({
        node: this.runtimeNode(),
        helper: this.helperPath(),
        jobPath: this.paths.jobPath,
        cwd: this.installRoot,
        env: helperEnv,
      });
    } catch (error) {
      releaseOperationLock(this.configDir, jobId);
      rmSync(this.paths.jobPath, { force: true });
      rmSync(this.paths.statePath, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      this.log(`迁移任务 ${jobId} 启动失败：${message}`);
      throw new HomeMoveError(
        "HOME_MOVE_SPAWN_FAILED",
        `无法启动迁移助手：${message}`,
        500,
      );
    }
    this.log(`创建迁移任务 ${jobId}：${this.home} → ${validation.targetHome}`);
    return { status: "started", jobId, targetHome: validation.targetHome };
  }

  cleanup(request: HomeCleanupRequest): HomeCleanupResult {
    const state = readMoveHomeState(this.configDir);
    if (
      !state ||
      state.status !== "completed" ||
      state.cleanup !== "pending" ||
      !state.oldHome
    )
      throw new HomeMoveError(
        "HOME_MOVE_INVALID",
        "没有待处理的旧数据记录。",
        409,
      );
    if (state.jobId !== request.jobId || state.oldHome !== request.oldHome)
      throw new HomeMoveError(
        "HOME_MOVE_INVALID",
        "待处理记录已变化，请刷新后重试。",
        409,
      );
    const oldHome = resolve(request.oldHome);
    const current = this.home;
    const marker = readMovedMarker(oldHome);
    if (
      !marker ||
      marker.jobId !== state.jobId ||
      !samePath(marker.to, current, this.platform)
    )
      throw new HomeMoveError(
        "HOME_MOVE_INVALID",
        "旧数据根标记缺失或不匹配，已拒绝处理。",
        409,
      );
    if (samePath(oldHome, current, this.platform))
      throw new HomeMoveError(
        "HOME_MOVE_INVALID",
        "旧数据根不能是当前数据根。",
        409,
      );
    if (isPathInside(oldHome, current, this.platform))
      throw new HomeMoveError(
        "HOME_MOVE_INVALID",
        "旧数据根不能包含当前数据根。",
        409,
      );
    if (
      samePath(oldHome, this.installRoot, this.platform) ||
      isPathInside(oldHome, this.installRoot, this.platform) ||
      isPathInside(this.installRoot, oldHome, this.platform)
    )
      throw new HomeMoveError(
        "HOME_MOVE_INVALID",
        "旧数据根不能包含安装目录。",
        409,
      );
    if (samePath(parse(oldHome).root, oldHome, this.platform))
      throw new HomeMoveError(
        "HOME_MOVE_INVALID",
        "旧数据根不能是盘符根目录。",
        409,
      );
    const managed = (state.managedPaths ?? []).map((path) =>
      path.replace(/\\/g, "/").replace(/\/+$/, ""),
    );
    if (managed.length === 0)
      throw new HomeMoveError("HOME_MOVE_INVALID", "待清理路径记录为空。", 409);
    for (const relativePath of managed) {
      if (
        !CLEANUP_ALLOWED_PATHS.has(relativePath) ||
        isAbsolute(relativePath) ||
        relativePath.split("/").includes("..")
      )
        throw new HomeMoveError(
          "HOME_MOVE_INVALID",
          `待清理路径不在允许范围：${relativePath}`,
          409,
        );
      if (!isPathInside(oldHome, resolve(oldHome, relativePath), this.platform))
        throw new HomeMoveError(
          "HOME_MOVE_INVALID",
          `待清理路径越界：${relativePath}`,
          409,
        );
    }

    if (request.action === "keep") {
      writeMoveHomeState(this.configDir, {
        ...state,
        cleanup: "kept",
        updatedAt: this.now().toISOString(),
      });
      this.log(`保留旧数据：${oldHome}`);
      return { action: "keep" };
    }
    if (!request.confirm)
      throw new HomeMoveError(
        "HOME_MOVE_INVALID",
        "删除旧数据需要二次确认。",
        400,
      );

    const deletedPaths: string[] = [];
    const failedPaths: string[] = [];
    for (const relativePath of managed) {
      try {
        removePathSafely(resolve(oldHome, relativePath));
        deletedPaths.push(relativePath);
      } catch {
        failedPaths.push(relativePath);
      }
    }
    const updatedAt = this.now().toISOString();
    if (failedPaths.length > 0) {
      writeMoveHomeState(this.configDir, { ...state, updatedAt });
      this.log(`删除旧数据部分失败：${failedPaths.join(", ")}（${oldHome}）`);
      return {
        action: "delete",
        deletedPaths,
        failedPaths,
        error: "部分旧文件删除失败，可稍后重试。",
      };
    }
    writeMoveHomeState(this.configDir, {
      ...state,
      cleanup: "deleted",
      updatedAt,
    });
    this.log(`已删除旧数据：${deletedPaths.join(", ")}（${oldHome}）`);
    return { action: "delete", deletedPaths };
  }

  pick(): Promise<{ path: string | null }> {
    if (this.platform !== "win32")
      throw new DomainError(
        "HOME_PICK_UNSUPPORTED",
        "当前系统不支持原生目录选择，请手动输入绝对路径。",
        400,
      );
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '选择 superPM 数据保存父目录'",
      "$dialog.ShowNewFolderButton = $true",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
    ].join("; ");
    return new Promise((done, fail) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      const timer = setTimeout(
        () => {
          child.kill();
          fail(
            new DomainError(
              "HOME_PICK_TIMEOUT",
              "目录选择超时，请手动输入绝对路径。",
              408,
            ),
          );
        },
        5 * 60 * 1000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        fail(
          new DomainError(
            "HOME_PICK_UNSUPPORTED",
            `无法打开目录选择窗口，请手动输入绝对路径（${error.message}）。`,
            400,
          ),
        );
      });
      child.once("exit", () => {
        clearTimeout(timer);
        const path = output.trim();
        done({ path: path || null });
      });
    });
  }
}

export function createDataRootService(options: DataRootServiceOptions) {
  return new DataRootService(options);
}
