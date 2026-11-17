import { it, expect } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("独立打包后的更新器不会因其他进程复用旧 MCP PID 而停在结束进程阶段", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superpm-updater-runtime-"));
  try {
    const updater = join(directory, "updater.mjs");
    await build({
      entryPoints: [resolve("scripts/install/updater.mjs")],
      outfile: updater,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: {
        js: 'import{createRequire as __superpmCreateRequire}from"node:module";const require=__superpmCreateRequire(import.meta.url);',
      },
    });
    const installRoot = join(directory, "install");
    const home = join(directory, "home");
    const migrations = join(installRoot, "app", "apps", "server", "drizzle");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(join(migrations, "0001_initial.sql"), "-- fixture");
    writeFileSync(
      join(installRoot, "app", "package.json"),
      JSON.stringify({ name: "superpm-workbench", version: "0.10.0" }),
    );
    mkdirSync(join(home, "runtime", "mcp"), { recursive: true });
    writeFileSync(
      join(home, "runtime", "mcp", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
        heartbeatAt: "2026-01-01T00:00:00.000Z",
        version: "0.10.0",
        schemaVersion: 1,
        writeEnabled: false,
      }),
    );
    const manifest = join(directory, "manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        name: "superpm-workbench",
        version: "1.1.0",
        platform: `${process.platform}-${process.arch}`,
        schemaVersion: 1,
        update: {
          file: "intentionally-missing.zip",
          sha256: "0".repeat(64),
          size: 1,
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        updater,
        "--manifest",
        manifest,
        "--install-root",
        installRoot,
        "--home",
        home,
        "--no-relocate",
        "--no-restart",
        "--force",
        "--timeout",
        "0",
        "--json",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        env: {
          ...process.env,
          SUPERPM_HOME: home,
          SUPERPM_CONFIG_DIR: join(directory, "config"),
        },
      },
    );
    expect(result.error).toBeUndefined();
    const outcome = JSON.parse(
      readFileSync(join(home, "updates", "last-update.json"), "utf8"),
    );
    // 只演练停机阶段：故意不存在的更新包让流程在下载阶段退出，不替换程序或数据。
    expect(outcome.logs).toContain("服务与 MCP 已停止");
    expect(outcome.error).toContain("intentionally-missing.zip");
    expect(outcome.error).not.toMatch(/MCP 进程/);
    expect(result.status).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
