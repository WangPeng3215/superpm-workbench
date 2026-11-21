import { expect, test, type Page } from "@playwright/test";
import type { Note } from "@superpm/shared";

function initialNote(): Note {
  return {
    id: 71,
    title: "回归便签",
    content: "原始正文",
    type: "inspiration",
    color: "yellow",
    isPinned: false,
    isArchived: false,
    convertedTaskId: null,
    convertedTask: null,
    createdAt: "2026-11-21T02:00:00.000Z",
    updatedAt: "2026-11-21T02:00:00.000Z",
    archivedAt: null,
  };
}

async function mockNotes(page: Page, empty = false) {
  const state = { note: empty ? null : initialNote(), failSave: false };
  const patches: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let nextListBarrier:
    | { waiting: boolean; promise: Promise<void>; release: () => void }
    | undefined;
  await page.route("**/api/notes**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/notes") {
      const notes =
        url.searchParams.has("archived") || !state.note
          ? []
          : [{ ...state.note }];
      const barrier = nextListBarrier;
      nextListBarrier = undefined;
      if (barrier) {
        barrier.waiting = true;
        await barrier.promise;
      }
      await route.fulfill({ json: notes });
      return;
    }
    if (request.method() === "PATCH" || request.method() === "POST") {
      const values = request.postDataJSON() as Record<string, unknown>;
      patches.push(values);
      if (state.failSave) {
        await route.fulfill({
          status: 503,
          json: {
            error: { code: "UNAVAILABLE", message: "模拟便签保存持续失败" },
          },
        });
        return;
      }
      state.note = {
        ...(state.note ?? initialNote()),
        ...values,
        updatedAt: "2026-11-21T03:00:00.000Z",
      } as Note;
      await route.fulfill({
        status: request.method() === "POST" ? 201 : 200,
        json: state.note,
      });
      return;
    }
    await route.fulfill({ status: 204 });
  });
  return {
    state,
    patches,
    errors,
    holdNextList() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const barrier = { waiting: false, promise, release };
      nextListBarrier = barrier;
      return barrier;
    },
  };
}

const card = (page: Page) => page.locator(".note-card").first();
const body = (page: Page) =>
  card(page).getByRole("textbox", { name: "便签内容" });
const title = (page: Page) =>
  card(page).getByRole("textbox", { name: "便签标题" });
const refresh = (page: Page) =>
  page
    .locator(".notes-toolbar")
    .getByRole("button", { name: "刷新", exact: true });

test("BUG-006：刷新同步新正文，之后只改标题不会回写旧正文", async ({
  page,
}) => {
  const fixture = await mockNotes(page);
  await page.goto("/notes");
  await expect(body(page)).toHaveValue("原始正文");
  fixture.state.note!.content = "其他会话更新的正文";
  await refresh(page).click();
  await expect(body(page)).toHaveValue("其他会话更新的正文");
  await title(page).fill("只修改便签标题");
  await expect(card(page).locator(".save-state")).toHaveText("已保存");
  expect(fixture.patches).toEqual([{ title: "只修改便签标题" }]);
  expect(fixture.state.note!.content).toBe("其他会话更新的正文");
  expect(fixture.errors).toEqual([]);
});

test("BUG-006：刷新返回时保留不同字段的新输入并合并外部正文", async ({
  page,
}) => {
  const fixture = await mockNotes(page);
  await page.goto("/notes");
  await expect(body(page)).toHaveValue("原始正文");
  await page.clock.install();
  fixture.state.note!.content = "刷新请求中的外部正文";
  const pending = fixture.holdNextList();
  await refresh(page).click();
  await expect.poll(() => pending.waiting).toBe(true);
  await title(page).fill("刷新期间输入的新标题");
  pending.release();
  await expect(body(page)).toHaveValue("刷新请求中的外部正文");
  await expect(title(page)).toHaveValue("刷新期间输入的新标题");
  await page.clock.runFor(800);
  await expect(card(page).locator(".save-state")).toHaveText("已保存");
  expect(fixture.patches).toEqual([{ title: "刷新期间输入的新标题" }]);
  expect(fixture.errors).toEqual([]);
});

test("BUG-006：刷新同字段冲突保留本地草稿并暂停自动保存", async ({ page }) => {
  const fixture = await mockNotes(page);
  await page.goto("/notes");
  await expect(body(page)).toHaveValue("原始正文");
  await page.clock.install();
  fixture.state.note!.content = "外部新正文";
  const pending = fixture.holdNextList();
  await refresh(page).click();
  await expect.poll(() => pending.waiting).toBe(true);
  await body(page).fill("刷新期间的本地草稿");
  pending.release();
  await expect(card(page).getByRole("alert")).toContainText(
    "已保留本地草稿并暂停保存",
  );
  await expect(body(page)).toHaveValue("刷新期间的本地草稿");
  await page.clock.runFor(1000);
  expect(fixture.patches).toEqual([]);
  await card(page)
    .getByRole("button", { name: "读取最新", exact: true })
    .click();
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "替换草稿", exact: true })
    .click();
  await expect(body(page)).toHaveValue("外部新正文");
  await expect(card(page).locator(".save-state")).toHaveText("已保存");
  expect(fixture.errors).toEqual([]);
});

test("BUG-006：旧刷新响应晚于成功保存返回时保持最新正文", async ({ page }) => {
  const fixture = await mockNotes(page);
  await page.goto("/notes");
  await expect(body(page)).toHaveValue("原始正文");
  await page.clock.install();
  const pending = fixture.holdNextList();
  await refresh(page).click();
  await expect.poll(() => pending.waiting).toBe(true);
  await body(page).fill("刷新期间已经保存的新正文");
  await page.clock.runFor(800);
  await expect(card(page).locator(".save-state")).toHaveText("已保存");
  pending.release();
  await expect(refresh(page)).not.toHaveClass(/is-loading/);
  await expect(body(page)).toHaveValue("刷新期间已经保存的新正文");
  expect(fixture.state.note!.content).toBe("刷新期间已经保存的新正文");
  expect(fixture.errors).toEqual([]);
});

test("BUG-007：持续保存失败阻止离开，刷新后恢复并可重试保存", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  const fixture = await mockNotes(page);
  fixture.state.failSave = true;
  await page.goto("/notes");
  await body(page).fill("失败后必须保留的便签草稿");
  await expect(card(page).locator(".save-state")).toContainText("保存失败");
  await page
    .locator('nav[aria-label="主导航"]')
    .getByRole("link", { name: "需求列表", exact: true })
    .click();
  await expect(page.locator(".el-message__content")).toContainText(
    "有便签尚未保存",
  );
  await expect(page).toHaveURL(/[/]notes$/);
  await expect(body(page)).toHaveValue("失败后必须保留的便签草稿");
  await page
    .getByRole("textbox", { name: "搜索便签" })
    .fill("没有匹配的搜索词");
  await expect(page.locator(".note-card")).toHaveCount(0);
  await page
    .locator('nav[aria-label="主导航"]')
    .getByRole("link", { name: "需求列表", exact: true })
    .click();
  await expect(page).toHaveURL(/[/]notes$/);
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(body(page)).toHaveValue("失败后必须保留的便签草稿");
  await page.reload();
  await expect(body(page)).toHaveValue("失败后必须保留的便签草稿");
  fixture.state.failSave = false;
  await card(page).getByRole("button", { name: "重试", exact: true }).click();
  await expect(card(page).locator(".save-state")).toHaveText("已保存");
  expect(fixture.state.note!.content).toBe("失败后必须保留的便签草稿");
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) =>
        key.startsWith("superpm.note-draft.v1."),
      ),
    ),
  ).toEqual([]);
  await page
    .locator('nav[aria-label="主导航"]')
    .getByRole("link", { name: "需求列表", exact: true })
    .click();
  await expect(page).toHaveURL(/[/]requirements$/);
  expect(fixture.errors).toEqual([]);
});

test("BUG-007：其他会话删除便签时保留草稿入口，确认后可移除", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  const fixture = await mockNotes(page);
  await page.goto("/notes");
  await expect(body(page)).toHaveValue("原始正文");
  await page.clock.install();
  fixture.state.note = null;
  const pending = fixture.holdNextList();
  await refresh(page).click();
  await expect.poll(() => pending.waiting).toBe(true);
  await body(page).fill("已删除便签仍须保留的本地草稿");
  pending.release();
  await expect(card(page).getByRole("alert")).toContainText(
    "便签已不在当前列表中",
  );
  await expect(body(page)).toHaveValue("已删除便签仍须保留的本地草稿");
  await page.clock.runFor(1000);
  expect(fixture.patches).toEqual([]);
  await page.reload();
  await expect(body(page)).toHaveValue("已删除便签仍须保留的本地草稿");
  await expect(card(page).getByRole("alert")).toContainText(
    "便签已不在当前列表中",
  );
  await page
    .locator('nav[aria-label="主导航"]')
    .getByRole("link", { name: "需求列表", exact: true })
    .click();
  await expect(page.locator(".el-message__content")).toContainText(
    "有便签尚未保存",
  );
  await expect(page).toHaveURL(/[/]notes$/);
  await card(page)
    .getByRole("button", { name: "移除草稿", exact: true })
    .click();
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(body(page)).toHaveValue("已删除便签仍须保留的本地草稿");
  await card(page)
    .getByRole("button", { name: "移除草稿", exact: true })
    .click();
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(page.locator(".note-card")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) =>
        key.startsWith("superpm.note-draft.v1."),
      ),
    ),
  ).toEqual([]);
  await page
    .locator('nav[aria-label="主导航"]')
    .getByRole("link", { name: "需求列表", exact: true })
    .click();
  await expect(page).toHaveURL(/[/]requirements$/);
  expect(fixture.errors).toEqual([]);
});

test("BUG-007：新建便签保存失败后刷新可恢复并创建", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  const fixture = await mockNotes(page, true);
  fixture.state.failSave = true;
  await page.goto("/notes");
  await page
    .locator(".notes-toolbar")
    .getByRole("button", { name: "新建便签" })
    .click();
  await body(page).fill("尚未创建成功的新便签草稿");
  await expect(card(page).locator(".save-state")).toContainText("保存失败");
  await page.reload();
  await expect(page.locator(".note-card.draft")).toHaveCount(1);
  await expect(body(page)).toHaveValue("尚未创建成功的新便签草稿");
  fixture.state.failSave = false;
  await card(page).getByRole("button", { name: "重试", exact: true }).click();
  await expect(card(page).locator(".save-state")).toHaveText("已保存");
  await expect(page.locator(".note-card.draft")).toHaveCount(0);
  expect(fixture.state.note!.content).toBe("尚未创建成功的新便签草稿");
  expect(fixture.errors).toEqual([]);
});
