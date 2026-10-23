import { appVersion, defaultPaths, homePath } from "./config/index.js";
import { prepareHomeIfConfigured } from "./config/home-migration.js";
import { appendFileLog } from "./config/logging.js";
import { listMcpProcesses, readServerState } from "./runtime/state.js";
import {
  createBackup,
  listBackups,
  resolveBackupDir,
  restoreBackup,
  verifyBackup,
} from "./services/backups.js";

function usage() {
  console.info(`superPM 数据备份工具 ${appVersion}

用法：
  backup-cli create [--reason 说明] [--json]   创建数据库、工作区与配置的完整备份
  backup-cli list [--json]                      列出已有备份
  backup-cli verify <备份ID|--all> [--json]     校验备份摘要与内容
  backup-cli restore <备份ID> [--json]          恢复备份（必须先停止服务与 MCP 客户端）

恢复前会自动创建 pre-restore 安全备份；原工作区改名保留，不直接删除。`);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const flags = new Set<string>();
  const positional: string[] = [];
  let reason = "manual";
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index];
    if (item === "--reason") {
      reason = rest[++index] ?? reason;
    } else if (item.startsWith("--")) flags.add(item.slice(2));
    else positional.push(item);
  }
  return { command, flags, positional, reason };
}

async function serverRunning(): Promise<boolean> {
  const state = readServerState(homePath);
  const port = state?.port ?? Number(process.env.PORT || 3001);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  const { command, flags, positional, reason } = parseArgs(
    process.argv.slice(2),
  );
  const json = flags.has("json");
  if (!command || command === "help" || flags.has("help")) {
    usage();
    return;
  }

  await prepareHomeIfConfigured();
  const { databasePath, workspacePath } = defaultPaths();
  const paths = { homePath, databasePath, workspacePath, version: appVersion };

  if (command === "create") {
    const meta = await createBackup({ ...paths, reason });
    appendFileLog(homePath, "backup.log", `创建备份 ${meta.id}`);
    if (json) {
      console.info(JSON.stringify({ ok: true, backup: meta }));
      return;
    }
    console.info(
      `已创建备份：${meta.id}\n数据库 ${meta.database.sizeBytes} 字节，工作区 ${meta.workspace.files} 个文件（${meta.workspace.bytes} 字节）`,
    );
    return;
  }

  if (command === "list") {
    const items = listBackups(homePath);
    if (json) {
      console.info(JSON.stringify({ ok: true, backups: items }));
      return;
    }
    if (items.length === 0) {
      console.info(`暂无备份（目录：${resolveBackupDir(homePath, "")}）`);
      return;
    }
    for (const meta of items)
      console.info(
        `${meta.id}  ${meta.createdAt}  v${meta.version}  ${meta.reason}  ${meta.workspace.files} 文件`,
      );
    return;
  }

  if (command === "verify") {
    const target = positional[0] ?? (flags.has("all") ? "--all" : undefined);
    if (!target) throw new Error("请指定备份 ID 或 --all");
    const ids =
      target === "--all"
        ? listBackups(homePath).map((meta) => meta.id)
        : [target];
    if (ids.length === 0) throw new Error("没有可校验的备份");
    const verified = [];
    for (const id of ids) {
      const meta = await verifyBackup(resolveBackupDir(homePath, id));
      verified.push(meta);
      if (!json)
        console.info(
          `校验通过：${meta.id}（${Object.keys(meta.database.tables).length} 张表）`,
        );
    }
    if (json) console.info(JSON.stringify({ ok: true, backups: verified }));
    return;
  }

  if (command === "restore") {
    const id = positional[0];
    if (!id) throw new Error("请指定要恢复的备份 ID");
    if (await serverRunning())
      throw new Error(
        "检测到服务正在运行，请先停止服务与所有 MCP 客户端再恢复",
      );
    const liveMcp = listMcpProcesses(homePath).filter((item) => item.alive);
    if (liveMcp.length > 0)
      throw new Error(
        `检测到 ${liveMcp.length} 个 MCP 进程仍在运行（PID ${liveMcp
          .map((item) => item.record.pid)
          .join(", ")}），请先关闭客户端再恢复`,
      );
    const result = await restoreBackup({
      backupDir: resolveBackupDir(homePath, id),
      databasePath,
      workspacePath,
      homePath,
      version: appVersion,
    });
    appendFileLog(
      homePath,
      "backup.log",
      `恢复备份 ${result.meta.id}${
        result.preRestoreBackupId
          ? `，恢复前备份 ${result.preRestoreBackupId}`
          : ""
      }`,
    );
    if (json) {
      console.info(
        JSON.stringify({
          ok: true,
          restored: result.meta.id,
          preRestoreBackupId: result.preRestoreBackupId,
          workspaceAsidePath: result.workspaceAsidePath,
        }),
      );
      return;
    }
    console.info(`已恢复备份：${result.meta.id}`);
    if (result.preRestoreBackupId)
      console.info(`恢复前的数据已备份为：${result.preRestoreBackupId}`);
    if (result.workspaceAsidePath)
      console.info(`原工作区已保留：${result.workspaceAsidePath}`);
    return;
  }

  usage();
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  console.error(
    `[backup] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
