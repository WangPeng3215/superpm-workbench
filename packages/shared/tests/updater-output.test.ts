import { build } from "esbuild";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const updaterSource = fileURLToPath(
  new URL("../../../scripts/install/updater.mjs", import.meta.url),
);
let bundleDirectory: string;
let runNode: (
  context: { node: string; childEnv: NodeJS.ProcessEnv },
  script: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

beforeAll(async () => {
  bundleDirectory = mkdtempSync(
    join(tmpdir(), "superpm-updater-output-bundle-"),
  );
  const updater = join(bundleDirectory, "updater.mjs");
  const source = readFileSync(updaterSource, "utf8");
  expect(source).toMatch(/await main\(\);\s*$/);
  await build({
    stdin: {
      contents: source.replace(/await main\(\);\s*$/, "export { runNode };\n"),
      resolveDir: dirname(updaterSource),
      sourcefile: updaterSource,
      loader: "js",
    },
    outfile: updater,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import{createRequire as __superpmCreateRequire}from"node:module";const require=__superpmCreateRequire(import.meta.url);',
    },
  });
  ({ runNode } = await import(/* @vite-ignore */ pathToFileURL(updater).href));
}, 30000);

afterAll(() => {
  if (bundleDirectory)
    rmSync(bundleDirectory, { recursive: true, force: true });
});

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("Temporary output writer did not finish");
    await new Promise((done) => setTimeout(done, 20));
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("updater command output", () => {
  it("waits for inherited stdout to close before returning command output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "superpm-updater-output-"));
    const cli = join(directory, "cli.cjs");
    const writer = join(directory, "writer.cjs");
    const writerPid = join(directory, "writer.pid");
    const writerDone = join(directory, "writer.done");
    const output =
      JSON.stringify({ ok: true, backup: { id: "fixture" } }) + "\n";
    writeFileSync(
      writer,
      [
        'const { writeFileSync } = require("node:fs");',
        "const parentPid = Number(process.argv[2]);",
        "const deadline = Date.now() + 3000;",
        'process.once("exit", () => writeFileSync(' +
          JSON.stringify(writerDone) +
          ', "done"));',
        "function writeAfterParentExit() {",
        "  try { process.kill(parentPid, 0); } catch {",
        "    setTimeout(() => process.stdout.write(" +
          JSON.stringify(output) +
          "), 300);",
        "    return;",
        "  }",
        "  if (Date.now() >= deadline) { process.exitCode = 1; return; }",
        "  setTimeout(writeAfterParentExit, 10);",
        "}",
        "writeAfterParentExit();",
      ].join("\n"),
    );
    writeFileSync(
      cli,
      [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        "const writer = spawn(process.execPath, [" +
          JSON.stringify(writer) +
          ", String(process.pid)], {",
        '  detached: true, stdio: ["ignore", "inherit", "inherit"], windowsHide: true,',
        "});",
        "writeFileSync(" + JSON.stringify(writerPid) + ", String(writer.pid));",
        "writer.unref();",
      ].join("\n"),
    );

    try {
      await expect(
        runNode(
          { node: process.execPath, childEnv: { ...process.env } },
          cli,
          [],
        ),
      ).resolves.toEqual({ stdout: output, stderr: "" });
    } finally {
      // The command may settle before its detached writer; retain its files until exit.
      await waitUntil(() => existsSync(writerPid) && existsSync(writerDone));
      const pid = Number(readFileSync(writerPid, "utf8"));
      await waitUntil(() => !isAlive(pid));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
