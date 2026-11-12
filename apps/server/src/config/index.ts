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
/**
 * 监听地址：默认只监听回环，避免把带登录的本机服务暴露到局域网。
 * 容器或托管平台需要绑定 0.0.0.0 才能被外部探活与反向代理访问，
 * 由部署方显式设置 SUPERPM_HOST=0.0.0.0 开启；不读通用的 HOST，避免被平台注入影响本地。
 */
export function resolveListenHost(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const host = env.SUPERPM_HOST?.trim();
  return host ? host : "127.0.0.1";
}
/**
 * Web 静态产物目录：默认仓库内 apps/web/dist。
 * 部署到托管环境时常把前端产物放在别处（服务端 bundle 与前端产物分开上传），
 * 用 SUPERPM_WEB_DIR 指定相对项目根的路径或绝对路径。
 */
export function resolveWebRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fallback = join(projectRoot, "apps", "web", "dist");
  const configured = env.SUPERPM_WEB_DIR?.trim();
  if (!configured) return fallback;
  return isAbsolute(configured) ? resolve(configured) : resolve(projectRoot, configured);
}
/**
 * 是否开放自助注册。
 * 默认开放（个人/小团队自建服务需要它）；部署在公网且只给固定几个人用时，
 * 用 SUPERPM_ALLOW_REGISTRATION=off 关掉入口，账号只能由超管创建。
 */
export function resolveRegistrationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = env.SUPERPM_ALLOW_REGISTRATION?.trim().toLowerCase();
  if (!configured) return true;
  return !["off", "false", "0", "no", "disabled"].includes(configured);
}
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
