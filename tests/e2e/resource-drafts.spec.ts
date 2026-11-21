import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

async function createRequirement(request: APIRequestContext, name: string) {
  const response = await request.post("/api/requirements", {
    data: { name: `${name}${Date.now()}`, proposedAt: "2026-11-20" },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ id: number }>;
}
async function openDocument(page: Page, requirementId: number) {
  await page.goto(`/requirements/${requirementId}`);
  await page.getByRole("tab", { name: "文档管理" }).click();
  await page.locator('.doc-card[data-name="需求记忆.md"]').click();
  await expect(page.getByLabel("文档内容")).toBeVisible();
}
const temporaryFailure = {
  status: 503,
  json: { error: { code: "TEMPORARY", message: "暂不可用" } },
};

test("文档失败草稿刷新后恢复，旧正文基准冻结保存，确认读取后清理", async ({
  page,
  request,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  const item = await createRequirement(request, "文档会话草稿");
  const memory = await (
    await request.get(`/api/requirements/${item.id}/memory`)
  ).json();
  const url = `/api/artifacts/nodes/${memory.id}/content`;
  const keySuffix = `.${item.id}.artifact.${memory.id}`;
  await page.route(`**${url}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill(temporaryFailure)
      : route.continue(),
  );
  await openDocument(page, item.id);
  await page.getByLabel("文档内容").fill("浏览器刷新后仍保留的文档草稿");
  await expect(page.locator(".md-footer")).toContainText("保存失败，请重试");
  const baseline = await (await request.get(url)).json();
  const updated = await request.put(url, {
    data: {
      content: "其他会话更新的文档正文",
      expectedVersion: baseline.version,
    },
  });
  expect(updated.ok()).toBe(true);
  await page.reload();
  await page.getByRole("tab", { name: "文档管理" }).click();
  await page.locator('.doc-card[data-name="需求记忆.md"]').click();
  await expect(page.getByLabel("文档内容")).toContainText(
    "浏览器刷新后仍保留的文档草稿",
  );
  await expect(page.getByRole("alert")).toContainText(
    "会话草稿已恢复并暂停保存",
  );
  await page.unroute(`**${url}`);
  await page.getByLabel("文档内容").fill("冻结期间继续输入也应保留");
  expect((await (await request.get(url)).json()).content).toBe(
    "其他会话更新的文档正文",
  );
  expect(
    await page.evaluate(
      (suffix) =>
        Object.keys(sessionStorage)
          .filter((key) => key.endsWith(suffix))
          .map((key) => JSON.parse(sessionStorage.getItem(key)!).version),
      keySuffix,
    ),
  ).toEqual([baseline.version]);
  await page.getByRole("button", { name: "读取最新内容", exact: true }).click();
  await page.getByRole("button", { name: "替换草稿", exact: true }).click();
  await expect(page.getByLabel("文档内容")).toContainText(
    "其他会话更新的文档正文",
  );
  expect(
    await page.evaluate(
      (suffix) =>
        Object.keys(sessionStorage).some((key) => key.endsWith(suffix)),
      keySuffix,
    ),
  ).toBe(false);
});

test("问题失败草稿刷新恢复，版本变化保留输入并冻结，显式读取可恢复编辑", async ({
  page,
  request,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  const item = await createRequirement(request, "问题会话草稿");
  const issue = await (
    await request.post(`/api/requirements/${item.id}/issues`, {
      data: { title: "问题原始标题", description: "问题原始正文" },
    })
  ).json();
  const url = `/api/requirements/${item.id}/issues/${issue.id}`;
  await page.route(`**${url}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill(temporaryFailure)
      : route.continue(),
  );
  await page.goto(`/requirements/${item.id}`);
  await page.getByRole("tab", { name: "问题记录" }).click();
  const title = page.getByRole("textbox", { name: "问题标题", exact: true });
  await title.fill("问题标题本地草稿");
  await expect(page.locator(".save-state")).toContainText("暂不可用");
  const baseline = await (await request.get(url)).json();
  const updated = await request.patch(url, {
    data: { title: "其他会话更新的问题", expectedVersion: baseline.version },
  });
  expect(updated.ok()).toBe(true);
  await page.reload();
  await page.getByRole("tab", { name: "问题记录" }).click();
  await expect(title).toHaveValue("问题标题本地草稿");
  await expect(page.locator(".save-state")).toContainText(
    "会话草稿已恢复并暂停保存",
  );
  await page.unroute(`**${url}`);
  await title.fill("冻结期间继续编辑的问题草稿");
  expect((await (await request.get(url)).json()).title).toBe(
    "其他会话更新的问题",
  );
  await page.getByRole("button", { name: "读取最新", exact: true }).click();
  await page.getByRole("button", { name: "替换草稿", exact: true }).click();
  await expect(title).toHaveValue("其他会话更新的问题");
  await title.fill("读取最新后可以再次保存");
  await expect
    .poll(async () => (await (await request.get(url)).json()).title)
    .toBe("读取最新后可以再次保存");
  expect(
    await page.evaluate(
      (suffix) =>
        Object.keys(sessionStorage).some((key) => key.endsWith(suffix)),
      `.${item.id}.issue.${issue.id}`,
    ),
  ).toBe(false);
});

test("文档GET失权不恢复草稿并清理该需求资源缓存", async ({ page, request }) => {
  page.on("dialog", (dialog) => dialog.accept());
  const item = await createRequirement(request, "文档失权清理");
  const memory = await (
    await request.get(`/api/requirements/${item.id}/memory`)
  ).json();
  const user = await (await request.get("/api/auth/me")).json();
  const url = `/api/artifacts/nodes/${memory.id}/content`;
  await page.goto(`/requirements/${item.id}`);
  await page.evaluate(
    ({ accountId, requirementId, nodeId }) => {
      sessionStorage.setItem(
        `superpm.resource-draft.v1.${accountId}.private.${requirementId}.artifact.${nodeId}`,
        JSON.stringify({
          version: "a".repeat(64),
          values: { html: "未经鉴权不能显示的旧草稿" },
        }),
      );
    },
    { accountId: user.id, requirementId: item.id, nodeId: memory.id },
  );
  await page.route(`**${url}`, (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: "FORBIDDEN", message: "权限已移除" } },
    }),
  );
  await page.getByRole("tab", { name: "文档管理" }).click();
  await page.locator('.doc-card[data-name="需求记忆.md"]').click();
  await expect(page.getByLabel("文档内容")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (suffix) =>
          Object.keys(sessionStorage).some((key) => key.endsWith(suffix)),
        `.${item.id}.artifact.${memory.id}`,
      ),
    )
    .toBe(false);
  await expect(
    page.getByText("未经鉴权不能显示的旧草稿", { exact: true }),
  ).toHaveCount(0);
});

test("问题401硬跳转前同步保留最新输入", async ({ page, request }) => {
  page.on("dialog", (dialog) => dialog.accept());
  const item = await createRequirement(request, "问题会话失效");
  const issue = await (
    await request.post(`/api/requirements/${item.id}/issues`, {
      data: { title: "登录失效前的问题" },
    })
  ).json();
  const url = `/api/requirements/${item.id}/issues/${issue.id}`;
  await page.route(`**${url}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 401,
          json: { error: { code: "UNAUTHORIZED", message: "登录失效" } },
        })
      : route.continue(),
  );
  await page.goto(`/requirements/${item.id}`);
  await page.getByRole("tab", { name: "问题记录" }).click();
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "UNAUTHORIZED", message: "登录失效" } },
    }),
  );
  await page
    .getByRole("textbox", { name: "问题标题", exact: true })
    .fill("登录失效仍保留的最新输入");
  await page.waitForResponse(
    (response) =>
      response.url().endsWith(url) &&
      response.request().method() === "PATCH" &&
      response.status() === 401,
  );
  await page.waitForURL(/\/login\?/);
  await expect
    .poll(() =>
      page.evaluate(
        (suffix) =>
          Object.keys(sessionStorage)
            .filter((key) => key.endsWith(suffix))
            .map(
              (key) => JSON.parse(sessionStorage.getItem(key)!).values.title,
            ),
        `.${item.id}.issue.${issue.id}`,
      ),
    )
    .toEqual(["登录失效仍保留的最新输入"]);
});

for (const status of [403, 404]) {
  test(`需求初始GET${status}在子编辑器挂载前清理两类资源草稿`, async ({
    page,
    request,
  }) => {
    const item = await createRequirement(request, `初载${status}失权`);
    const user = await (await request.get("/api/auth/me")).json();
    await page.goto("/requirements");
    const keys = await page.evaluate(
      ({ accountId, requirementId }) => {
        const own = [
          `superpm.resource-draft.v1.${accountId}.private.${requirementId}.artifact.1`,
          `superpm.resource-draft.v1.${accountId}.9.${requirementId}.issue.2`,
        ];
        const other = `superpm.resource-draft.v1.${accountId + 1}.private.${requirementId}.artifact.1`;
        for (const key of [...own, other])
          sessionStorage.setItem(key, "旧草稿");
        return { own, other };
      },
      { accountId: user.id, requirementId: item.id },
    );
    await page.route(`**/api/requirements/${item.id}`, (route) =>
      route.fulfill({
        status,
        json: {
          error: {
            code: status === 403 ? "FORBIDDEN" : "NOT_FOUND",
            message: "需求已不可访问",
          },
        },
      }),
    );
    await page.goto(`/requirements/${item.id}`);
    await expect(
      page.getByText("该需求已不可访问，已清理内容和本地草稿。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        (keys) => keys.map((key) => sessionStorage.getItem(key)),
        keys.own,
      ),
    ).toEqual([null, null]);
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), keys.other),
    ).toBe("旧草稿");
  });
}

test("问题被其他会话删除只清当前问题，其他问题和文档页签仍可用", async ({
  page,
  request,
}) => {
  const item = await createRequirement(request, "问题独立删除");
  const survivor = await (
    await request.post(`/api/requirements/${item.id}/issues`, {
      data: { title: "仍可访问的问题" },
    })
  ).json();
  const removed = await (
    await request.post(`/api/requirements/${item.id}/issues`, {
      data: { title: "稍后被删除的问题" },
    })
  ).json();
  await openDocument(page, item.id);
  await page.getByRole("tab", { name: "问题记录" }).click();
  await page
    .locator(".issue-row")
    .filter({ hasText: removed.title })
    .getByRole("button")
    .first()
    .click();
  const title = page.getByRole("textbox", { name: "问题标题", exact: true });
  await expect(title).toHaveValue(removed.title);
  const response = await request.delete(
    `/api/requirements/${item.id}/issues/${removed.id}?expectedVersion=${removed.version}`,
  );
  expect(response.ok()).toBe(true);
  await title.fill("对象已删除时提交的本地输入");
  await expect(page.locator(".detail-state")).toContainText("问题不存在");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(
    await page.evaluate(
      (suffix) =>
        Object.keys(sessionStorage).some((key) => key.endsWith(suffix)),
      `.${item.id}.issue.${removed.id}`,
    ),
  ).toBe(false);
  await page
    .locator(".issue-row")
    .filter({ hasText: survivor.title })
    .getByRole("button")
    .first()
    .click();
  await expect(title).toHaveValue(survivor.title);
  await page.getByRole("tab", { name: "需求记忆.md", exact: true }).click();
  await expect(page.getByLabel("文档内容")).toContainText("需求记忆");
});

test("正文404但父鉴权暂不可用时保留草稿并暂停当前资源", async ({
  page,
  request,
}) => {
  const item = await createRequirement(request, "资源404鉴权暂不可用");
  const memory = await (
    await request.get(`/api/requirements/${item.id}/memory`)
  ).json();
  await openDocument(page, item.id);
  await page.route(`**/api/artifacts/nodes/${memory.id}/content`, (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "正文不存在" } },
    }),
  );
  await page.route(`**/api/requirements/${item.id}`, (route) =>
    route.fulfill(temporaryFailure),
  );
  await page.getByLabel("文档内容").fill("父鉴权暂不可用仍保留的本地草稿");
  await expect(page.getByRole("alert")).toContainText(
    "暂时无法确认需求访问权限",
  );
  await expect(page.getByLabel("文档内容")).toContainText(
    "父鉴权暂不可用仍保留的本地草稿",
  );
  expect(
    await page.evaluate(
      (suffix) =>
        Object.keys(sessionStorage)
          .filter((key) => key.endsWith(suffix))
          .map((key) => JSON.parse(sessionStorage.getItem(key)!).values.html),
      `.${item.id}.artifact.${memory.id}`,
    ),
  ).toEqual([expect.stringContaining("父鉴权暂不可用仍保留的本地草稿")]);
});

test("关联关系404但问题仍存在时保留问题未保存草稿", async ({
  page,
  request,
}) => {
  const item = await createRequirement(request, "关联404保稿");
  const issue = await (
    await request.post(`/api/requirements/${item.id}/issues`, {
      data: { title: "关联资源独立失效" },
    })
  ).json();
  const memory = await (
    await request.get(`/api/requirements/${item.id}/memory`)
  ).json();
  const issueUrl = `/api/requirements/${item.id}/issues/${issue.id}`;
  expect(
    (
      await request.post(`${issueUrl}/assets`, {
        data: { assetId: memory.id, relationType: "reference" },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/requirements/${item.id}`);
  await page.getByRole("tab", { name: "问题记录" }).click();
  await page.route(`**${issueUrl}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill(temporaryFailure)
      : route.continue(),
  );
  const title = page.getByRole("textbox", { name: "问题标题", exact: true });
  await title.fill("关联404不能清除的问题草稿");
  await expect(page.locator(".save-state")).toContainText("暂不可用");
  await page.route(`**${issueUrl}/assets/${memory.id}`, (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "关联关系不存在" } },
    }),
  );
  await page
    .getByRole("button", { name: "取消关联 需求记忆.md", exact: true })
    .click();
  await expect(page.locator(".el-message__content")).toContainText(
    "关联关系不存在",
  );
  await expect(title).toHaveValue("关联404不能清除的问题草稿");
  expect(
    await page.evaluate(
      (suffix) =>
        Object.keys(sessionStorage)
          .filter((key) => key.endsWith(suffix))
          .map((key) => JSON.parse(sessionStorage.getItem(key)!).values.title),
      `.${item.id}.issue.${issue.id}`,
    ),
  ).toEqual(["关联404不能清除的问题草稿"]);
});

test("正文404且父需求复核403时整页清理资源草稿", async ({ page, request }) => {
  const item = await createRequirement(request, "资源404父需求已失权");
  const memory = await (
    await request.get(`/api/requirements/${item.id}/memory`)
  ).json();
  await openDocument(page, item.id);
  await page.route(`**/api/artifacts/nodes/${memory.id}/content`, (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "资源不可访问" } },
    }),
  );
  await page.route(`**/api/requirements/${item.id}`, (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: "FORBIDDEN", message: "成员权限已移除" } },
    }),
  );
  await page.getByLabel("文档内容").fill("失权后必须清除的本地输入");
  await expect(page.getByRole("alert")).toContainText("该需求已不可访问");
  await expect(page.getByLabel("文档内容")).toHaveCount(0);
  expect(
    await page.evaluate(
      (suffix) =>
        Object.keys(sessionStorage).some((key) => key.endsWith(suffix)),
      `.${item.id}.artifact.${memory.id}`,
    ),
  ).toBe(false);
});
