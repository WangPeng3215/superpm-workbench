import { expect, test, type Page } from "@playwright/test";

// auth-flow 项目未配置 storageState：浏览器与 request 夹具均以未登录状态起步，
// 专用于验证登录 / 退出 / 改密流程本身。

// 登录页表单在浅色（ClassicTheme .cf-*）与深色（DarkTheme .df-*）主题下结构一致，
// 统一用 autocomplete 属性定位输入框、按钮文案定位提交按钮
function usernameInput(page: Page) {
  return page.locator("input[autocomplete='username']");
}
function passwordInput(page: Page) {
  return page.locator("input[autocomplete='current-password']");
}
function submitButton(page: Page) {
  return page.getByRole("button", { name: "立即登录" });
}
// 右上角用户区下拉菜单项
async function openUserMenu(page: Page, command: string) {
  await page.locator(".user-trigger").click();
  await page
    .locator(".el-dropdown-menu__item:visible")
    .getByText(command, { exact: true })
    .click();
}
async function loginViaUi(page: Page, username: string, password: string) {
  await page.goto("/login");
  await usernameInput(page).fill(username);
  await passwordInput(page).fill(password);
  await submitButton(page).click();
}

test("错误密码登录失败并提示", async ({ page }) => {
  await loginViaUi(page, "admin", "wrong-password");
  await expect(page.locator(".cf-error, .df-error")).toContainText(
    "账号或密码错误",
  );
  await expect(page).toHaveURL(/\/login/);
});

test("正确密码登录后进入需求工作台并显示用户名", async ({ page }) => {
  await loginViaUi(page, "admin", "admin123");
  await expect(page).toHaveURL(/\/requirements/);
  // 右上角用户区显示种子账号显示名
  await expect(page.locator(".user-trigger strong")).toHaveText("管理员");
  // 侧栏底部保留系统设置入口
  await expect(
    page.locator(".sidebar-bottom").getByText("系统设置"),
  ).toBeVisible();
});

test("退出登录后访问受保护页面回到登录页", async ({ page }) => {
  await loginViaUi(page, "admin", "admin123");
  await expect(page).toHaveURL(/\/requirements/);
  await openUserMenu(page, "退出登录");
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  // 未登录访问受保护路由：守卫重定向回登录页并携带回跳地址
  await page.goto("/requirements");
  await expect(page).toHaveURL(/\/login\?redirect=/);
});

test("修改密码后旧密码失效、新密码可登录", async ({
  page,
  request,
}) => {
  await loginViaUi(page, "admin", "admin123");
  await expect(page).toHaveURL(/\/requirements/);
  await openUserMenu(page, "修改密码");
  const dialog = page.locator(".el-dialog");
  await dialog.getByPlaceholder("请输入原密码").fill("admin123");
  await dialog.getByPlaceholder("至少 6 位").fill("newpass456");
  await dialog.getByPlaceholder("再次输入新密码").fill("newpass456");
  await dialog.getByRole("button", { name: "确认修改" }).click();
  await expect(page.locator(".el-message")).toContainText("密码已修改");
  // 退出登录
  await openUserMenu(page, "退出登录");
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  // 旧密码已失效
  const oldLogin = await request.post("/api/auth/login", {
    data: { username: "admin", password: "admin123" },
  });
  expect(oldLogin.status()).toBe(401);
  // 新密码可登录，随后恢复默认密码避免影响其他用例
  const newLogin = await request.post("/api/auth/login", {
    data: { username: "admin", password: "newpass456" },
  });
  expect(newLogin.ok()).toBeTruthy();
  const restore = await request.post("/api/auth/change-password", {
    data: { oldPassword: "newpass456", newPassword: "admin123" },
  });
  expect(restore.ok()).toBeTruthy();
});
