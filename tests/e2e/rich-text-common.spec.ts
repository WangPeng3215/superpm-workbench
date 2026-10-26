import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

function waitArtifactSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /\/api\/artifacts\/nodes\/\d+\/content$/.test(
        new URL(response.request().url()).pathname,
      ),
  );
}

async function createRequirementViaApi(
  request: APIRequestContext,
  name: string,
) {
  const created = await request.post("/api/requirements", {
    data: { name, proposedAt: "2026-10-26" },
  });
  expect(created.ok()).toBeTruthy();
  return (await created.json()) as { id: number; name: string };
}

async function applyColor(page: Page) {
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "文字颜色", exact: true }).click();
  await page.locator('button[aria-label="文字颜色 #be123c"]:visible').click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "文字高亮", exact: true }).click();
  await page.locator('button[aria-label="高亮颜色 #fef08a"]:visible').click();
}

// 颜色、高亮与需求引用是编辑器的公共能力：所有挂载点都有入口，
// Markdown 文档以行内 HTML 持久化，刷新后样式与引用仍可用。
test("rich text colors, highlights and requirement refs are shared across editors", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const suffix = Date.now();
  const main = await createRequirementViaApi(
    request,
    `富文本公共能力-${suffix}`,
  );
  const target = await createRequirementViaApi(request, `引用目标-${suffix}`);

  // 需求详情描述编辑器
  await page.goto(`/requirements/${main.id}`);
  await expect(page.getByRole("tab", { name: "需求详情" })).toBeVisible();
  const detailEditor = page.locator(".inline-rich").first();
  for (const label of ["文字颜色", "文字高亮", "插入需求引用"]) {
    await expect(
      detailEditor.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }

  // Markdown 文档编辑器
  await page.getByRole("tab", { name: "文档管理", exact: true }).click();
  await page.locator('.doc-card[data-name="需求记忆.md"]').click();
  const docToolbar = page
    .locator(".inline-rich")
    .filter({ has: page.getByLabel("文档内容") })
    .locator(".rich-toolbar");
  for (const label of ["文字颜色", "文字高亮", "插入需求引用"]) {
    await expect(
      docToolbar.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }
  const doc = page.getByLabel("文档内容");
  await doc.fill("彩色文档内容");
  await page.keyboard.press("ControlOrMeta+a");
  await docToolbar
    .getByRole("button", { name: "文字颜色", exact: true })
    .click();
  await page.locator('button[aria-label="文字颜色 #be123c"]:visible').click();
  await page.keyboard.press("ControlOrMeta+a");
  await docToolbar
    .getByRole("button", { name: "文字高亮", exact: true })
    .click();
  const coloredSaved = waitArtifactSave(page);
  await page.locator('button[aria-label="高亮颜色 #fef08a"]:visible').click();
  await coloredSaved;
  await expect(doc.locator('span[style*="color"]')).toHaveCount(1);
  await expect(doc.locator("mark")).toHaveCount(1);
  // 追加需求引用并等待自动保存
  await page.keyboard.press("End");
  await docToolbar.getByRole("button", { name: "插入需求引用" }).click();
  const refDialog = page
    .getByRole("dialog")
    .filter({ hasText: "插入需求引用" });
  await expect(refDialog).toBeVisible();
  const refSaved = waitArtifactSave(page);
  await refDialog
    .locator(".reference-option")
    .filter({ hasText: target.name })
    .click();
  await refSaved;
  await expect(doc.locator("[data-requirement-id]")).toHaveCount(1);
  await expect(page.getByText("已自动保存到本地文件")).toBeVisible();

  const memory = (await (
    await request.get(`/api/requirements/${main.id}/memory`)
  ).json()) as { id: number };
  const memoryContent = (await (
    await request.get(`/api/artifacts/nodes/${memory.id}/content`)
  ).json()) as { content: string };
  expect(memoryContent.content).toContain("color: rgb(190, 18, 60)");
  expect(memoryContent.content).toContain("<mark");
  expect(memoryContent.content).toContain("data-requirement-id");

  // 刷新后样式与引用回显，点击引用跳转到目标需求
  await page.reload();
  await page.getByRole("tab", { name: "文档管理", exact: true }).click();
  await page.locator('.doc-card[data-name="需求记忆.md"]').click();
  const reopened = page.getByLabel("文档内容");
  await expect(reopened).toContainText("彩色文档内容");
  await expect(reopened.locator('span[style*="color"]')).toHaveCount(1);
  await expect(reopened.locator("mark")).toHaveCount(1);
  await expect(reopened.locator("[data-requirement-id]")).toHaveCount(1);
  await reopened.locator("[data-requirement-id]").click();
  await expect(page).toHaveURL(new RegExp(`/requirements/${target.id}$`));

  // 列表描述弹窗复用同一编辑器
  await page.goto("/requirements");
  const row = page
    .getByRole("button", { name: main.name, exact: true })
    .locator("xpath=ancestor::tr");
  await row.locator(".rich-cell").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (const label of ["文字颜色", "文字高亮", "插入需求引用"]) {
    await expect(
      dialog.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }
  await dialog.getByLabel("富文本内容").fill("列表彩色描述");
  await applyColor(page);
  await dialog.getByRole("button", { name: "应用内容", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page
    .locator("tr.editing-row")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const saved = (await (
    await request.get(`/api/requirements?q=${encodeURIComponent(main.name)}`)
  ).json()) as { items: Array<{ descriptionHtml: string }> };
  expect(saved.items[0].descriptionHtml).toContain("color:");

  // 问题记录的两个紧凑编辑器同样具备公共能力
  await page.goto(`/requirements/${main.id}`);
  await page.getByRole("tab", { name: "问题记录", exact: true }).click();
  await page
    .locator(".issue-empty .issue-primary, .issue-rail .issue-primary")
    .first()
    .click();
  const createDialog = page.locator(".el-dialog:visible");
  await createDialog.getByPlaceholder("一句话说清问题").fill("公共能力检查");
  await createDialog.getByRole("button", { name: "创建问题" }).click();
  await expect(
    page.locator(".issue-row").filter({ hasText: "公共能力检查" }),
  ).toBeVisible();
  const issueEditor = page.locator(
    '.inline-rich:has(.rich-document[aria-label="问题描述"])',
  );
  for (const label of ["文字颜色", "文字高亮", "插入需求引用"]) {
    await expect(
      issueEditor.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }

  expect(errors).toEqual([]);
});
