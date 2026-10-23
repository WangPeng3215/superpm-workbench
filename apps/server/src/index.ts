import { randomBytes } from "node:crypto";
import { createApp } from "./app.js";
import { appHome, appVersion, homePath } from "./config/index.js";
import { prepareHomeIfConfigured } from "./config/home-migration.js";
import { createServerLogger } from "./config/logging.js";
import { SCHEMA_VERSION } from "./db/migrate.js";
import { removeServerState, writeServerState } from "./runtime/state.js";

try {
  const migration = await prepareHomeIfConfigured();
  if (migration?.status === "completed")
    console.info(
      `[superpm] 用户数据已迁移到 ${migration.home}，原安装目录数据保留未删除`,
    );
} catch (error) {
  console.error("[superpm] 数据迁移失败，服务未启动；旧数据未改动。", error);
  process.exit(1);
}

const shutdownToken = randomBytes(24).toString("hex");
const app = await createApp({
  serveWeb: true,
  logger: createServerLogger(appHome) ?? true,
  shutdownToken,
  onShutdownRequested: () => void shutdown(0),
});
const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  await app.close();
  throw new Error("PORT 必须为 1–65535 的整数");
}

let closing = false;
async function shutdown(code: number) {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
    code = 1;
  }
  removeServerState(homePath);
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(0));
}
try {
  await app.listen({ host: "127.0.0.1", port });
  writeServerState(homePath, {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    version: appVersion,
    schemaVersion: SCHEMA_VERSION,
    shutdownToken,
  });
  console.info(
    `[superpm] 服务已启动：http://127.0.0.1:${port}（数据根 ${homePath}）`,
  );
} catch (error) {
  await app.close();
  throw error;
}
