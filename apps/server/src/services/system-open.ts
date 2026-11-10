import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, win32 } from "node:path";

export interface SystemOpenCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /**
   * 参数里已自带引号，交由 CreateProcess 原样拼接。
   * Windows 的 explorer.exe 对引号位置敏感，不能交给 Node 自动加引号。
   */
  verbatim?: boolean;
}

/**
 * Windows 路径加引号：路径本身不允许包含双引号，直接包一层即可。
 * 以反斜杠结尾（驱动根目录等）时不加引号，否则尾部 \ 会被命令行解析当作转义字符。
 */
function quoteWin32Path(path: string): string {
  return path.endsWith("\\") ? path : `"${path}"`;
}

/**
 * explorer.exe 的绝对路径。
 *
 * 裸名依赖 PATH 查找：IDE、精简 shell 或自定义环境的 PATH 可能不含系统目录，
 * spawn 会直接以 `spawn explorer.exe ENOENT` 失败，用户看到的就是「无法启动
 * 系统默认程序」。因此优先用 %SystemRoot%\explorer.exe，取不到时退回裸名。
 */
export function resolveWindowsExplorer(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync,
): string {
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  const candidate = win32.join(root, "explorer.exe");
  return exists(candidate) ? candidate : "explorer.exe";
}

/**
 * 平台命令集中在此，便于单测。
 * - 默认：用系统默认程序打开（目录即进入资源管理器）；
 * - `reveal`：打开所在目录并选中目标，仅对文件有意义。
 * 只负责拼装，不负责执行；调用方使用 launchSystemOpen。
 *
 * Windows 不使用 `cmd /c start`（cmd 会解释路径中的 &、% 等字符），
 * 也不依赖 PowerShell（部分环境 PATH 或执行策略受限）。
 * explorer.exe 只接收一个路径参数，由 ShellExecute 按文件关联打开，
 * 路径作为独立 argv 传递，不经过 shell 解释。
 * explorer.exe 不认正斜杠：传 `D:/a/b` 时不会报错，而是静默打开“文档”，
 * 所以 Windows 下统一转换为反斜杠。
 *
 * 引号位置同样敏感：`/select,` 开关与路径必须同属一个参数，且**只能给路径加引号**。
 * 若整段 `/select,<路径>` 被引号包住（Node 遇到含空格参数时的默认行为），
 * Explorer 匹配不到开关，会退回默认目录（通常是「文档」）——表现为“在文件夹中
 * 显示”打开的路径不对。因此 Windows 分支自带引号并置 verbatim，由调用方原样拼接。
 */
export function buildSystemOpenCommand(
  path: string,
  options: { reveal?: boolean; platform?: NodeJS.Platform } = {},
): SystemOpenCommand {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const native = win32.normalize(path);
    const quoted = quoteWin32Path(native);
    return {
      command: "explorer.exe",
      args: [options.reveal ? `/select,${quoted}` : quoted],
      verbatim: true,
    };
  }
  if (platform === "darwin")
    return options.reveal
      ? { command: "open", args: ["-R", path] }
      : { command: "open", args: [path] };
  // Linux 桌面没有统一的“选中文件”协议，退化到打开父目录
  return options.reveal
    ? { command: "xdg-open", args: [dirname(path)] }
    : { command: "xdg-open", args: [path] };
}

/** 后台启动且不等待目标程序退出；启动失败时 reject，便于接口反馈原因 */
export function launchSystemOpen(
  path: string,
  options: { reveal?: boolean } = {},
): Promise<void> {
  const { command, args, env, verbatim } = buildSystemOpenCommand(
    path,
    options,
  );
  // 不要使用 detached：Windows 下 detached 的启动器再拉起 GUI 程序时，
  // 窗口不会出现在当前桌面（实测 WPS/记事本均无窗口）。
  // 也不要用 windowsHide：它会给子进程带上 SW_HIDE，explorer.exe 会把该
  // 显示状态传给新建的资源管理器窗口，结果进程起来了但窗口不显示，
  // 用户看到的现象就是“点了没反应”。explorer.exe 本身是 GUI 程序，不会弹控制台。
  // windowsVerbatimArguments：参数已自带引号，禁止 Node 再包一层。
  // explorer.exe 改用绝对路径，避免精简 PATH 下 spawn ENOENT。
  const executable =
    command === "explorer.exe" ? resolveWindowsExplorer() : command;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "ignore",
      windowsVerbatimArguments: verbatim === true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    let settled = false;
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
    child.once("error", (error) => {
      if (settled) {
        console.error("[superpm] 系统默认程序启动后发生错误", error);
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

export function systemOpenFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `无法启动系统默认程序：${detail}`;
}
