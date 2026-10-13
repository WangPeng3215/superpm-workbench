import { isAbsolute, relative, resolve, win32 } from "node:path";
import { DomainError } from "../services/requirements.js";

/** Lexical boundary only. Check real paths/symlinks before future file operations. */
export function resolveWorkspacePath(workspacePath: string, filename: string) {
  const normalized = filename.replace(/\\/g, "/");
  if (
    !filename ||
    filename.includes("\0") ||
    isAbsolute(filename) ||
    win32.isAbsolute(filename) ||
    normalized.split("/").includes("..") ||
    /^[a-z]:/i.test(filename)
  ) {
    throw new DomainError("INVALID_PATH", "文件路径必须位于 Workspace 内");
  }
  const target = resolve(workspacePath, filename);
  const distance = relative(resolve(workspacePath), target);
  if (!distance || distance.startsWith("..") || isAbsolute(distance))
    throw new DomainError("INVALID_PATH", "文件路径必须位于 Workspace 内");
  return target;
}
