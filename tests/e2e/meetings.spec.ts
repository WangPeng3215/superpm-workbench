import { test, expect, type Page } from "@playwright/test";

async function applyColor(page: Page) {
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "文字颜色", exact: true }).click();
  await page.locator('button[aria-label="文字颜色 #be123c"]:visible').click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "文字高亮", exact: true }).click();
  await page.locator('button[aria-label="高亮颜色 #fef08a"]:visible').click();
}

test("meeting create, detail and edit use the left-right editor layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/meetings");
  await expect(page.locator(".page-heading")).toHaveCount(0);
  await expect(page.locator(".toolbox-fab")).toBeVisible();
  await expect(page.locator(".fab-badge")).toHaveCount(0);

  await page.goto("/meetings/new");
  const title = `布局验收会议-${Date.now()}`;
  await page.getByPlaceholder("例如：第 42 周项目周例会").fill(title);
  await page
    .locator('.rich-document[aria-label="会议内容"]')
    .fill("会议布局验收内容：左侧编辑区应占据主要面积。");
  await applyColor(page);

  // 新建：编辑区在左、信息栏在右，正文撑满左侧剩余高度
  const createMain = await page.locator(".form-main").boundingBox();
  const createSide = await page.locator(".form-side").boundingBox();
  const createDoc = await page
    .locator(".form-main .rich-document")
    .boundingBox();
  expect(createMain!.width).toBeGreaterThan(createSide!.width);
  expect(createSide!.x).toBeGreaterThan(createMain!.x + createMain!.width);
  expect(createDoc!.height).toBeGreaterThan(300);
  await page.screenshot({ path: "test-results/meeting-create.png" });

  await page.getByRole("button", { name: "保存会议" }).click();
  await expect(page).toHaveURL(/\/meetings\/\d+$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(
    page.locator('.rich-document[aria-label="会议内容"]'),
  ).toContainText("会议布局验收内容");
  // 颜色经 HTML 持久化后在只读详情仍保留
  await expect(
    page.locator('.rich-document[aria-label="会议内容"] span').first(),
  ).toHaveCSS("color", "rgb(190, 18, 60)");

  // 详情：只读正文占左侧主要面积，右侧信息栏纵向排列
  const panel = await page.locator(".content-panel").boundingBox();
  const side = await page.locator(".detail-side").boundingBox();
  const readonlyDoc = await page
    .locator(".content-panel .rich-document")
    .boundingBox();
  expect(panel!.width).toBeGreaterThan(side!.width);
  expect(side!.x).toBeGreaterThan(panel!.x + panel!.width);
  expect(readonlyDoc!.height).toBeGreaterThan(panel!.height * 0.8);
  await page.screenshot({ path: "test-results/meeting-detail.png" });

  // 编辑态同样保持左右布局
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editMain = await page.locator(".form-main").boundingBox();
  const editSide = await page.locator(".form-side").boundingBox();
  const editDoc = await page.locator(".form-main .rich-document").boundingBox();
  expect(editMain!.width).toBeGreaterThan(editSide!.width);
  expect(editSide!.x).toBeGreaterThan(editMain!.x + editMain!.width);
  expect(editDoc!.height).toBeGreaterThan(300);
  await page.screenshot({ path: "test-results/meeting-edit.png" });

  expect(errors).toEqual([]);
});

test("meeting requirement picker adds to a clickable list", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const requirementName = `关联需求-${stamp}`;
  const created = await (
    await request.post("/api/requirements", {
      data: { name: requirementName, proposedAt: "2026-10-26" },
    })
  ).json();
  expect(created.requirementNo).toMatch(/^REQ-\d+$/);

  await page.goto("/meetings/new");
  const title = `关联需求会议-${stamp}`;
  await page.getByPlaceholder("例如：第 42 周项目周例会").fill(title);

  const picker = page.locator(".requirement-picker");
  const search = picker.getByRole("combobox", { name: "搜索需求" });
  await search.click();
  await search.fill(requirementName);
  const option = page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: requirementName });
  await expect(option).toBeVisible();
  await option.click();
  await expect(option).toBeHidden();

  // 搜索框只负责检索：选中后清空并恢复占位文案，关联项落到下方列表
  await expect(search).toHaveValue("");
  await expect(picker.locator(".el-select__placeholder")).toHaveText(
    "搜索需求编号或名称，点击结果添加",
  );
  const row = picker
    .locator(".selected-row")
    .filter({ hasText: requirementName });
  await expect(row).toContainText(created.requirementNo);

  // 再次搜索时已关联项标记「已添加」且不可重复选择
  await search.click();
  await search.fill(requirementName);
  const again = page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: requirementName });
  await expect(again).toBeVisible();
  await expect(again).toHaveClass(/is-disabled/);
  await expect(again).toContainText("已添加");
  // 点击表单其他区域收起下拉，避免遮挡下方列表行
  await page.getByPlaceholder("例如：第 42 周项目周例会").click();
  await expect(again).toBeHidden();

  // 点击列表行打开需求详情：未保存先确认，取消后留在新建页
  await row
    .getByRole("button", { name: `打开需求 ${created.requirementNo}` })
    .click();
  const confirm = page.locator(".el-message-box");
  await expect(confirm).toContainText("离开新建会议");
  await confirm.getByRole("button", { name: "继续编辑" }).click();
  await expect(page).toHaveURL(/\/meetings\/new$/);
  await expect(row).toBeVisible();

  // 保存后详情展示关联需求，点击同样可打开需求详情
  await page.getByRole("button", { name: "保存会议" }).click();
  await expect(page).toHaveURL(/\/meetings\/\d+$/);
  const detailRow = page
    .locator(".requirement-row")
    .filter({ hasText: requirementName });
  await expect(detailRow).toContainText(created.requirementNo);
  await detailRow.click();
  await expect(page).toHaveURL(new RegExp(`/requirements/${created.id}$`));
  await expect(
    page.getByRole("heading", { name: requirementName }),
  ).toBeVisible();
});

test("closing an unsaved new-meeting tab waits for leave confirmation", async ({
  page,
}) => {
  await page.goto("/meetings/new");
  const title = `未保存关闭-${Date.now()}`;
  const titleInput = page.getByPlaceholder("例如：第 42 周项目周例会");
  await titleInput.fill(title);

  const tab = page.locator(".topbar-tab").filter({ hasText: "新建会议" });
  const close = tab.locator(".tab-close");
  await close.click();

  const confirm = page.locator(".el-message-box");
  await expect(confirm).toContainText("离开新建会议");
  // 取消时页签与页面都必须保留，不能出现页签先关闭导致页面不同步
  await confirm.getByRole("button", { name: "继续编辑" }).click();
  await expect(page).toHaveURL(/\/meetings\/new$/);
  await expect(tab).toBeVisible();
  await expect(titleInput).toHaveValue(title);

  await close.click();
  await expect(confirm).toContainText("离开新建会议");
  await confirm.getByRole("button", { name: "离开", exact: true }).click();
  await expect(page).toHaveURL(/\/requirements$/);
  await expect(
    page.locator(".topbar-tab").filter({ hasText: "新建会议" }),
  ).toHaveCount(0);
});
