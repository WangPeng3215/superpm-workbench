import { spawn } from "node:child_process";
import { dirname } from "node:path";

export interface SystemOpenCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
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
 */
export function buildSystemOpenCommand(
  path: string,
  options: { reveal?: boolean; platform?: NodeJS.Platform } = {},
): SystemOpenCommand {
  const platform = options.platform ?? process.platform;
  if (platform === "win32")
    return {
      command: "explorer.exe",
      args: [options.reveal ? `/select,${path}` : path],
    };
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
  const { command, args, env } = buildSystemOpenCommand(path, options);
  // 不要使用 detached：Windows 下 detached 的启动器再拉起 GUI 程序时，
  // 窗口不会出现在当前桌面（实测 WPS/记事本均无窗口）。
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: true,
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
