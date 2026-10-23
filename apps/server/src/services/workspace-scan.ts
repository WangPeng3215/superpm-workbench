import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export interface WorkspaceEntry {
  path: string;
  type: "file" | "directory" | "link";
  size: number;
}

export interface WorkspaceSnapshot {
  files: number;
  bytes: number;
  entries: WorkspaceEntry[];
}

/** 递归列出工作区条目（相对路径、类型、大小），用于复制/备份校验。 */
export function walkWorkspace(root: string): WorkspaceSnapshot {
  const entries: WorkspaceEntry[] = [];
  if (!existsSync(root)) return { files: 0, bytes: 0, entries };
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      const path = relative(root, full).split("\\").join("/");
      const info = lstatSync(full);
      if (info.isSymbolicLink()) entries.push({ path, type: "link", size: 0 });
      else if (info.isDirectory()) {
        entries.push({ path, type: "directory", size: 0 });
        visit(full);
      } else entries.push({ path, type: "file", size: info.size });
    }
  };
  visit(root);
  return {
    files: entries.filter((entry) => entry.type === "file").length,
    bytes: entries.reduce((total, entry) => total + entry.size, 0),
    entries,
  };
}

export function sameWorkspace(
  left: WorkspaceSnapshot,
  right: WorkspaceSnapshot,
): boolean {
  return JSON.stringify(left.entries) === JSON.stringify(right.entries);
}
