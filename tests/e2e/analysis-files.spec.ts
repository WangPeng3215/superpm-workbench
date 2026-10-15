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

// 右栏产物区条目：按条目文本过滤 .asset-item
function assetItem(page: Page, name: string) {
  return page.locator(".asset-item").filter({ hasText: name });
}

// 悬停条目后点开「更多」下拉（图标默认 visibility:hidden，需先悬停条目），再点击指定菜单命令
async function runAssetCommand(page: Page, name: string, command: string) {
  const item = assetItem(page, name);
  await item.hover();
  await item.locator(".asset-more-icon").click();
  // 各条目下拉的弹层都挂在 body 下，同一时刻只有当前打开的可见
  await page
    .locator(".el-dropdown-menu__item:visible")
    .getByText(command, { exact: true })
    .click();
}

// 一级分类卡片：按分类中文名定位
function categoryCard(page: Page, label: string) {
  return page.locator(".category-card").filter({ hasText: label });
}

// 进入某分类的二级「全部文件」视图：点卡片上的「查看所有文件」按钮，
// 绕过打开策略（0 文件空态 / 单文件直开 / 唯一定稿直开），对任意文件数都稳定
async function openCategoryAssets(page: Page, label: string) {
  await categoryCard(page, label)
    .getByRole("button", { name: "查看所有文件" })
    .click();
  await expect(page.locator(".assets-title")).toHaveText(label);
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
  // 产物区为两态视图：先进「分析记录」分类的全部文件列表
  await openCategoryAssets(page, "分析记录");
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
  // 附件.txt 在右栏产物区展示为定稿条目，点击后走 raw 新窗口而不是编辑器
  await expect(assetItem(page, "附件.txt").locator(".asset-state")).toHaveText(
    "定稿",
  );
  await fileButton.click();
  await expect(editor.locator("h1")).toHaveText("文件内的分析方案");
  await expect(editor.locator("strong")).toHaveText("补充内容");
  // 非 Markdown 附件：新窗口打开 raw 地址
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "附件.txt", exact: true }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/raw$/);
  await popup.close();
  // 底部回到已保存状态，且全程没有触发 PUT 保存
  await expect(page.locator(".md-footer")).toContainText("已自动保存");
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
  // 进入「分析记录」分类的二级列表后再操作条目
  await openCategoryAssets(page, "分析记录");
  await page
    .getByRole("button", { name: markdownFile.name, exact: true })
    .click();
  await expect(editor).toContainText("文件内的分析方案");
  await editor.fill("属于补充方案的最新修改");
  // 点击右栏「分析记录」条目：切换文档前先冲刷未保存的修改
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
  // 进入「分析记录」分类的二级列表后再切换文档
  await openCategoryAssets(page, "分析记录");
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
  // 左栏同步期间出现加载遮罩，点击右栏条目不会立即读取下一个文件
  await expect(page.locator(".analysis-page .el-loading-mask")).toBeVisible();
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
  // 进入「分析记录」分类的二级列表后再切换文档
  await openCategoryAssets(page, "分析记录");
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
  // 冲刷失败：底部出现失败提示与「重试保存」按钮，编辑器保留草稿内容
  await expect(page.locator(".md-footer")).toContainText("保存失败，请重试");
  await expect(
    page.getByRole("button", { name: "重试保存", exact: true }),
  ).toBeVisible();
  await expect(editor).toHaveText("保存失败也不能丢失的草稿");
  await page.unroute(contentUrl);
  // 点击「重试保存」补交失败的那次保存
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(page.locator(".md-footer")).toContainText("已自动保存");
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
  const { baseUrl, markdownFile, editor } = await createAnalysis(page, request);
  // 进入「分析记录」分类的二级列表后再切换文档
  await openCategoryAssets(page, "分析记录");
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
  // 读取失败后编辑器保持原文件内容
  await expect(editor).toContainText("需求分析记录");
  await page.unroute(contentUrl);
  await page
    .getByRole("button", { name: markdownFile.name, exact: true })
    .click();
  await expect(editor).toContainText("文件内的分析方案");
});

test("opens Markdown across categories and retains the active draft across status switches", async ({
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
  // 右栏进入 PRD 分类列表再打开 Markdown（此刻 PRD 仅 1 个文件，点卡片主体会直开，故走「查看所有文件」）
  await openCategoryAssets(page, "PRD");
  await page.getByRole("button", { name: file.name, exact: true }).click();
  await expect(editor).toContainText("PRD 文件内容");
  // 「恢复草稿」后条目仍在右栏可见（列表恒为全部），状态徽标变为草稿
  await runAssetCommand(page, file.name, "恢复草稿");
  await expect(assetItem(page, file.name).locator(".asset-state")).toHaveText(
    "草稿",
  );
  // 编辑仍保存回原 PRD 文件
  await editor.fill("筛选隐藏文件后仍保存到原来的 PRD 文件");
  await expect
    .poll(async () => {
      const saved = await (
        await request.get(`${baseUrl}/${file.id}/content`)
      ).json();
      return saved.content;
    })
    .toContain("筛选隐藏文件后仍保存到原来的 PRD 文件");
  // 再显式「设为定稿」，编辑器内容不受状态切换影响
  await runAssetCommand(page, file.name, "设为定稿");
  await expect(assetItem(page, file.name).locator(".asset-state")).toHaveText(
    "定稿",
  );
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
    // 编辑器常驻左栏（补充文档 5.1）：冲刷期间出现同步遮罩，编辑器与其中的草稿保持原状，阶段尚未切换
    await expect(page.locator(".analysis-page .el-loading-mask")).toBeVisible();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveText("离开前的最后一版草稿");
    responseGate.release();
    // 最终保存完成后阶段切换才生效（查看阶段偏离当前阶段时出现「设为当前阶段」按钮），编辑器仍常驻且草稿不丢
    await expect(
      page.getByRole("button", { name: "设为当前阶段", exact: true }),
    ).toBeVisible();
    await expect(editor).toHaveText("离开前的最后一版草稿");
    await page
      .locator(".stage-timeline .stage-name")
      .filter({ hasText: "需求分析" })
      .click();
    await expect(editor).toHaveText("离开前的最后一版草稿");
    // 离开阶段前的最后一次修改已随冲刷落盘
    const saved = await (
      await request.get(`${baseUrl}/${defaultFile.id}/content`)
    ).json();
    expect(saved.content).toContain("离开前的最后一版草稿");
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
  // 进入「分析记录」分类的二级列表后再切换文档
  await openCategoryAssets(page, "分析记录");
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
    // 编辑器工具栏的隐藏图片上传入口仍在左栏 .md-panel 内
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
  // 进入「分析记录」分类的二级列表后再通过「更多」菜单删除
  await openCategoryAssets(page, "分析记录");
  // 产物区列表固定一次拉全（phase=all），拦截删除后的刷新请求
  await page.route(
    `**${baseUrl}?phase=all&all=*`,
    (route) =>
      route.fulfill({
        status: 500,
        json: { error: { message: "删除后的列表暂不可用" } },
      }),
    { times: 1 },
  );
  // 从右栏产物条目的「更多」菜单删除默认分析记录（软删除）
  await runAssetCommand(page, defaultFile.name, "删除");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  // 删除后的列表刷新失败，提示错误；常驻列表保留最后一次成功的数据
  await expect(
    page.getByText("删除后的列表暂不可用", { exact: true }),
  ).toBeVisible();
  // 切走再切回查看阶段：编辑器常驻左栏不再随阶段卸载，内容保持原状
  // （删除当前文档后左栏已回退到服务端自动重建的默认分析记录，编辑器内容即其标志）
  await page
    .locator(".stage-timeline .stage-name")
    .filter({ hasText: "UI 设计" })
    .click();
  await expect(editor).toContainText("需求分析记录");
  await page
    .locator(".stage-timeline .stage-name")
    .filter({ hasText: "需求分析" })
    .click();
  // 分类视图与列表常驻、阶段切换不再重置：重新加载页面触发重新拉取，
  // 右栏重新拉取列表成功（服务端已自动重建默认分析记录，状态为定稿）
  await page.reload();
  await page.getByRole("tab", { name: "需求进展", exact: true }).click();
  await expect(editor).toContainText("需求分析记录");
  await openCategoryAssets(page, "分析记录");
  await expect(
    page.getByRole("button", { name: defaultFile.name, exact: true }),
  ).toBeVisible();
  await expect(
    assetItem(page, defaultFile.name).locator(".asset-state"),
  ).toHaveText("定稿");
});

test("keeps renamed Markdown selectable and returns to the default after deletion", async ({
  page,
  request,
}) => {
  const { defaultFile, markdownFile, editor } = await createAnalysis(
    page,
    request,
  );
  // 进入「分析记录」分类的二级列表后再操作条目
  await openCategoryAssets(page, "分析记录");
  await page
    .getByRole("button", { name: markdownFile.name, exact: true })
    .click();
  await expect(editor).toContainText("文件内的分析方案");
  // 通过右栏「更多」菜单重命名（两步弹窗的确认按钮为「确定」）
  await runAssetCommand(page, markdownFile.name, "重命名");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("无扩展名的补充方案");
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  const renamedAsset = page.getByRole("button", {
    name: "无扩展名的补充方案",
    exact: true,
  });
  await expect(renamedAsset).toBeVisible();
  // 重命名不改动编辑器中已打开的内容
  await expect(editor).toContainText("文件内的分析方案");
  await page
    .getByRole("button", { name: defaultFile.name, exact: true })
    .click();
  await expect(editor).toContainText("需求分析记录");
  await renamedAsset.click();
  await expect(editor).toContainText("文件内的分析方案");
  // 软删除：条目从右栏消失，点击默认分析记录回到默认编辑器
  await runAssetCommand(page, "无扩展名的补充方案", "删除");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(renamedAsset).toHaveCount(0);
  await page
    .getByRole("button", { name: defaultFile.name, exact: true })
    .click();
  await expect(editor).toContainText("需求分析记录");
});

// ===== 右栏产物区补充改造回归：打开策略 / 图片页内预览 / 链接域名 / 上传文档打开 =====
test.describe("assets panel open strategy, previews and link hosts", () => {
  // 分类卡片固定七分类常驻右栏（不再随阶段分组），直接复用顶部的
  // categoryCard / openCategoryAssets 辅助函数

  // 通过 API 追加产物数据后，刷新页面并重新进入「需求进展」页签
  async function reopenProgress(page: Page) {
    await page.reload();
    await page.getByRole("tab", { name: "需求进展", exact: true }).click();
    // 等左栏默认分析记录渲染完成，页面就绪
    await expect(page.locator(".md-panel .rich-document")).toContainText(
      "需求分析记录",
    );
  }

  // 通过产物区「上传文件」入口上传本地文件（走真实 file chooser 流程）
  async function uploadAsset(
    page: Page,
    file: { name: string; mimeType: string; buffer: Buffer },
  ) {
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传文件", exact: true }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(file);
  }

  test("applies the category open strategy to single file, single link and multi drafts", async ({
    page,
    request,
  }) => {
    const { baseUrl, editor } = await createAnalysis(page, request);
    // PRD：单文件分类（点卡片主体 → md 进左栏编辑器）
    const markdown = await request.post(baseUrl, {
      data: {
        phase: "analysis",
        category: "prd",
        name: "打开策略.md",
        mime: "text/markdown",
        data: Buffer.from("# 打开策略文档\n\n单文件直开").toString("base64"),
        isFinal: true,
      },
    });
    expect(markdown.ok()).toBeTruthy();
    // 原型图：单链接分类（点卡片主体 → 新窗口打开链接）
    const linked = await request.post(baseUrl, {
      data: {
        phase: "analysis",
        category: "prototype",
        name: "原型链接",
        resourceType: "link",
        linkUrl: "https://figma.example.com/design/123",
        isFinal: true,
      },
    });
    expect(linked.ok()).toBeTruthy();
    // 其他：多文件且无定稿分类（点卡片主体 → 进二级列表并提示）
    for (const name of ["待选方案一.txt", "待选方案二.txt"]) {
      const draft = await request.post(baseUrl, {
        data: {
          phase: "analysis",
          category: "other",
          name,
          mime: "text/plain",
          data: Buffer.from(`${name} 的草稿内容`).toString("base64"),
          isFinal: false,
        },
      });
      expect(draft.ok()).toBeTruthy();
    }
    await reopenProgress(page);
    // 外部域名离线不可达：在 context 级拦截（page.route 不会作用于 popup）返回占位页
    await page.context().route("https://figma.example.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<html><body>设计稿占位页</body></html>",
      }),
    );
    // 等分类统计就绪（列表加载完成后才显示文件数），避免过早点击被当作空分类
    await expect(categoryCard(page, "PRD")).toContainText("1 个文件");
    await expect(categoryCard(page, "原型图")).toContainText("1 个文件");
    await expect(categoryCard(page, "其他文件")).toContainText("2 个文件");
    // 单文件分类点卡片主体（而非「查看所有文件」按钮）→ 左栏编辑器直接打开该文件
    await categoryCard(page, "PRD").click();
    await expect(editor).toContainText("打开策略文档");
    // 直开不进入二级视图：分类卡片仍在
    await expect(page.locator(".category-grid")).toBeVisible();
    // 单链接分类点卡片主体 → 新窗口打开链接
    const popupPromise = page.waitForEvent("popup");
    await categoryCard(page, "原型图").click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL("https://figma.example.com/design/123");
    await popup.close();
    // 多文件且无定稿分类点卡片主体 → 进入二级列表并显示选择提示
    await categoryCard(page, "其他文件").click();
    await expect(page.locator(".assets-title")).toHaveText("其他文件");
    await expect(page.locator(".assets-hint")).toHaveText(
      "该分类存在多个文件，请选择要打开的文件，或先将某一文件设为定稿。",
    );
    await expect(page.locator(".asset-item")).toHaveCount(2);
  });

  test("previews an uploaded image in the inline image viewer", async ({
    page,
    request,
  }) => {
    await createAnalysis(page, request);
    await openCategoryAssets(page, "其他文件");
    // 上传 1x1 PNG 到「其他文件」分类
    await uploadAsset(page, {
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expect(assetItem(page, "pixel.png")).toBeVisible();
    // 点条目 → 页内预览弹层（teleport 到 body），图片源为 raw 地址
    await assetItem(page, "pixel.png").locator(".asset-name").click();
    const viewer = page.locator(".el-image-viewer__wrapper");
    await expect(viewer).toBeVisible();
    await expect(page.locator(".el-image-viewer__img")).toHaveAttribute(
      "src",
      /\/raw$/,
    );
    // 点关闭按钮后弹层消失
    await page.locator(".el-image-viewer__close").click();
    await expect(viewer).toHaveCount(0);
  });

  test("creates a design link and shows its host next to the entry", async ({
    page,
    request,
  }) => {
    await createAnalysis(page, request);
    // UI 设计稿分类（kind=both，可上传也可新建链接）：经「查看所有文件」进入二级
    await openCategoryAssets(page, "UI 设计稿");
    await page.getByRole("button", { name: "新建链接", exact: true }).click();
    // 第一步弹窗：输入链接地址
    await page
      .locator(".el-message-box__input input")
      .fill("https://figma.example.com/design/123");
    await page
      .locator(".el-message-box")
      .getByRole("button", { name: "下一步", exact: true })
      .click();
    // 第二步弹窗：输入名称（按提示文本定位，避开弹窗关闭过渡期的双节点）
    const nameBox = page
      .locator(".el-message-box")
      .filter({ hasText: "输入名称" });
    await expect(nameBox).toBeVisible();
    await nameBox.locator(".el-message-box__input input").fill("主视觉");
    await nameBox.getByRole("button", { name: "确定", exact: true }).click();
    // 二级条目出现，并展示来源域名
    await expect(assetItem(page, "主视觉")).toBeVisible();
    await expect(
      assetItem(page, "主视觉").locator(".asset-host"),
    ).toHaveText("figma.example.com");
  });

  test("opens an uploaded markdown asset in the editor", async ({
    page,
    request,
  }) => {
    await createAnalysis(page, request);
    // 通过产物区上传第二个 Markdown 到「分析记录」分类
    await openCategoryAssets(page, "分析记录");
    await uploadAsset(page, {
      name: "次级方案.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 次级方案标题\n\n第二份文档的正文内容"),
    });
    await expect(assetItem(page, "次级方案.md")).toBeVisible();
    // 点条目打开后编辑器内容随之切换为该文件
    await assetItem(page, "次级方案.md").locator(".asset-name").click();
    await expect(page.locator(".md-panel .rich-document")).toContainText(
      "次级方案标题",
    );
  });
});
