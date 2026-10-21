import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { readFileSync } from "node:fs";

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
// 状态下拉的选项（弹层挂在 body 下，按可见过滤）
function statusOption(page: Page, label: string) {
  return page
    .locator(".el-select-dropdown:visible .el-select-dropdown__item")
    .filter({ hasText: label });
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
  // 查看阶段为 UI 设计（问题阶段）：进入「需求问题」页签管理该阶段问题
  await page.getByRole("tab", { name: "需求问题", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  return requirement.id as number;
}

// 通过内联表单新建问题，可选填分类
async function createIssue(page: Page, title: string, typeName?: string) {
  await panel(page).getByRole("button", { name: "新建问题", exact: true }).click();
  await panel(page).getByPlaceholder("问题标题（必填）").fill(title);
  if (typeName) {
    await panel(page).locator(".issue-type-select").click();
    await statusOption(page, typeName).click();
  }
  await panel(page)
    .locator(".issue-create-form")
    .getByRole("button", { name: "创建", exact: true })
    .click();
  await expect(issueItem(page, title)).toBeVisible();
}

test("creates an issue, autosaves the markdown body and keeps it across reopen", async ({
  page,
  request,
}) => {
  const requirementId = await createDesignRequirement(page, request);
  // 默认列表形态：仅左栏列表，右侧编辑器未打开；多选导出按钮存在且禁用
  await expect(page.locator(".issues-right")).toHaveCount(0);
  await expect(panel(page).locator(".issue-export")).toBeVisible();
  await expect(panel(page).locator(".issue-export")).toBeDisabled();
  // 新建问题：标题 + 分类下拉选择「缺陷」
  await createIssue(page, "主视觉配色不一致", "缺陷");
  const item = issueItem(page, "主视觉配色不一致");
  await expect(
    item.locator(".enum-tag").filter({ hasText: "缺陷" }),
  ).toBeVisible();
  await expect(
    item.locator(".enum-tag").filter({ hasText: "待处理" }),
  ).toBeVisible();
  // 进详情：点击问题在右侧打开 md 编辑器
  await item.locator(".issue-title").click();
  await expect(page.locator(".issues-right")).toBeVisible();
  await expect(page.locator(".issue-detail")).toBeVisible();
  await expect(page.locator(".issues-right .inline-rich")).toBeVisible();
  await expect(
    panel(page).locator(".activity-row").filter({ hasText: "创建问题" }),
  ).toBeVisible();
  // 编辑正文：防抖自动保存走 PATCH 更新（正文写入 md 文件）
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/issues\/\d+$/.test(new URL(response.request().url()).pathname),
  );
  await page.locator(".issues-right .rich-document").click();
  await page.keyboard.type("首屏白屏后无法恢复，需排查挂载时序");
  await saved;
  // 关闭详情后重新打开：正文内容仍在
  await page.locator(".issues-close").click();
  await expect(page.locator(".issues-right")).toHaveCount(0);
  await item.locator(".issue-title").click();
  await expect(page.locator(".issues-right .rich-document")).toContainText(
    "首屏白屏后无法恢复",
  );
  // 正文端点返回 md 文件内容
  const list = await (await request.get(`/api/requirements/${requirementId}/issues`)).json();
  const issueId = list.items[0].id as number;
  const description = await (
    await request.get(`/api/requirements/${requirementId}/issues/${issueId}/description`)
  ).json();
  expect(String(description.content)).toContain("首屏白屏后无法恢复");
});

test("transitions status freely via the select without any dialog", async ({
  page,
  request,
}) => {
  const requirementId = await createDesignRequirement(page, request);
  await createIssue(page, "按钮点击无响应");
  await issueItem(page, "按钮点击无响应").locator(".issue-title").click();
  await expect(page.locator(".issues-right")).toBeVisible();
  await expect(page.locator(".issues-right .inline-rich")).toBeVisible();
  // 待处理 → 已解决：直接生效，不再弹出解决说明输入框
  await panel(page).locator(".issue-status-select").click();
  await statusOption(page, "已解决").click();
  await expect(headStatus(page)).toHaveText("已解决");
  await expect(page.locator(".el-message-box")).toHaveCount(0);
  // 服务端时间线记录状态流转（面板时间线在重开详情时刷新）
  const statusList = await (
    await request.get(`/api/requirements/${requirementId}/issues`)
  ).json();
  const statusDetail = await (
    await request.get(
      `/api/requirements/${requirementId}/issues/${statusList.items[0].id}`,
    )
  ).json();
  expect(
    statusDetail.activities.find(
      (item: { activityType: string }) => item.activityType === "status_change",
    ),
  ).toMatchObject({ oldStatus: "pending", newStatus: "resolved" });
  // 已解决 → 测试中：任意方向可流转
  await panel(page).locator(".issue-status-select").click();
  await statusOption(page, "测试中").click();
  await expect(headStatus(page)).toHaveText("测试中");
});

test("exports selected issues as a markdown file", async ({ page, request }) => {
  await createDesignRequirement(page, request);
  await createIssue(page, "主视觉配色不一致", "缺陷");
  await createIssue(page, "文案截断");
  // 勾选两条后导出
  await issueItem(page, "主视觉配色不一致").locator(".issue-check").click();
  await issueItem(page, "文案截断").locator(".issue-check").click();
  const downloadPromise = page.waitForEvent("download");
  await panel(page).locator(".issue-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  const content = readFileSync(await download.path(), "utf8");
  expect(content).toContain("主视觉配色不一致");
  expect(content).toContain("分类：缺陷");
  expect(content).toContain("状态：待处理");
  expect(content).toContain("文案截断");
});

test("links artifacts to an issue and unlinks them", async ({
  page,
  request,
}) => {
  const requirementId = await createDesignRequirement(page, request);
  // API 预置知识库文件夹 + 文件
  const folder = await (
    await request.post(`/api/requirements/${requirementId}/artifacts/folders`, {
      data: { parentId: null, name: "设计稿" },
    })
  ).json();
  await request.post(`/api/requirements/${requirementId}/artifacts/files`, {
    data: { parentId: folder.id, name: "视觉稿说明.md" },
  });
  await createIssue(page, "缺少空态图标");
  await issueItem(page, "缺少空态图标").locator(".issue-title").click();
  await expect(page.locator(".issues-right")).toBeVisible();
  // 打开关联弹窗：目录树展示文件夹与文件，勾选文件后确定
  await panel(page).getByRole("button", { name: "关联产出物" }).click();
  const dialog = page.locator(".el-dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .locator(".tree-row")
    .filter({ hasText: "视觉稿说明.md" })
    .locator(".tree-check")
    .click();
  await dialog.getByRole("button", { name: "确定关联" }).click();
  await expect(
    panel(page).locator(".asset-row").filter({ hasText: "视觉稿说明.md" }),
  ).toBeVisible();
  // 解除关联：关联行消失，产出物本体不受影响
  await panel(page)
    .locator(".asset-row")
    .filter({ hasText: "视觉稿说明.md" })
    .getByRole("button", { name: "解除" })
    .click();
  await expect(panel(page).locator(".asset-row")).toHaveCount(0);
});

test("posts a comment and shows it in the activity timeline", async ({
  page,
  request,
}) => {
  await createDesignRequirement(page, request);
  await createIssue(page, "文案截断");
  await issueItem(page, "文案截断").locator(".issue-title").click();
  await expect(page.locator(".issues-right")).toBeVisible();
  await expect(page.locator(".issues-right .inline-rich")).toBeVisible();
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
