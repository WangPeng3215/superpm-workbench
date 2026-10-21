import Database from "better-sqlite3";
import { defaultPaths, ensurePaths } from "../config/index.js";
import { migrate } from "./migrate.js";

export function migrateDefaultDatabase() {
  const paths = defaultPaths();
  ensurePaths(paths.databasePath, paths.workspacePath);
  const db = new Database(paths.databasePath);
  try {
    migrate(db, undefined, paths.workspacePath);
  } finally {
    db.close();
  }
  return paths.databasePath;
}
