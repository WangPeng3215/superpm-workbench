import { defineConfig } from "@playwright/test";

// 登录态文件：由 auth 项目写入（见 tests/e2e/auth.setup.ts，两处路径需一致）
const authStatePath = "test-results/auth-state.json";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:3012",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx tsx scripts/e2e-server.ts",
    url: "http://127.0.0.1:3012/api/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [
    // 1) 全局登录准备：登录 admin 并保存 storageState 供后续项目复用
    { name: "auth", testMatch: /auth\.setup\.ts/ },
    // 2) 业务用例：浏览器上下文与 request 夹具统一携带登录态（旧用例零改动）
    {
      name: "e2e",
      testIgnore: /auth\.setup\.ts|auth-flow\.spec\.ts/,
      dependencies: ["auth"],
      use: { storageState: authStatePath },
    },
    // 3) 认证流程用例：未登录状态起步
    {
      name: "auth-flow",
      testMatch: /auth-flow\.spec\.ts/,
      dependencies: ["auth"],
    },
  ],
});
