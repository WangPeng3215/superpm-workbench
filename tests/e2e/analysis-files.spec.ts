import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { RequirementFile, RequirementFileList } from "@superpm/shared";

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function createAnalysis(page: Page, request: APIRequestContext) {
  const created = await request.post("/api/requirements", {
    data: { name: `文件回显-${Date.now()}`, proposedAt: "2026-10-14" },
  });
  expect(created.ok()).toBeTruthy();
  const requirement = await created.json();
  const baseUrl = `/api/requirements/${requirement.id}/files`;
  const listing = await request.get(`${baseUrl}?phase=analysis&all=true`);
  const files = (await listing.json()) as RequirementFileList;
  const defaultFile = files.editorFile!;
  const defaultContent = await (
    await request.get(`${baseUrl}/${defaultFile.id}/content`)
  ).json();
  const uploaded = await request.post(baseUrl, {
    data: {
      phase: "analysis",
      category: "record",
      name: "补充方案.MD",
      mime: "text/markdown",
      data: Buffer.from(
        "# 文件内的分析方案\n\n这是 **补充内容**。\n\n- 第一项\n",
      ).toString("base64"),
      isFinal: true,
    },
  });
  expect(uploaded.ok()).toBeTruthy();
  const markdownFile = (await uploaded.json()) as RequirementFile;
  const textUpload = await request.post(baseUrl, {
    data: {
      phase: "analysis",
      category: "record",
      name: "附件.txt",
      mime: "text/plain",
      data: Buffer.from("普通附件，不进入 Markdown 编辑器").toString("base64"),
      isFinal: true,
    },
  });
  expect(textUpload.ok()).toBeTruthy();
  await page.goto(`/requirements/${requirement.id}`);
  await page.getByRole("tab", { name: "需求进展", exact: true }).click();
  const editor = page.locator(".md-panel .rich-document");
  await expect(editor).toContainText("需求分析记录");
  return {
    baseUrl,
    defaultFile,
    defaultContent: defaultContent.content as string,
    markdownFile,
    editor,
  };
}

test("opens Markdown files from disk without changing their contents", async ({
  page,
  request,
}) => {
  const { baseUrl, markdownFile, editor } = await createAnalysis(page, request);
  const writes: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() === "PUT" && outgoing.url().endsWith("/content")) {
      writes.push(outgoing.url());
    }
  });
  const fileButton = page.getByRole("button", {
    name: markdownFile.name,
    exact: true,
  });
  await expect(fileButton).toBeVisible();
  await fileButton.click();
  await expect(editor.locator("h1")).toHaveText("文件内的分析方案");
  await expect(editor.locator("strong")).toHaveText("补充内容");
  await expect(fileButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".md-panel .current-file")).toContainText(
    markdownFile.name,
  );
  await expect(
    page.getByRole("button", { name: "附件.txt", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".file-row")
      .filter({ hasText: "附件.txt" })
      .getByRole("link", { name: "预览" }),
  ).toHaveAttribute("target", "_blank");
  await page.waitForTimeout(1000);
  expect(writes).toEqual([]);
  const stored = await (
    await request.get(`${baseUrl}/${markdownFile.id}/content`)
  ).json();
  expect(stored.content).toContain("# 文件内的分析方案");
  expect(stored.content).toContain("**补充内容**");
});

test("flushes pending edits to the selected file before switching", async ({
  page,
  request,
}) => {
  const { baseUrl, defaultFile, defaultContent, markdownFile, editor } =
    await createAnalysis(page, request);
  await page
    .getByRole("button", { name: markdownFile.name, exact: true })
    .click();
  await expect(editor).toContainText("文件内的分析方案");
  await editor.fill("属于补充方案的最新修改");
  await page
    .getByRole("button", { name: defaultFile.name, exact: true })
    .click();
  await expect(editor).toContainText("需求分析记录");
  const saved = await (
    await request.get(`${baseUrl}/${markdownFile.id}/content`)
  ).json();
  const original = await (
    await request.get(`${baseUrl}/${defaultFile.id}/content`)
  ).json();
  expect(saved.content).toContain("属于补充方案的最新修改");
  expect(original.content).toBe(defaultContent);
  await editor.press("Control+z");
  await expect(editor).not.toContainText("属于补充方案的最新修改");
  await page
    .getByRole("button", { name: markdownFile.name, exact: true })
    .click();
  await expect(editor).toContainText("属于补充方案的最新修改");
});

test("waits for an in-flight autosave and persists subsequent edits", async ({
  page,
  request,
}) => {
  const { baseUrl, defaultFile, markdownFile, editor } = await createAnalysis(
    page,
    request,
  );
  let releaseSave!: () => void;
  let startedSave!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    startedSave = resolve;
  });
  const saveReleased = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let saveCount = 0;
  await page.route(`**${baseUrl}/${defaultFile.id}/content`, async (route) => {
    if (route.request().method() === "PUT" && ++saveCount === 1) {
      startedSave();
      await saveReleased;
    }
    await route.continue();
  });
  const nextFileReads: string[] = [];
  page.on("request", (outgoing) => {
    if (
      outgoing.method() === "GET" &&
      outgoing.url().endsWith(`${baseUrl}/${markdownFile.id}/content`)
    ) {
      nextFileReads.push(outgoing.url());
    }
  });
  await editor.fill("第一次修改");
  await saveStarted;
  await editor.fill("等待保存期间的最后修改");
  await page
    .getByRole("button", { name: markdownFile.name, exact: true })
    .click();
  await expect(page.locator(".md-panel")).toHaveAttribute("inert", "");
  expect(nextFileReads).toEqual([]);
  releaseSave();
  await expect(editor).toContainText("文件内的分析方案");
  const saved = await (
    await request.get(`${baseUrl}/${defaultFile.id}/content`)
  ).json();
  expect(saved.content).toContain("等待保存期间的最后修改");
  expect(saveCount).toBe(2);
});

test("keeps unsaved content when saving fails and allows retry", async ({
  page,
  request,
}) => {
  const { baseUrl, defaultFile, markdownFile, editor } = await createAnalysis(
    page,
    request,
  );
  const contentUrl = `**${baseUrl}/${defaultFile.id}/content`;
  await page.route(contentUrl, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 500,
        json: { error: { message: "模拟保存失败" } },
      });
    } else {
      await route.continue();
    }
  });
  await editor.fill("保存失败也不能丢失的草稿");
  await page
    .getByRole("button", { name: markdownFile.name, exact: true })
    .click();
  await expect(
    page.getByText("保存失败，请重试", { exact: false }),
  ).toBeVisible();
  await expect(editor).toHaveText("保存失败也不能丢失的草稿");
  await expect(
    page.getByRole("button", { name: defaultFile.name, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.unroute(contentUrl);
  await page
    .getByRole("button", { name: markdownFile.name, exact: true })
    .click();
  await expect(editor).toContainText("文件内的分析方案");
  const saved = await (
    await request.get(`${baseUrl}/${defaultFile.id}/content`)
  ).json();
  expect(saved.content).toContain("保存失败也不能丢失的草稿");
});

test("retains the current file when reading another file fails", async ({
  page,
  request,
}) => {
  const { baseUrl, defaultFile, markdownFile, editor } = await createAnalysis(
    page,
    request,
  );
  const contentUrl = `**${baseUrl}/${markdownFile.id}/content`;
  await page.route(contentUrl, (route) =>
    route.fulfill({
      status: 404,
      json: { error: { message: "文件内容不存在" } },
    }),
  );
  await page
    .getByRole("button", { name: markdownFile.name, exact: true })
    .click();
  await expect(page.getByText("文件内容不存在", { exact: true })).toBeVisible();
  await expect(editor).toContainText("需求分析记录");
  await expect(
    page.getByRole("button", { name: defaultFile.name, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.unroute(contentUrl);
  await page
    .getByRole("button", { name: markdownFile.name, exact: true })
    .click();
  await expect(editor).toContainText("文件内的分析方案");
});

test("opens Markdown across categories and retains the active draft when filtering", async ({
  page,
  request,
}) => {
  const { baseUrl, editor } = await createAnalysis(page, request);
  const uploaded = await request.post(baseUrl, {
    data: {
      phase: "analysis",
      category: "prd",
      name: "需求说明.markdown",
      mime: "text/markdown",
      data: Buffer.from("# PRD 文件内容\n\n跨分类回显").toString("base64"),
      isFinal: true,
    },
  });
  expect(uploaded.ok()).toBeTruthy();
  const file = (await uploaded.json()) as RequirementFile;
  await page.reload();
  await page.getByRole("tab", { name: "需求进展", exact: true }).click();
  await page.getByRole("tab", { name: /^PRD/ }).click();
  await page.getByRole("button", { name: file.name, exact: true }).click();
  await expect(editor).toContainText("PRD 文件内容");
  await page
    .locator(".file-row")
    .filter({ hasText: file.name })
    .getByRole("button", { name: "取消确认", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: file.name, exact: true }),
  ).toHaveCount(0);
  await editor.fill("筛选隐藏文件后仍保存到原来的 PRD 文件");
  await expect
    .poll(async () => {
      const saved = await (
        await request.get(`${baseUrl}/${file.id}/content`)
      ).json();
      return saved.content;
    })
    .toContain("筛选隐藏文件后仍保存到原来的 PRD 文件");
  await page.locator(".files-panel .el-switch").click();
  await expect(page.locator(".files-panel").getByRole("switch")).toBeChecked();
  await expect(
    page.getByRole("button", { name: file.name, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toHaveText("筛选隐藏文件后仍保存到原来的 PRD 文件");
});

test("waits for the final autosave before leaving the analysis stage", async ({
  page,
  request,
}) => {
  const { baseUrl, defaultFile, editor } = await createAnalysis(page, request);
  const started = createGate();
  const responseGate = createGate();
  let firstSave = true;
  await page.route(`**${baseUrl}/${defaultFile.id}/content`, async (route) => {
    if (route.request().method() === "PUT" && firstSave) {
      firstSave = false;
      const response = await route.fetch();
      started.release();
      await responseGate.promise;
      await route.fulfill({ response });
    } else {
      await route.continue();
    }
  });
  try {
    await editor.fill("已落盘但响应尚未返回");
    await started.promise;
    await editor.fill("离开前的最后一版草稿");
    await page
      .locator(".stage-timeline .stage-name")
      .filter({ hasText: "UI 设计" })
      .click();
    await expect(editor).toBeVisible();
    await expect(page.locator(".stage-placeholder")).toHaveCount(0);
    responseGate.release();
    await expect(page.locator(".stage-placeholder")).toBeVisible();
    await page
      .locator(".stage-timeline .stage-name")
      .filter({ hasText: "需求分析" })
      .click();
    await expect(editor).toHaveText("离开前的最后一版草稿");
  } finally {
    responseGate.release();
  }
});

test("blocks navigation when analysis content cannot be saved", async ({
  page,
  request,
}) => {
  const { baseUrl, defaultFile, editor } = await createAnalysis(page, request);
  const contentUrl = `**${baseUrl}/${defaultFile.id}/content`;
  await page.route(contentUrl, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 500,
        json: { error: { message: "离开前保存失败" } },
      });
    } else {
      await route.continue();
    }
  });
  await editor.fill("导航失败后应保留的草稿");
  await page.getByRole("button", { name: "返回需求列表", exact: true }).click();
  await expect(page.getByText("离开前保存失败", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/requirements\/\d+$/);
  await expect(editor).toHaveText("导航失败后应保留的草稿");
  await page.unroute(contentUrl);
  await page.getByRole("button", { name: "返回需求列表", exact: true }).click();
  await expect(page).toHaveURL(/\/requirements$/);
});

test("preserves an image upload that completes while opening another file", async ({
  page,
  request,
}) => {
  const { baseUrl, defaultFile, markdownFile, editor } = await createAnalysis(
    page,
    request,
  );
  const imageStarted = createGate();
  const imageGate = createGate();
  const readGate = createGate();
  await page.route(
    `**${baseUrl.replace(/\/files$/, "")}/images`,
    async (route) => {
      const response = await route.fetch();
      imageStarted.release();
      await imageGate.promise;
      await route.fulfill({ response });
    },
  );
  await page.route(`**${baseUrl}/${markdownFile.id}/content`, async (route) => {
    await readGate.promise;
    await route.continue();
  });
  try {
    await page.locator(".md-panel input[type=file]").setInputFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ahtkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await imageStarted.promise;
    await page
      .getByRole("button", { name: markdownFile.name, exact: true })
      .click();
    imageGate.release();
    await expect(editor.locator("img")).toHaveCount(1);
    readGate.release();
    await expect(editor).toContainText("文件内的分析方案");
    const saved = await (
      await request.get(`${baseUrl}/${defaultFile.id}/content`)
    ).json();
    expect(saved.content).toContain("<img");
    expect(saved.content).toContain('alt="pixel.png"');
  } finally {
    imageGate.release();
    readGate.release();
  }
});

test("recovers the default editor after deletion and a failed list refresh", async ({
  page,
  request,
}) => {
  const { baseUrl, defaultFile, editor } = await createAnalysis(page, request);
  await page.route(
    `**${baseUrl}?phase=analysis&all=*`,
    (route) =>
      route.fulfill({
        status: 500,
        json: { error: { message: "删除后的列表暂不可用" } },
      }),
    { times: 1 },
  );
  await page
    .locator(".file-row")
    .filter({ hasText: defaultFile.name })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await expect(
    page.getByText("删除后的列表暂不可用", { exact: true }),
  ).toBeVisible();
  await page.locator(".files-panel .el-switch").click();
  await expect(editor).toContainText("需求分析记录");
  await expect(
    page.getByRole("button", { name: defaultFile.name, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("keeps renamed Markdown selectable and returns to the default after deletion", async ({
  page,
  request,
}) => {
  const { defaultFile, markdownFile, editor } = await createAnalysis(
    page,
    request,
  );
  await page
    .getByRole("button", { name: markdownFile.name, exact: true })
    .click();
  await expect(editor).toContainText("文件内的分析方案");
  const fileRow = page
    .locator(".file-row")
    .filter({ hasText: markdownFile.name });
  await fileRow.getByRole("button", { name: "重命名", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("无扩展名的补充方案");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".md-panel .current-file")).toContainText(
    "无扩展名的补充方案",
  );
  await page
    .getByRole("button", { name: defaultFile.name, exact: true })
    .click();
  await expect(editor).toContainText("需求分析记录");
  await page
    .getByRole("button", { name: "无扩展名的补充方案", exact: true })
    .click();
  await expect(editor).toContainText("文件内的分析方案");
  await page
    .locator(".file-row")
    .filter({ hasText: "无扩展名的补充方案" })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(editor).toContainText("需求分析记录");
  await expect(
    page.getByRole("button", { name: "无扩展名的补充方案", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: defaultFile.name, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
