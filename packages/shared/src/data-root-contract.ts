import { z } from "zod";

/** 配置指针与迁移状态文件的格式版本；高于该版本的配置会被拒绝。 */
export const DATA_ROOT_SCHEMA_VERSION = 1;

export const dataRootSources = [
  "env",
  "config",
  "default",
  "development",
] as const;
export type DataRootSource = (typeof dataRootSources)[number];

export const dataRootSourceLabels: Record<DataRootSource, string> = {
  config: "配置文件",
  env: "环境变量",
  default: "默认目录",
  development: "开发环境",
};

export const dataRootLockedReasons = [
  "environment",
  "development",
  "not-packaged",
  "config-unwritable",
] as const;
export type DataRootLockedReason = (typeof dataRootLockedReasons)[number];

export const dataRootLockedReasonLabels: Record<DataRootLockedReason, string> =
  {
    environment: "数据根由 SUPERPM_HOME 环境变量指定",
    development: "开发环境下数据固定在仓库目录",
    "not-packaged": "当前不是发布包，无法自动重启迁移",
    "config-unwritable": "配置目录不可写，无法保存新的保存位置",
  };

export interface DataRootResolution {
  home: string;
  source: DataRootSource;
  configDir: string;
  configPath: string;
  markerPath: string;
  warning?: string;
}

export interface PendingOldData {
  jobId: string;
  oldHome: string;
  movedAt: string;
  managedPaths: string[];
}

export interface DataRootSystemInfo {
  homePath: string;
  homeSource: DataRootSource;
  dataRootEditable: boolean;
  dataRootLockedReason?: DataRootLockedReason;
  moveInProgress: boolean;
  pendingOldData?: PendingOldData;
}

export const dataRootConfigSchema = z.object({
  schemaVersion: z.number().int().min(1),
  home: z.string().min(1),
  previousHome: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
});
export type DataRootConfig = z.infer<typeof dataRootConfigSchema>;

export const homeMarkerSchema = z.object({
  schemaVersion: z.number().int().min(1),
  home: z.string().min(1),
  movedFrom: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  createdAt: z.string().min(1).optional(),
});
export type HomeMarker = z.infer<typeof homeMarkerSchema>;

export const movedMarkerSchema = z.object({
  schemaVersion: z.number().int().min(1),
  to: z.string().min(1),
  jobId: z.string().min(1),
  movedAt: z.string().min(1),
});
export type MovedMarker = z.infer<typeof movedMarkerSchema>;

export const moveHomePhases = [
  "preparing",
  "stopping",
  "copying",
  "verifying",
  "switching",
  "restarting",
  "completed",
  "failed",
] as const;
export type HomeMovePhase = (typeof moveHomePhases)[number];

export const homeMoveStatuses = ["running", "completed", "failed"] as const;
export type HomeMoveStatus = (typeof homeMoveStatuses)[number];

export const homeMoveCleanupStates = [
  "none",
  "pending",
  "kept",
  "deleted",
] as const;
export type HomeMoveCleanup = (typeof homeMoveCleanupStates)[number];

export const homeMoveRollbackStates = [
  "restored-old",
  "not-needed",
  "failed",
] as const;
export type HomeMoveRollback = (typeof homeMoveRollbackStates)[number];

export interface HomeMoveProgress {
  copiedBytes: number;
  totalBytes: number;
  copiedFiles: number;
  totalFiles: number;
}

export interface HomeMoveState {
  schemaVersion: number;
  jobId: string;
  status: HomeMoveStatus;
  phase: HomeMovePhase;
  fromHome: string;
  toHome: string;
  progress?: HomeMoveProgress;
  startedAt: string;
  updatedAt: string;
  cleanup: HomeMoveCleanup;
  oldHome?: string;
  managedPaths?: string[];
  movedAt?: string;
  error?: {
    message: string;
    phase: HomeMovePhase;
    rollback: HomeMoveRollback;
  };
}

export const homeMoveStateSchema = z.object({
  schemaVersion: z.number().int().min(1),
  jobId: z.string().min(1),
  status: z.enum(homeMoveStatuses),
  phase: z.enum(moveHomePhases),
  fromHome: z.string().min(1),
  toHome: z.string().min(1),
  progress: z
    .object({
      copiedBytes: z.number().int().min(0),
      totalBytes: z.number().int().min(0),
      copiedFiles: z.number().int().min(0),
      totalFiles: z.number().int().min(0),
    })
    .optional(),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  cleanup: z.enum(homeMoveCleanupStates),
  oldHome: z.string().min(1).optional(),
  managedPaths: z.array(z.string().min(1)).optional(),
  movedAt: z.string().min(1).optional(),
  error: z
    .object({
      message: z.string(),
      phase: z.enum(moveHomePhases),
      rollback: z.enum(homeMoveRollbackStates),
    })
    .optional(),
});
export type HomeMoveStateInput = z.infer<typeof homeMoveStateSchema>;

export const homeMoveJobSchema = z.object({
  schemaVersion: z.number().int().min(1),
  jobId: z.string().min(1),
  fromHome: z.string().min(1),
  toHome: z.string().min(1),
  installRoot: z.string().min(1),
  requestedBy: z.number().int().optional(),
  createdAt: z.string().min(1),
});
export type HomeMoveJob = z.infer<typeof homeMoveJobSchema>;

export const operationLockSchema = z.object({
  schemaVersion: z.number().int().min(1),
  kind: z.literal("move"),
  jobId: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  heartbeatAt: z.string().min(1).optional(),
});
export type OperationLock = z.infer<typeof operationLockSchema>;

export interface HomeValidationResult {
  targetHome: string;
  exists: boolean;
  empty: boolean;
  writable: boolean;
  freeBytes: number;
  requiredBytes: number;
  sourceBytes: number;
  databaseExists: boolean;
  databaseRows?: number;
  workspaceFiles: number;
  warnings: string[];
  blockedReasons: string[];
}

export interface HomeMoveStartResult {
  status: "started";
  jobId: string;
  targetHome: string;
}

export interface HomeMoveView {
  status: "idle" | HomeMoveStatus;
  jobId?: string;
  phase?: HomeMovePhase;
  fromHome?: string;
  toHome?: string;
  progress?: HomeMoveProgress;
  startedAt?: string;
  updatedAt?: string;
  error?: HomeMoveState["error"];
  cleanup?: HomeMoveCleanup;
  oldHome?: string;
  managedPaths?: string[];
  movedAt?: string;
}

export interface HomeCleanupResult {
  action: "keep" | "delete";
  deletedPaths?: string[];
  failedPaths?: string[];
  error?: string;
}

export const homeValidateRequestSchema = z.object({
  parent: z.string().trim().min(1).max(1000),
});
export type HomeValidateRequest = z.infer<typeof homeValidateRequestSchema>;

export const homeMoveRequestSchema = z.object({
  parent: z.string().trim().min(1).max(1000),
  confirmTarget: z.string().trim().min(1).max(1000),
});
export type HomeMoveRequest = z.infer<typeof homeMoveRequestSchema>;

export const homeCleanupRequestSchema = z.object({
  action: z.enum(["keep", "delete"]),
  jobId: z.string().trim().min(1).max(200),
  oldHome: z.string().trim().min(1).max(1000),
  confirm: z.boolean().optional(),
});
export type HomeCleanupRequest = z.infer<typeof homeCleanupRequestSchema>;

export type HomeMoveErrorCode =
  | "HOME_MOVE_NOT_AVAILABLE"
  | "HOME_MOVE_INVALID"
  | "HOME_MOVE_BUSY"
  | "HOME_MOVE_SPAWN_FAILED"
  | "HOME_MOVE_STATE_FAILED";
