import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { dailyDateSchema, dailyTimeSchema } from "@superpm/shared";

process.env.SUPERPM_BUSINESS_TZ = "Asia/Shanghai";
const businessDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: process.env.SUPERPM_BUSINESS_TZ,
}).format(new Date());
let dailyTaskClock = new Date(businessDate + "T10:00:00+08:00");
const testClockSchema = z
  .object({ date: dailyDateSchema, time: dailyTimeSchema })
  .strict();
const { createApp } = await import("../apps/server/src/app");

const directory = mkdtempSync(join(tmpdir(), "superpm-browser-"));
const app = await createApp({
  databasePath: join(directory, "test.sqlite"),
  workspacePath: join(directory, "workspace"),
  logger: false,
  serveWeb: true,
  dailyTaskNow: () => new Date(dailyTaskClock),
});
app.get("/__test/clock", async () => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(dailyTaskClock)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
});
app.post("/__test/clock", async (request, reply) => {
  const { date, time } = testClockSchema.parse(request.body);
  dailyTaskClock = new Date(`${date}T${time}:00+08:00`);
  return reply.send({ date, time });
});
await app.listen({ host: "127.0.0.1", port: 3012 });
async function shutdown() {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
