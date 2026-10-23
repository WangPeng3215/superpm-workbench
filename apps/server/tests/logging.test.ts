import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileLog, createServerLogger } from "../src/config/logging.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "superpm-log-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function waitForContent(path: string, expected: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (content.includes(expected)) return content;
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("数据根文件日志", () => {
  it("追加日志带时间戳，未配置数据根时静默", () => {
    appendFileLog(home, "backup.log", "创建备份 demo");
    const content = readFileSync(join(home, "logs", "backup.log"), "utf8");
    expect(content).toContain("创建备份 demo");
    expect(content.trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(() => appendFileLog(undefined, "backup.log", "忽略")).not.toThrow();
  });

  it("服务日志同时写入数据根按日文件", async () => {
    const logger = createServerLogger(home);
    expect(logger?.level).toBe("info");
    logger!.stream.write('{"level":30,"msg":"hello"}\n');
    await new Promise<void>((done) => logger!.stream.end(done));
    const files = readdirSync(join(home, "logs")).filter((name) =>
      name.startsWith("server-"),
    );
    expect(files).toHaveLength(1);
    const content = await waitForContent(
      join(home, "logs", files[0]),
      '"msg":"hello"',
    );
    expect(content).toContain('"msg":"hello"');
  });

  it("未配置数据根时不创建服务日志", () => {
    expect(createServerLogger(undefined)).toBeUndefined();
  });
});
