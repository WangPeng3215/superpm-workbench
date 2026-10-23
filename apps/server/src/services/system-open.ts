import { dirname } from "node:path";

export interface SystemOpenCommand {
  command: string;
  args: string[];
}

/**
 * 平台命令集中在此，便于单测。
 * - 默认：用系统默认程序打开（目录即进入资源管理器）；
 * - `reveal`：打开所在目录并选中目标，仅对文件有意义。
 * 只负责拼装，不负责执行；调用方负责 detached spawn。
 */
export function buildSystemOpenCommand(
  path: string,
  options: { reveal?: boolean; platform?: NodeJS.Platform } = {},
): SystemOpenCommand {
  const platform = options.platform ?? process.platform;
  if (platform === "win32")
    return options.reveal
      ? { command: "explorer.exe", args: ["/select,", path] }
      : { command: "cmd", args: ["/c", "start", "", path] };
  if (platform === "darwin")
    return options.reveal
      ? { command: "open", args: ["-R", path] }
      : { command: "open", args: [path] };
  // Linux 桌面没有统一的“选中文件”协议，退化到打开父目录
  return options.reveal
    ? { command: "xdg-open", args: [dirname(path)] }
    : { command: "xdg-open", args: [path] };
}
