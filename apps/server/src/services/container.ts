import Database from "better-sqlite3";
import { resolve } from "node:path";
import { defaultPaths, ensurePaths } from "../config/index.js";
import { migrate } from "../db/migrate.js";
import { createScopedDatabase } from "../db/scope.js";
import { RequirementService } from "./requirements.js";
import { AuthService } from "./auth.js";
import { RequirementDirectoryResolver } from "./requirement-directory.js";
import { StageWorkspaceService } from "./stage-workspace.js";
import { RequirementFileService } from "./requirement-files.js";
import { IssueService } from "./issues.js";
import { ArtifactService } from "./artifacts.js";
import { RequirementProgressService } from "./requirement-progress.js";
import { DailyTaskService } from "./daily-tasks.js";
import { OnlineToolService } from "./online-tools.js";
import { MeetingService } from "./meetings.js";
import { NoteService } from "./notes.js";
import { OptimizationPointService } from "./optimization-points.js";

export interface ServiceContainerOptions {
  databasePath?: string;
  workspacePath?: string;
}

export interface ServiceContainer {
  databasePath: string;
  workspacePath: string;
  db: Database.Database;
  requirements: RequirementService;
  auth: AuthService;
  directories: RequirementDirectoryResolver;
  workspace: StageWorkspaceService;
  files: RequirementFileService;
  issues: IssueService;
  artifacts: ArtifactService;
  progress: RequirementProgressService;
  dailyTasks: DailyTaskService;
  notes: NoteService;
  onlineTools: OnlineToolService;
  meetings: MeetingService;
  optimizationPoints: OptimizationPointService;
  close(): void;
}

export function createServiceContainer(
  options: ServiceContainerOptions = {},
): ServiceContainer {
  const defaults = defaultPaths();
  const databasePath =
    options.databasePath === ":memory:"
      ? ":memory:"
      : resolve(options.databasePath ?? defaults.databasePath);
  const workspacePath = resolve(
    options.workspacePath ?? defaults.workspacePath,
  );
  ensurePaths(databasePath, workspacePath);
  const rawDb = new Database(databasePath);
  try {
    migrate(rawDb, undefined, workspacePath);
  } catch (error) {
    rawDb.close();
    throw error;
  }
  // 业务服务一律拿到「作用域代理」：语句在执行时按当前登录用户自动追加 user_id 条件。
  // 迁移、种子、MCP、定时补偿等系统路径不在作用域内，行为与改造前一致。
  const db = createScopedDatabase(rawDb);
  const directories = new RequirementDirectoryResolver(db, workspacePath);
  // 注入目录解析器：建需与优化点转换共用 createWithWorkspace（含目录初始化）
  // 仓储层用原生连接：drizzle 生成语句并自带参数绑定，隔离条件在仓储内显式书写
  const requirements = new RequirementService(db, directories, rawDb);
  const optimizationPoints = new OptimizationPointService(db, requirements);
  const auth = new AuthService(rawDb);
  auth.ensureSeed();
  const issues = new IssueService(db, requirements, workspacePath, directories);
  const artifacts = new ArtifactService(
    db,
    workspacePath,
    requirements,
    directories,
  );
  // 升级后清理历史遗留的 WPS/Office ~$ 临时文件索引（只删索引，不动磁盘）
  artifacts.purgeTemporaryArtifacts();
  const dailyTasks = new DailyTaskService(db);
  let closed = false;
  return {
    databasePath,
    workspacePath,
    db,
    requirements,
    auth,
    directories,
    workspace: new StageWorkspaceService(
      db,
      workspacePath,
      requirements,
      directories,
    ),
    files: new RequirementFileService(
      db,
      workspacePath,
      requirements,
      directories,
    ),
    issues,
    artifacts,
    progress: new RequirementProgressService(
      requirements,
      issues,
      artifacts,
      directories,
    ),
    dailyTasks,
    notes: new NoteService(db, dailyTasks),
    onlineTools: new OnlineToolService(db),
    meetings: new MeetingService(db),
    optimizationPoints,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
