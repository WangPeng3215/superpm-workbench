import { test, expect, type Page } from "@playwright/test";

async function createTask(
  page: Page,
  title: string,
  options: { estimate?: string; description?: string } = {},
) {
  await page.getByRole("button", { name: "新建任务" }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建任务" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: /任务名称/ }).fill(title);
  if (options.description)
    await dialog
      .getByRole("textbox", { name: "备注" })
      .fill(options.description);
  if (options.estimate) {
    await dialog
      .locator(".el-form-item")
      .filter({ hasText: "预计耗时" })
      .locator(".el-select__wrapper")
      .click();
    await page
      .locator(".el-select-dropdown__item:visible")
      .filter({ hasText: options.estimate })
      .first()
      .click();
  }
  await dialog.getByRole("button", { name: "创建任务" }).click();
  await expect(dialog).toBeHidden();
  const card = page.locator(".task-card").filter({ hasText: title });
  await expect(card).toBeVisible();
  return card;
}

async function openTaskMenu(page: Page, title: string) {
  const card = page.locator(".task-card").filter({ hasText: title });
  await card.getByRole("button", { name: "更多操作" }).click();
  return page.locator(".el-dropdown-menu:visible");
}

test("每日任务：创建、筛选、完成、编辑、小结复制与删除", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tasks");
  await expect(page.locator(".hero-title")).toContainText("今天");
  await expect(page.getByText("这一天还没有任务")).toBeVisible();

  await createTask(page, "整理晨会纪要", { description: "记录结论与待办" });
  await createTask(page, "梳理需求优先级", { estimate: "2 小时" });
  await expect(page.locator(".hero-sub")).toContainText("共 2 项任务");
  await expect(page.locator(".hero-sub")).toContainText("计划 3 小时");
  await expect(
    page.locator(".metric").filter({ hasText: "实际" }),
  ).toContainText("0.0 小时");

  // 状态筛选为空态，再恢复全部
  await page.locator(".status-filter .el-select__wrapper").click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: "已完成 · 0" })
    .click();
  await expect(page.getByText("当前筛选下没有任务")).toBeVisible();
  await page.locator(".status-filter .el-select__wrapper").click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: "全部任务 · 2" })
    .click();
  await expect(page.locator(".task-card")).toHaveCount(2);

  // 勾选完成
  const firstCard = page
    .locator(".task-card")
    .filter({ hasText: "整理晨会纪要" });
  await firstCard.getByRole("button", { name: "标记为已完成" }).click();
  await expect(firstCard.getByText("已完成", { exact: true })).toBeVisible();
  await expect(
    page.locator(".metric").filter({ hasText: "完成" }).locator("strong"),
  ).toHaveText("1");

  // 工作小结与剪贴板复制
  await expect(page.locator(".summary-preview")).toContainText("整理晨会纪要");
  await page.getByRole("button", { name: "查看全文" }).click();
  const summaryDialog = page.getByRole("dialog", { name: "每日工作总结" });
  await expect(summaryDialog).toBeVisible();
  await expect(summaryDialog.locator(".summary-text")).toContainText(
    "梳理需求优先级",
  );
  await summaryDialog.getByRole("button", { name: "复制全文" }).click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("【每日工作总结】");
  expect(clipboard).toContain("整理晨会纪要");
  await summaryDialog
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(summaryDialog).toBeHidden();

  // 编辑任务
  const menu = await openTaskMenu(page, "梳理需求优先级");
  await menu.getByText("编辑任务", { exact: true }).click();
  const editDialog = page.getByRole("dialog", { name: "编辑任务" });
  await expect(editDialog).toBeVisible();
  await editDialog
    .getByRole("textbox", { name: /任务名称/ })
    .fill("梳理并拆解需求优先级");
  await editDialog.getByRole("button", { name: "保存修改" }).click();
  await expect(editDialog).toBeHidden();
  await expect(
    page.locator(".task-card").filter({ hasText: "梳理并拆解需求优先级" }),
  ).toBeVisible();

  await page.waitForTimeout(3200);
  await page.screenshot({
    path: "test-results/daily-tasks-light.png",
    fullPage: true,
  });

  // 删除无工时任务
  const deleteMenu = await openTaskMenu(page, "梳理并拆解需求优先级");
  await deleteMenu.getByText("删除任务", { exact: true }).click();
  const messageBox = page.locator(".el-message-box");
  await expect(messageBox).toBeVisible();
  await messageBox.getByRole("button", { name: "删除" }).click();
  await expect(
    page.locator(".task-card").filter({ hasText: "梳理并拆解需求优先级" }),
  ).toBeHidden();
  await expect(page.locator(".task-card")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("每日任务：计时、自动生成工时与校正", async ({ page }) => {
  const hour = new Date().getHours();
  test.skip(hour >= 18, "业务日 18:00 后不允许开始计时");

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tasks");
  await expect(page.locator(".hero-title")).toContainText("今天");

  await createTask(page, "验证计时链路");
  const card = page.locator(".task-card").filter({ hasText: "验证计时链路" });
  await card.getByRole("button", { name: "开始", exact: true }).click();
  await expect(page.locator(".timer-bar")).toBeVisible();
  await expect(page.locator(".timer-bar")).toContainText("验证计时链路");
  await expect(page.locator(".timer-clock")).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(
    page.locator(".task-card").filter({ hasText: "验证计时链路" }),
  ).toContainText("计时中");
  await page.waitForTimeout(1600);
  await page.screenshot({
    path: "test-results/daily-tasks-timer.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "结束计时" }).click();
  await expect(page.locator(".timer-bar")).toBeHidden();
  await expect(
    page.locator(".task-card").filter({ hasText: "验证计时链路" }),
  ).toContainText("已完成");

  // 工时校正：把结束时间往后调 5 分钟
  const menu = await openTaskMenu(page, "验证计时链路");
  await menu.getByText("工时校正", { exact: true }).click();
  const entryDialog = page.getByRole("dialog", { name: "工时校正" });
  await expect(entryDialog).toBeVisible();
  const startInput = entryDialog.getByRole("combobox", { name: "开始时间" });
  const endInput = entryDialog.getByRole("combobox", { name: "结束时间" });
  const start = await startInput.inputValue();
  const [startHour, startMinute] = start.split(":").map(Number);
  const endTotal = startHour * 60 + startMinute + 5;
  const end = `${String(Math.floor(endTotal / 60)).padStart(2, "0")}:${String(
    endTotal % 60,
  ).padStart(2, "0")}`;
  const endField = entryDialog.locator(".entry-controls .el-input").nth(1);
  await endField.locator(".el-input__wrapper").click();
  await endInput.press("Control+a");
  await endInput.pressSequentially(end);
  await endInput.press("Enter");
  await expect(endInput).toHaveValue(end);
  await entryDialog
    .getByRole("textbox", { name: "修正原因（可选）" })
    .fill("补充收尾沟通");
  const correction = page.waitForResponse(
    (response) =>
      response.url().includes("/api/daily-time-entries/") &&
      response.request().method() === "PATCH",
  );
  await entryDialog.getByRole("button", { name: "保存", exact: true }).click();
  expect((await correction).status()).toBe(200);
  await expect(page.getByText("工时记录已修正").first()).toBeVisible();
  await expect(entryDialog.locator(".entry-duration")).not.toHaveText("0 分钟");
  await entryDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(entryDialog).toBeHidden();
  await expect(page.locator(".summary-preview")).toContainText("验证计时链路");

  // 有工时记录的任务删除后归档，小结仍保留
  const deleteMenu = await openTaskMenu(page, "验证计时链路");
  await deleteMenu.getByText("删除任务", { exact: true }).click();
  const messageBox = page.locator(".el-message-box");
  await messageBox.getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("任务已删除，工时记录已归档")).toBeVisible();
  await expect(
    page.locator(".task-card").filter({ hasText: "验证计时链路" }),
  ).toHaveCount(0);
  await expect(page.locator(".summary-preview")).toContainText("验证计时链路");
  expect(errors).toEqual([]);
});

test("每日任务：深色模式与窄屏无横向滚动", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/tasks");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator(".hero-title")).toContainText("今天");
  await page.waitForTimeout(800);
  await expect
    .poll(() =>
      page
        .locator("html")
        .evaluate((element) => getComputedStyle(element).opacity),
    )
    .toBe("1");
  await page.screenshot({
    path: "test-results/daily-tasks-dark.png",
    fullPage: true,
    animations: "disabled",
  });

  await page.setViewportSize({ width: 420, height: 900 });
  await expect(page.locator(".daily-page")).toBeVisible();
  await page.waitForTimeout(500);
  const horizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  );
  expect(horizontalOverflow).toBe(false);
  await page.screenshot({
    path: "test-results/daily-tasks-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});
