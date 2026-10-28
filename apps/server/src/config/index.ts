import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import {
  assertDataRootAvailable,
  defaultDataHome,
  isPackagedRoot,
  resolveDataRoot,
  type DataRootResolution,
} from "@superpm/shared/data-root";

export { isPackagedRoot };
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
export const isPackagedInstall = isPackagedRoot(projectRoot);
export const installRoot = resolve(
  process.env.SUPERPM_INSTALL_ROOT ||
    (isPackagedInstall ? dirname(projectRoot) : projectRoot),
);
export const defaultHomePath = defaultDataHome;

/**
 * 解析当前进程的数据根。
 * 优先级：SUPERPM_HOME > 配置指针 > 平台默认目录；开发仓库未显式指定时用仓库根。
 */
export function resolveAppDataRoot(
  env: NodeJS.ProcessEnv = process.env,
): DataRootResolution {
  return resolveDataRoot({
    env,
    packaged: isPackagedInstall,
    developmentRoot: projectRoot,
  });
}

// 部署包通过 SUPERPM_HOME 固定用户数据根；开发环境不设置，沿用仓库内 data/workspace。
// 优先级：进程环境变量 > 数据根 .env > 项目根 .env。
export function loadEnv(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const original = { ...env };
  config({ path: join(root, ".env"), quiet: true, processEnv: env });
  const resolution = resolveDataRoot({
    env,
    packaged: isPackagedRoot(root),
    developmentRoot: root,
  });
  if (resolution.source === "development") return undefined;
  if (!original.SUPERPM_HOME && resolution.source !== "env")
    env.SUPERPM_HOME = resolution.home;
  config({
    path: join(resolution.home, ".env"),
    quiet: true,
    override: true,
    processEnv: env,
  });
  // override 无法区分进程变量与项目根 .env，这里恢复进程变量原始值。
  for (const [key, value] of Object.entries(original))
    if (value !== undefined) env[key] = value;
  env.SUPERPM_HOME = resolution.home;
  env.SUPERPM_HOME_SOURCE = resolution.source;
  assertDataRootAvailable(resolution, env);
  return resolution.home;
}
export const appHome = loadEnv(projectRoot);
export const homePath = appHome ?? projectRoot;
// 旧安装目录中可能保存着 data/、workspace/ 与 .env；发布包升级后由启动器指向原安装根。
export const legacyRoot = resolve(
  process.env.SUPERPM_LEGACY_ROOT || projectRoot,
);
// 本地默认程序打开（补充文档 5.4）：服务仅监听 127.0.0.1，默认开启；
// 在远程/共享部署等不希望触发本机程序的场景可显式设为 0、false 或 off 关闭。
export function resolveAllowSystemOpen(value?: string): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}
export const allowSystemOpen = resolveAllowSystemOpen(
  process.env.SUPERPM_ALLOW_SYSTEM_OPEN,
);
function readAppVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
// 根 package.json 是版本号唯一来源；服务端、MCP 与 Web 构建都从这里取。
export const appVersion = readAppVersion();
function resolveSetting(base: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}
export function defaultPaths() {
  const base = homePath;
  return {
    databasePath: join(
      resolveSetting(base, process.env.SUPERPM_DATA_DIR || "data"),
      "superpm.sqlite",
    ),
    workspacePath: resolveSetting(
      base,
      process.env.SUPERPM_WORKSPACE_DIR || "workspace",
    ),
  };
}
export function ensurePaths(databasePath: string, workspacePath: string) {
  if (databasePath !== ":memory:")
    mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
}
