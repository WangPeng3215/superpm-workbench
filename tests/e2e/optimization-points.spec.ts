import { test, expect, type Page } from "@playwright/test";

const NAME_PLACEHOLDER = "一句话说明发现的问题或机会";
const MODULE_PLACEHOLDER = "选填，如：需求管理";
// 正文与需求详情同款：Markdown 输入的富文本编辑器，不再拆「问题描述 / 优化思路」两个框
const CONTENT_LABEL = "优化点内容";
const PREVIEW_LABEL = "需求详情预览";
const DESCRIPTION_LABEL = "需求描述内容";

/** 打开指定状态筛选下拉并选中一项 */
async function selectStatusFilter(page: Page, label: string) {
  await page.locator(".status-filter .el-select__wrapper").click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: label })
    .click();
}

test("optimization point keeps a light record and tracks its status", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const stamp = Date.now();
  const name = `列表操作繁琐-${stamp}`;

  // 左侧菜单进入：未记录时先显示空状态引导
  await page.goto("/requirements");
  await page.getByRole("link", { name: "优化点" }).click();
  await expect(page).toHaveURL(/\/optimization-points$/);
  await expect(page.locator(".point-table")).toBeVisible();
  await expect(page.getByText("还没有记录优化点")).toBeVisible();

  // 新增：跳独立新建页（同会议记录），只要求名称与一份正文
  await page.getByRole("button", { name: "新增优化点" }).first().click();
  await expect(page).toHaveURL(/\/optimization-points\/new$/);
  await page.getByRole("button", { name: "保存优化点" }).click();
  await expect(page.locator(".form-error")).toContainText("请输入优化点名称");

  await page.getByPlaceholder(NAME_PLACEHOLDER).fill(name);
  await page.getByPlaceholder(MODULE_PLACEHOLDER).fill("需求管理");
  await page
    .locator(`.rich-document[aria-label="${CONTENT_LABEL}"]`)
    .fill("批量操作需要逐行点击，效率偏低。");
  await page.getByRole("button", { name: "保存优化点" }).click();

  // 保存后直接进入详情，页签文案回填优化点名称
  await expect(page).toHaveURL(/\/optimization-points\/\d+$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(
    page.locator(".topbar-tab").filter({ hasText: name }),
  ).toHaveCount(1);

  // 详情：状态默认待评估，模块与正文按填写回显
  const statusTag = page.locator(".detail-head .enum-tag");
  await expect(statusTag).toHaveText("待评估");
  await expect(page.getByPlaceholder(MODULE_PLACEHOLDER)).toHaveValue(
    "需求管理",
  );
  await expect(
    page.locator(`.rich-document[aria-label="${CONTENT_LABEL}"]`),
  ).toContainText("批量操作需要逐行点击，效率偏低。");

  // 状态可调整：保存前显示未保存标记，保存后头部标签同步
  await page.locator(".status-select .el-select__wrapper").click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: "评估中" })
    .click();
  await expect(page.locator(".dirty-flag")).toHaveText("未保存");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("优化点已保存")).toBeVisible();
  await expect(statusTag).toHaveText("评估中");
  await expect(page.locator(".dirty-flag")).toHaveCount(0);

  // 列表：关键词搜索与状态筛选
  await page.getByRole("button", { name: "返回优化点列表" }).click();
  await expect(page).toHaveURL(/\/optimization-points$/);
  await page.getByLabel("搜索优化点名称").fill(name);
  await expect(page.locator(".point-name")).toHaveCount(1);
  await expect(page.locator(".point-table")).toContainText("需求管理");

  await selectStatusFilter(page, "已转正式需求");
  await expect(page.getByText("没有找到匹配的优化点")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page.locator(".point-name")).toHaveCount(1);

  // 删除需二次确认
  await page.getByRole("button", { name: "删除" }).first().click();
  const confirm = page.locator(".el-message-box");
  await expect(confirm).toContainText("删除后该优化点记录将不可恢复");
  await confirm.getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("优化点已删除")).toBeVisible();
  await expect(page.getByText("还没有记录优化点")).toBeVisible();

  expect(errors).toEqual([]);
});

test("optimization point converts into a real requirement", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const name = `导出按钮不明显-${stamp}`;
  const content = "导出入口藏在二级菜单里，用户经常找不到。";
  const created = await (
    await request.post("/api/optimization-points", {
      data: {
        name,
        module: "报表",
        description: content,
        descriptionHtml: `<p>${content}</p>`,
      },
    })
  ).json();
  expect(created.status).toBe("pending");
  expect(created.requirement).toBeNull();

  await page.goto(`/optimization-points/${created.id}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText("尚未转换。")).toBeVisible();

  // 转换入口与保存按钮并排在页头
  const headActions = page.locator(".head-actions");
  await expect(
    headActions.getByRole("button", { name: "转为正式需求" }),
  ).toBeVisible();
  await expect(
    headActions.getByRole("button", { name: "保存", exact: true }),
  ).toBeVisible();

  // 转换前可在弹窗内确认需求名称，并预览将整段继承的正文
  await page.getByRole("button", { name: "转为正式需求" }).click();
  const dialog = page.locator(".el-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("优化点管理");
  await expect(dialog.locator(".el-input__inner").first()).toHaveValue(name);
  await expect(
    dialog.locator(`.rich-document[aria-label="${PREVIEW_LABEL}"]`),
  ).toContainText(content);
  await dialog.getByRole("button", { name: "确认转换" }).click();

  // 转换成功：头部状态与关联需求卡片同步
  await expect(page.getByText(/已生成正式需求 REQ-\d{4}/)).toBeVisible();
  await expect(page.locator(".detail-head .enum-tag")).toHaveText(
    "已转正式需求",
  );
  const requirementRow = page.locator(".requirement-row");
  await expect(requirementRow).toContainText(/REQ-\d{4}/);
  await expect(requirementRow).toContainText(name);
  // 已转换后不再提供重复转换入口，状态选择被锁定
  await expect(page.getByRole("button", { name: "转为正式需求" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("combobox", { name: "当前状态" })).toBeDisabled();

  // 打开正式需求：名称与正文已继承（正文即需求详情），并能反查来源优化点
  await requirementRow.click();
  await expect(page).toHaveURL(/\/requirements\/\d+$/);
  const requirementId = Number(new URL(page.url()).pathname.split("/").pop());
  expect(requirementId).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(
    page.locator(`.rich-document[aria-label="${DESCRIPTION_LABEL}"]`),
  ).toContainText(content);

  const sourceBlock = page.locator(".related-block").filter({
    has: page.getByRole("heading", { name: "来源优化点" }),
  });
  await expect(sourceBlock).toContainText(name);
  await sourceBlock.getByRole("button").click();
  await expect(page).toHaveURL(
    new RegExp(`/optimization-points/${created.id}$`),
  );

  // 删除正式需求后关联失效，但优化点内容保留且允许重新转换
  expect(
    (await request.delete(`/api/requirements/${requirementId}`)).status(),
  ).toBe(204);
  await page.goto(`/optimization-points/${created.id}`);
  await expect(page.locator(".side-warning")).toContainText(
    "关联的正式需求已被删除",
  );
  await expect(
    page.getByRole("button", { name: "转为正式需求" }),
  ).toBeEnabled();
  await expect(
    page.locator(`.rich-document[aria-label="${CONTENT_LABEL}"]`),
  ).toContainText(content);

  // 列表操作列同样提供转换入口：跳到详情并直接打开确认弹窗
  await page.goto("/optimization-points");
  await page.getByLabel("搜索优化点名称").fill(name);
  const listRow = page.locator(".el-table__row").filter({ hasText: name });
  await listRow.getByRole("button", { name: "转为正式需求" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/optimization-points/${created.id}$`),
  );
  await expect(page.locator(".el-dialog")).toBeVisible();
});
