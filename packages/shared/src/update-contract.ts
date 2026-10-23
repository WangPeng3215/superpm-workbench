import { z } from "zod";

/** 固定发布源：GitHub Release 的 latest 清单；应用与更新器共用同一地址。 */
export const UPDATE_DEFAULT_MANIFEST_URL =
  "https://github.com/WangPeng3215/superpm-workbench/releases/latest/download/update-manifest.json";

// 与 scripts/install/updater.mjs 的允许列表保持一致，避免应用内检查与独立更新器判断不同。
export const updateAllowedHosts = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "raw.githubusercontent.com",
] as const;

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const updateManifestArtifactSchema = z
  .object({
    file: z.string().trim().min(1).max(300),
    url: z.string().trim().min(1).max(2000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i, "更新包 sha256 无效"),
    size: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024),
  })
  .strict();

export const updateManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    name: z.literal("superpm-workbench"),
    version: z.string().regex(versionPattern, "更新清单版本号无效"),
    platform: z.string().trim().min(1).max(50),
    releasedAt: z.string().trim().min(1).max(100),
    schemaVersion: z.number().int().positive(),
    minUpdaterVersion: z
      .string()
      .regex(versionPattern, "最低更新器版本号无效")
      .optional(),
    notes: z.string().max(50000).optional(),
    full: updateManifestArtifactSchema.optional(),
    update: updateManifestArtifactSchema,
  })
  .strict();
export type UpdateManifest = z.infer<typeof updateManifestSchema>;

export const updateInstallRequestSchema = z
  .object({
    version: z.string().regex(versionPattern, "目标版本号无效"),
    force: z.boolean().default(false),
  })
  .strict();
export type UpdateInstallRequest = z.input<typeof updateInstallRequestSchema>;

export interface UpdateCheckResult {
  checkedAt: string;
  source: string;
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  installable: boolean;
  blockedReason: string | null;
  notes: string;
  releasedAt: string;
  schemaVersion: number;
  minUpdaterVersion: string | null;
  updateFile: string;
  updateSize: number;
}

export interface UpdateLockInfo {
  pid: number;
  createdAt: string;
  version?: string;
}

export interface UpdateMcpProcessInfo {
  pid: number;
  version: string;
  startedAt: string;
  heartbeatAt: string;
  stale: boolean;
}

export type UpdateProgressStatus =
  | "starting"
  | "running"
  | "up-to-date"
  | "updated"
  | "failed"
  | "rolled-back"
  | "rollback-failed";

export interface UpdateProgress {
  status: UpdateProgressStatus;
  phase: string;
  percent: number;
  message: string;
  from?: string;
  to?: string;
  received?: number;
  total?: number;
  pid?: number;
  startedAt?: string;
  updatedAt: string;
  error?: string;
}

export type UpdateInstallStatus =
  "downloading" | "verifying" | "launching" | "installing" | "failed";

export interface UpdateInstallState {
  status: UpdateInstallStatus;
  percent: number;
  received: number;
  total: number;
  message: string;
  version: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export interface UpdateLastResult {
  ok: boolean;
  status: string;
  from?: string;
  to?: string;
  version?: string;
  error?: string;
  rollbackError?: string;
  restartError?: string;
  backupId?: string;
  schemaVersion?: number;
  port?: number;
  finishedAt?: string;
  logs?: string[];
}

export interface UpdateStatus {
  currentVersion: string;
  schemaVersion: number;
  dataRoot: string;
  manifestUrl: string;
  installSupported: boolean;
  unsupportedReason: string | null;
  updaterVersion: string | null;
  updateLock: UpdateLockInfo | null;
  mcpProcesses: UpdateMcpProcessInfo[];
  install: UpdateInstallState | null;
  progress: UpdateProgress | null;
  lastUpdate: UpdateLastResult | null;
}
