import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
// 发布包中项目根位于 <安装目录>/app，程序目录之外才是稳定安装布局。
export const isPackagedInstall = basename(projectRoot) === "app";
export const installRoot = resolve(
  process.env.SUPERPM_INSTALL_ROOT ||
    (isPackagedInstall ? dirname(projectRoot) : projectRoot),
);
/** 未显式设置 SUPERPM_HOME 时，发布包默认使用的固定数据根。 */
export function defaultHomePath(env: NodeJS.ProcessEnv = process.env): string {
  const platform = process.platform;
  if (platform === "win32")
    return join(
      env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "superPM",
    );
  if (platform === "darwin")
    return join(homedir(), "Library", "Application Support", "superPM");
  return join(
    env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "superpm",
  );
}
// 部署包通过 SUPERPM_HOME 固定用户数据根；开发环境不设置，沿用仓库内 data/workspace。
// 优先级：进程环境变量 > 数据根 .env > 项目根 .env。
export function loadEnv(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const original = { ...env };
  config({ path: join(root, ".env"), quiet: true, processEnv: env });
  let configuredHome = env.SUPERPM_HOME?.trim();
  // 发布包直接运行时也不能把用户数据写进程序目录。
  if (!configuredHome && basename(root) === "app") {
    configuredHome = defaultHomePath(env);
    env.SUPERPM_HOME = configuredHome;
  }
  const home = configuredHome ? resolve(configuredHome) : undefined;
  if (home) {
    config({
      path: join(home, ".env"),
      quiet: true,
      override: true,
      processEnv: env,
    });
    // override 无法区分进程变量与项目根 .env，这里恢复进程变量原始值。
    for (const [key, value] of Object.entries(original))
      if (value !== undefined) env[key] = value;
  }
  return home;
}
export const appHome = loadEnv(projectRoot);
export const homePath = appHome ?? projectRoot;
// 旧安装目录中可能保存着 data/、workspace/ 与 .env；发布包升级后由启动器指向原安装根。
export const legacyRoot = resolve(
  process.env.SUPERPM_LEGACY_ROOT || projectRoot,
);
// 本地默认程序打开总开关（补充文档 5.4）：默认关闭，SUPERPM_ALLOW_SYSTEM_OPEN=1 显式开启
export const allowSystemOpen = process.env.SUPERPM_ALLOW_SYSTEM_OPEN === "1";
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
