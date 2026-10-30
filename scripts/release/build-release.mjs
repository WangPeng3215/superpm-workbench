#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import yauzl from "yauzl";
import yazl from "yazl";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXED_MTIME = new Date("2020-01-01T00:00:00Z");

function parseArgs(argv) {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const options = {
    version: root.version,
    out: join(repoRoot, "release"),
    nodeVersion: "22.22.0",
    runtimeSource: "download",
    repo: "WangPeng3215/superpm-workbench",
    tag: undefined,
    notes: "",
    smoke: true,
    skipBuild: false,
    skillOnly: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === "--version") options.version = argv[++index];
    else if (item === "--out") options.out = argv[++index];
    else if (item === "--node-version") options.nodeVersion = argv[++index];
    else if (item === "--runtime-source") options.runtimeSource = argv[++index];
    else if (item === "--repo") options.repo = argv[++index];
    else if (item === "--tag") options.tag = argv[++index];
    else if (item === "--notes") options.notes = argv[++index];
    else if (item === "--notes-file")
      options.notes = readFileSync(argv[++index], "utf8");
    else if (item === "--no-smoke") options.smoke = false;
    else if (item === "--skip-build") options.skipBuild = true;
    else if (item === "--skill-only") options.skillOnly = true;
    else if (item === "--help" || item === "-h") options.help = true;
    else throw new Error(`未知参数：${item}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version))
    throw new Error(`版本号无效：${options.version}`);
  if (!["download", "local"].includes(options.runtimeSource))
    throw new Error(`--runtime-source 只能是 download 或 local`);
  return options;
}

function run(command, args, env = process.env) {
  const windows = process.platform === "win32";
  const result = spawnSync(
    windows && command === "npm" ? "npm.cmd" : command,
    args,
    {
      cwd: repoRoot,
      stdio: "inherit",
      env,
      shell: windows && command === "npm",
    },
  );
  if (result.error)
    throw new Error(
      `命令启动失败（${command} ${args.join(" ")}）：${result.error.message}`,
    );
  if (result.status !== 0)
    throw new Error(
      `命令失败（${result.status}）：${command} ${args.join(" ")}`,
    );
}

function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => done(hash.digest("hex")));
    stream.on("error", fail);
  });
}

function walk(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`发布暂存目录不允许符号链接：${absolute}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile())
        entries.push({
          absolute,
          relative: relative(root, absolute).split(sep).join("/"),
        });
    }
  };
  visit(root);
  return entries;
}

function copy(relativeSource, targetRoot, relativeTarget = relativeSource) {
  const source = join(repoRoot, relativeSource);
  if (!existsSync(source)) throw new Error(`缺少文件：${source}`);
  const target = join(targetRoot, relativeTarget);
  mkdirSync(dirname(target), { recursive: true });
  if (lstatSync(source).isDirectory())
    cpSync(source, target, { recursive: true, force: true });
  else copyFileSync(source, target);
}

function schemaVersionOf(directory) {
  const versions = readdirSync(directory)
    .map((file) => /^(\d+)_.*\.sql$/.exec(file)?.[1])
    .filter(Boolean)
    .map(Number);
  return versions.length ? Math.max(...versions) : 0;
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "superpm-release-builder/1.0" },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`下载失败：${url} HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadFile(url, target) {
  const response = await fetch(url, {
    headers: { "user-agent": "superpm-release-builder/1.0" },
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`下载失败：${url} HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(target));
}

function extractSelected(zipPath, targetDir, wanted) {
  return new Promise((done, fail) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip)
        return fail(error ?? new Error("无法读取 Node 压缩包"));
      zip.on("entry", (entry) => {
        const name = entry.fileName;
        const target = wanted[name];
        if (!target) {
          zip.readEntry();
          return;
        }
        mkdirSync(dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError);
          const output = createWriteStream(target);
          stream.on("error", fail);
          output.on("error", fail);
          output.on("finish", () => output.close(() => zip.readEntry()));
          stream.pipe(output);
        });
      });
      zip.on("end", () => done());
      zip.on("error", fail);
      zip.readEntry();
    });
  });
}

async function ensureRuntime(cacheRoot, version, source) {
  const key = `node-v${version}-win-x64`;
  const cache = join(cacheRoot, key);
  const node = join(cache, "node.exe");
  const license = join(cache, "LICENSE");
  const marker = join(cache, ".ready");
  if (existsSync(node) && existsSync(license) && existsSync(marker))
    return { node, license };
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  if (source === "local") {
    if (
      process.execPath.endsWith("node.exe") &&
      process.version === `v${version}`
    )
      copyFileSync(process.execPath, node);
    else if (process.version === `v${version}`)
      copyFileSync(process.execPath, node);
    else
      throw new Error(
        `本地 Node 版本 ${process.version} 与要求 v${version} 不一致`,
      );
    console.log(`[release] 使用本地 Node：${process.execPath}`);
    const licenseText = await fetchBuffer(
      `https://nodejs.org/dist/v${version}/LICENSE`,
    );
    writeFileSync(license, licenseText);
  } else {
    const base = `https://nodejs.org/dist/v${version}`;
    console.log(`[release] 下载 Node v${version} win-x64…`);
    const shasums = (await fetchBuffer(`${base}/SHASUMS256.txt`)).toString(
      "utf8",
    );
    const line = shasums
      .split(/\r?\n/)
      .find((item) => item.trim().endsWith(`${key}.zip`));
    if (!line) throw new Error("Node SHASUMS256 中缺少 win-x64 包");
    const expected = line.trim().split(/\s+/)[0];
    const zipPath = join(cacheRoot, `${key}.zip`);
    await downloadFile(`${base}/${key}.zip`, zipPath);
    const actual = await sha256File(zipPath);
    if (actual !== expected)
      throw new Error(
        `Node 压缩包摘要不一致：期望 ${expected}，实际 ${actual}`,
      );
    await extractSelected(zipPath, cache, {
      [`${key}/node.exe`]: node,
      [`${key}/LICENSE`]: license,
    });
    rmSync(zipPath, { force: true });
  }
  if (!existsSync(node) || !existsSync(license))
    throw new Error("Node 运行时准备失败：缺少 node.exe 或 LICENSE");
  writeFileSync(marker, `${version}\n`);
  return { node, license };
}

function stageApp(work, version) {
  const app = join(work, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(
    join(app, "package.json"),
    `${JSON.stringify(
      {
        name: "superpm-workbench",
        version,
        private: true,
        type: "module",
        dependencies: { "better-sqlite3": "12.11.1" },
      },
      null,
      2,
    )}\n`,
  );
  copy("apps/server/dist", app);
  copy("apps/server/drizzle", app);
  copy("apps/web/dist", app);

  const modules = join(app, "node_modules");
  const copyPackage = (name, files) => {
    const source = join(repoRoot, "node_modules", name);
    for (const file of files) {
      const absolute = join(source, file);
      const target = join(modules, name, file);
      mkdirSync(dirname(target), { recursive: true });
      if (lstatSync(absolute).isDirectory())
        cpSync(absolute, target, { recursive: true, force: true });
      else copyFileSync(absolute, target);
    }
  };
  copyPackage("better-sqlite3", [
    "package.json",
    "LICENSE",
    "lib",
    "build/Release/better_sqlite3.node",
  ]);
  copyPackage("bindings", ["package.json", "LICENSE.md", "bindings.js"]);
  copyPackage("file-uri-to-path", ["package.json", "LICENSE", "index.js"]);

  writeFileSync(
    join(app, "README.txt"),
    `superPM Workbench v${version}\n\n此目录为可替换程序目录，请勿手工修改。\n数据保存在数据根（默认 %LOCALAPPDATA%\\superPM）。\n`,
  );
  const schema = schemaVersionOf(join(app, "apps", "server", "drizzle"));
  const expected = schemaVersionOf(join(repoRoot, "apps", "server", "drizzle"));
  if (schema !== expected)
    throw new Error(
      `数据库迁移文件不完整：包内 schema ${schema}，仓库 schema ${expected}`,
    );
  return { app, schema };
}

function stageSkill(work, version) {
  const root = join(work, "skill");
  const skill = join(root, "superpm");
  mkdirSync(skill, { recursive: true });
  copy(".agents/skills/superpm/SKILL.md", skill, "SKILL.md");
  copy(".agents/skills/superpm/references", skill, "references");
  copy("docs/mcp.md", skill, "docs/mcp.md");
  copy("docs/install-update.md", skill, "docs/install-update.md");
  copy(
    "docs/deployment-update-strategy.md",
    skill,
    "docs/deployment-update-strategy.md",
  );
  writeFileSync(
    join(skill, "INSTALL.txt"),
    `superPM Workbench Skill v${version}

适用：superPM 源码仓库与 Release 安装版。

安装：把 superpm 目录复制到 AI 客户端的用户级 skills 目录，例如：
  Qoder        %USERPROFILE%\\.qoder\\skills\\superpm
  Claude Code  %USERPROFILE%\\.claude\\skills\\superpm
其他客户端：放入其支持的 skills 目录，或让 AI 直接读取 SKILL.md。

说明：
- 安装版请先读 references/install-mode.md，使用 SuperPM.cmd / Stop.cmd。
- 本包不包含源码仓库脚本；开发任务请在 Git 仓库中使用 Skill。
- docs/ 内为本版本对应的 MCP 与安装更新文档。
`,
  );
  return skill;
}

async function stageInstall(work, options, appStage, runtime) {
  const install = join(work, "install");
  mkdirSync(join(install, "bin"), { recursive: true });
  mkdirSync(join(install, "runtime"), { recursive: true });
  copyFileSync(
    join(repoRoot, "scripts/install/SuperPM.cmd"),
    join(install, "SuperPM.cmd"),
  );
  copyFileSync(
    join(repoRoot, "scripts/install/Update.cmd"),
    join(install, "Update.cmd"),
  );
  copyFileSync(
    join(repoRoot, "scripts/install/Stop.cmd"),
    join(install, "Stop.cmd"),
  );
  copyFileSync(
    join(repoRoot, "scripts/install/Stop.ps1"),
    join(install, "Stop.ps1"),
  );
  const bundleEntry = async (entry, target) => {
    await build({
      absWorkingDir: repoRoot,
      entryPoints: [join(repoRoot, "scripts/install", entry)],
      outfile: join(install, "bin", target),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "bundle",
      banner: {
        js: 'import{createRequire as __superpmCreateRequire}from"node:module";const require=__superpmCreateRequire(import.meta.url);',
      },
      legalComments: "none",
      logLevel: "warning",
    });
  };
  await bundleEntry("launcher.mjs", "launcher.mjs");
  await bundleEntry("updater.mjs", "updater.mjs");
  await bundleEntry("move-home.mjs", "move-home.mjs");
  copyFileSync(runtime.node, join(install, "runtime", "node.exe"));
  copyFileSync(runtime.license, join(install, "runtime", "LICENSE"));
  writeFileSync(
    join(install, "runtime", "version.txt"),
    `Node.js v${options.nodeVersion} win-x64\n`,
  );
  cpSync(appStage.app, join(install, "app"), {
    recursive: true,
    force: true,
  });
  writeFileSync(
    join(install, "install.json"),
    `${JSON.stringify(
      {
        name: "superpm-workbench",
        version: options.version,
        platform: "win32-x64",
        schemaVersion: appStage.schema,
        builtAt: new Date().toISOString(),
        updaterVersion: "1.1.0",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(install, "README.txt"),
    `superPM Workbench v${options.version}

启动：双击 SuperPM.cmd
停止：Stop.cmd（服务无响应时用 Stop.cmd -Force 强制结束）
更新：Update.cmd --manifest <更新清单地址>
数据根：%LOCALAPPDATA%\\superPM（可用 SUPERPM_HOME 覆盖）
      可在应用「设置 → 数据存储位置」中修改并迁移现有数据
日志：数据根 logs\\ 目录
`,
  );
  return install;
}

async function createZip(zipPath, root, prefix) {
  mkdirSync(dirname(zipPath), { recursive: true });
  const zip = new yazl.ZipFile();
  const entries = walk(root);
  for (const entry of entries)
    zip.addFile(entry.absolute, `${prefix}${entry.relative}`, {
      mtime: FIXED_MTIME,
      mode: 0o100644,
    });
  const output = createWriteStream(zipPath);
  const finished = new Promise((done, fail) => {
    output.on("close", done);
    output.on("error", fail);
  });
  zip.outputStream.pipe(output);
  zip.end();
  await finished;
  return { size: statSync(zipPath).size, sha256: await sha256File(zipPath) };
}

async function extractZip(zipPath, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  await new Promise((done, fail) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return fail(error ?? new Error("无法读取发布包"));
      zip.on("entry", (entry) => {
        const normalized = entry.fileName.replace(/\\/g, "/");
        const segments = normalized.split("/").filter(Boolean);
        if (
          normalized.startsWith("/") ||
          /^[A-Za-z]:/.test(normalized) ||
          segments.some((segment) => segment === "..")
        )
          return fail(new Error(`压缩包路径非法：${entry.fileName}`));
        const target = join(targetDir, ...segments);
        const distance = relative(targetDir, target);
        if (distance.startsWith("..")) return fail(new Error("压缩包路径越界"));
        if (normalized.endsWith("/")) {
          mkdirSync(target, { recursive: true });
          zip.readEntry();
          return;
        }
        mkdirSync(dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError);
          const output = createWriteStream(target);
          stream.on("error", fail);
          output.on("error", fail);
          output.on("finish", () => output.close(() => zip.readEntry()));
          stream.pipe(output);
        });
      });
      zip.on("end", () => done());
      zip.on("error", fail);
      zip.readEntry();
    });
  });
}

function writeManifest(out, options, manifest, full, update) {
  const baseUrl = `https://github.com/${options.repo}/releases/download/${options.tag}`;
  const result = {
    manifestVersion: 1,
    name: "superpm-workbench",
    version: options.version,
    platform: "win32-x64",
    releasedAt: new Date().toISOString(),
    schemaVersion: manifest.schemaVersion,
    minUpdaterVersion: "1.1.0",
    notes: options.notes || `superPM Workbench v${options.version}`,
    full: {
      file: full.file,
      url: `${baseUrl}/${encodeURIComponent(full.file)}`,
      sha256: full.sha256,
      size: full.size,
    },
    update: {
      file: update.file,
      url: `${baseUrl}/${encodeURIComponent(update.file)}`,
      sha256: update.sha256,
      size: update.size,
    },
  };
  const path = join(out, "update-manifest.json");
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return { path, manifest: result };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`用法：node scripts/release/build-release.mjs [选项]

  --version <版本>        覆盖包版本（默认根 package.json）
  --out <目录>            输出目录（默认 release/）
  --node-version <版本>   自带 Node 版本（默认 22.22.0）
  --runtime-source <来源> download | local（默认 download）
  --repo <owner/repo>     GitHub 仓库
  --tag <标签>            Release 标签（默认 v<版本>）
  --notes <说明>          更新说明
  --no-smoke              跳过安装包冒烟测试
  --skill-only            只生成 AI Skill 包，不构建安装包`);
    return;
  }
  options.tag = options.tag ?? `v${options.version}`;
  const out = resolve(options.out);
  const cache = join(repoRoot, ".release-cache");
  // 安装包需要真实执行自带运行时；放在仓库内会被开发环境的写入沙箱限制。
  const work = mkdtempSync(
    join(tmpdir(), `superpm-release-${options.version}-`),
  );
  console.log(`[release] 暂存目录 ${work}`);
  mkdirSync(out, { recursive: true });

  if (options.skillOnly) {
    const skillFile = `superpm-skill-${options.version}.zip`;
    const skillPath = join(out, skillFile);
    console.log("[release] 生成 AI Skill 包…");
    const skill = await createZip(
      skillPath,
      stageSkill(work, options.version),
      "superpm/",
    );
    rmSync(work, { recursive: true, force: true });
    console.log(
      `\n[release] 完成：\n  Skill 包 ${skillPath}（${skill.size} 字节）`,
    );
    return;
  }

  if (!options.skipBuild) {
    console.log(`[release] 构建 v${options.version}…`);
    const env = { ...process.env, SUPERPM_BUILD_VERSION: options.version };
    run("npm", ["run", "build", "-w", "@superpm/web"], env);
    run("npm", ["run", "build", "-w", "@superpm/server"], env);
  }

  const appStage = stageApp(work, options.version);
  const runtime = await ensureRuntime(
    cache,
    options.nodeVersion,
    options.runtimeSource,
  );
  const install = await stageInstall(work, options, appStage, runtime);

  const folder = `superpm-workbench-${options.version}-win-x64`;
  const fullFile = `${folder}.zip`;
  const updateFile = `superpm-workbench-${options.version}-update-win-x64.zip`;
  const fullPath = join(out, fullFile);
  const updatePath = join(out, updateFile);

  console.log("[release] 生成完整安装包…");
  const full = await createZip(fullPath, install, `${folder}/`);
  console.log("[release] 生成增量更新包…");
  const update = await createZip(updatePath, join(install, "app"), "app/");
  const skillFile = `superpm-skill-${options.version}.zip`;
  const skillPath = join(out, skillFile);
  console.log("[release] 生成 AI Skill 包…");
  const skill = await createZip(
    skillPath,
    stageSkill(work, options.version),
    "superpm/",
  );
  const manifest = writeManifest(
    out,
    options,
    { schemaVersion: appStage.schema },
    { file: fullFile, ...full },
    { file: updateFile, ...update },
  );

  if (options.smoke) {
    console.log("[release] 解压完整安装包并执行冒烟测试…");
    const smokeRoot = join(work, "smoke");
    await extractZip(fullPath, smokeRoot);
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts/release/smoke-test.mjs"),
        "--install",
        join(smokeRoot, folder),
        "--json",
      ],
      { stdio: "inherit", cwd: repoRoot, env: process.env },
    );
    if (result.status !== 0) throw new Error("安装包冒烟测试失败");
  }

  rmSync(work, { recursive: true, force: true });
  console.log(
    `\n[release] 完成：\n  完整包 ${fullPath}（${full.size} 字节）\n  更新包 ${updatePath}（${update.size} 字节）\n  Skill 包 ${skillPath}（${skill.size} 字节）\n  清单   ${manifest.path}`,
  );
}

await main();
