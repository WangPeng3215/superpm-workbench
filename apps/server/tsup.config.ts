import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/mcp/stdio.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  external: ["better-sqlite3", "drizzle-orm", "@modelcontextprotocol/sdk"],
  noExternal: ["@superpm/shared"],
});
