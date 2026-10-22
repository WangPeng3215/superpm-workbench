import type Database from "better-sqlite3";
import {
  artifactMemoryName,
  isProtectedArtifactPath,
  requirementDefaultFolders,
  requirementDirectoryName,
  requirementImagesFolder,
  requirementMemoryTemplate,
  type RequirementWorkspaceStage,
  type RequirementWorkspaceState,
  type RequirementWorkspaceStatus,
} from "@superpm/shared";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { DomainError } from "./requirements.js";

export interface RequirementDirectoryRow {
  requirement_id: number;
  directory_name: string;
  relative_path: string;
  status: RequirementWorkspaceStatus;
  failure_stage: RequirementWorkspaceStage | null;
  failure_reason: string | null;
  initialized_at: string | null;
  created_at: string;
  updated_at: string;
}

// 默认目录模板（文档 §12.1）：images 为系统级目录，其余为可自由改名/移动/删除的普通目录
export const defaultWorkspaceFolders = [
  requirementImagesFolder,
  ...requirementDefaultFolders,
] as const;

/**
 * 需求物理目录解析（V1.1 文档 §12.2）：把需求 ID 映射到工作区下的可读物理目录。
 * 目录名采用「需求编号 + 空格 + 需求名称」，但关联依据始终是需求 ID；
 * 所有需要定位需求目录的服务都经由此处，保证路径安全与命名规则只有一份实现。
 */
export class RequirementDirectoryResolver {
  constructor(
    private db: Database.Database,
    private root: string,
  ) {}

  /** 需求行（仅取命名所需字段）；不存在时抛 404 */
  private requirementRow(requirementId: number) {
    const row = this.db
      .prepare("SELECT id, requirement_no, name FROM requirements WHERE id=?")
      .get(requirementId) as
      { id: number; requirement_no: string; name: string } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "需求不存在", 404);
    return row;
  }

  row(requirementId: number): RequirementDirectoryRow | undefined {
    return this.db
      .prepare("SELECT * FROM requirement_directories WHERE requirement_id=?")
      .get(requirementId) as RequirementDirectoryRow | undefined;
  }

  /**
   * 取目录映射；不存在时按规则生成并落库（幂等）。
   * 存量数字目录（requirements/{id}）在首次解析时被「收养」：整体重命名到可读名，
   * 文件随目录一起迁移，随后改写 requirement_files 中记录的相对路径。
   */
  ensureMapping(requirementId: number): RequirementDirectoryRow {
    const existing = this.row(requirementId);
    if (existing) return existing;
    const requirement = this.requirementRow(requirementId);
    const directoryName = requirementDirectoryName(
      requirement.requirement_no,
      requirement.name,
    );
    const relativePath = `requirements/${directoryName}`;
    const rootAbs = realpathSync(this.root);
    const targetAbs = join(rootAbs, "requirements", directoryName);
    const legacyAbs = join(rootAbs, "requirements", String(requirementId));
    const now = new Date().toISOString();
    // 该路径若已被其他需求占用，必须停止（不得覆盖他人目录）
    const claimed = this.db
      .prepare(
        "SELECT requirement_id FROM requirement_directories WHERE relative_path=? AND requirement_id != ?",
      )
      .get(relativePath, requirementId) as
      { requirement_id: number } | undefined;
    if (claimed)
      throw new DomainError(
        "CONFLICT",
        `目录名 ${directoryName} 已被其他需求占用，请先调整需求名称`,
        409,
      );
    let adoptedFrom: string | null = null;
    if (!existsSync(targetAbs) && existsSync(legacyAbs)) {
      // 存量收养：整体重命名，目录内文件随之迁移
      mkdirSync(dirname(targetAbs), { recursive: true });
      renameSync(legacyAbs, targetAbs);
      adoptedFrom = `requirements/${requirementId}`;
    }
    this.db
      .prepare(
        "INSERT INTO requirement_directories(requirement_id, directory_name, relative_path, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      )
      .run(requirementId, directoryName, relativePath, now, now);
    if (adoptedFrom) this.rewriteFilePaths(adoptedFrom, relativePath);
    return this.row(requirementId)!;
  }

  // 收养改名后同步 requirement_files 中已入库的绝对相对路径（未回填的行保持 NULL，按需惰性推导）
  private rewriteFilePaths(oldPrefix: string, newPrefix: string) {
    const rows = this.db
      .prepare(
        "SELECT id, relative_path FROM requirement_files WHERE relative_path LIKE ?",
      )
      .all(`${oldPrefix}/%`) as { id: number; relative_path: string }[];
    const update = this.db.prepare(
      "UPDATE requirement_files SET relative_path=? WHERE id=?",
    );
    for (const row of rows)
      update.run(
        `${newPrefix}/${row.relative_path.slice(oldPrefix.length + 1)}`,
        row.id,
      );
  }

  /** 需求目录相对工作区根的路径（正斜杠分隔），如 requirements/REQ-0001 名称 */
  relativeRoot(requirementId: number): string {
    return this.ensureMapping(requirementId).relative_path;
  }

  /** 需求根目录的绝对路径（要求已存在） */
  absoluteRoot(requirementId: number): string {
    const path = this.resolve(requirementId, "", false);
    if (!existsSync(path))
      throw new DomainError("NOT_FOUND", "需求目录不存在，请重新初始化", 404);
    return path;
  }

  /**
   * 逐级解析需求内相对路径：拒绝越界、非法段与符号链接。
   * create=false 时不落盘建目录（用于"目标必须不存在"或只读解析）。
   */
  resolve(
    requirementId: number,
    relativePath: string,
    create: boolean,
  ): string {
    const rootAbs = realpathSync(this.root);
    const segments = this.relativeRoot(requirementId).split("/");
    if (relativePath) {
      for (const segment of relativePath.split("/")) {
        if (!segment || segment === "." || segment === "..")
          throw new DomainError("INVALID_PATH", "路径包含非法段");
        segments.push(segment);
      }
    }
    let current = rootAbs;
    for (const segment of segments) {
      current = join(current, segment);
      if (!existsSync(current)) {
        if (!create) continue;
        mkdirSync(current);
      }
      if (lstatSync(current).isSymbolicLink())
        throw new DomainError("INVALID_PATH", "路径不能包含符号链接");
      const resolved = realpathSync(current);
      const distance = relative(rootAbs, resolved);
      if (distance.startsWith("..") || isAbsolute(distance))
        throw new DomainError("INVALID_PATH", "路径越界");
    }
    return current;
  }

  /** 初始化状态 + 磁盘比对（缺失的系统级资源与默认目录名） */
  state(requirementId: number): RequirementWorkspaceState {
    this.requirementRow(requirementId);
    const mapping = this.ensureMapping(requirementId);
    const rootAbs = this.resolve(requirementId, "", false);
    const directoryExists = existsSync(rootAbs);
    const missingResources: string[] = [];
    if (directoryExists) {
      for (const name of [artifactMemoryName, ...defaultWorkspaceFolders])
        if (!existsSync(join(rootAbs, name))) missingResources.push(name);
    } else {
      missingResources.push(artifactMemoryName, ...defaultWorkspaceFolders);
    }
    return {
      requirementId,
      directoryName: mapping.directory_name,
      relativePath: mapping.relative_path,
      status: mapping.status,
      failureStage: mapping.failure_stage,
      failureReason: mapping.failure_reason,
      initializedAt: mapping.initialized_at,
      directoryExists,
      missingResources,
    };
  }

  private markStatus(
    requirementId: number,
    status: RequirementWorkspaceStatus,
    extra: {
      stage?: RequirementWorkspaceStage | null;
      reason?: string | null;
      initializedAt?: string | null;
    } = {},
  ) {
    this.db
      .prepare(
        "UPDATE requirement_directories SET status=?, failure_stage=?, failure_reason=?, initialized_at=COALESCE(?, initialized_at), updated_at=? WHERE requirement_id=?",
      )
      .run(
        status,
        extra.stage ?? null,
        extra.reason ?? null,
        extra.initializedAt ?? null,
        new Date().toISOString(),
        requirementId,
      );
  }

  /**
   * 初始化需求物理目录与默认资源（文档 §12.5）。幂等：
   * 已存在的文件/目录一律不覆盖、不重建；失败时记录阶段与原因并保持非 completed 状态。
   */
  initialize(requirementId: number): RequirementWorkspaceState {
    const requirement = this.requirementRow(requirementId);
    let stage: RequirementWorkspaceStage = "resolve";
    try {
      const mapping = this.ensureMapping(requirementId);
      stage = "create-directory";
      const rootAbs = this.resolve(requirementId, "", true);
      stage = "memory";
      const memoryAbs = join(rootAbs, artifactMemoryName);
      // 仅当不存在时创建，且用 wx 兜底：初始化重试不得覆盖用户已编辑的内容
      if (!existsSync(memoryAbs))
        writeFileSync(memoryAbs, requirementMemoryTemplate(requirement.name), {
          flag: "wx",
          encoding: "utf8",
        });
      stage = "folders";
      for (const folder of defaultWorkspaceFolders) {
        const abs = join(rootAbs, folder);
        if (!existsSync(abs)) mkdirSync(abs);
      }
      stage = "index";
      this.db
        .prepare(
          "UPDATE requirement_directories SET status='completed', failure_stage=NULL, failure_reason=NULL, initialized_at=?, updated_at=? WHERE requirement_id=?",
        )
        .run(new Date().toISOString(), new Date().toISOString(), requirementId);
      return this.state(requirementId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.markStatus(requirementId, "failed", { stage, reason });
      throw new DomainError(
        "WORKSPACE_INIT_FAILED",
        `需求目录初始化在「${stage}」阶段失败：${reason}`,
        500,
      );
    }
  }

  /**
   * 修复默认结构（文档 §12.1）：仅在用户显式触发时补建缺失的默认目录与需求记忆，
   * 普通刷新不会重新创建用户主动删除的目录。
   */
  repair(requirementId: number): RequirementWorkspaceState {
    const requirement = this.requirementRow(requirementId);
    this.ensureMapping(requirementId);
    const rootAbs = this.resolve(requirementId, "", true);
    const memoryAbs = join(rootAbs, artifactMemoryName);
    if (!existsSync(memoryAbs))
      writeFileSync(memoryAbs, requirementMemoryTemplate(requirement.name), {
        flag: "wx",
        encoding: "utf8",
      });
    for (const folder of defaultWorkspaceFolders) {
      const abs = join(rootAbs, folder);
      if (!existsSync(abs)) mkdirSync(abs);
    }
    this.markStatus(requirementId, "completed", {
      initializedAt: new Date().toISOString(),
    });
    return this.state(requirementId);
  }

  /** 磁盘上需求根目录的直接子项名（供外部修改识别） */ listRootEntries(
    requirementId: number,
  ): string[] {
    const rootAbs = this.resolve(requirementId, "", false);
    if (!existsSync(rootAbs)) return [];
    return readdirSync(rootAbs, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => entry.name);
  }

  /** 需求记忆文件是否位于根目录且为普通文件（系统级资源保护的前置判断） */
  isProtectedPath(relativePath: string): boolean {
    return isProtectedArtifactPath(relativePath);
  }

  /** 目录修改时间（用于索引登记） */
  mtimeOf(path: string): string | null {
    return existsSync(path) ? statSync(path).mtime.toISOString() : null;
  }
}
