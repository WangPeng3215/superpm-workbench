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
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("需求已保存").first()).toBeVisible();
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
    await request.get(`/api/requirements/${id}/issues?stage=design`)
  ).json();
  expect(design.items[0].title).toBe("设计评审阻塞");
  const testing = await (
    await request.get(`/api/requirements/${id}/issues?stage=testing`)
  ).json();
  expect(testing.items[0].status).toBe("resolved");
  expect(testing.items[0].resolvedAt).toBeTruthy();
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
  await expect(page.getByRole("button", { name: "显示属性", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
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
  await expect(page.getByRole("button", { name: "查询", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "更多时间条件" }).click();
  await expect(page.locator(".date-filter:visible")).toHaveCount(6);
  await expect(page.locator(".editable-table th.el-table__cell").first()).toHaveCSS(
    "height",
    "38px",
  );
});

test("workbench shell uses compact native theme and collapsed navigation", async ({
  page,
}) => {
  await page.goto("/requirements");
  await expect(page.locator(".topbar")).toHaveCSS("height", "52px");
  await expect(page.locator(".topbar-tabs")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".topbar-tabs")).toHaveCSS("border-top-width", "0px");
  const activeTab = page.locator(".topbar-tab.active");
  await expect(activeTab).toHaveCSS("height", "36px");
  await expect(activeTab).toHaveCSS("border-top-left-radius", "8px");
  await expect(activeTab).toHaveCSS("border-bottom-left-radius", "0px");
  const brand = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--brand").trim(),
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
  await page
    .getByRole("button", { name: "版本与更新", exact: true })
    .click();
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/当前版本 \d+\.\d+\.\d+/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "检查更新" })).toBeVisible();
  await expect(panel.getByText(/未检测到发布安装布局/)).toBeVisible();
  expect(errors).toEqual([]);
});
