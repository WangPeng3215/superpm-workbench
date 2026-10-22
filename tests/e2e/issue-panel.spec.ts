import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

// 问题记录面板根节点（空台账与双栏形态）
function panel(page: Page) {
  return page.locator(".issue-app, .issue-empty");
}
function issueRow(page: Page, title: string) {
  return page.locator(".issue-row").filter({ hasText: title });
}
// 下拉选项挂在 body 下，按可见弹层过滤；选完等弹层收起再继续，避免连续切换时被关闭动画吞掉点击
async function selectOption(page: Page, label: string) {
  await page
    .locator(".el-select-dropdown:visible .el-select-dropdown__item")
    .filter({ hasText: label })
    .click();
  await expect(page.locator(".el-select-dropdown:visible")).toHaveCount(0);
}
function waitForIssuePatch(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/api\/requirements\/\d+\/issues\/\d+$/.test(
        new URL(response.request().url()).pathname,
      ),
  );
}

async function createDesignRequirement(page: Page, request: APIRequestContext) {
  const created = await request.post("/api/requirements", {
    data: { name: `问题面板-${Date.now()}`, proposedAt: "2026-10-14" },
  });
  expect(created.ok()).toBeTruthy();
  const requirement = await created.json();
  const patched = await request.patch(`/api/requirements/${requirement.id}`, {
    data: { currentStage: "design" },
  });
  expect(patched.ok()).toBeTruthy();
  await page.goto(`/requirements/${requirement.id}`);
  await page.getByRole("tab", { name: "问题记录", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  return requirement.id as number;
}

// 新建弹窗：标题必填，可选类型；创建后详情自动打开
async function createIssue(page: Page, title: string, typeName?: string) {
  await page
    .locator(".issue-empty .issue-primary, .issue-rail .issue-primary")
    .first()
    .click();
  const dialog = page.locator(".el-dialog:visible");
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("一句话说清问题").fill(title);
  if (typeName) {
    await dialog.locator(".create-row .el-select").first().click();
    await selectOption(page, typeName);
  }
  await dialog.getByRole("button", { name: "创建问题" }).click();
  await expect(dialog).toBeHidden();
  await expect(issueRow(page, title)).toBeVisible();
  await expect(page.locator(".detail-pane .title-input")).toHaveValue(title);
}

test("creates an issue, autosaves both markdown editors and keeps content across reload", async ({
  page,
  request,
}) => {
  const requirementId = await createDesignRequirement(page, request);
  // 空台账：文案 + 真实零计数
  await expect(page.locator(".issue-empty h2")).toContainText("先记下来");
  await expect(
    page.locator(".empty-chip").filter({ hasText: "待分析" }),
  ).toContainText("0");
  // 新建：标题 + 类型
  await createIssue(page, "主视觉配色不一致", "UI 设计疑问");
  const item = issueRow(page, "主视觉配色不一致");
  await expect(item.locator(".row-meta")).toContainText("UI 设计疑问");
  await expect(item.locator(".row-meta")).toContainText("UI 设计");
  await expect(item.locator(".status-pill")).toHaveText("待分析");
  // 详情：两个独立编辑器 + 只读时间
  await expect(page.locator('.rich-document[aria-label="问题描述"]')).toBeVisible();
  await expect(
    page.locator('.rich-document[aria-label="解决方案或最终结论"]'),
  ).toBeVisible();
  await expect(page.locator(".meta-times")).toContainText("创建");
  // 描述自动保存为 Markdown（防抖后 PATCH）
  const saved = waitForIssuePatch(page);
  await page.locator('.rich-document[aria-label="问题描述"]').click();
  await page.keyboard.type("首屏白屏后无法恢复，需排查挂载时序");
  await saved;
  const list = await (
    await request.get(`/api/requirements/${requirementId}/issues`)
  ).json();
  const issueId = list.items[0].id as number;
  await expect
    .poll(async () => {
      const description = await (
        await request.get(
          `/api/requirements/${requirementId}/issues/${issueId}/description`,
        )
      ).json();
      return String(description.content);
    })
    .toContain("首屏白屏后无法恢复");
  const description = await (
    await request.get(
      `/api/requirements/${requirementId}/issues/${issueId}/description`,
    )
  ).json();
  expect(String(description.content)).not.toContain("<p>");
  // 解决方案独立保存（不写入描述）
  const solutionSaved = waitForIssuePatch(page);
  await page
    .locator('.rich-document[aria-label="解决方案或最终结论"]')
    .click();
  await page.keyboard.type("按新稿重新导出切图");
  await solutionSaved;
  await expect
    .poll(async () => {
      const detail = await (
        await request.get(
          `/api/requirements/${requirementId}/issues/${issueId}`,
        )
      ).json();
      return detail.solution as string;
    })
    .toContain("按新稿重新导出切图");
  // 刷新后重新进入：描述仍在编辑器内
  await page.reload();
  await page.getByRole("tab", { name: "问题记录", exact: true }).click();
  await issueRow(page, "主视觉配色不一致").click();
  await expect(page.locator('.rich-document[aria-label="问题描述"]')).toContainText(
    "首屏白屏后无法恢复",
  );
});

test("guards resolved without a solution, then autosaves status, type and stage", async ({
  page,
  request,
}) => {
  const requirementId = await createDesignRequirement(page, request);
  await createIssue(page, "按钮点击无响应");
  const issueId = (await (
    await request.get(`/api/requirements/${requirementId}/issues`)
  ).json()).items[0].id as number;
  // 未填解决方案：客户端拦截并恢复原状态
  await page.locator(".meta-field--status .el-select").click();
  await selectOption(page, "已解决");
  await expect(
    page.locator(".el-message--warning").filter({ hasText: "请先填写解决方案" }),
  ).toBeVisible();
  await expect(page.locator(".meta-field--status")).toContainText("待分析");
  // 填写解决方案
  const solutionSaved = waitForIssuePatch(page);
  await page
    .locator('.rich-document[aria-label="解决方案或最终结论"]')
    .click();
  await page.keyboard.type("确认容器宽度导致，已调整布局");
  await solutionSaved;
  // 再标记已解决：落库并写解决时间
  const resolvedSaved = waitForIssuePatch(page);
  await page.locator(".meta-field--status .el-select").click();
  await selectOption(page, "已解决");
  await resolvedSaved;
  await expect(page.locator(".meta-field--status")).toContainText("已解决");
  await expect
    .poll(async () => {
      const detail = await (
        await request.get(
          `/api/requirements/${requirementId}/issues/${issueId}`,
        )
      ).json();
      return detail.status as string;
    })
    .toBe("resolved");
  const resolvedDetail = await (
    await request.get(`/api/requirements/${requirementId}/issues/${issueId}`)
  ).json();
  expect(resolvedDetail.resolvedAt).toBeTruthy();
  // 暂不处理与已解决不同：解决时间清空
  const wontFixSaved = waitForIssuePatch(page);
  await page.locator(".meta-field--status .el-select").click();
  await selectOption(page, "暂不处理");
  await wontFixSaved;
  await expect(page.locator(".meta-field--status")).toContainText("暂不处理");
  // 类型与产生阶段独立保存
  const typeSaved = waitForIssuePatch(page);
  await page.locator(".meta-field--type .el-select").click();
  await selectOption(page, "开发疑问");
  await typeSaved;
  const stageSaved = waitForIssuePatch(page);
  await page.locator(".meta-field--stage .el-select").click();
  await selectOption(page, "需求分析");
  await stageSaved;
  await expect
    .poll(async () => {
      const detail = await (
        await request.get(
          `/api/requirements/${requirementId}/issues/${issueId}`,
        )
      ).json();
      return `${detail.type}/${detail.stage}/${detail.resolvedAt}`;
    })
    .toBe("development/analysis/null");
  // 状态筛选（下拉）可直接定位到暂不处理
  await page.locator(".status-filter").click();
  await selectOption(page, "暂不处理");
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await expect(
    issueRow(page, "按钮点击无响应").locator(".status-pill"),
  ).toContainText("暂不处理");
});

test("filters by status, type and keyword and clears all filters", async ({
  page,
  request,
}) => {
  const requirementId = await createDesignRequirement(page, request);
  const seed = async (data: object) =>
    (
      await request.post(`/api/requirements/${requirementId}/issues`, {
        data,
      })
    ).json();
  const ui = await seed({
    title: "按钮样式不一致",
    stage: "design",
    type: "ui",
    description: "登录页间距偏差 4px",
  });
  const development = await seed({
    title: "接口报错",
    stage: "development",
    type: "development",
    description: "保存时返回 500",
  });
  await seed({
    title: "回归失败",
    stage: "testing",
    type: "testing",
    description: "冒烟用例未通过",
  });
  await request.patch(`/api/requirements/${requirementId}/issues/${ui.id}`, {
    data: { status: "processing" },
  });
  await request.patch(
    `/api/requirements/${requirementId}/issues/${development.id}`,
    { data: { status: "resolved", solution: "已修复空指针" } },
  );
  await page.reload();
  await page.getByRole("tab", { name: "问题记录", exact: true }).click();
  await expect(page.locator(".issue-row")).toHaveCount(3);
  // 状态筛选
  await page.locator(".status-filter").click();
  await selectOption(page, "处理中");
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await expect(issueRow(page, "按钮样式不一致")).toBeVisible();
  await page.locator(".status-filter").click();
  await selectOption(page, "全部状态");
  await expect(page.locator(".issue-row")).toHaveCount(3);
  // 关键词：正文与标题均可命中，点击搜索按钮生效
  const search = page.getByPlaceholder("搜索标题或描述");
  await search.fill("间距");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await expect(issueRow(page, "按钮样式不一致")).toBeVisible();
  await page.locator(".search-clear").click();
  await expect(page.locator(".issue-row")).toHaveCount(3);
  await search.fill("接口");
  await search.press("Enter");
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await expect(issueRow(page, "接口报错")).toBeVisible();
  await page.locator(".search-clear").click();
  await expect(page.locator(".issue-row")).toHaveCount(3);
  // 类型筛选
  await page.locator(".type-filter").click();
  await selectOption(page, "UI 设计疑问");
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await expect(issueRow(page, "按钮样式不一致")).toBeVisible();
  // 组合无结果：清除筛选恢复全部
  await page.locator(".status-filter").click();
  await selectOption(page, "已解决");
  await expect(page.getByText("没有符合条件的问题")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page.locator(".issue-row")).toHaveCount(3);
});

test("links and unlinks an artifact from an issue", async ({
  page,
  request,
}) => {
  const requirementId = await createDesignRequirement(page, request);
  const folder = await (
    await request.post(`/api/requirements/${requirementId}/artifacts/folders`, {
      data: { parentId: null, name: "设计稿" },
    })
  ).json();
  const file = await (
    await request.post(`/api/requirements/${requirementId}/artifacts/files`, {
      data: { parentId: folder.id, name: "视觉稿说明.md" },
    })
  ).json();
  await createIssue(page, "缺少空态图标");
  const section = page.locator(".detail-section").filter({
    has: page.getByRole("heading", { name: "关联产出物" }),
  });
  await section.getByRole("button", { name: "关联" }).click();
  const dialog = page.locator(".el-dialog:visible");
  await expect(dialog).toBeVisible();
  const treeRow = dialog.locator(".tree-row").filter({ hasText: "视觉稿说明.md" });
  await treeRow.locator(".tree-check").click();
  const linked = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/issues/`) &&
      response.url().endsWith("/assets"),
  );
  await dialog.getByRole("button", { name: "确定关联" }).click();
  await linked;
  await expect(section.locator(".asset-chip")).toContainText("视觉稿说明.md");
  const listed = await (
    await request.get(`/api/requirements/${requirementId}/issues`)
  ).json();
  const issueId = listed.items[0].id as number;
  const assets = await (
    await request.get(
      `/api/requirements/${requirementId}/issues/${issueId}/assets`,
    )
  ).json();
  expect(assets.total).toBe(1);
  expect(assets.items[0].asset.id).toBe(file.id);
  // 解除关联：只移除关系，不动产出物本体
  const unlinked = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().endsWith(`/assets/${file.id}`),
  );
  await section
    .getByRole("button", { name: "取消关联 视觉稿说明.md" })
    .click();
  await unlinked;
  await expect(section.locator(".asset-chip")).toHaveCount(0);
  const afterUnlink = await (
    await request.get(`/api/artifacts/nodes/${file.id}`)
  ).json();
  expect(afterUnlink.node.name).toBe("视觉稿说明.md");
});

test("deletes an issue after confirmation", async ({ page, request }) => {
  const requirementId = await createDesignRequirement(page, request);
  await createIssue(page, "待删除的问题");
  await page.locator(".ghost-danger").click();
  const confirm = page.locator(".el-message-box");
  await expect(confirm).toBeVisible();
  const removed = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      /\/issues\/\d+$/.test(new URL(response.request().url()).pathname),
  );
  await confirm.getByRole("button", { name: "删除", exact: true }).click();
  await removed;
  // 空台账重新出现，接口不再返回该问题
  await expect(page.locator(".issue-empty")).toBeVisible();
  const list = await (
    await request.get(`/api/requirements/${requirementId}/issues`)
  ).json();
  expect(list.total).toBe(0);
});

test.describe("narrow viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("switches between the ledger and detail with the back button", async ({
    page,
    request,
  }) => {
    const requirementId = await createDesignRequirement(page, request);
    await request.post(`/api/requirements/${requirementId}/issues`, {
      data: { title: "移动端列表问题", stage: "design" },
    });
    await page.reload();
    await page.getByRole("tab", { name: "问题记录", exact: true }).click();
    await expect(page.locator(".detail-pane")).toBeVisible();
    await expect(page.locator(".back-button")).toBeVisible();
    await expect(page.locator(".issue-rail")).toBeHidden();
    // 返回列表：左栏出现，详情隐藏
    await page.locator(".back-button").click();
    await expect(page.locator(".issue-rail")).toBeVisible();
    await expect(page.locator(".detail-pane")).toBeHidden();
    await issueRow(page, "移动端列表问题").click();
    await expect(page.locator(".detail-pane")).toBeVisible();
  });
});
