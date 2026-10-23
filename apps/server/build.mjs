import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
rmSync(join(root, "dist"), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    index: "src/index.ts",
    "mcp/stdio": "src/mcp/stdio.ts",
    "backup-cli": "src/backup-cli.ts",
    "db/migrate-cli": "src/db/migrate-cli.ts",
  },
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "bundle",
  // 原生模块必须从发布包的 node_modules 加载；其余依赖全部进 bundle。
  external: ["better-sqlite3"],
  // 打包进 ESM 的 CJS 依赖仍会调用 require；注入 createRequire 保证运行时可解析。
  banner: {
    js: 'import{createRequire as __superpmCreateRequire}from"node:module";const require=__superpmCreateRequire(import.meta.url);',
  },
  legalComments: "none",
  logLevel: "info",
});
