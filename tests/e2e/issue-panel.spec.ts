import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

// 问题面板根节点
function panel(page: Page) {
  return page.locator(".issues-panel");
}
// 列表中按标题定位问题条目
function issueItem(page: Page, title: string) {
  return page.locator(".issue-item").filter({ hasText: title });
}
// 详情头部的状态 tag
function headStatus(page: Page) {
  return page.locator(".issues-head .enum-tag");
}

// 建一个处于 UI 设计阶段的需求：进入详情页后左栏自动切到问题视图
async function createDesignRequirement(
  page: Page,
  request: APIRequestContext,
) {
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
  // 进入「需求进展」页签；查看阶段为 UI 设计（问题阶段），左栏自动展示问题面板
  await page.getByRole("tab", { name: "需求进展", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  return requirement.id as number;
}

// 通过内联表单新建一个仅填标题的问题
async function createIssue(page: Page, title: string) {
  await panel(page).getByRole("button", { name: "新建问题", exact: true }).click();
  await panel(page).getByPlaceholder("问题标题（必填）").fill(title);
  await panel(page)
    .locator(".issue-create-form")
    .getByRole("button", { name: "创建", exact: true })
    .click();
  await expect(issueItem(page, title)).toBeVisible();
}

test("creates an issue in the design stage and starts processing it", async ({
  page,
  request,
}) => {
  await createDesignRequirement(page, request);
  // 新建问题：标题 + 类型下拉选择「缺陷」
  await panel(page).getByRole("button", { name: "新建问题", exact: true }).click();
  await panel(page).getByPlaceholder("问题标题（必填）").fill("主视觉配色不一致");
  await panel(page).locator(".issue-type-select").click();
  await page
    .locator(".el-select-dropdown:visible .el-select-dropdown__item")
    .filter({ hasText: "缺陷" })
    .click();
  await panel(page)
    .locator(".issue-create-form")
    .getByRole("button", { name: "创建", exact: true })
    .click();
  // 列表出现新问题：类型 tag + 状态 tag（待处理）
  const item = issueItem(page, "主视觉配色不一致");
  await expect(item).toBeVisible();
  await expect(
    item.locator(".enum-tag").filter({ hasText: "缺陷" }),
  ).toBeVisible();
  await expect(
    item.locator(".enum-tag").filter({ hasText: "待处理" }),
  ).toBeVisible();
  // 进详情：初始含系统记录，执行「开始处理」状态流转
  await item.locator(".issue-title").click();
  await expect(page.locator(".issue-detail")).toBeVisible();
  await expect(
    panel(page).locator(".activity-row").filter({ hasText: "创建问题" }),
  ).toBeVisible();
  await panel(page).getByRole("button", { name: "开始处理", exact: true }).click();
  // 状态 tag 变为处理中，时间线出现状态变更记录
  await expect(headStatus(page)).toHaveText("处理中");
  await expect(
    panel(page)
      .locator(".activity-row")
      .filter({ hasText: "状态变更：待处理 → 处理中" }),
  ).toBeVisible();
});

test("blocks resolving without a note then resolves after filling it", async ({
  page,
  request,
}) => {
  await createDesignRequirement(page, request);
  await createIssue(page, "按钮点击无响应");
  await issueItem(page, "按钮点击无响应").locator(".issue-title").click();
  await expect(page.locator(".issue-detail")).toBeVisible();
  // 未填解决说明：弹窗内取消 → 状态保持待处理
  await panel(page).getByRole("button", { name: "标记解决", exact: true }).click();
  const messageBox = page.locator(".el-message-box");
  await expect(messageBox).toBeVisible();
  await messageBox.getByRole("button", { name: "取消", exact: true }).click();
  await expect(headStatus(page)).toHaveText("待处理");
  // 填写解决说明后标记成功：状态 tag 与解决说明块同步更新
  await panel(page).getByRole("button", { name: "标记解决", exact: true }).click();
  await page.locator(".el-message-box__input input").fill("事件绑定已修复并回归通过");
  await messageBox.getByRole("button", { name: "确定", exact: true }).click();
  await expect(headStatus(page)).toHaveText("已解决");
  await expect(panel(page).locator(".issue-solution")).toContainText(
    "事件绑定已修复并回归通过",
  );
  await expect(
    panel(page).locator(".activity-row").filter({ hasText: "解决说明：事件绑定已修复并回归通过" }),
  ).toBeVisible();
  // 已解决问题可「重新打开」回到待处理
  await panel(page).getByRole("button", { name: "重新打开", exact: true }).click();
  await expect(headStatus(page)).toHaveText("待处理");
});

test("posts a comment and shows it in the activity timeline", async ({
  page,
  request,
}) => {
  await createDesignRequirement(page, request);
  await createIssue(page, "文案截断");
  await issueItem(page, "文案截断").locator(".issue-title").click();
  await expect(page.locator(".issue-detail")).toBeVisible();
  // 发送评论后时间线出现该评论内容
  await panel(page)
    .getByPlaceholder("填写处理说明…")
    .fill("已确认为容器宽度问题");
  await panel(page).getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    panel(page)
      .locator(".activity-row")
      .filter({ hasText: "评论：已确认为容器宽度问题" }),
  ).toBeVisible();
});
