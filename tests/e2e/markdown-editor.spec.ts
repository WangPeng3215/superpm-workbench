import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { RequirementFile, RequirementFileList } from "@superpm/shared";

const documentSource = [
  "---",
  "title: 原生 Markdown 验收",
  "tags: [需求, 接口]",
  "---",
  "",
  "# 接口需求",
  "",
  "| 参数 | 类型 | 必填 |",
  "| --- | --- | --- |",
  "| event_id | string | 是 |",
  "",
  "- [x] 保留已完成事项",
  "- [ ] 保留待办事项",
  "",
  "```json",
  '{ "enabled": true }',
  "```",
  "",
  "<!-- 保留原始注释 -->",
  "",
  "正文包含 **粗体**、~~删除线~~ 和 `行内代码`。",
  "",
].join("\n");

async function createAnalysis(request: APIRequestContext) {
  const response = await request.post("/api/requirements", {
    data: { name: `原生 Markdown-${Date.now()}`, proposedAt: "2026-10-14" },
  });
  expect(response.ok()).toBeTruthy();
  const requirement = await response.json();
  const baseUrl = `/api/requirements/${requirement.id}/files`;
  const listing = await request.get(`${baseUrl}?phase=analysis&all=true`);
  const files = (await listing.json()) as RequirementFileList;
  return { requirement, baseUrl, defaultFile: files.editorFile! };
}

async function openAnalysis(page: Page, requirementId: number) {
  await page.goto(`/requirements/${requirementId}`);
  await page.getByRole("tab", { name: "需求进展", exact: true }).click();
  await expect(page.locator(".md-panel .current-file")).toContainText(
    "分析记录",
  );
}

async function uploadFile(
  request: APIRequestContext,
  baseUrl: string,
  content: string,
) {
  const uploaded = await request.post(baseUrl, {
    data: {
      phase: "analysis",
      category: "record",
      name: "接口方案.md",
      mime: "text/markdown",
      data: Buffer.from(content).toString("base64"),
      isFinal: true,
    },
  });
  expect(uploaded.ok()).toBeTruthy();
  return (await uploaded.json()) as RequirementFile;
}

test("uploads a Markdown draft through the page and immediately opens it", async ({
  page,
  request,
}) => {
  const { requirement, baseUrl } = await createAnalysis(request);
  await openAnalysis(page, requirement.id);
  await page.locator(".files-panel input[type=file]").setInputFiles({
    name: "刚上传的接口需求.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(documentSource),
  });
  const fileButton = page.getByRole("button", {
    name: "刚上传的接口需求.md",
    exact: true,
  });
  await expect(fileButton).toBeVisible();
  await expect(fileButton).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("textbox", { name: "Markdown 源码", exact: true }),
  ).toContainText("# 接口需求");
  await expect(page.locator(".markdown-preview table")).toContainText(
    "event_id",
  );
  const listing = (await (
    await request.get(`${baseUrl}?phase=analysis&all=true`)
  ).json()) as RequirementFileList;
  const file = listing.groups
    .flatMap((group) => group.files)
    .find((item) => item.name === "刚上传的接口需求.md")!;
  expect(file.isFinal).toBe(false);
  const stored = await (
    await request.get(`${baseUrl}/${file.id}/content`)
  ).json();
  expect(stored.content).toBe(documentSource);
});

test("opens Markdown by clicking its file information area", async ({
  page,
  request,
}) => {
  const { requirement, baseUrl } = await createAnalysis(request);
  const file = await uploadFile(request, baseUrl, documentSource);
  await openAnalysis(page, requirement.id);
  await page
    .locator(".file-row")
    .filter({ hasText: file.name })
    .getByText(/更新于/)
    .click();
  await expect(page.locator(".md-panel .current-file")).toContainText(
    file.name,
  );
  await expect(
    page.getByRole("textbox", { name: "Markdown 源码", exact: true }),
  ).toContainText("<!-- 保留原始注释 -->");
});

test("saves Markdown source without converting tables tasks or front matter to HTML", async ({
  page,
  request,
}) => {
  const { requirement, baseUrl, defaultFile } = await createAnalysis(request);
  await openAnalysis(page, requirement.id);
  const editor = page.getByRole("textbox", {
    name: "Markdown 源码",
    exact: true,
  });
  await editor.fill(documentSource);
  await expect
    .poll(async () => {
      const stored = await (
        await request.get(`${baseUrl}/${defaultFile.id}/content`)
      ).json();
      return stored.content;
    })
    .toBe(documentSource);
  await page.reload();
  await page.getByRole("tab", { name: "需求进展", exact: true }).click();
  await expect(editor).toContainText("tags: [需求, 接口]");
  await expect(editor).toContainText("- [x] 保留已完成事项");
  await expect(page.locator(".markdown-preview table")).toContainText(
    "event_id",
  );
  await expect(page.locator(".markdown-preview pre code")).toContainText(
    '"enabled": true',
  );
  await expect(page.locator(".markdown-preview del")).toHaveText("删除线");
});

test("supports Markdown formatting shortcuts undo redo and preview modes", async ({
  page,
  request,
}) => {
  const { requirement } = await createAnalysis(request);
  await openAnalysis(page, requirement.id);
  const editor = page.getByRole("textbox", {
    name: "Markdown 源码",
    exact: true,
  });
  await editor.fill("重点内容");
  await editor.press("Control+a");
  await editor.press("Control+b");
  await expect(editor).toHaveText("**重点内容**");
  await expect(page.locator(".markdown-preview strong")).toHaveText("重点内容");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(editor).toHaveText("重点内容");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(editor).toHaveText("**重点内容**");
  await page.getByRole("button", { name: "仅预览", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.locator(".markdown-preview")).toBeVisible();
  await page.getByRole("button", { name: "仅源码", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(page.locator(".markdown-preview")).not.toBeVisible();
});

test("sanitizes preview HTML without mutating the Markdown source", async ({
  page,
  request,
}) => {
  const { requirement, baseUrl, defaultFile } = await createAnalysis(request);
  await openAnalysis(page, requirement.id);
  const source =
    '# 安全预览\n\n<script>alert("blocked")</script>\n<img src="invalid-image" onerror="alert(1)">';
  const editor = page.getByRole("textbox", {
    name: "Markdown 源码",
    exact: true,
  });
  await editor.fill(source);
  const preview = page.locator(".markdown-preview");
  await expect(preview.locator("script")).toHaveCount(0);
  await expect(preview.locator("img")).not.toHaveAttribute("onerror");
  await expect
    .poll(async () => {
      const stored = await (
        await request.get(`${baseUrl}/${defaultFile.id}/content`)
      ).json();
      return stored.content;
    })
    .toBe(source);
});

test("opens historical HTML as source without silently rewriting it", async ({
  page,
  request,
}) => {
  const { requirement, baseUrl } = await createAnalysis(request);
  const content = "<h2>历史记录</h2><p>保留 <strong>原文</strong>。</p>";
  const file = await uploadFile(request, baseUrl, content);
  await openAnalysis(page, requirement.id);
  await page.getByRole("button", { name: file.name, exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 源码", exact: true }),
  ).toHaveText(content);
  await expect(page.locator(".markdown-preview h2")).toHaveText("历史记录");
  await page.waitForTimeout(1000);
  const stored = await (
    await request.get(`${baseUrl}/${file.id}/content`)
  ).json();
  expect(stored.content).toBe(content);
});
