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
 * Windows 不用 `cmd /c start`：cmd 会解释路径中的 &、% 等字符，文件名可被注入命令；
 * 改用固定 PowerShell 命令并从环境变量读取路径，避免命令拼接。
 */
export function buildSystemOpenCommand(
  path: string,
  options: { reveal?: boolean; platform?: NodeJS.Platform } = {},
): SystemOpenCommand {
  const platform = options.platform ?? process.platform;
  if (platform === "win32")
    return options.reveal
      ? { command: "explorer.exe", args: [`/select,${path}`] }
      : {
          command: "powershell.exe",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Process -FilePath $env:SUPERPM_TARGET_PATH",
          ],
          env: { SUPERPM_TARGET_PATH: path },
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

/** 后台启动且不等待目标程序退出，避免阻塞请求 */
export function launchSystemOpen(
  path: string,
  options: { reveal?: boolean } = {},
): void {
  const { command, args, env } = buildSystemOpenCommand(path, options);
  // 不要使用 detached：Windows 下 detached 的 PowerShell 再启动 GUI 程序时，
  // 窗口不会出现在当前桌面（实测 WPS/记事本均无窗口）。
  const child = spawn(command, args, {
    stdio: "ignore",
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  // 接口已返回 204，无法再向调用方反馈；至少要避免 error 事件导致服务进程退出
  child.on("error", (error) => {
    console.error("[superpm] 无法启动系统默认程序", error);
  });
  child.unref();
}
