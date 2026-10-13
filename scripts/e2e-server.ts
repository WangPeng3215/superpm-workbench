import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../apps/server/src/app";

const directory = mkdtempSync(join(tmpdir(), "superpm-browser-"));
const app = await createApp({
  databasePath: join(directory, "test.sqlite"),
  workspacePath: join(directory, "workspace"),
  logger: false,
  serveWeb: true,
});
await app.listen({ host: "127.0.0.1", port: 3012 });
async function shutdown() {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
