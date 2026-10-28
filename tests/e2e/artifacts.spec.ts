import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactNode, Requirement } from "@superpm/shared";

const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// 文档管理卡片：按 data-name 精确定位
function docCard(page: Page, name: string) {
  return page.locator(`.doc-card[data-name="${name}"]`);
}
function crumb(page: Page, name: string | RegExp) {
  return page.locator(".doc-breadcrumb .crumb").filter({ hasText: name });
}

// 悬停卡片后点开「更多」下拉，再点击指定菜单命令
async function runCardCommand(page: Page, name: string, command: string) {
  const card = docCard(page, name);
  await card.hover();
  await card.locator(".doc-more-btn").click();
  await page
    .locator(".el-dropdown-menu__item:visible")
    .getByText(command, { exact: true })
    .click();
}

// 通过「新建」下拉与对话框创建（走真实 UI 流程）
async function createViaDialog(
  page: Page,
  kind: "文件夹" | "文件" | "链接",
  fields: { name: string; url?: string; description?: string },
) {
  const tools = page.locator(".doc-tools");
  await tools.getByRole("button", { name: /新建/ }).click();
  await page
    .locator(".el-dropdown-menu__item:visible")
    .getByText(`新建${kind}`, { exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByPlaceholder(/名称|文件夹名称|文件名称|链接名称/)
    .fill(fields.name);
  if (fields.url) await dialog.getByPlaceholder("https://…").fill(fields.url);
  if (fields.description)
    await dialog.locator("textarea").fill(fields.description);
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
}

// 建需求（记忆即时初始化）并打开「文档管理」页签
async function openDocManager(page: Page, request: APIRequestContext) {
  const created = await request.post("/api/requirements", {
    data: { name: `知识库-${Date.now()}`, proposedAt: "2026-10-16" },
  });
  expect(created.ok()).toBeTruthy();
  const requirement = (await created.json()) as Requirement;
  const memory = (await (
    await request.get(`/api/requirements/${requirement.id}/memory`)
  ).json()) as ArtifactNode;
  await page.goto(`/requirements/${requirement.id}`);
  await page.getByRole("tab", { name: "文档管理", exact: true }).click();
  // 文件面板直接铺满页签，md 文件不再默认打开编辑器
  await expect(page.locator(".doc-manager")).toBeVisible();
  // 物理目录名是「需求编号 + 需求名称」（§12），按目录映射取真实路径
  const state = (await (
    await request.get(`/api/requirements/${requirement.id}/directory`)
  ).json()) as { relativePath: string };
  const system = (await (await request.get("/api/system")).json()) as {
    workspacePath: string;
  };
  return {
    requirement,
    memory,
    requirementRoot: join(
      system.workspacePath,
      ...state.relativePath.split("/"),
    ),
  };
}

test.describe("需求知识库（文档管理）", () => {
  test("创建多级文件夹与文件并支持面包屑往返", async ({ page, request }) => {
    const { requirement, requirementRoot } = await openDocManager(
      page,
      request,
    );
    await createViaDialog(page, "文件夹", { name: "研究资料" });
    await expect(docCard(page, "研究资料")).toBeVisible();
    expect(existsSync(join(requirementRoot, "研究资料"))).toBe(true);
    // 进入子目录：面包屑出现二级层级
    await docCard(page, "研究资料").click();
    await expect(crumb(page, "研究资料")).toBeVisible();
    await createViaDialog(page, "文件", { name: "调研笔记.md" });
    await expect(docCard(page, "调研笔记.md")).toBeVisible();
    expect(existsSync(join(requirementRoot, "研究资料", "调研笔记.md"))).toBe(
      true,
    );
    // 面包屑回到根目录，子目录卡片可见；再进入确认文件在子目录中
    await crumb(page, /知识库-/).click();
    await expect(docCard(page, "研究资料")).toBeVisible();
    await docCard(page, "研究资料").click();
    await expect(docCard(page, "调研笔记.md")).toBeVisible();
    // API 复核：子目录列表与根目录列表与磁盘一致
    const root = await (
      await request.get(`/api/requirements/${requirement.id}/artifacts`)
    ).json();
    expect(
      root.folders.map((folder: { name: string }) => folder.name),
    ).toContain("研究资料");
  });

  test("新建 Markdown 文件后以新页签打开编辑器并自动保存", async ({
    page,
    request,
  }) => {
    const { requirement } = await openDocManager(page, request);
    await createViaDialog(page, "文件", { name: "调研笔记.md" });
    await expect(docCard(page, "调研笔记.md")).toBeVisible();
    // 点击 md 卡片：新页签出现并激活，编辑器加载文件内容
    await docCard(page, "调研笔记.md").click();
    const tab = page.getByRole("tab", { name: "调研笔记.md", exact: true });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveClass(/is-active/);
    const editor = page.locator(".el-tab-pane:visible .rich-document");
    const footer = page.locator(".el-tab-pane:visible .md-footer");
    await expect(footer).toContainText("已自动保存");
    await editor.fill("# 调研笔记正文");
    await expect(footer).toContainText("已自动保存到本地文件");
    // 服务端落盘复核：记忆文件仍是模板，新建文件保存了正文
    const root = await (
      await request.get(`/api/requirements/${requirement.id}/artifacts`)
    ).json();
    const created = root.files.find(
      (file: { name: string }) => file.name === "调研笔记.md",
    ) as ArtifactNode;
    const saved = await (
      await request.get(`/api/artifacts/nodes/${created.id}/content`)
    ).json();
    expect(saved.content).toContain("调研笔记正文");
    // 关闭页签回到文档管理；重新打开内容仍在（自动保存不丢）
    await tab.locator(".is-icon-close").click();
    await expect(tab).toHaveCount(0);
    await expect(page.locator(".doc-manager")).toBeVisible();
    await docCard(page, "调研笔记.md").click();
    await expect(
      page.locator(".el-tab-pane:visible .rich-document"),
    ).toContainText("调研笔记正文");
  });

  test("新建链接展示来源域名并在新窗口打开", async ({ page, request }) => {
    await openDocManager(page, request);
    await createViaDialog(page, "链接", {
      name: "主视觉",
      url: "https://figma.example.com/design/123",
    });
    const linkCard = docCard(page, "主视觉");
    await expect(linkCard).toBeVisible();
    await expect(linkCard).toContainText("figma.example.com");
    // 外部域名离线不可达：context 级拦截（popup 不受 page.route 影响）
    await page.context().route("https://figma.example.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<html><body>设计稿占位页</body></html>",
      }),
    );
    const popupPromise = page.waitForEvent("popup");
    await linkCard.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL("https://figma.example.com/design/123");
    await popup.close();
  });

  test("重命名与移动文件（移动目标树选择）", async ({ page, request }) => {
    await openDocManager(page, request);
    await createViaDialog(page, "文件夹", { name: "归档" });
    await createViaDialog(page, "文件", { name: "草稿.md" });
    // 重命名
    await runCardCommand(page, "草稿.md", "重命名");
    const renameDialog = page.getByRole("dialog");
    await renameDialog.getByRole("textbox").fill("定稿草案.md");
    await renameDialog
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(docCard(page, "草稿.md")).toHaveCount(0);
    await expect(docCard(page, "定稿草案.md")).toBeVisible();
    // 移动到「归档」：先打开目录树下拉，点展开箭头加载子级，再选中目标文件夹
    await runCardCommand(page, "定稿草案.md", "移动到…");
    const moveDialog = page.getByRole("dialog");
    await moveDialog.locator(".el-select").click();
    const treePopper = page
      .locator(".el-tree-select__popper:visible")
      .filter({ hasText: "知识库-" });
    await treePopper.locator(".el-tree-node__expand-icon").first().click();
    const targetNode = treePopper
      .locator(".el-tree-node__content")
      .filter({ hasText: "归档" });
    await expect(targetNode).toBeVisible();
    await targetNode.click();
    await moveDialog.getByRole("button", { name: "移动", exact: true }).click();
    await expect(docCard(page, "定稿草案.md")).toHaveCount(0);
    // 进入「归档」确认文件已在其中
    await docCard(page, "归档").click();
    await expect(docCard(page, "定稿草案.md")).toBeVisible();
  });

  test("非法名称与越界路径被拒绝并提示", async ({ page, request }) => {
    await openDocManager(page, request);
    await createViaDialog(page, "文件", { name: "../escape" });
    await expect(
      page.locator(".el-message__content").filter({ hasText: "名称不能为空" }),
    ).toBeVisible();
    // 未创建任何卡片
    await expect(page.locator(".doc-card.is-file")).toHaveCount(1); // 仅有需求记忆
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(page.locator(".doc-card.is-file")).toHaveCount(1);
  });

  test("需求记忆文件受保护：无删除入口且 API 拒绝删除", async ({
    page,
    request,
  }) => {
    const { memory } = await openDocManager(page, request);
    const memoryCard = docCard(page, "需求记忆.md");
    await expect(memoryCard).toContainText("需求记忆");
    // 记忆卡片的下拉菜单不含删除/重命名/移动
    await memoryCard.hover();
    await memoryCard.locator(".doc-more-btn").click();
    const menu = page.locator(".el-dropdown-menu__item:visible");
    await expect(menu.filter({ hasText: /^打开$/ })).toBeVisible();
    await expect(menu.filter({ hasText: /^下载$/ })).toBeVisible();
    await expect(menu.filter({ hasText: "删除" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // API 层同样拒绝（服务端删除保护）
    const removed = await request.delete(`/api/artifacts/nodes/${memory.id}`);
    expect(removed.status()).toBe(409);
  });

  test("磁盘外部增删文件后经刷新同步：缺失标记与外部修改", async ({
    page,
    request,
  }) => {
    const { requirementRoot } = await openDocManager(page, request);
    // 外部放置一个图片与一个文本
    writeFileSync(join(requirementRoot, "pixel.png"), ONE_PX_PNG);
    writeFileSync(join(requirementRoot, "外部说明.txt"), "磁盘上的说明");
    await page.locator(".doc-tools .refresh-btn").click();
    await expect(docCard(page, "pixel.png")).toBeVisible();
    await expect(docCard(page, "外部说明.txt")).toBeVisible();
    // 图片点卡片 → 页内预览弹层（teleport 到 body），图片源为 raw 地址，不交给系统应用
    await docCard(page, "pixel.png").click();
    const viewer = page.locator(".el-image-viewer__wrapper");
    await expect(viewer).toBeVisible();
    await expect(page.locator(".el-image-viewer__img")).toHaveAttribute(
      "src",
      /\/api\/artifacts\/nodes\/\d+\/raw$/,
    );
    await page.locator(".el-image-viewer__close").click();
    await expect(viewer).toHaveCount(0);
    // 外部删除 → 刷新后标记缺失，点击给出提示而非报错
    rmSync(join(requirementRoot, "外部说明.txt"));
    await page.locator(".doc-tools .refresh-btn").click();
    const missingCard = docCard(page, "外部说明.txt");
    await expect(missingCard).toBeVisible();
    await expect(missingCard).toContainText("文件缺失");
    await missingCard.click();
    await expect(
      page.getByText("文件在磁盘上已缺失，请先刷新目录或从磁盘恢复后重试。"),
    ).toBeVisible();
  });

  test("删除非空目录需二次确认（提示影响范围）", async ({ page, request }) => {
    const { requirementRoot } = await openDocManager(page, request);
    await createViaDialog(page, "文件夹", { name: "项目材料" });
    await docCard(page, "项目材料").click();
    await createViaDialog(page, "文件", { name: "内部记录.md" });
    await crumb(page, /知识库-/).click();
    await expect(docCard(page, "项目材料")).toBeVisible();
    // 第一次删除确认 → 服务端 409 → 二次确认展示影响范围
    await runCardCommand(page, "项目材料", "删除");
    await page
      .locator(".el-message-box")
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    const secondBox = page
      .locator(".el-message-box")
      .filter({ hasText: "1 个子项" });
    await expect(secondBox).toBeVisible();
    await secondBox
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    await expect(docCard(page, "项目材料")).toHaveCount(0);
    expect(existsSync(join(requirementRoot, "项目材料"))).toBe(false);
  });

  test("按名称搜索跨目录匹配并展示相对路径", async ({ page, request }) => {
    await openDocManager(page, request);
    await createViaDialog(page, "文件夹", { name: "资料库" });
    await docCard(page, "资料库").click();
    await createViaDialog(page, "文件", { name: "调研笔记.md" });
    await crumb(page, /知识库-/).click();
    await createViaDialog(page, "文件", { name: "会议记录.md" });
    const search = page.locator(".doc-search input");
    await search.fill("笔记");
    await expect(docCard(page, "调研笔记.md")).toBeVisible();
    await expect(docCard(page, "会议记录.md")).toHaveCount(0);
    // 搜索结果展示跨目录的相对路径
    await expect(docCard(page, "调研笔记.md")).toContainText(
      "资料库/调研笔记.md",
    );
    // 清空搜索回到目录视图
    await search.fill("");
    await expect(docCard(page, "会议记录.md")).toBeVisible();
    await expect(docCard(page, "调研笔记.md")).toHaveCount(0);
  });

  test("新建文件省略扩展名时默认创建 Markdown 文档", async ({
    page,
    request,
  }) => {
    const { requirementRoot } = await openDocManager(page, request);
    await createViaDialog(page, "文件", { name: "默认格式笔记" });
    await expect(docCard(page, "默认格式笔记.md")).toBeVisible();
    await expect(docCard(page, "默认格式笔记")).toHaveCount(0);
    expect(existsSync(join(requirementRoot, "默认格式笔记.md"))).toBe(true);
    await docCard(page, "默认格式笔记.md").click();
    await expect(
      page.getByRole("tab", { name: "默认格式笔记.md", exact: true }),
    ).toBeVisible();
  });

  test("最终版文件和链接排在其他卡片之前", async ({ page, request }) => {
    const { requirement } = await openDocManager(page, request);
    await createViaDialog(page, "文件夹", { name: "普通目录" });
    await createViaDialog(page, "文件", { name: "普通文档.md" });
    await createViaDialog(page, "文件", { name: "确认文档.md" });
    await createViaDialog(page, "链接", {
      name: "确认链接",
      url: "https://example.com/final",
    });
    const root = await (
      await request.get(`/api/requirements/${requirement.id}/artifacts`)
    ).json();
    const finalFile = root.files.find(
      (file: ArtifactNode) => file.name === "确认文档.md",
    ) as ArtifactNode;
    const finalLink = root.links.find(
      (link: { name: string }) => link.name === "确认链接",
    );
    await request.patch(`/api/artifacts/nodes/${finalFile.id}/final`, {
      data: { isFinal: true },
    });
    await request.patch(`/api/artifacts/links/${finalLink.id}/final`, {
      data: { isFinal: true },
    });
    await page.reload();
    await page.getByRole("tab", { name: "文档管理", exact: true }).click();
    const visualNames = await page.locator(".doc-card").evaluateAll((cards) =>
      cards
        .map((card) => {
          const rect = card.getBoundingClientRect();
          return {
            name: card.getAttribute("data-name"),
            top: rect.top,
            left: rect.left,
          };
        })
        .sort((a, b) => a.top - b.top || a.left - b.left)
        .map((card) => card.name),
    );
    expect(new Set(visualNames.slice(0, 2))).toEqual(
      new Set(["确认文档.md", "确认链接"]),
    );
    expect(visualNames.slice(2)).toContain("普通目录");
    expect(visualNames.slice(2)).toContain("普通文档.md");
  });

  test("仅在文件名截断时通过悬浮气泡显示完整名称", async ({
    page,
    request,
  }) => {
    await openDocManager(page, request);
    const longName = `${"这是一份用于验证长文件名悬浮提示的会议纪要".repeat(3)}.md`;
    await createViaDialog(page, "文件", { name: "短.md" });
    await createViaDialog(page, "文件", { name: longName });
    await docCard(page, "短.md").locator(".name-text").hover();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await docCard(page, longName).locator(".name-text").hover();
    await expect(
      page.getByRole("tooltip").filter({ hasText: longName }),
    ).toBeVisible();
  });
});
