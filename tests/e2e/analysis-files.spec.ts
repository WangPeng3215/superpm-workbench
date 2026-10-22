import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { ArtifactNode, Requirement } from "@superpm/shared";

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// 文档管理卡片：按 data-name 精确定位（卡片主体点击 = 打开策略）
function docCard(page: Page, name: string) {
  return page.locator(`.doc-card[data-name="${name}"]`);
}

// 顶层文档页签（动态、可关闭）：按页签文本定位
function docTab(page: Page, name: string) {
  return page.getByRole("tab", { name, exact: true });
}

// 悬停卡片后点开「更多」下拉，再点击指定菜单命令（弹层挂在 body 下）
async function runCardCommand(page: Page, name: string, command: string) {
  const card = docCard(page, name);
  await card.hover();
  await card.locator(".doc-more-btn").click();
  await page
    .locator(".el-dropdown-menu__item:visible")
    .getByText(command, { exact: true })
    .click();
}

// 回到「文档管理」页签操作文件卡片（文档页签激活时卡片面板不可见）
async function gotoDocManager(page: Page) {
  await docTab(page, "文档管理").click();
  await expect(page.locator(".doc-manager")).toBeVisible();
}

// 当前激活页签内的编辑器与状态条（页签惰性求值，随激活页签自动跟随）
function activeEditor(page: Page) {
  return page.locator(".el-tab-pane:visible .md-panel .rich-document");
}
function activeFooter(page: Page) {
  return page.locator(".el-tab-pane:visible .md-footer");
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

// 通过 API 建需求（记忆即时初始化）并放置两个知识库文件，随后打开「文档管理」页签
// 并点击记忆卡片以新页签打开编辑器（记忆文件不再自动展示）
async function createDocFixture(page: Page, request: APIRequestContext) {
  const created = await request.post("/api/requirements", {
    data: { name: `文档回显-${Date.now()}`, proposedAt: "2026-10-14" },
  });
  expect(created.ok()).toBeTruthy();
  const requirement = (await created.json()) as Requirement;
  const artifactsBase = `/api/requirements/${requirement.id}/artifacts`;
  const memory = (await (
    await request.get(`/api/requirements/${requirement.id}/memory`)
  ).json()) as ArtifactNode;
  const markdownFile = (await (
    await request.post(`${artifactsBase}/files`, {
      data: {
        parentId: null,
        name: "补充方案.MD",
        initialContent:
          "# 文件内的分析方案\n\n这是 **补充内容**。\n\n- 第一项\n",
      },
    })
  ).json()) as ArtifactNode;
  const textFile = (await (
    await request.post(`${artifactsBase}/files`, {
      data: {
        parentId: null,
        name: "附件.txt",
        initialContent: "普通附件，不进入 Markdown 编辑器",
      },
    })
  ).json()) as ArtifactNode;
  await page.goto(`/requirements/${requirement.id}`);
  await docTab(page, "文档管理").click();
  await expect(page.locator(".doc-manager")).toBeVisible();
  await docCard(page, "需求记忆.md").click();
  // 记忆页签出现并激活，编辑器回显记忆内容
  const memoryTab = docTab(page, "需求记忆.md");
  await expect(memoryTab).toHaveClass(/is-active/);
  const editor = activeEditor(page);
  await expect(editor).toContainText("需求记忆");
  return {
    requirement,
    artifactsBase,
    memory,
    markdownFile,
    textFile,
    editor,
  };
}

test("opens Markdown files from disk without changing their contents", async ({
  page,
  request,
}) => {
  const { markdownFile, textFile, editor } = await createDocFixture(
    page,
    request,
  );
  const writes: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() === "PUT" && outgoing.url().endsWith("/content")) {
      writes.push(outgoing.url());
    }
  });
  // 卡片网格点开 Markdown → 新页签编辑器回显磁盘内容
  await gotoDocManager(page);
  await expect(docCard(page, markdownFile.name)).toBeVisible();
  await docCard(page, markdownFile.name).click();
  await expect(editor.locator("h1")).toHaveText("文件内的分析方案");
  await expect(editor.locator("strong")).toHaveText("补充内容");
  // 非 Markdown 附件（未知格式）：新窗口打开 raw 地址下载，绝不进入编辑器
  const popupPromise = page.waitForEvent("popup");
  await gotoDocManager(page);
  await docCard(page, textFile.name).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/raw$/);
  await popup.close();
  // 补充方案页签保持已保存状态，且全程没有触发 PUT 保存
  await docTab(page, markdownFile.name).click();
  await expect(activeFooter(page)).toContainText("已自动保存");
  expect(writes).toEqual([]);
  const stored = await (
    await request.get(`/api/artifacts/nodes/${markdownFile.id}/content`)
  ).json();
  expect(stored.content).toContain("# 文件内的分析方案");
  expect(stored.content).toContain("**补充内容**");
});

test("flushes pending edits to the open tab before switching files", async ({
  page,
  request,
}) => {
  const { memory, markdownFile, editor } = await createDocFixture(
    page,
    request,
  );
  const memoryContent = await (
    await request.get(`/api/artifacts/nodes/${memory.id}/content`)
  ).json();
  // 打开补充方案页签并编辑
  await gotoDocManager(page);
  await docCard(page, markdownFile.name).click();
  await expect(editor).toContainText("文件内的分析方案");
  await editor.fill("属于补充方案的最新修改");
  // 切换到记忆页签：切换前先冲刷补充方案的未保存修改
  await gotoDocManager(page);
  await docCard(page, "需求记忆.md").click();
  await expect(editor).toContainText("需求记忆");
  const markdownSaved = await (
    await request.get(`/api/artifacts/nodes/${markdownFile.id}/content`)
  ).json();
  const memorySaved = await (
    await request.get(`/api/artifacts/nodes/${memory.id}/content`)
  ).json();
  expect(markdownSaved.content).toContain("属于补充方案的最新修改");
  expect(memorySaved.content).toBe(memoryContent.content);
  // 补充方案页签内容保留已保存的草稿
  await gotoDocManager(page);
  await docCard(page, markdownFile.name).click();
  await expect(editor).toContainText("属于补充方案的最新修改");
});

test("waits for an in-flight autosave and persists subsequent edits", async ({
  page,
  request,
}) => {
  const { memory, markdownFile, editor } = await createDocFixture(
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
  await page.route(
    `**/api/artifacts/nodes/${memory.id}/content`,
    async (route) => {
      if (route.request().method() === "PUT" && ++saveCount === 1) {
        startedSave();
        await saveReleased;
      }
      await route.continue();
    },
  );
  const nextFileReads: string[] = [];
  page.on("request", (outgoing) => {
    if (
      outgoing.method() === "GET" &&
      outgoing.url().endsWith(`/api/artifacts/nodes/${markdownFile.id}/content`)
    ) {
      nextFileReads.push(outgoing.url());
    }
  });
  await editor.fill("第一次修改");
  await saveStarted;
  await editor.fill("等待保存期间的最后修改");
  // 打开新文件页签：在途保存完成前不会读取新文件
  await gotoDocManager(page);
  await docCard(page, markdownFile.name).click();
  expect(nextFileReads).toEqual([]);
  releaseSave();
  await expect(editor).toContainText("文件内的分析方案");
  const saved = await (
    await request.get(`/api/artifacts/nodes/${memory.id}/content`)
  ).json();
  expect(saved.content).toContain("等待保存期间的最后修改");
  expect(saveCount).toBe(2);
});

test("keeps unsaved content when saving fails and allows retry", async ({
  page,
  request,
}) => {
  const { memory, markdownFile, editor } = await createDocFixture(
    page,
    request,
  );
  const contentUrl = `**/api/artifacts/nodes/${memory.id}/content`;
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
  // 底部出现失败提示与「重试保存」按钮，编辑器保留草稿内容
  await expect(activeFooter(page)).toContainText("保存失败，请重试");
  await expect(
    page.getByRole("button", { name: "重试保存", exact: true }),
  ).toBeVisible();
  await expect(editor).toHaveText("保存失败也不能丢失的草稿");
  // 冲刷失败中止打开新页签：补充方案页签未出现
  await gotoDocManager(page);
  await docCard(page, markdownFile.name).click();
  await expect(docTab(page, markdownFile.name)).toHaveCount(0);
  await page.unroute(contentUrl);
  // 回到记忆页签，点击「重试保存」补交失败的那次保存
  await docTab(page, "需求记忆.md").click();
  await expect(editor).toHaveText("保存失败也不能丢失的草稿");
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(activeFooter(page)).toContainText("已自动保存");
  await gotoDocManager(page);
  await docCard(page, markdownFile.name).click();
  await expect(editor).toContainText("文件内的分析方案");
  const saved = await (
    await request.get(`/api/artifacts/nodes/${memory.id}/content`)
  ).json();
  expect(saved.content).toContain("保存失败也不能丢失的草稿");
});

test("shows the failed tab as error and keeps other tabs untouched", async ({
  page,
  request,
}) => {
  const { markdownFile, editor } = await createDocFixture(page, request);
  const contentUrl = `**/api/artifacts/nodes/${markdownFile.id}/content`;
  await page.route(contentUrl, (route) =>
    route.fulfill({
      status: 404,
      json: { error: { message: "文件内容不存在" } },
    }),
  );
  await gotoDocManager(page);
  await docCard(page, markdownFile.name).click();
  // 新页签打开但展示错误信息，记忆页签内容不受影响
  await expect(docTab(page, markdownFile.name)).toBeVisible();
  await expect(page.locator(".el-message__content")).toContainText(
    "文件内容不存在",
  );
  await expect(page.locator(".el-tab-pane:visible")).toContainText(
    "文件内容不存在",
  );
  await docTab(page, "需求记忆.md").click();
  await expect(editor).toContainText("需求记忆");
  await page.unroute(contentUrl);
  // 关闭失败页签后重新打开：读取成功
  await docTab(page, markdownFile.name).locator(".is-icon-close").click();
  await expect(docTab(page, markdownFile.name)).toHaveCount(0);
  await gotoDocManager(page);
  await docCard(page, markdownFile.name).click();
  await expect(editor).toContainText("文件内的分析方案");
});

test("keeps doc tabs open with their drafts when switching stages", async ({
  page,
  request,
}) => {
  const { memory, editor } = await createDocFixture(page, request);
  const started = createGate();
  const responseGate = createGate();
  let firstSave = true;
  await page.route(
    `**/api/artifacts/nodes/${memory.id}/content`,
    async (route) => {
      if (route.request().method() === "PUT" && firstSave) {
        firstSave = false;
        const response = await route.fetch();
        started.release();
        await responseGate.promise;
        await route.fulfill({ response });
      } else {
        await route.continue();
      }
    },
  );
  try {
    await editor.fill("已落盘但响应尚未返回");
    await started.promise;
    await editor.fill("离开前的最后一版草稿");
    // 切到 UI 设计阶段（详情表单保存当前阶段）：文档页签保持打开，问题页签展示问题台账
    await switchStage(page, "UI 设计");
    await docTab(page, "问题记录").click();
    await expect(page.locator(".issue-app, .issue-empty")).toBeVisible();
    await expect(docTab(page, "需求记忆.md")).toBeVisible();
    responseGate.release();
    // 切回记忆页签：草稿不丢且最终修改已随自动保存落盘
    await docTab(page, "需求记忆.md").click();
    await expect(editor).toHaveText("离开前的最后一版草稿");
    const saved = await (
      await request.get(`/api/artifacts/nodes/${memory.id}/content`)
    ).json();
    expect(saved.content).toContain("离开前的最后一版草稿");
  } finally {
    responseGate.release();
  }
});

test("blocks navigation when doc content cannot be saved", async ({
  page,
  request,
}) => {
  const { memory, editor } = await createDocFixture(page, request);
  const contentUrl = `**/api/artifacts/nodes/${memory.id}/content`;
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
  await page.getByRole("link", { name: "需求列表" }).click();
  await expect(page.getByText("离开前保存失败", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/requirements\/\d+$/);
  await expect(editor).toHaveText("导航失败后应保留的草稿");
  await page.unroute(contentUrl);
  await page.getByRole("link", { name: "需求列表" }).click();
  await expect(page).toHaveURL(/\/requirements$/);
});

test("preserves an image upload that completes while opening another file", async ({
  page,
  request,
}) => {
  const { requirement, memory, markdownFile, editor } = await createDocFixture(
    page,
    request,
  );
  const imageStarted = createGate();
  const imageGate = createGate();
  const readGate = createGate();
  await page.route(
    `**/api/requirements/${requirement.id}/artifacts/images`,
    async (route) => {
      const response = await route.fetch();
      imageStarted.release();
      await imageGate.promise;
      await route.fulfill({ response });
    },
  );
  await page.route(
    `**/api/artifacts/nodes/${markdownFile.id}/content`,
    async (route) => {
      await readGate.promise;
      await route.continue();
    },
  );
  try {
    // 记忆页签编辑器工具栏的隐藏图片上传入口仍在 .md-panel 内
    await page.locator(".md-panel input[type=file]").setInputFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ahtkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await imageStarted.promise;
    // 打开另一文档页签：冲刷等待图片上传完成并落盘
    await gotoDocManager(page);
    await docCard(page, markdownFile.name).click();
    imageGate.release();
    readGate.release();
    // 切回记忆页签：上传的图片保留在编辑器内
    await docTab(page, "需求记忆.md").click();
    await expect(editor.locator("img")).toHaveCount(1);
    const saved = await (
      await request.get(`/api/artifacts/nodes/${memory.id}/content`)
    ).json();
    // 正文以 Markdown 落盘：图片为 ![alt](相对路径) 形式
    expect(saved.content).toContain("![pixel.png](");
    expect(saved.content).toContain("images/pixel");
    // 补充方案页签正常加载
    await gotoDocManager(page);
    await docCard(page, markdownFile.name).click();
    await expect(editor).toContainText("文件内的分析方案");
  } finally {
    imageGate.release();
    readGate.release();
  }
});

test("round-trips a markdown table through the rich editor", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/requirements", {
    data: { name: `表格回显-${Date.now()}`, proposedAt: "2026-10-14" },
  });
  expect(created.ok()).toBeTruthy();
  const requirement = (await created.json()) as Requirement;
  const tableMarkdown =
    "# 字段说明\n\n| 字段 | 类型 |\n| --- | --- |\n| id | number |\n";
  const file = (await (
    await request.post(`/api/requirements/${requirement.id}/artifacts/files`, {
      data: {
        parentId: null,
        name: "字段表.md",
        initialContent: tableMarkdown,
      },
    })
  ).json()) as ArtifactNode;
  await page.goto(`/requirements/${requirement.id}`);
  await docTab(page, "文档管理").click();
  await docCard(page, "字段表.md").click();
  const editor = activeEditor(page);
  // Markdown 表格读入后成为可编辑表格，表头与单元格内容都在编辑器内
  await expect(editor.locator("table")).toHaveCount(1);
  await expect(editor.locator("th").first()).toHaveText("字段");
  await expect(editor.locator("td").first()).toHaveText("id");
  // 编辑正文触发保存：表格仍以 Markdown 表格语法写回，不被降级为 HTML
  await editor.locator("h1").click();
  await page.keyboard.press("End");
  await page.keyboard.type("补充");
  await expect(activeFooter(page)).toContainText("已自动保存", {
    timeout: 15000,
  });
  const saved = await (
    await request.get(`/api/artifacts/nodes/${file.id}/content`)
  ).json();
  expect(saved.content).toContain("| 字段 | 类型 |");
  expect(saved.content).toContain("| --- | --- |");
  expect(saved.content).toContain("| id | number |");
  expect(saved.content).not.toContain("<table");
  expect(saved.content).not.toContain("<colgroup");
});

test("keeps renamed Markdown selectable and closes its tab after deletion", async ({
  page,
  request,
}) => {
  const { markdownFile, editor } = await createDocFixture(page, request);
  await gotoDocManager(page);
  await docCard(page, markdownFile.name).click();
  await expect(editor).toContainText("文件内的分析方案");
  // 通过卡片「更多」菜单重命名（弹窗确认按钮为「保存」）
  await gotoDocManager(page);
  await runCardCommand(page, markdownFile.name, "重命名");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("无扩展名的补充方案");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  const renamedCard = docCard(page, "无扩展名的补充方案");
  await expect(renamedCard).toBeVisible();
  // 重命名不改动已打开页签中的内容（页签名沿用打开时的文件名）
  await docTab(page, markdownFile.name).click();
  await expect(editor).toContainText("文件内的分析方案");
  // 删除该文档：对应页签自动关闭，切回记忆页签内容完好
  await gotoDocManager(page);
  await runCardCommand(page, "无扩展名的补充方案", "删除");
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await expect(renamedCard).toHaveCount(0);
  await expect(docTab(page, markdownFile.name)).toHaveCount(0);
  await docTab(page, "需求记忆.md").click();
  await expect(editor).toContainText("需求记忆");
});
