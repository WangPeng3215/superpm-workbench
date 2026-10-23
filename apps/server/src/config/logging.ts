import { appendFileSync, createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";

export interface ServerLoggerOptions {
  level: string;
  stream: Writable;
}

function writeLine(home: string, name: string, message: string) {
  const directory = join(home, "logs");
  mkdirSync(directory, { recursive: true });
  appendFileSync(
    join(directory, name),
    `${new Date().toISOString()} ${message}\n`,
    "utf8",
  );
}

/** 数据根内的追加日志；日志失败不能影响业务，因此忽略异常。 */
export function appendFileLog(
  home: string | undefined,
  name: string,
  message: string,
) {
  if (!home) return;
  try {
    writeLine(home, name, message);
  } catch {
    // 日志不可写时保持静默，避免掩盖真正的业务错误
  }
}

/** HTTP 服务主日志：控制台与数据根 logs/server-YYYY-MM-DD.log 同时写入。 */
export function createServerLogger(
  home: string | undefined,
): ServerLoggerOptions | undefined {
  if (!home) return undefined;
  const directory = join(home, "logs");
  mkdirSync(directory, { recursive: true });
  const file = createWriteStream(
    join(directory, `server-${new Date().toISOString().slice(0, 10)}.log`),
    { flags: "a" },
  );
  file.on("error", () => {});
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      process.stdout.write(chunk);
      file.write(chunk, callback);
    },
    final(callback) {
      file.end();
      callback();
    },
  });
  return { level: "info", stream };
}
