import { test, expect, type Page } from "@playwright/test";

const prefix = "E2E在线工具-";

type ToolboxProbe = { urls: string[]; block: boolean };

declare global {
  interface Window {
    __toolboxProbe?: ToolboxProbe;
  }
}

async function openAddDialog(page: Page) {
  await page.getByRole("button", { name: "添加工具" }).click();
  const dialog = page.getByRole("dialog", { name: "添加在线工具" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function addTool(
  page: Page,
  options: {
    name: string;
    url: string;
    category?: string;
    description?: string;
    favorite?: boolean;
  },
) {
  const dialog = await openAddDialog(page);
  await dialog.getByRole("textbox", { name: "工具名称" }).fill(options.name);
  await dialog.getByRole("textbox", { name: "工具网址" }).fill(options.url);
  if (options.category) {
    await dialog.locator(".category-select .el-select__wrapper").click();
    await page
      .locator(".el-select-dropdown__item:visible")
      .filter({ hasText: options.category })
      .first()
      .click();
  }
  if (options.description)
    await dialog
      .getByRole("textbox", { name: "简介" })
      .fill(options.description);
  if (options.favorite)
    await dialog
      .locator(".el-form-item")
      .filter({ hasText: "快捷入口" })
      .locator(".el-switch")
      .click();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  return page.locator(".el-table__row").filter({ hasText: options.name });
}

async function openToolbox(page: Page) {
  await page.locator(".toolbox-fab").click();
  const panel = page.getByRole("dialog", { name: "快捷工具" });
  await expect(panel).toBeVisible();
  return panel;
}

test.afterEach(async ({ request }) => {
  const response = await request.get("/api/online-tools");
  if (!response.ok()) return;
  const tools = (await response.json()) as { id: number; name: string }[];
  for (const tool of tools) {
    if (tool.name.startsWith(prefix))
      await request.delete(`/api/online-tools/${tool.id}`);
  }
});

test("在线工具箱：维护、快捷弹窗与安全打开", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const probe: ToolboxProbe = { urls: [], block: false };
    window.__toolboxProbe = probe;
    window.open = ((url?: string | URL) => {
      if (probe.block) return null;
      probe.urls.push(String(url));
      return { opener: window } as Window;
    }) as typeof window.open;
  });

  const figma = `${prefix}${Date.now()}-Figma`;
  const processOn = `${prefix}${Date.now()}-ProcessOn`;

  await page.goto("/online-tools");
  await expect(page.getByRole("heading", { name: "在线工具" })).toBeVisible();
  await expect(page.getByText("还没有在线工具")).toBeVisible();

  // 新增两个收藏工具：第二个应追加到快捷入口末尾
  await addTool(page, {
    name: figma,
    url: "https://www.figma.com",
    category: "效率",
    description: "在线协作设计",
    favorite: true,
  });
  await expect(page.getByText("在线工具已添加")).toBeVisible();
  await expect(page.locator(".fab-badge")).toHaveText("1");

  await addTool(page, {
    name: processOn,
    url: "https://www.processon.com",
    category: "思维导图",
    description: "在线流程图与思维导图",
    favorite: true,
  });
  await expect(page.locator(".fab-badge")).toHaveText("2");

  const firstRow = page.locator(".el-table__row").first();
  await expect(firstRow).toContainText(figma);
  const processRow = page
    .locator(".el-table__row")
    .filter({ hasText: processOn });
  await expect(processRow).toContainText("快捷");
  await processRow.getByRole("button", { name: `上移 ${processOn}` }).click();
  await expect(page.locator(".el-table__row").first()).toContainText(processOn);
  await expect(
    page.getByRole("button", { name: `上移 ${processOn}` }),
  ).toBeDisabled();

  // 搜索与分类过滤（维护页按名称搜索）
  await page.getByRole("textbox", { name: "搜索工具名称" }).fill("Figma");
  await expect(page.locator(".el-table__row")).toHaveCount(1);
  await expect(page.locator(".el-table__row").first()).toContainText(figma);
  await page.getByRole("textbox", { name: "搜索工具名称" }).fill("");
  await expect(page.locator(".el-table__row")).toHaveCount(2);

  // 悬浮弹窗：只展示启用且收藏的工具，支持按名称/简介/分类搜索
  let panel = await openToolbox(page);
  await expect(
    panel.getByRole("button", { name: new RegExp(figma) }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: new RegExp(processOn) }),
  ).toBeVisible();
  await expect(panel.getByText("www.figma.com")).toBeVisible();
  const search = panel.getByRole("textbox", { name: "搜索快捷工具" });
  await search.fill("思维导图");
  await expect(
    panel.getByRole("button", { name: new RegExp(figma) }),
  ).toBeHidden();
  await expect(
    panel.getByRole("button", { name: new RegExp(processOn) }),
  ).toBeVisible();
  await search.fill("找不到的工具");
  await expect(panel.getByText("没有找到匹配的工具")).toBeVisible();
  await panel.getByRole("button", { name: "清除搜索" }).click();
  await expect(
    panel.getByRole("button", { name: new RegExp(figma) }),
  ).toBeVisible();

  // 打开工具：新标签页、关闭弹窗、记录网址
  await panel.getByRole("button", { name: new RegExp(figma) }).click();
  await expect(panel).toBeHidden();
  const opened = await page.evaluate(() => window.__toolboxProbe?.urls ?? []);
  expect(opened).toContain("https://www.figma.com");

  // 弹窗被拦截时给出提示且不关闭
  panel = await openToolbox(page);
  await page.evaluate(() => {
    if (window.__toolboxProbe) window.__toolboxProbe.block = true;
  });
  await panel.getByRole("button", { name: new RegExp(processOn) }).click();
  await expect(
    page.getByText("浏览器拦截了新标签页，请允许弹出窗口后重试"),
  ).toBeVisible();
  await expect(panel).toBeVisible();
  await page.evaluate(() => {
    if (window.__toolboxProbe) window.__toolboxProbe.block = false;
  });

  // 点击外部关闭弹窗
  await page.getByRole("heading", { name: "在线工具" }).click();
  await expect(panel).toBeHidden();

  // 停用后不出现在快捷弹窗；重新启用恢复
  await processRow.locator(".el-switch").nth(1).click();
  await expect(page.getByText("工具已停用")).toBeVisible();
  panel = await openToolbox(page);
  await expect(
    panel.getByRole("button", { name: new RegExp(processOn) }),
  ).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page
    .locator(".el-table__row")
    .filter({ hasText: processOn })
    .locator(".el-switch")
    .nth(1)
    .click();
  await expect(page.getByText("工具已启用")).toBeVisible();

  // 重名与非法网址校验
  const duplicate = await openAddDialog(page);
  await duplicate.getByRole("textbox", { name: "工具名称" }).fill(figma);
  await duplicate
    .getByRole("textbox", { name: "工具网址" })
    .fill("https://example.com");
  await duplicate.getByRole("button", { name: "保存" }).click();
  await expect(
    duplicate.getByText("工具名称已存在，请换一个名称"),
  ).toBeVisible();
  await duplicate.getByRole("button", { name: "取消" }).click();
  await expect(duplicate).toBeHidden();

  const unsafe = await openAddDialog(page);
  await unsafe.getByRole("textbox", { name: "工具名称" }).fill(`${prefix}非法`);
  await unsafe
    .getByRole("textbox", { name: "工具网址" })
    .fill("javascript:alert(1)");
  await unsafe.getByRole("button", { name: "保存" }).click();
  await expect(
    unsafe.getByText("请输入以 http:// 或 https:// 开头的有效网址"),
  ).toBeVisible();
  await unsafe.getByRole("button", { name: "取消" }).click();

  // 删除确认文案与空态
  const deleteRow = page.locator(".el-table__row").filter({ hasText: figma });
  await deleteRow.getByRole("button", { name: "删除" }).click();
  const confirm = page.locator(".el-message-box");
  await expect(confirm).toContainText("删除在线工具");
  await expect(confirm).toContainText(
    "删除后，该工具将从快捷工具箱中移除。此操作不可撤销。",
  );
  await confirm.getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("在线工具已删除")).toBeVisible();
  await expect(page.locator(".el-table__row")).toHaveCount(1);

  await page
    .locator(".el-table__row")
    .filter({ hasText: processOn })
    .getByRole("button", { name: "删除" })
    .click();
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "删除" })
    .click();
  await expect(page.getByText("还没有在线工具")).toBeVisible();
  await expect(page.locator(".fab-badge")).toHaveCount(0);
  await expect(page.locator(".el-message-box")).toBeHidden();

  await page.screenshot({
    path: "test-results/online-tools.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("快捷悬浮按钮：拖拽、位置持久化与路由关闭", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/requirements");
  const fab = page.locator(".toolbox-fab");
  await expect(fab).toBeVisible();

  const box = await fab.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await fab.hover();
  await page.mouse.down();
  await page.mouse.move(box.x - 220, box.y - 160, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await fab.boundingBox())?.x ?? 9999)
    .toBeLessThan(1234);

  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem("superpm.toolbox.position.v1");
    return raw ? JSON.parse(raw) : null;
  });
  expect(stored?.version).toBe(1);
  expect(stored?.x).toBeLessThan(1234);
  expect(stored?.y).toBeLessThan(500);

  await page.reload();
  const moved = await fab.boundingBox();
  expect(moved?.x).toBeCloseTo(stored.x, 0);
  expect(moved?.y).toBeCloseTo(stored.y, 0);

  // 缩小窗口后回到视口内
  await page.setViewportSize({ width: 720, height: 560 });
  await expect
    .poll(async () => (await fab.boundingBox())?.x ?? 9999)
    .toBeLessThanOrEqual(720 - 58 - 8);
  const clamped = await fab.boundingBox();
  expect(clamped?.y ?? 9999).toBeLessThanOrEqual(560 - 58 - 8);
  // 等待 clamp 后的 240ms 位移动画结束，避免点击落在移动中的按钮外
  await page.waitForTimeout(300);

  // 轻微移动不触发拖拽，仍可打开弹窗；路由切换自动关闭
  await page.mouse.move((clamped?.x ?? 0) + 29, (clamped?.y ?? 0) + 29);
  await page.mouse.down();
  await page.mouse.move((clamped?.x ?? 0) + 31, (clamped?.y ?? 0) + 30);
  await page.mouse.up();
  const panel = page.getByRole("dialog", { name: "快捷工具" });
  await expect(panel).toBeVisible();
  await page.getByRole("link", { name: "每日任务" }).click();
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/\/tasks$/);

  await page.screenshot({
    path: "test-results/online-tools-fab.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
