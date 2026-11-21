import { test, expect } from "@playwright/test";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("优化点旧保存响应保留请求期间的新正文和未保存状态", async ({
  page,
  request,
}) => {
  const createdResponse = await request.post("/api/optimization-points", {
    data: {
      name: `保存期间继续编辑-${Date.now()}`,
      description: "最初正文",
      descriptionHtml: "<p>最初正文</p>",
    },
  });
  expect(createdResponse.ok()).toBe(true);
  const point = (await createdResponse.json()) as { id: number };
  const url = `/api/optimization-points/${point.id}`;
  const started = gate();
  const released = gate();
  const payloads: { description: string; descriptionHtml: string }[] = [];

  await page.route(`**${url}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    payloads.push(route.request().postDataJSON());
    if (payloads.length !== 1) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    started.release();
    await released.promise;
    await route.fulfill({ response });
  });

  try {
    await page.goto(`/optimization-points/${point.id}`);
    const editor = page.locator('.rich-document[aria-label="优化点内容"]');
    const save = page.getByRole("button", { name: "保存", exact: true });
    await editor.fill("第一次提交的正文");
    await save.click();
    await started.promise;
    await expect(save).toBeDisabled();
    await editor.fill("请求期间继续输入的最新正文");
    released.release();

    await expect(save).toBeEnabled();
    await expect(editor).toContainText("请求期间继续输入的最新正文");
    await expect(page.locator(".dirty-flag")).toHaveText("未保存");
    expect((await (await request.get(url)).json()).description).toBe(
      "第一次提交的正文",
    );

    await save.click();
    await expect(page.locator(".dirty-flag")).toHaveCount(0);
    await expect(editor).toContainText("请求期间继续输入的最新正文");
    expect(payloads.map((payload) => payload.description)).toEqual([
      "第一次提交的正文",
      "请求期间继续输入的最新正文",
    ]);
    expect(payloads[1].descriptionHtml).toContain("请求期间继续输入的最新正文");
    expect((await (await request.get(url)).json()).description).toBe(
      "请求期间继续输入的最新正文",
    );
    await page.reload();
    await expect(editor).toContainText("请求期间继续输入的最新正文");
    await expect(page.locator(".dirty-flag")).toHaveCount(0);
  } finally {
    released.release();
    await request.delete(url);
  }
});

for (const oldSaveFails of [false, true]) {
  test(`切换优化点后旧保存${oldSaveFails ? "失败" : "响应"}不影响当前详情和在途保存`, async ({
    page,
    request,
  }) => {
    const stamp = Date.now();
    const points = await Promise.all(
      ["A", "B"].map(async (label) => {
        const response = await request.post("/api/optimization-points", {
          data: {
            name: `保存路由竞争-${label}-${stamp}`,
            description: `${label} 的原始正文`,
            descriptionHtml: `<p>${label} 的原始正文</p>`,
          },
        });
        expect(response.ok()).toBe(true);
        return response.json() as Promise<{ id: number; name: string }>;
      }),
    );
    const [first, second] = points;
    const firstUrl = `/api/optimization-points/${first.id}`;
    const secondUrl = `/api/optimization-points/${second.id}`;
    const started = gate();
    const released = gate();
    const secondStarted = gate();
    const secondReleased = gate();
    await page.route(`**${firstUrl}`, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      started.release();
      await released.promise;
      if (oldSaveFails) {
        await route.fulfill({
          status: 503,
          json: { error: { code: "UNAVAILABLE", message: "旧优化点保存失败" } },
        });
      } else {
        await route.fulfill({ response });
      }
    });
    await page.route(`**${secondUrl}`, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      secondStarted.release();
      await secondReleased.promise;
      await route.fulfill({ response });
    });

    try {
      await page.goto(`/optimization-points/${second.id}`);
      await expect(
        page.getByRole("heading", { name: second.name }),
      ).toBeVisible();
      await page.getByRole("button", { name: "返回优化点列表" }).click();
      await page.getByLabel("搜索优化点名称").fill(first.name);
      await page.locator(".point-name").filter({ hasText: first.name }).click();
      await expect(
        page.getByRole("heading", { name: first.name }),
      ).toBeVisible();
      const editor = page.locator('.rich-document[aria-label="优化点内容"]');
      const save = page.getByRole("button", { name: "保存", exact: true });
      await editor.fill("A 提交时的正文");
      await save.click();
      await started.promise;

      const secondTab = page.locator(".topbar-tab").filter({
        hasText: second.name,
      });
      await secondTab.click();
      await page
        .locator(".el-message-box")
        .getByRole("button", { name: "仍要离开", exact: true })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/optimization-points/${second.id}$`),
      );
      await expect(
        page.getByRole("heading", { name: second.name }),
      ).toBeVisible();
      await editor.fill("B 当前未保存的新正文");
      await expect(save).toBeEnabled();
      await save.click();
      await secondStarted.promise;

      const oldResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === firstUrl &&
          response.request().method() === "PATCH",
      );
      released.release();
      await (await oldResponse).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );

      await expect(
        page.getByRole("heading", { name: second.name }),
      ).toBeVisible();
      await expect(editor).toContainText("B 当前未保存的新正文");
      await expect(secondTab).toContainText(second.name);
      await expect(page.locator(".dirty-flag")).toHaveText("未保存");
      await expect(save).toBeDisabled();
      await expect(save).toHaveClass(/is-loading/);
      await expect(page.locator(".save-error")).toHaveCount(0);
      secondReleased.release();
      await expect(page.locator(".dirty-flag")).toHaveCount(0);
      expect((await (await request.get(secondUrl)).json()).description).toBe(
        "B 当前未保存的新正文",
      );
      expect((await (await request.get(firstUrl)).json()).description).toBe(
        "A 提交时的正文",
      );
    } finally {
      released.release();
      secondReleased.release();
      await Promise.all(
        points.map((point) =>
          request.delete(`/api/optimization-points/${point.id}`),
        ),
      );
    }
  });
}
