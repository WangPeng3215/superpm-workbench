import Database from "better-sqlite3";
import { resolve } from "node:path";
import { defaultPaths, ensurePaths } from "../config/index.js";
import { migrate } from "../db/migrate.js";
import { RequirementService } from "./requirements.js";
import { AuthService } from "./auth.js";
import { RequirementDirectoryResolver } from "./requirement-directory.js";
import { StageWorkspaceService } from "./stage-workspace.js";
import { RequirementFileService } from "./requirement-files.js";
import { IssueService } from "./issues.js";
import { ArtifactService } from "./artifacts.js";
import { RequirementProgressService } from "./requirement-progress.js";
import { DailyTaskService } from "./daily-tasks.js";

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
  const db = new Database(databasePath);
  try {
    migrate(db, undefined, workspacePath);
  } catch (error) {
    db.close();
    throw error;
  }
  const directories = new RequirementDirectoryResolver(db, workspacePath);
  const requirements = new RequirementService(db);
  const auth = new AuthService(db);
  auth.ensureSeed();
  const issues = new IssueService(db, requirements, workspacePath, directories);
  const artifacts = new ArtifactService(
    db,
    workspacePath,
    requirements,
    directories,
  );
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
    dailyTasks: new DailyTaskService(db),
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
