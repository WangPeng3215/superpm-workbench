import { test, expect, type Page } from "@playwright/test";

async function addRequirement(page: Page, name: string) {
  await page.getByRole("button", { name: /在底部新增一行/ }).click();
  const row = page.locator("tr.editing-row");
  await expect(row).toBeVisible();
  await row.getByRole("textbox", { name: "需求名称" }).fill(name);
  await row.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  return page
    .getByRole("button", { name, exact: true })
    .locator("xpath=ancestor::tr");
}

test("inline CRUD inserts a child below its parent", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const name = `浏览器主需求-${Date.now()}`;
  await page.goto("/requirements");
  await expect(page.getByText("本地服务已连接")).toBeVisible();
  const mainRow = await addRequirement(page, name);
  await mainRow.getByRole("button", { name: "子需求", exact: true }).click();
  const childName = `${name}-子项`;
  const childRow = page.locator("tr.editing-row");
  await childRow.getByRole("textbox", { name: "需求名称" }).fill(childName);
  await childRow.getByRole("button", { name: "保存", exact: true }).click();
  // 子需求行的名称按钮内含「子需求」徽标，名称用包含匹配
  const child = page.getByRole("button", { name: childName });
  await expect(child).toHaveCount(1);
  await expect(child).toBeVisible();
  await child.click();
  await page
    .locator("tr.editing-row")
    .getByRole("textbox", { name: "需求名称" })
    .fill(`${childName}-已编辑`);
  await page
    .locator("tr.editing-row")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: `${childName}-已编辑` }),
  ).toBeVisible();
  const result = await (
    await request.get(`/api/requirements?q=${encodeURIComponent(name)}`)
  ).json();
  expect(result.items[0].children[0].name).toBe(`${childName}-已编辑`);
  await page.screenshot({ path: "test-results/workbench.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("rich description and column preferences persist", async ({
  page,
  request,
}) => {
  const name = `富文本验收-${Date.now()}`;
  await page.goto("/requirements");
  const row = await addRequirement(page, name);
  await row.getByRole("button", { name: "添加描述", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("富文本内容").fill("描述内容");
  await editor.getByRole("button", { name: "应用内容", exact: true }).click();
  await page
    .locator("tr.editing-row")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const item = (
    await (
      await request.get(`/api/requirements?q=${encodeURIComponent(name)}`)
    ).json()
  ).items[0];
  expect(item.descriptionHtml).toContain("描述内容");
  await page.getByRole("button", { name: "列设置", exact: true }).click();
  const columns = page.getByRole("dialog");
  // 列设置抽屉里的 el-checkbox 原生 input 为隐藏元素，需点击其可见 label
  await columns
    .locator(".el-checkbox")
    .filter({ hasText: "需求描述" })
    .click();
  await columns.getByRole("button", { name: "完成", exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: /需求描述/ }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("columnheader", { name: /需求描述/ }),
  ).toHaveCount(0);
});

test("stage workspace persists analysis docs and issue resolution", async ({
  page,
  request,
}) => {
  const name = `阶段验收-${Date.now()}`;
  await page.goto("/requirements");
  const row = await addRequirement(page, name);
  await row.locator(".requirement-no").click();
  await expect(page).toHaveURL(/\/requirements\/\d+$/);
  await expect(page.getByRole("tab", { name: "需求详情" })).toBeVisible();
  // 文档管理页签：点击需求记忆卡片以新页签打开编辑器，自动保存
  await page.getByRole("tab", { name: "文档管理" }).click();
  await page.locator('.doc-card[data-name="需求记忆.md"]').click();
  const recordEditor = page.getByLabel("文档内容");
  await expect(recordEditor).toBeVisible();
  await recordEditor.fill("# 阶段验收内容");
  await expect(page.getByText("已自动保存到本地文件")).toBeVisible();
  // 切到 UI 设计阶段：问题页签联动激活，新建问题
  const timeline = page.locator(".stage-timeline");
  await timeline.getByText("UI 设计", { exact: true }).click();
  const issuesPanel = page.locator(".issues-panel");
  await issuesPanel.getByRole("button", { name: /新建问题/ }).click();
  await issuesPanel.getByPlaceholder("问题标题（必填）").fill("设计评审阻塞");
  await issuesPanel.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    issuesPanel.getByRole("button", { name: "设计评审阻塞" }),
  ).toBeVisible();
  // 切到需求测试阶段：新建问题并在详情中标记解决
  await timeline.getByText("需求测试", { exact: true }).click();
  await issuesPanel.getByRole("button", { name: /新建问题/ }).click();
  await issuesPanel.getByPlaceholder("问题标题（必填）").fill("测试问题");
  await issuesPanel.getByRole("button", { name: "创建", exact: true }).click();
  await issuesPanel.getByRole("button", { name: "测试问题" }).click();
  await issuesPanel.getByRole("button", { name: "标记解决" }).click();
  await page.getByPlaceholder("填写解决说明").fill("修复完成，复测通过");
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(
    issuesPanel.locator(".issues-head").getByText("已解决"),
  ).toBeVisible();
  // 服务端持久化校验：需求记忆文档内容与各阶段问题状态
  const found = await (
    await request.get(`/api/requirements?q=${encodeURIComponent(name)}`)
  ).json();
  const id = found.items[0].id;
  const memory = (await (
    await request.get(`/api/requirements/${id}/memory`)
  ).json()) as { id: number };
  const record = await (
    await request.get(`/api/artifacts/nodes/${memory.id}/content`)
  ).json();
  expect(record.content).toContain("阶段验收内容");
  const design = await (
    await request.get(`/api/requirements/${id}/issues?phase=design`)
  ).json();
  expect(design.items[0].title).toBe("设计评审阻塞");
  const testing = await (
    await request.get(`/api/requirements/${id}/issues?phase=testing`)
  ).json();
  expect(testing.items[0].status).toBe("resolved");
  expect(testing.items[0].solution).toContain("复测通过");
});

test("unsaved inline edits are protected on cancel and navigation", async ({
  page,
}) => {
  await page.goto("/requirements");
  await page.getByRole("button", { name: /在底部新增一行/ }).click();
  await page
    .locator("tr.editing-row")
    .getByRole("textbox", { name: "需求名称" })
    .fill("未保存的名称");
  await page
    .locator("tr.editing-row")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(
    page.locator("tr.editing-row").getByRole("textbox", { name: "需求名称" }),
  ).toHaveValue("未保存的名称");
  await page.getByRole("link", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page).toHaveURL(/requirements/);
  await page
    .locator("tr.editing-row")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(page.locator("tr.editing-row")).toHaveCount(0);
});
