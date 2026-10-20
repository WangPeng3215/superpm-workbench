import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test as setup, expect } from "@playwright/test";

// 全局认证准备：用种子账号 admin 登录一次并把会话 Cookie 保存为 storageState，
// 供 "e2e" 项目的浏览器上下文与 request 夹具统一复用（旧用例零改动通过鉴权）。
// 路径需与 playwright.config.ts 中 e2e 项目的 storageState 保持一致。
const authStatePath = join(
  process.cwd(),
  "test-results",
  "auth-state.json",
);

setup("登录默认账号并保存会话", async ({ request }) => {
  mkdirSync(dirname(authStatePath), { recursive: true });
  const response = await request.post("/api/auth/login", {
    data: { username: "admin", password: "admin123" },
  });
  expect(response.ok()).toBeTruthy();
  await request.storageState({ path: authStatePath });
});
