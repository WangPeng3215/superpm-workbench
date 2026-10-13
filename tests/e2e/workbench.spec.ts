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
  const child = page.getByRole("button", { name: childName, exact: true });
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
    page.getByRole("button", { name: `${childName}-已编辑`, exact: true }),
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
  await columns
    .getByRole("checkbox", { name: "需求描述", exact: true })
    .uncheck();
  await columns.getByRole("button", { name: "完成", exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: /需求描述/ }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("columnheader", { name: /需求描述/ }),
  ).toHaveCount(0);
});

test("four stage workspace persists documents, links and issue resolution", async ({
  page,
  request,
}) => {
  const name = `阶段验收-${Date.now()}`;
  await page.goto("/requirements");
  const row = await addRequirement(page, name);
  await row.locator(".requirement-no").click();
  await expect(page).toHaveURL(/\/requirements\/\d+$/);
  await expect(page.getByRole("tab", { name: "需求详情" })).toBeVisible();
  await page.getByRole("button", { name: "阶段工作台", exact: true }).click();
  const drawer = page.locator(".xly-drawer");
  await expect(drawer).toBeVisible();
  await drawer.locator("textarea").fill("# 分析记录\n\n阶段验收内容");
  await drawer
    .getByRole("button", { name: "保存分析产物", exact: true })
    .click();
  await expect(
    page.getByText("阶段内容已保存到本地", { exact: true }),
  ).toBeVisible();
  await drawer.locator(".progress-stage").nth(1).click();
  await drawer
    .getByLabel("UI 设计稿链接")
    .fill("https://figma.com/design/example");
  await drawer.getByRole("button", { name: "保存链接", exact: true }).click();
  await drawer.locator(".progress-stage").nth(2).click();
  await drawer
    .getByRole("button", { name: "记录第一个问题", exact: true })
    .click();
  const record = page.getByRole("dialog").last();
  await record.getByPlaceholder("简要描述变更或问题").fill("开发阻塞");
  await record.locator(".rich-record-input").first().click();
  const rich = page.getByRole("dialog").last();
  await rich.getByLabel("富文本内容").fill("需要支持批量上传");
  await rich.getByRole("button", { name: "应用内容", exact: true }).click();
  await record.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(drawer.getByText("开发阻塞", { exact: true })).toBeVisible();
  await drawer.locator(".progress-stage").nth(3).click();
  await drawer
    .getByRole("button", { name: "记录第一个问题", exact: true })
    .click();
  const testing = page.getByRole("dialog").last();
  await testing.getByPlaceholder("简要描述变更或问题").fill("测试问题");
  await testing.getByRole("radio", { name: "已解决", exact: true }).click();
  await testing.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(drawer.getByText("测试问题", { exact: true })).toBeVisible();
  const result = await (
    await request.get(`/api/requirements?q=${encodeURIComponent(name)}`)
  ).json();
  const id = result.items[0].id;
  const workspace = await (
    await request.get(`/api/requirements/${id}/workspace`)
  ).json();
  expect(workspace.analysis.analysisText).toContain("阶段验收内容");
  expect(workspace.designUrl).toBe("https://figma.com/design/example");
  expect(workspace.development[0].bodyHtml).toContain("批量上传");
  expect(workspace.testing[0].status).toBe("resolved");
  await drawer.locator(".progress-stage").nth(2).click();
  await drawer.getByRole("button", { name: /从问题创建子需求/ }).click();
  await expect(page.getByText(/子需求已创建/)).toBeVisible();
  const updated = await (
    await request.get(`/api/requirements?q=${encodeURIComponent(name)}`)
  ).json();
  expect(updated.items[0].children[0].name).toBe("开发阻塞");
  expect(updated.items[0].children[0].description).toContain(
    "需要支持批量上传",
  );
});

test("unsaved inline edits are protected on cancel and navigation", async ({
  page,
}) => {
  await page.goto("/requirements");
  await page.getByRole("button", { name: "新增需求", exact: true }).click();
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
