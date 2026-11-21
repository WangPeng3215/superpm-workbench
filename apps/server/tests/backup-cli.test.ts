import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../src/backup-cli.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
let directory: string;
let homePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "superpm-backup-cli-"));
  homePath = join(directory, "home");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SUPERPM_HOME: homePath,
      SUPERPM_HOME_SOURCE: "env",
      SUPERPM_LEGACY_ROOT: join(directory, "legacy"),
      SUPERPM_CONFIG_DIR: join(directory, "config"),
      SUPERPM_DATA_DIR: "data",
      SUPERPM_WORKSPACE_DIR: "workspace",
    },
    timeout: 10000,
  });
}

describe("备份 CLI 列表", () => {
  it.each([false, true])(
    "备份根目录存在=%s 时，普通空列表成功并显示备份根目录",
    (rootExists) => {
      const backupRoot = join(homePath, "backups");
      if (rootExists) mkdirSync(backupRoot, { recursive: true });

      const result = runCli("list");

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(`暂无备份（目录：${backupRoot}）`);
    },
  );

  it("JSON 空列表保持成功", () => {
    const result = runCli("list", "--json");

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, backups: [] });
  });

  it.each(["../escape", "../../outside"])(
    "校验具体备份时仍拒绝越界 ID %s",
    (id) => {
      const result = runCli("verify", id);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`非法备份 ID：${id}`);
    },
  );
});
