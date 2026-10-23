import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { inspectDatabase } from "../db/inspect.js";
import { walkWorkspace } from "./workspace-scan.js";

export interface BackupOptions {
  homePath: string;
  databasePath: string;
  workspacePath: string;
  version: string;
  reason?: string;
}

export interface BackupMeta {
  id: string;
  createdAt: string;
  reason: string;
  version: string;
  schemaVersion: number;
  database: {
    file: string;
    sizeBytes: number;
    sha256: string;
    integrity: string;
    tables: Record<string, number>;
  };
  workspace: { files: number; bytes: number };
  configFile: boolean;
}

export interface RestoreOptions {
  backupDir: string;
  homePath: string;
  databasePath: string;
  workspacePath: string;
  version: string;
  createSafetyBackup?: boolean;
}

function backupsRoot(homePath: string) {
  return join(homePath, "backups");
}

function isInside(base: string, target: string): boolean {
  const distance = relative(resolve(base), resolve(target));
  return (
    distance === "" || (!distance.startsWith("..") && !isAbsolute(distance))
  );
}

function sha256File(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => done(hash.digest("hex")));
    stream.on("error", fail);
  });
}

function nextBackupId(homePath: string, reason?: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const suffix =
    (reason ?? "manual")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "manual";
  let id = `${stamp}-${suffix}`;
  let index = 2;
  while (existsSync(join(backupsRoot(homePath), id)))
    id = `${stamp}-${suffix}-${index++}`;
  return id;
}

/** 备份数据库、工作区与数据根 .env；数据库使用 SQLite 在线备份接口。 */
export async function createBackup(
  options: BackupOptions,
): Promise<BackupMeta> {
  if (!existsSync(options.databasePath))
    throw new Error(`数据库不存在，无法备份：${options.databasePath}`);
  const root = backupsRoot(options.homePath);
  mkdirSync(root, { recursive: true });
  const id = nextBackupId(options.homePath, options.reason);
  const stage = join(root, `.partial-${id}`);
  const target = join(root, id);
  mkdirSync(join(stage, "data"), { recursive: true });
  try {
    const source = new Database(options.databasePath);
    try {
      await source.backup(join(stage, "data", "superpm.sqlite"));
    } finally {
      source.close();
    }
    if (existsSync(options.workspacePath))
      cpSync(options.workspacePath, join(stage, "workspace"), {
        recursive: true,
        force: true,
        dereference: false,
      });
    else mkdirSync(join(stage, "workspace"), { recursive: true });

    const envFile = join(options.homePath, ".env");
    const configFile = existsSync(envFile);
    if (configFile) copyFileSync(envFile, join(stage, "config.env"));

    const databaseFile = join(stage, "data", "superpm.sqlite");
    const snapshot = inspectDatabase(databaseFile);
    const workspace = walkWorkspace(join(stage, "workspace"));
    const meta: BackupMeta = {
      id,
      createdAt: new Date().toISOString(),
      reason: options.reason ?? "manual",
      version: options.version,
      schemaVersion: snapshot.schemaVersion,
      database: {
        file: "data/superpm.sqlite",
        sizeBytes: statSync(databaseFile).size,
        sha256: await sha256File(databaseFile),
        integrity: snapshot.integrity,
        tables: snapshot.tables,
      },
      workspace: { files: workspace.files, bytes: workspace.bytes },
      configFile,
    };
    writeFileSync(join(stage, "meta.json"), JSON.stringify(meta, null, 2));
    renameSync(stage, target);
    return meta;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function readMeta(backupDir: string): BackupMeta {
  const path = join(backupDir, "meta.json");
  if (!existsSync(path)) throw new Error(`备份缺少 meta.json：${backupDir}`);
  const meta = JSON.parse(readFileSync(path, "utf8")) as BackupMeta;
  if (!meta.id || !meta.database?.sha256)
    throw new Error(`备份元数据不完整：${path}`);
  return meta;
}

export function listBackups(homePath: string): BackupMeta[] {
  const root = backupsRoot(homePath);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith("."))
    .map((name) => join(root, name))
    .filter((dir) => existsSync(join(dir, "meta.json")))
    .map((dir) => readMeta(dir))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** 校验摘要、数据库完整性与表行数，以及工作区文件统计。 */
export async function verifyBackup(backupDir: string): Promise<BackupMeta> {
  const meta = readMeta(backupDir);
  const databaseFile = resolve(backupDir, meta.database.file);
  if (!isInside(backupDir, databaseFile))
    throw new Error(`备份数据库路径超出备份目录：${meta.database.file}`);
  if (!existsSync(databaseFile))
    throw new Error(`备份数据库缺失：${databaseFile}`);
  const digest = await sha256File(databaseFile);
  if (digest !== meta.database.sha256)
    throw new Error(
      `备份数据库摘要不一致：${meta.database.sha256} != ${digest}`,
    );
  const snapshot = inspectDatabase(databaseFile);
  if (JSON.stringify(snapshot.tables) !== JSON.stringify(meta.database.tables))
    throw new Error("备份数据库表行数与元数据不一致");
  const workspace = walkWorkspace(join(backupDir, "workspace"));
  if (
    workspace.files !== meta.workspace.files ||
    workspace.bytes !== meta.workspace.bytes
  )
    throw new Error("备份工作区文件统计与元数据不一致");
  return meta;
}

/**
 * 恢复备份。调用方必须确保应用与 MCP 进程均已停止。
 * 当前数据会先自动备份（pre-restore），原工作区改名保留而非删除。
 */
export async function restoreBackup(options: RestoreOptions): Promise<{
  meta: BackupMeta;
  preRestoreBackupId?: string;
  workspaceAsidePath?: string;
}> {
  const meta = await verifyBackup(options.backupDir);
  let preRestoreBackupId: string | undefined;
  if (
    options.createSafetyBackup !== false &&
    existsSync(options.databasePath)
  ) {
    const safety = await createBackup({
      homePath: options.homePath,
      databasePath: options.databasePath,
      workspacePath: options.workspacePath,
      version: options.version,
      reason: "pre-restore",
    });
    preRestoreBackupId = safety.id;
  }

  mkdirSync(dirname(options.databasePath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(`${options.databasePath}${suffix}`, { force: true });
  copyFileSync(
    join(options.backupDir, ...meta.database.file.split("/")),
    options.databasePath,
  );

  let workspaceAsidePath: string | undefined;
  if (existsSync(options.workspacePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    workspaceAsidePath = `${options.workspacePath}.pre-restore-${stamp}`;
    renameSync(options.workspacePath, workspaceAsidePath);
  }
  const backupWorkspace = join(options.backupDir, "workspace");
  if (existsSync(backupWorkspace))
    cpSync(backupWorkspace, options.workspacePath, {
      recursive: true,
      force: true,
      dereference: false,
    });
  else mkdirSync(options.workspacePath, { recursive: true });

  const restored = inspectDatabase(options.databasePath);
  if (JSON.stringify(restored.tables) !== JSON.stringify(meta.database.tables))
    throw new Error(
      `恢复后的数据库校验失败${
        preRestoreBackupId
          ? `；可用 pre-restore 备份 ${preRestoreBackupId} 回退`
          : ""
      }`,
    );
  return { meta, preRestoreBackupId, workspaceAsidePath };
}

export function resolveBackupDir(homePath: string, id: string): string {
  const root = resolve(backupsRoot(homePath));
  const target = resolve(root, id);
  if (!id || !isInside(root, target)) throw new Error(`非法备份 ID：${id}`);
  return target;
}
