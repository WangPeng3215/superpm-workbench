import { test, expect, type Page } from "@playwright/test";

async function addRequirement(page: Page, name: string) {
  await page.getByRole("button", { name: "添加需求", exact: true }).click();
  const row = page.locator("tr.editing-row");
  await expect(row).toBeVisible();
  const input = row.getByRole("textbox", { name: "需求名称" });
  await input.fill(name);
  await input.press("Enter");
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  return page
    .getByRole("button", { name, exact: true })
    .locator("xpath=ancestor::tr");
}

// 通过详情表单切换当前阶段（头部步骤条已移除）：下拉选择阶段并保存
async function switchStage(page: Page, label: string) {
  await page.getByRole("tab", { name: "需求详情" }).click();
  await page
    .locator("label.field")
    .filter({ hasText: "当前阶段" })
    .locator(".el-select")
    .click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: label })
    .click();
  await expect(page.locator(".head-stage")).toHaveText(label);
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
  await childRow.getByRole("button", { name: "创建", exact: true }).click();
  // 子需求行的名称按钮内含「子需求」徽标，名称用包含匹配
  const child = page.getByRole("button", { name: childName });
  await expect(child).toHaveCount(1);
  await expect(child).toBeVisible();
  await child.click();
  await page
    .locator("tr.editing-row")
    .getByRole("textbox", { name: "需求名称" })
    .fill(`${childName}-已编辑`);
  await expect(page.getByText("已自动保存", { exact: true })).toBeVisible();
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
  await expect(page.getByText("已自动保存", { exact: true })).toBeVisible();
  const item = (
    await (
      await request.get(`/api/requirements?q=${encodeURIComponent(name)}`)
    ).json()
  ).items[0];
  expect(item.descriptionHtml).toContain("描述内容");
  await page.getByRole("button", { name: "列设置", exact: true }).click();
  const columns = page.getByRole("dialog");
  // 列设置抽屉里的 el-checkbox 原生 input 为隐藏元素，需点击其可见 label
  await columns.locator(".el-checkbox").filter({ hasText: "需求描述" }).click();
  await columns.getByRole("button", { name: "完成", exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: /需求描述/ }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("columnheader", { name: /需求描述/ }),
  ).toHaveCount(0);
});

test("list description dialog shares the detail editor and keeps block styles", async ({
  page,
  request,
}) => {
  const name = `描述编辑器-${Date.now()}`;
  await page.goto("/requirements");
  const row = await addRequirement(page, name);
  await row.getByRole("button", { name: "添加描述", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const content = dialog.getByLabel("富文本内容");
  await expect(content).toBeVisible();
  // 与需求详情使用同一套工具栏：下划线、任务清单、对齐、缩进都应存在
  for (const label of [
    "下划线",
    "任务清单",
    "左对齐",
    "居中对齐",
    "右对齐",
    "两端对齐",
    "增加缩进",
    "减少缩进",
  ])
    await expect(
      dialog.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  await content.fill("复选框后的文字应紧跟复选框排列，而不是被推到最右侧。");
  // 任务清单：正文紧邻复选框所在列
  await dialog.getByRole("button", { name: "任务清单", exact: true }).click();
  const item = content.locator('ul[data-type="taskList"] li').first();
  await expect(item).toBeVisible();
  const labelBox = await item.locator("label").boundingBox();
  const contentBox = await item.locator("div").first().boundingBox();
  expect(contentBox!.x - (labelBox!.x + labelBox!.width)).toBeLessThan(20);
  // 退出任务清单后设置对齐与块级缩进
  await dialog.getByRole("button", { name: "任务清单", exact: true }).click();
  await dialog.getByRole("button", { name: "居中对齐", exact: true }).click();
  const paragraph = content.locator("p").first();
  await expect(paragraph).toHaveCSS("text-align", "center");
  await dialog.getByRole("button", { name: "增加缩进", exact: true }).click();
  await expect(paragraph).toHaveAttribute("data-indent", "1");
  // 真实选区内斜体生效
  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await dialog.getByRole("button", { name: "斜体", exact: true }).click();
  await expect(content.locator("em").first()).toContainText("复选框");
  await dialog.getByRole("button", { name: "应用内容", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("已自动保存", { exact: true })).toBeVisible();
  const saved = (
    await (
      await request.get(`/api/requirements?q=${encodeURIComponent(name)}`)
    ).json()
  ).items[0];
  expect(saved.descriptionHtml).toContain("text-align: center");
  expect(saved.descriptionHtml).toContain('data-indent="1"');
  expect(saved.descriptionHtml).toContain("<em>");
  // 刷新后从列表再次打开，仍复用统一编辑器并回显样式
  await page.reload();
  const reopened = page
    .getByRole("button", { name, exact: true })
    .locator("xpath=ancestor::tr");
  await reopened.locator(".rich-cell").click();
  await expect(dialog).toBeVisible();
  await expect(content).toContainText("复选框后的文字");
  await expect(content.locator("p").first()).toHaveCSS("text-align", "center");
  await expect(content.locator("p").first()).toHaveAttribute(
    "data-indent",
    "1",
  );
  await expect(
    dialog.getByRole("button", { name: "居中对齐", exact: true }),
  ).toHaveCount(1);
});

test("document editor keeps list item alignment in markdown", async ({
  page,
}) => {
  const name = `文档对齐-${Date.now()}`;
  await page.goto("/requirements");
  const row = await addRequirement(page, name);
  await row.locator(".requirement-no").click();
  await expect(page).toHaveURL(/\/requirements\/\d+$/);
  await page.getByRole("tab", { name: "文档管理" }).click();
  await page.locator('.doc-card[data-name="需求记忆.md"]').click();
  const editor = page.getByLabel("文档内容");
  const toolbar = page
    .locator(".inline-rich")
    .filter({ has: editor })
    .locator(".rich-toolbar");
  await editor.fill("列表项也要保留对齐");
  await page.keyboard.press("ControlOrMeta+a");
  await toolbar.getByRole("button", { name: "项目列表", exact: true }).click();
  const item = editor.locator("li p").first();
  await expect(item).toBeVisible();
  await toolbar.getByRole("button", { name: "居中对齐", exact: true }).click();
  await expect(item).toHaveCSS("text-align", "center");
  await expect(page.getByText("已自动保存到本地文件")).toBeVisible();
  // 重新打开文档：对齐由 Markdown 内的行内承载还原，而不是被静默丢弃
  await page.reload();
  await page.getByRole("tab", { name: "文档管理" }).click();
  await page.locator('.doc-card[data-name="需求记忆.md"]').click();
  const reopened = page.getByLabel("文档内容").locator("li p").first();
  await expect(reopened).toHaveCSS("text-align", "center");
  await expect(reopened).toContainText("列表项也要保留对齐");
});

test("requirement detail keeps open document when switching features", async ({
  page,
  request,
}) => {
  const name = `详情状态-${Date.now()}`;
  await page.goto("/requirements");
  const row = await addRequirement(page, name);
  await row.locator(".requirement-no").click();
  await expect(page).toHaveURL(/\/requirements\/\d+$/);
  const detailUrl = page.url();
  const id = Number(new URL(detailUrl).pathname.split("/").pop());
  // 打开文档管理中的需求记忆并留下可识别的 DOM 标记
  await page.getByRole("tab", { name: "文档管理" }).click();
  await page.locator('.doc-card[data-name="需求记忆.md"]').click();
  const editor = page.getByLabel("文档内容");
  await expect(editor).toBeVisible();
  const surface = page.locator(".inline-rich").filter({ has: editor });
  await surface.evaluate((el) => el.setAttribute("data-keep-alive-probe", "1"));
  await editor.fill("切换功能后仍保留的文档内容");
  await expect(page.getByText("已自动保存到本地文件")).toBeVisible();
  // 切到其他功能
  await page.getByRole("link", { name: "每日任务" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  // 服务端在此期间更新需求名称，返回时应刷新基础数据但不重置页面状态
  const renamed = `${name}-已更新`;
  await request.patch(`/api/requirements/${id}`, {
    data: { name: renamed },
  });
  await page
    .locator(".topbar-tab")
    .filter({ hasText: name })
    .locator(".tab-label")
    .click();
  await expect(page).toHaveURL(detailUrl);
  await expect(page.locator(".head-title")).toHaveText(renamed);
  const docTab = page.getByRole("tab", { name: "需求记忆.md" });
  await expect(docTab).toBeVisible();
  await expect(docTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("文档内容")).toContainText(
    "切换功能后仍保留的文档内容",
  );
  // DOM 未被重建：同一编辑器节点被页面缓存保留下来
  await expect(page.locator('[data-keep-alive-probe="1"]')).toHaveCount(1);
  // 马上切换功能时，导航先完成需求详情的保存
  await page.getByRole("tab", { name: "需求详情" }).click();
  const nameInput = page
    .locator("label.field")
    .filter({ hasText: "需求名称" })
    .getByRole("textbox");
  const savedName = `${renamed}-离页保存`;
  await nameInput.fill(savedName);
  await page.getByRole("link", { name: "每日任务" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  expect(
    (await (await request.get(`/api/requirements/${id}`)).json()).name,
  ).toBe(savedName);
  await page
    .locator(".topbar-tab")
    .filter({ hasText: name })
    .locator(".tab-label")
    .click();
  await expect(page).toHaveURL(detailUrl);
  await expect(nameInput).toHaveValue(savedName);
  await expect(
    page.getByRole("status").filter({ hasText: "已同步到本地" }),
  ).toBeVisible();
});

test("cached requirement detail state is scoped per requirement", async ({
  page,
}) => {
  const first = `缓存一-${Date.now()}`;
  await page.goto("/requirements");
  const firstRow = await addRequirement(page, first);
  await firstRow.locator(".requirement-no").click();
  await expect(page).toHaveURL(/\/requirements\/\d+$/);
  await page.getByRole("tab", { name: "文档管理" }).click();
  await page.locator('.doc-card[data-name="需求记忆.md"]').click();
  await expect(page.getByRole("tab", { name: "需求记忆.md" })).toBeVisible();
  // 切回列表并打开第二个需求：新详情页不应带有第一个需求的文档页签
  await page.locator(".topbar-tab").filter({ hasText: "需求列表" }).click();
  const second = `缓存二-${Date.now()}`;
  const secondRow = await addRequirement(page, second);
  await secondRow.locator(".requirement-no").click();
  await expect(page).toHaveURL(/\/requirements\/\d+$/);
  await expect(page.getByRole("tab", { name: "需求记忆.md" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "需求详情" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // 切回第一个需求：其文档页签与编辑器仍在
  await page.locator(".topbar-tab").filter({ hasText: first }).click();
  await expect(page.getByRole("tab", { name: "需求记忆.md" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "需求记忆.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("requirement detail automatically saves the description and properties", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/requirements", {
    data: { name: "自动保存需求", proposedAt: "2026-06-01" },
  });
  expect(response.ok()).toBeTruthy();
  const { id } = await response.json();
  const path = `/requirements/${id}`;
  const name = page.getByPlaceholder("输入需求名称");
  const editor = page.locator(".detail-desc .tiptap");
  await page.goto(path);
  await name.fill("自动保存后的名称");
  await editor.fill("自动保存的需求描述");
  await expect
    .poll(async () => {
      const detail = await (await request.get(`/api${path}`)).json();
      return [detail.name, detail.description, detail.descriptionHtml];
    })
    .toEqual([
      "自动保存后的名称",
      "自动保存的需求描述",
      "<p>自动保存的需求描述</p>",
    ]);
  await page.reload();
  await expect(name).toHaveValue("自动保存后的名称");
  await expect(editor).toHaveText("自动保存的需求描述");
});

test("requirement autosave keeps edits made during a request and retries a failed save", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/requirements", {
    data: { name: "保存重试需求", proposedAt: "2026-06-01" },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  const path = `/requirements/${id}`;
  const apiPath = `/api${path}`;
  const name = page.getByPlaceholder("输入需求名称");
  const firstSaved = Promise.withResolvers<void>();
  const releaseResponse = Promise.withResolvers<void>();
  let attempts = 0;
  await page.route(apiPath, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    attempts += 1;
    if (attempts === 1) {
      const response = await route.fetch();
      firstSaved.resolve();
      await releaseResponse.promise;
      return route.fulfill({ response });
    }
    if (attempts === 2) return route.fulfill({ status: 503 });
    return route.continue();
  });
  await page.goto(path);
  await name.fill("先输入的名称");
  try {
    await firstSaved.promise;
    await name.fill("请求期间输入的新名称");
  } finally {
    releaseResponse.resolve();
  }
  const retry = page.getByRole("button", { name: "重试保存" });
  await expect(retry).toBeVisible();
  await expect(name).toHaveValue("请求期间输入的新名称");
  expect((await (await request.get(apiPath)).json()).name).toBe("先输入的名称");
  await retry.click();
  await expect(page.locator(".head-title")).toHaveText("请求期间输入的新名称");
  expect((await (await request.get(apiPath)).json()).name).toBe(
    "请求期间输入的新名称",
  );
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
  await expect(
    page.locator(".inline-rich .rich-toolbar button").first(),
  ).toHaveCSS("height", "28px");
  await expect(recordEditor).toHaveCSS("line-height", "22.1px");
  await recordEditor.fill("# 阶段验收内容");
  await expect(page.getByText("已自动保存到本地文件")).toBeVisible();
  // 切到 UI 设计阶段：详情表单保存当前阶段，问题页签可记录全部阶段问题，新建问题
  await switchStage(page, "UI 设计");
  await page.getByRole("tab", { name: "问题记录" }).click();
  const issuesPanel = page.locator(".issue-app, .issue-empty");
  await issuesPanel.getByRole("button", { name: /新增/ }).first().click();
  const createDialog = page.locator(".el-dialog:visible");
  await createDialog.getByPlaceholder("一句话说清问题").fill("设计评审阻塞");
  await createDialog.getByRole("button", { name: "创建问题" }).click();
  await expect(
    page.locator(".issue-row").filter({ hasText: "设计评审阻塞" }),
  ).toBeVisible();
  // 切到需求测试阶段：新建问题并填写结论后标记解决
  await switchStage(page, "需求测试");
  await page.getByRole("tab", { name: "问题记录" }).click();
  await issuesPanel.getByRole("button", { name: /新增/ }).first().click();
  await page
    .locator(".el-dialog:visible")
    .getByPlaceholder("一句话说清问题")
    .fill("测试问题");
  await page
    .locator(".el-dialog:visible")
    .getByRole("button", { name: "创建问题" })
    .click();
  await expect(
    page.locator(".issue-row").filter({ hasText: "测试问题" }),
  ).toBeVisible();
  // 先填写解决方案，再标记已解决（服务端强制结论非空）
  await page
    .locator('.rich-document[aria-label="解决方案或最终结论"]')
    .fill("测试通过，关闭问题");
  const resolved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/issues\/\d+$/.test(new URL(response.request().url()).pathname),
  );
  await issuesPanel.locator(".meta-field--status .el-select").click();
  await page
    .locator(".el-select-dropdown:visible .el-select-dropdown__item")
    .filter({ hasText: "已解决" })
    .click();
  await resolved;
  await expect(issuesPanel.locator(".meta-field--status")).toContainText(
    "已解决",
  );
  // 新增的「已上线」阶段可在详情中切换并回显
  await switchStage(page, "已上线");
  await expect(
    page.locator("label.field").filter({ hasText: "当前阶段" }),
  ).toContainText("已上线");
  // 服务端持久化校验：需求记忆文档内容与各阶段问题状态
  const found = await (
    await request.get(`/api/requirements?q=${encodeURIComponent(name)}`)
  ).json();
  const id = found.items[0].id;
  expect(found.items[0].currentStage).toBe("online");
  const memory = (await (
    await request.get(`/api/requirements/${id}/memory`)
  ).json()) as { id: number };
  const record = await (
    await request.get(`/api/artifacts/nodes/${memory.id}/content`)
  ).json();
  expect(record.content).toContain("阶段验收内容");
  const design = await (
    await request.get(`/api/requirements/${id}/issues?stage=design`)
  ).json();
  expect(design.items[0].title).toBe("设计评审阻塞");
  const testing = await (
    await request.get(`/api/requirements/${id}/issues?stage=testing`)
  ).json();
  expect(testing.items[0].status).toBe("resolved");
  expect(testing.items[0].resolvedAt).toBeTruthy();
});

test("creating a requirement works when the name column is hidden", async ({
  page,
  request,
}) => {
  await page.goto("/requirements");
  await page.getByRole("button", { name: "列设置", exact: true }).click();
  const columns = page.getByRole("dialog");
  await columns.locator(".el-checkbox").filter({ hasText: "需求名称" }).click();
  await columns.getByRole("button", { name: "完成", exact: true }).click();
  const header = page.getByRole("columnheader", { name: /需求名称/ });
  await expect(header).toHaveCount(0);
  await page.getByRole("button", { name: "添加需求", exact: true }).click();
  const name = "隐藏列新建-" + Date.now();
  const input = page
    .locator(".editing-row")
    .getByRole("textbox", { name: "需求名称" });
  await input.fill(name);
  await input.press("Enter");
  await expect(header).toHaveCount(0);
  const result = await request.get(
    "/api/requirements?q=" + encodeURIComponent(name),
  );
  expect((await result.json()).items[0].name).toBe(name);
});

test("leaving the list waits for edits queued during a save", async ({
  page,
  request,
}) => {
  const name = "切换页面保存-" + Date.now();
  const created = await request.post("/api/requirements", {
    data: { name, proposedAt: "2026-10-13" },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  const apiPath = "/api/requirements/" + id;
  const firstSave = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  await page.route(apiPath, async (route) => {
    if (route.request().method() !== "PATCH" || ++attempts > 1)
      return route.continue();
    const response = await route.fetch();
    firstSave.resolve();
    await release.promise;
    return route.fulfill({ response });
  });
  await page.goto("/requirements");
  await page.getByRole("button", { name, exact: true }).click();
  const input = page
    .locator(".editing-row")
    .getByRole("textbox", { name: "需求名称" });
  await input.fill(name + "第一次");
  try {
    await firstSave.promise;
    await input.fill(name + "第二次");
    await page.getByRole("link", { name: "每日任务", exact: true }).click();
    await expect(page).toHaveURL(/requirements$/);
  } finally {
    release.resolve();
  }
  await expect(page).toHaveURL(/tasks$/);
  expect((await (await request.get(apiPath)).json()).name).toBe(
    name + "第二次",
  );
  expect(attempts).toBe(2);
});

test("number sorting keeps pinned requirements first until unpinned", async ({
  page,
  request,
}) => {
  const prefix = "排序置顶-" + Date.now();
  for (const suffix of ["甲", "乙"]) {
    const response = await request.post("/api/requirements", {
      data: { name: prefix + suffix, proposedAt: "2026-10-13" },
    });
    expect(response.ok()).toBeTruthy();
  }
  await page.goto("/requirements");
  await page.getByPlaceholder("搜索名称或编号").fill(prefix);
  await page.getByRole("button", { name: "查询", exact: true }).click();
  const names = page.locator(".name-cell");
  const numberHeader = page.getByRole("columnheader", { name: /需求编号/ });
  await numberHeader.locator(".sort-caret.ascending").click();
  await expect(names).toHaveText([prefix + "甲", prefix + "乙"]);
  const second = page
    .locator("tr")
    .filter({ has: names.filter({ hasText: prefix + "乙" }) });
  await second.getByRole("button", { name: "置顶", exact: true }).click();
  await expect(names).toHaveText([prefix + "乙", prefix + "甲"]);
  await page.reload();
  await expect(
    second.getByRole("button", { name: "取消置顶", exact: true }),
  ).toBeVisible();
  await page.getByPlaceholder("搜索名称或编号").fill(prefix);
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await numberHeader.locator(".sort-caret.ascending").click();
  await second.getByRole("button", { name: "取消置顶", exact: true }).click();
  await expect(names).toHaveText([prefix + "甲", prefix + "乙"]);
  await numberHeader.locator(".sort-caret.descending").click();
  await expect(names).toHaveText([prefix + "乙", prefix + "甲"]);
});

test("unsaved inline edits are protected on cancel and navigation", async ({
  page,
}) => {
  await page.goto("/requirements");
  await page.getByRole("button", { name: "添加需求", exact: true }).click();
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

// 功能页签：左侧菜单打开功能后页签才出现且可关闭；需求详情为动态页签的路由联动
test("workbench tabs open from menu and close with route fallback", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const name = `页签验收-${Date.now()}`;
  await page.goto("/requirements");
  // 页签不预置：首次进入仅当前功能页签出现，且可关闭（有关闭按钮）
  await expect(page.locator(".topbar-tab")).toHaveCount(1);
  await expect(page.locator(".topbar-tab").first()).toContainText("需求列表");
  // 侧栏/顶栏入口打开功能 → 对应页签依次出现
  await page.getByRole("link", { name: "每日任务" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.locator(".topbar-tab")).toHaveCount(2);
  await page.getByRole("link", { name: "系统通知" }).click();
  await expect(page.locator(".topbar-tab")).toHaveCount(3);
  await page.getByRole("link", { name: "系统设置" }).click();
  await expect(page.locator(".topbar-tab")).toHaveCount(4);
  // 打开需求详情 → 动态页签出现，加载完成后回填「编号 · 名称」
  await page.locator(".topbar-tab").filter({ hasText: "需求列表" }).click();
  await expect(page).toHaveURL(/\/requirements$/);
  const row = await addRequirement(page, name);
  await row.locator(".requirement-no").click();
  await expect(page).toHaveURL(/\/requirements\/\d+$/);
  const tab1 = page.locator(".topbar-tab").filter({ hasText: name });
  await expect(tab1).toBeVisible();
  await expect(tab1).toContainText("·");
  // 点击功能页签「需求列表」返回列表，再打开第二个需求 → 4 功能页签 + 2 详情页签
  await page.locator(".topbar-tab").filter({ hasText: "需求列表" }).click();
  const name2 = `页签二-${Date.now()}`;
  const row2 = await addRequirement(page, name2);
  await row2.locator(".requirement-no").click();
  const tab2 = page.locator(".topbar-tab").filter({ hasText: name2 });
  await expect(tab2).toBeVisible();
  await expect(page.locator(".topbar-tab")).toHaveCount(6);
  const detail2Url = page.url();
  // 点击第一个详情页签切换路由
  await tab1.locator(".tab-label").click();
  await expect(page).not.toHaveURL(detail2Url);
  await expect(page.getByRole("tab", { name: "需求详情" })).toBeVisible();
  // 关闭激活页签 → 路由回退到右侧第一个页签（第二个详情）
  await tab1.locator(".tab-close").click();
  await expect(page.locator(".topbar-tab")).toHaveCount(5);
  await expect(page).toHaveURL(detail2Url);
  // 关闭非激活页签不改变当前路由：回列表重新打开第一个需求，再关第二个详情
  await page.locator(".topbar-tab").filter({ hasText: "需求列表" }).click();
  const row1 = page
    .getByRole("button", { name, exact: true })
    .locator("xpath=ancestor::tr");
  await row1.locator(".requirement-no").click();
  await expect(page.locator(".topbar-tab")).toHaveCount(6);
  await tab2.locator(".tab-close").click();
  await expect(page.locator(".topbar-tab")).toHaveCount(5);
  await expect(page).toHaveURL(/\/requirements\/\d+$/);
  // 关闭最后一个详情页签（激活中、右侧无页签）→ 回退左侧最近的功能页签
  await page
    .locator(".topbar-tab")
    .filter({ hasText: name })
    .locator(".tab-close")
    .click();
  await expect(page.locator(".topbar-tab")).toHaveCount(4);
  await expect(page).toHaveURL(/\/settings$/);
  // 依次关闭激活的功能页签：逐个回退右邻页签路由
  await page
    .locator(".topbar-tab")
    .filter({ hasText: "系统设置" })
    .locator(".tab-close")
    .click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.locator(".topbar-tab")).toHaveCount(3);
  await page
    .locator(".topbar-tab")
    .filter({ hasText: "系统通知" })
    .locator(".tab-close")
    .click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.locator(".topbar-tab")).toHaveCount(2);
  await page
    .locator(".topbar-tab")
    .filter({ hasText: "每日任务" })
    .locator(".tab-close")
    .click();
  await expect(page).toHaveURL(/\/requirements$/);
  await expect(page.locator(".topbar-tab")).toHaveCount(1);
  // 关闭最后一个页签：路由兜底回需求列表，页签随路由联动重新开出
  await page.locator(".topbar-tab .tab-close").click();
  await expect(page).toHaveURL(/\/requirements$/);
  await expect(page.locator(".topbar-tab")).toHaveCount(1);
  await expect(page.locator(".topbar-tab").first()).toContainText("需求列表");
  expect(errors).toEqual([]);
});

test("topbar tabs scroll when crowded and can close other or all tabs", async ({
  page,
}) => {
  await page.goto("/requirements");
  for (const [name, path] of [
    ["优化点", "optimization-points"],
    ["每日任务", "tasks"],
    ["会议记录", "meetings"],
    ["便签", "notes"],
    ["工具箱", "online-tools"],
    ["系统设置", "settings"],
  ]) {
    await page.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(path + "$"));
  }
  const left = page.getByRole("button", { name: "向左滚动页签" });
  const right = page.getByRole("button", { name: "向右滚动页签" });
  const menu = page.getByRole("button", { name: "页签操作" });
  await page.setViewportSize({ width: 680, height: 900 });
  await expect
    .poll(() =>
      page
        .locator(".topbar-tabs")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    )
    .toBeGreaterThan(0);
  await expect(right).toBeEnabled();
  await right.click();
  await expect(left).toBeEnabled();
  await left.click();
  await expect(right).toBeEnabled();
  await menu.click();
  await page.getByRole("menuitem", { name: "关闭其他（全部）" }).click();
  await expect(page.locator(".topbar-tab")).toHaveCount(1);
  await expect(page.locator(".topbar-tab.active")).toHaveText("系统设置");
  await expect(left).toBeHidden();
  await menu.click();
  await page.getByRole("menuitem", { name: "关闭所有标签页" }).click();
  await expect(page).toHaveURL(/\/requirements$/);
  await expect(page.locator(".topbar-tab")).toHaveCount(1);
  await expect(page.locator(".topbar-tab.active")).toHaveText("需求列表");
});

test("closing all tabs keeps the current tab if saving is blocked", async ({
  page,
}) => {
  await page.goto("/requirements");
  const row = await addRequirement(page, "批量关闭前保存");
  await row.locator(".requirement-no").click();
  const name = page.getByPlaceholder("输入需求名称");
  await name.fill("");
  const detailUrl = page.url();
  const menu = page.getByRole("button", { name: "页签操作" });
  await menu.click();
  await page.getByRole("menuitem", { name: "关闭所有标签页" }).click();
  await expect(page.locator(".el-message--warning")).toContainText(
    "填写需求名称后自动保存",
  );
  await expect(page).toHaveURL(detailUrl);
  await expect(page.locator(".topbar-tab")).toHaveCount(2);
  await name.fill("批量关闭后已保存");
  await menu.click();
  await page.getByRole("menuitem", { name: "关闭所有标签页" }).click();
  await expect(page).toHaveURL(/\/requirements$/);
  await expect(page.locator(".topbar-tab")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "批量关闭后已保存", exact: true }),
  ).toBeVisible();
});

test("tab order and pin changes persist on refresh", async ({ page }) => {
  await page.goto("/requirements");
  for (const [name, path] of [
    ["优化点", "optimization-points"],
    ["每日任务", "tasks"],
    ["会议记录", "meetings"],
  ]) {
    await page.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(path + "$"));
  }
  const tabs = page.locator(".topbar-tab");
  const label = (name: string) =>
    tabs.filter({ hasText: name }).locator(".tab-label");
  await label("每日任务").dragTo(label("会议记录"));
  await expect(tabs.locator(".tab-label")).toHaveText([
    "需求列表",
    "优化点管理",
    "会议记录",
    "每日任务",
  ]);
  await tabs.getByRole("button", { name: "固定 每日任务" }).click();
  await expect(tabs.locator(".tab-label")).toHaveText([
    "每日任务",
    "需求列表",
    "优化点管理",
    "会议记录",
  ]);
  const storedLayout = await page.evaluate(async () => {
    const user = (await (await fetch("/api/auth/me")).json()) as {
      id: number;
    };
    return JSON.parse(
      localStorage.getItem(`superpm.workbench.tab-layout.v1.${user.id}`) ??
        "null",
    );
  });
  expect(storedLayout.order).toEqual([
    "/tasks",
    "/requirements",
    "/optimization-points",
    "/meetings",
  ]);
  await page.reload();
  await expect(tabs.locator(".tab-label")).toHaveText([
    "每日任务",
    "需求列表",
    "优化点管理",
    "会议记录",
  ]);
  const unpin = page.getByRole("button", {
    name: "取消固定 每日任务",
    exact: true,
  });
  const pin = page.getByRole("button", { name: "固定 每日任务", exact: true });
  await expect(unpin).toBeVisible();
  await unpin.click();
  await expect(pin).toBeVisible();
  await page.reload();
  await expect(pin).toBeVisible();
  await label("每日任务").dragTo(label("会议记录"));
  await expect(tabs.locator(".tab-label")).toHaveText([
    "需求列表",
    "优化点管理",
    "会议记录",
    "每日任务",
  ]);
});

test("close other tabs offers both pinned-tab policies", async ({ page }) => {
  await page.goto("/requirements");
  for (const [name, path] of [
    ["优化点", "optimization-points"],
    ["每日任务", "tasks"],
    ["会议记录", "meetings"],
  ]) {
    await page.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(path + "$"));
  }
  await page
    .locator(".topbar-tab")
    .filter({ hasText: "优化点管理" })
    .getByRole("button", { name: "固定 优化点管理" })
    .click();
  const menu = page.getByRole("button", { name: "页签操作" });
  await menu.click();
  await page
    .getByRole("menuitem", { name: "关闭其他（保留固定页签）" })
    .click();
  await expect(page.locator(".topbar-tab .tab-label")).toHaveText([
    "优化点管理",
    "会议记录",
  ]);
  await menu.click();
  await page.getByRole("menuitem", { name: "关闭其他（全部）" }).click();
  await expect(page.locator(".topbar-tab .tab-label")).toHaveText(["会议记录"]);
});

test("requirement detail can collapse the property sidebar", async ({
  page,
}) => {
  await page.goto("/requirements");
  const row = await addRequirement(page, `属性侧栏-${Date.now()}`);
  await row.locator(".requirement-no").click();
  await expect(page.getByRole("tab", { name: "需求详情" })).toBeVisible();
  await expect(page.locator(".detail-save-state")).toHaveText("已同步到本地");
  await page.getByRole("button", { name: "隐藏属性", exact: true }).click();
  await expect(page.locator(".detail-fields")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "显示属性", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "显示属性", exact: true }).click();
  await expect(page.locator(".detail-fields")).toBeVisible();
});

test("requirements toolbar keeps secondary date filters collapsed", async ({
  page,
}) => {
  await page.goto("/requirements");
  await expect(page.locator(".requirements-toolbar")).toBeVisible();
  await expect(page.locator(".filter-panel")).toHaveCount(0);
  await expect(page.locator(".date-filter:visible")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "查询", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "更多时间条件" }).click();
  await expect(page.locator(".date-filter:visible")).toHaveCount(6);
  await expect(
    page.locator(".editable-table th.el-table__cell").first(),
  ).toHaveCSS("height", "38px");
});

test("workbench shell uses compact native theme and collapsed navigation", async ({
  page,
}) => {
  await page.goto("/requirements");
  await expect(page.locator('nav[aria-label="主导航"] > a')).toHaveText([
    "需求列表",
    "优化点",
    "每日任务",
    "会议记录",
    "便签",
    "工具箱",
  ]);
  await expect(page.locator(".topbar")).toHaveCSS("height", "52px");
  await expect(page.locator(".topbar-tabs")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".topbar-tabs")).toHaveCSS(
    "border-top-width",
    "0px",
  );
  const activeTab = page.locator(".topbar-tab.active");
  await expect(activeTab).toHaveCSS("height", "38px");
  await expect(activeTab).toHaveCSS("border-top-left-radius", "8px");
  await expect(activeTab).toHaveCSS("border-bottom-left-radius", "8px");
  const brand = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--brand")
      .trim(),
  );
  expect(brand).toBe("#3370ff");
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator(".sidebar")).toHaveCSS("width", "64px");
  const settings = page.getByRole("link", { name: "系统设置", exact: true });
  await expect(settings).toHaveAttribute("title", "系统设置");
  await expect(settings.locator(".el-icon")).toHaveCSS("font-size", "20px");
});

test("settings shows version and update entry without contacting release source", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/settings");
  await expect(page.locator(".settings-nav button")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "本地存储", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const panel = page
    .locator("section.update-panel")
    .filter({ hasText: "版本与更新" });
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "版本与更新", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/当前版本 \d+\.\d+\.\d+/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "检查更新" })).toBeVisible();
  await expect(panel.getByText(/未检测到发布安装布局/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("settings storage shows current data root and locked reason", async ({
  page,
}) => {
  await page.goto("/settings");
  const panel = page.locator("section.storage-panel");
  await expect(panel.getByText("保存位置", { exact: true })).toBeVisible();
  await expect(panel.getByText("开发环境", { exact: true })).toBeVisible();
  await expect(panel.getByText("开发环境下数据固定在仓库目录")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "在资源管理器中打开" }),
  ).toBeEnabled();
  await expect(
    panel.getByRole("button", { name: "修改保存位置" }),
  ).toBeDisabled();
});

test("storage location dialog picks and validates a target directory", async ({
  page,
}) => {
  await page.route("**/api/system", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.dataRootEditable = true;
    delete body.dataRootLockedReason;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/system/home/pick", (route) =>
    route.fulfill({ json: { path: "D:/superPMData" } }),
  );
  await page.route("**/api/system/home/validate", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      json: {
        targetHome: `${body.parent}/superPM`,
        exists: false,
        empty: true,
        writable: true,
        freeBytes: 107374182400,
        requiredBytes: 10485760,
        sourceBytes: 8388608,
        databaseExists: true,
        databaseRows: 42,
        workspaceFiles: 7,
        warnings: ["将在所选目录中创建 superPM 子目录"],
        blockedReasons: [],
      },
    });
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "修改保存位置" }).click();
  const dialog = page
    .locator(".el-dialog")
    .filter({ hasText: "修改数据保存位置" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "选择目录…" }).click();
  await expect(dialog.locator("input").first()).toHaveValue("D:/superPMData");
  await dialog.getByRole("button", { name: "校验", exact: true }).click();
  await expect(dialog.getByText("D:/superPMData/superPM")).toBeVisible();
  await expect(dialog.getByText("42 条记录")).toBeVisible();
  await expect(
    dialog.getByText("将在所选目录中创建 superPM 子目录"),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "开始迁移" })).toBeEnabled();
});

test("post-migration cleanup prompt appears once and keeps old data", async ({
  page,
}) => {
  let cleanupBody: Record<string, unknown> | null = null;
  await page.route("**/api/system", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.pendingOldData = {
      jobId: "job-e2e",
      oldHome: "D:/old-superpm",
      movedAt: "2026-10-24T08:00:00.000Z",
      managedPaths: ["data", "workspace"],
    };
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/system/home/cleanup", async (route) => {
    cleanupBody = route.request().postDataJSON();
    await route.fulfill({ json: { action: "keep" } });
  });

  await page.goto("/requirements");
  const dialog = page
    .locator(".el-dialog")
    .filter({ hasText: "旧数据目录处理" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("D:/old-superpm")).toBeVisible();
  await dialog.getByRole("button", { name: "保留旧数据" }).click();
  await expect(dialog).toBeHidden();
  expect(cleanupBody).toMatchObject({
    action: "keep",
    jobId: "job-e2e",
    oldHome: "D:/old-superpm",
  });

  await page.getByRole("link", { name: "系统设置", exact: true }).click();
  await expect(
    page.locator(".el-dialog").filter({ hasText: "旧数据目录处理" }),
  ).toBeHidden();
});
