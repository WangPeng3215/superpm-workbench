import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const prefix = "E2E便签-";

function todayInBusinessZone() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
}

async function cleanup(request: APIRequestContext) {
  const dayResponse = await request.get(
    `/api/daily-tasks?date=${todayInBusinessZone()}`,
  );
  if (dayResponse.ok()) {
    const day = (await dayResponse.json()) as {
      tasks: Array<{ id: number; title: string }>;
    };
    for (const task of day.tasks) {
      if (task.title.startsWith(prefix))
        await request.delete(`/api/daily-tasks/${task.id}`);
    }
  }
  for (const archived of [false, true]) {
    const response = await request.get(
      `/api/notes${archived ? "?archived=true" : ""}`,
    );
    if (!response.ok()) continue;
    const notes = (await response.json()) as Array<{
      id: number;
      title: string;
    }>;
    for (const note of notes) {
      if (note.title.startsWith(prefix))
        await request.delete(`/api/notes/${note.id}`);
    }
  }
}

function startPage(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.afterEach(async ({ request }) => {
  await cleanup(request);
});

test("便签：自动保存、搜索筛选、置顶、归档恢复与删除", async ({ page }) => {
  const errors = startPage(page);
  const noteTitle = `${prefix}${Date.now()}`;
  const noteContent = `自动保存内容 ${noteTitle}`;

  await page.goto("/notes");
  await expect(page.locator(".page-heading")).toHaveCount(0);
  await expect(page.getByText("还没有便签，记录第一条灵感吧")).toBeVisible();

  // 空白草稿失焦后直接丢弃，不产生空便签
  const createButton = page
    .locator(".notes-toolbar")
    .getByRole("button", { name: "新建便签" });
  await createButton.click();
  const draft = page.locator(".note-card.draft");
  await expect(draft).toBeVisible();
  await expect(draft.getByRole("textbox", { name: "便签内容" })).toBeFocused();
  await page.getByRole("textbox", { name: "搜索便签" }).click();
  await expect(page.locator(".note-card")).toHaveCount(0);

  // 卡片内直接编辑，防抖后自动保存
  await createButton.click();
  const card = page.locator(".note-card").first();
  await card.getByRole("textbox", { name: "便签标题" }).fill(noteTitle);
  await card.getByRole("textbox", { name: "便签内容" }).fill(noteContent);
  await expect(card.locator(".save-state")).toHaveText("已保存");
  await expect(card.locator(".type-badge")).toHaveText("灵感");
  await expect(page.locator(".note-count")).toHaveText("1 张便签");

  // 刷新后仍保留，搜索标题/正文
  await page.reload();
  await expect(page.locator(".note-card")).toHaveCount(1);
  const reloaded = page.locator(".note-card").first();
  await expect(reloaded.getByRole("textbox", { name: "便签标题" })).toHaveValue(
    noteTitle,
  );
  const search = page.getByRole("textbox", { name: "搜索便签" });
  await search.fill("自动保存内容");
  await expect(page.locator(".note-card")).toHaveCount(1);
  await search.fill("不存在的关键字");
  await expect(page.getByText("没有找到匹配的便签")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page.locator(".note-card")).toHaveCount(1);

  // 置顶并切换类型，筛选不丢失编辑内容
  await reloaded.getByRole("button", { name: "置顶便签" }).click();
  await expect(reloaded.locator(".pin-badge")).toBeVisible();
  await expect(reloaded.locator(".save-state")).toHaveText("已保存");

  await page.locator(".note-filter .el-select__wrapper").click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: "已置顶" })
    .click();
  await expect(page.locator(".note-card")).toHaveCount(1);

  await reloaded.getByRole("button", { name: "更多操作" }).click();
  await page
    .locator(".el-dropdown-menu__item:visible")
    .filter({ hasText: "标记为工作备忘" })
    .click();
  await expect(reloaded.locator(".type-badge")).toHaveText("工作备忘");

  await page.locator(".note-filter .el-select__wrapper").click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: "灵感" })
    .first()
    .click();
  await expect(page.locator(".note-card")).toHaveCount(0);
  await page.locator(".note-filter .el-select__wrapper").click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: "工作备忘" })
    .click();
  await expect(page.locator(".note-card")).toHaveCount(1);
  await expect(reloaded.getByRole("textbox", { name: "便签内容" })).toHaveValue(
    noteContent,
  );
  await page.locator(".note-filter .el-select__wrapper").click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: "全部类型" })
    .click();

  // 归档 → 归档视图 → 恢复
  await reloaded.getByRole("button", { name: "更多操作" }).click();
  await page
    .locator(".el-dropdown-menu__item:visible")
    .filter({ hasText: "归档便签" })
    .click();
  await expect(page.getByText("便签已归档")).toBeVisible();
  await expect(page.locator(".note-card")).toHaveCount(0);
  await page
    .locator(".notes-toolbar")
    .getByRole("button", { name: /归档$/ })
    .click();
  await expect(page.locator(".archive-banner")).toBeVisible();
  const archivedCard = page.locator(".note-card.archived");
  await expect(archivedCard).toHaveCount(1);
  await expect(archivedCard).toContainText(noteTitle);
  await archivedCard.getByRole("button", { name: "恢复便签" }).click();
  await expect(page.getByText("便签已恢复")).toBeVisible();
  await expect(page.locator(".note-card")).toHaveCount(0);
  await page
    .locator(".notes-toolbar")
    .getByRole("button", { name: /返回便签/ })
    .click();
  await expect(page.locator(".note-card")).toHaveCount(1);

  // 深色主题与窄屏可用
  await page.getByRole("button", { name: "切换到深色模式" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const paper = await page
    .locator(".note-card")
    .evaluate((el) => getComputedStyle(el).getPropertyValue("--note-paper"));
  expect(paper.trim()).not.toBe("");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
  await expect(page.locator(".notes-board")).toHaveCSS(
    "grid-template-columns",
    /^\d+(\.\d+)?px$/,
  );
  await page.screenshot({
    path: "test-results/notes-dark-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "切换到浅色模式" }).click();

  // 删除需确认，删除后回到空态
  await page
    .locator(".note-card")
    .first()
    .getByRole("button", {
      name: "更多操作",
    })
    .click();
  await page
    .locator(".el-dropdown-menu__item:visible")
    .filter({ hasText: "删除便签" })
    .click();
  const confirm = page.locator(".el-message-box");
  await expect(confirm).toContainText("删除后无法恢复");
  await confirm.getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("便签已删除")).toBeVisible();
  await expect(page.locator(".note-card")).toHaveCount(0);
  await expect(page.getByText("还没有便签，记录第一条灵感吧")).toBeVisible();

  await page.screenshot({ path: "test-results/notes.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("便签转每日任务：幂等转换与打开目标任务", async ({ page, request }) => {
  const errors = startPage(page);
  const noteTitle = `${prefix}转换-${Date.now()}`;
  const created = await request.post("/api/notes", {
    data: {
      title: noteTitle,
      content: "转换正文\n第二行内容",
      type: "work_memo",
      color: "blue",
    },
  });
  expect(created.status()).toBe(201);
  const note = (await created.json()) as { id: number };

  await page.goto("/notes");
  const card = page.locator(".note-card").first();
  await expect(card).toBeVisible();
  await expect(card.getByRole("textbox", { name: "便签标题" })).toHaveValue(
    noteTitle,
  );

  await card.getByRole("button", { name: "转为每日任务" }).click();
  await expect(page.getByText("已转为每日任务")).toBeVisible();
  const linked = card.locator(".task-action.linked");
  await expect(linked).toContainText(noteTitle);

  const notesResponse = await request.get("/api/notes");
  const notes = (await notesResponse.json()) as Array<{
    id: number;
    convertedTaskId: number | null;
  }>;
  const convertedTaskId = notes.find(
    (item) => item.id === note.id,
  )?.convertedTaskId;
  expect(convertedTaskId).toBeGreaterThan(0);

  // 服务层幂等：重复转换不再创建任务
  const again = await request.post(`/api/notes/${note.id}/convert`);
  expect(again.ok()).toBeTruthy();
  const againBody = (await again.json()) as {
    created: boolean;
    task: { id: number };
  };
  expect(againBody.created).toBe(false);
  expect(againBody.task.id).toBe(convertedTaskId);

  const dayResponse = await request.get(
    `/api/daily-tasks?date=${todayInBusinessZone()}`,
  );
  expect(dayResponse.ok()).toBeTruthy();
  const day = (await dayResponse.json()) as {
    tasks: Array<{ id: number; title: string }>;
  };
  expect(day.tasks.filter((task) => task.title === noteTitle)).toHaveLength(1);

  // 便签上的任务链接直达对应任务编辑弹窗
  await linked.click();
  await expect(page).toHaveURL(/\/tasks$/);
  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "任务名称" })).toHaveValue(
    noteTitle,
  );
  await dialog.getByRole("button", { name: "取消" }).click();

  await page.goto("/notes");
  await expect(page.locator(".note-card").first()).toBeVisible();
  await expect(page.locator(".task-action.linked")).toContainText(noteTitle);
  await page.screenshot({
    path: "test-results/notes-converted.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("工具箱新建入口：任意页面快速创建便签并通过侧栏进入便签页", async ({
  page,
}) => {
  const errors = startPage(page);
  const content = `快速记录 ${prefix}${Date.now()}`;

  await page.goto("/requirements");
  await page.locator(".toolbox-fab").click();
  const panel = page.getByRole("dialog", { name: "快捷工具" });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".builtin-tile")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: /新建便签/ })).toBeVisible();
  await page.screenshot({ path: "test-results/notes-toolbox.png" });

  await panel.getByRole("button", { name: /新建便签/ }).click();
  const dialog = page.getByRole("dialog", { name: "新建便签" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "便签内容" })).toBeFocused();
  await dialog.getByRole("textbox", { name: "便签内容" }).fill(content);
  await dialog.getByRole("button", { name: "创建便签" }).click();
  await expect(
    page.getByText("便签已创建，可在「便签」中继续编辑"),
  ).toBeVisible();
  await expect(dialog).toBeHidden();

  await page
    .locator('nav[aria-label="主导航"]')
    .getByRole("link", { name: "便签" })
    .click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(
    page.getByRole("textbox", { name: "便签内容" }).first(),
  ).toHaveValue(content);
  expect(errors).toEqual([]);
});
