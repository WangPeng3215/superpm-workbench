import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
function findProjectRoot() {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = join(directory, "package.json");
    if (
      existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, "utf8")).name === "superpm-workbench"
    )
      return directory;
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("找不到 superpm-workbench 项目根目录");
    directory = parent;
  }
}
export const projectRoot = findProjectRoot();
config({ path: join(projectRoot, ".env"), quiet: true });
// 本地默认程序打开总开关（补充文档 5.4）：默认关闭，SUPERPM_ALLOW_SYSTEM_OPEN=1 显式开启
export const allowSystemOpen = process.env.SUPERPM_ALLOW_SYSTEM_OPEN === "1";
export function defaultPaths() {
  return {
    databasePath: resolve(
      projectRoot,
      process.env.SUPERPM_DATA_DIR || "data",
      "superpm.sqlite",
    ),
    workspacePath: resolve(
      projectRoot,
      process.env.SUPERPM_WORKSPACE_DIR || "workspace",
    ),
  };
}
export function ensurePaths(databasePath: string, workspacePath: string) {
  if (databasePath !== ":memory:")
    mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
}
