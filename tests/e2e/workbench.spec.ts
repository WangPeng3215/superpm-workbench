import { test, expect } from "@playwright/test";

test("requirement CRUD, child relationships, stage viewing and restart-safe persistence", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/requirements");
  await expect(page.getByText("本地服务已连接")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "需求工作台", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建需求", exact: true }).click();
  const form = page.getByRole("dialog");
  await form
    .getByPlaceholder("例如：建立本地文件版本管理")
    .fill("浏览器验收主需求");
  await form
    .getByPlaceholder("描述背景、目标和范围（可后续补充）")
    .fill("验证基础框架的完整操作流程");
  await form.getByRole("button", { name: "创建需求", exact: true }).click();
  await expect(page.locator(".xly-drawer")).toBeVisible();
  const created = (
    await (await request.get("/api/requirements?q=浏览器验收主需求")).json()
  ).items[0];
  await page.locator(".progress-stage").filter({ hasText: "需求测试" }).click();
  await expect(page.getByText("需求测试工作区骨架已就绪")).toBeVisible();
  expect(
    (await (await request.get(`/api/requirements/${created.id}`)).json())
      .currentStage,
  ).toBe("analysis");
  await page.getByRole("button", { name: "设为当前阶段" }).click();
  await expect(
    page.getByText("需求分析 → 需求测试", { exact: true }),
  ).toBeVisible();
  expect(
    (await (await request.get(`/api/requirements/${created.id}`)).json())
      .status,
  ).toBe("not_started");
  await page.screenshot({ path: "test-results/detail.png", fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "子需求", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByPlaceholder("例如：建立本地文件版本管理")
    .fill("浏览器验收子需求");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建需求", exact: true })
    .click();
  await expect(page.locator(".xly-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "浏览器验收子需求", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("row")
    .filter({ hasText: "浏览器验收子需求" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByPlaceholder("例如：建立本地文件版本管理")
    .fill("浏览器验收子需求已编辑");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "浏览器验收子需求已编辑", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "浏览器验收子需求已编辑", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "浏览器验收子需求已编辑", exact: true })
    .click();
  await page.getByRole("button", { name: "软删除需求" }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "浏览器验收子需求已编辑", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "确认删除", exact: true }),
  ).toBeHidden();
  await expect(page.locator(".xly-drawer")).toBeHidden();
  await page.screenshot({ path: "test-results/workbench.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("dirty edit survives cancelled close and router navigation", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.getByRole("link", { name: "需求工作台", exact: true }).click();
  await page.getByRole("button", { name: "新建需求", exact: true }).click();
  await page
    .getByPlaceholder("例如：建立本地文件版本管理")
    .fill("尚未保存的内容");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续编辑", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByPlaceholder("例如：建立本地文件版本管理")).toHaveValue(
    "尚未保存的内容",
  );
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "继续编辑", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByPlaceholder("例如：建立本地文件版本管理")).toHaveValue(
    "尚未保存的内容",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(page.getByPlaceholder("例如：建立本地文件版本管理")).toHaveCount(
    0,
  );
});

test("ordinary creation keeps parent selector editable; settings deep link works", async ({
  page,
}) => {
  await page.goto("/requirements");
  await page.getByRole("button", { name: "新建需求", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("父需求", { exact: true })).toBeVisible();
  await expect(
    dialog.locator("[data-testid=parent-requirement-select]"),
  ).toBeVisible();
  await dialog
    .locator("[data-testid=parent-requirement-select] .el-select__wrapper")
    .click();
  await page
    .getByRole("option")
    .filter({ hasText: "浏览器验收主需求" })
    .click();
  await expect(dialog.getByText("父需求", { exact: true })).toBeVisible();
  await dialog
    .locator("[data-testid=parent-requirement-select] .el-select__wrapper")
    .click();
  await expect(
    page.getByRole("option").filter({ hasText: "浏览器验收主需求" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "本地存储", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("数据库位置", { exact: true })).toBeVisible();
});
