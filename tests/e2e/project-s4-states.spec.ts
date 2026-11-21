import { expect, test } from "@playwright/test";

const password = "secret123";

test("概览加载状态可见，长名称在宽窄窗口加载后可用", async ({
  page,
  request,
}, testInfo) => {
  const name = `S4 加载检查 ${"较长的项目名称".repeat(12)}`;
  const created = await request.post("/api/projects", { data: { name } });
  expect(created.status()).toBe(201);
  const { project } = await created.json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/projects/${project.id}/overview`, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto(`/projects/${project.id}`);
    const overview = page.getByRole("region", {
      name: "项目概览",
      exact: true,
    });
    await expect(overview.locator(".el-loading-mask")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("overview-loading.png"),
      animations: "disabled",
    });
    release();
    await expect(overview.locator(".el-loading-mask")).toHaveCount(0);
    await expect(
      overview.getByText("当前没有可统计的承诺需求", { exact: true }),
    ).toBeVisible();
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(
        page.getByRole("button", { name: "返回项目列表", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`overview-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
  } finally {
    release();
  }
});

test("项目详情在 1440x1000 下保持紧凑且无横向溢出", async ({
  page,
  request,
}) => {
  const name = `S4 宽屏布局 ${Date.now()}`;
  const response = await request.post("/api/projects", { data: { name } });
  expect(response.status(), await response.text()).toBe(201);
  const { project } = await response.json();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "返回项目列表", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".project-header")).toHaveCSS(
    "height",
    /^(2[0-9]|3[0-9])px$/,
  );
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewport + 1);
});

test("项目只读成员可以查看各页签但看不到写入入口", async ({ browser }) => {
  const stamp = Date.now();
  const ownerContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3012",
  });
  const viewerContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3012",
  });
  try {
    const ownerRegistration = await ownerContext.request.post(
      "/api/auth/register",
      { data: { username: `s4_owner_${stamp}`, password } },
    );
    expect(ownerRegistration.status(), await ownerRegistration.text()).toBe(
      201,
    );
    const registration = await viewerContext.request.post(
      "/api/auth/register",
      {
        data: { username: `s4_viewer_${stamp}`, password },
      },
    );
    expect(registration.status(), await registration.text()).toBe(201);
    const viewer = await registration.json();
    const created = await ownerContext.request.post("/api/projects", {
      data: { name: `S4 只读项目 ${stamp}` },
    });
    expect(created.status(), await created.text()).toBe(201);
    let project = (await created.json()).project;
    const added = await ownerContext.request.post(
      `/api/projects/${project.id}/members`,
      {
        data: {
          userId: viewer.id,
          roles: ["viewer"],
          expectedVersion: project.version,
        },
      },
    );
    expect(added.ok(), await added.text()).toBeTruthy();
    project = (await added.json()).project;

    const requirement = await ownerContext.request.post("/api/requirements", {
      data: {
        name: `只读范围 ${stamp}`,
        projectId: project.id,
        proposedAt: "2026-11-21",
        acceptanceCriteria: "可被只读成员查看",
      },
    });
    expect(requirement.ok(), await requirement.text()).toBeTruthy();
    const task = await ownerContext.request.post(
      `/api/projects/${project.id}/tasks`,
      {
        data: {
          title: `只读任务 ${stamp}`,
          type: "development",
          assigneeUserId: project.ownerUserId,
          confirmerUserId: project.ownerUserId,
        },
      },
    );
    expect(task.status(), await task.text()).toBe(201);

    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(`/projects/${project.id}`);
    await expect(
      viewerPage.getByText("当前项目为只读状态，或当前账号没有项目维护权限。", {
        exact: true,
      }),
    ).toBeVisible();

    await viewerPage
      .getByRole("tab", { name: "项目概览", exact: true })
      .click();
    await expect(
      viewerPage.getByRole("heading", { name: "项目基本信息", exact: true }),
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("button", { name: "立即保存", exact: true }),
    ).toBeDisabled();
    await expect(
      viewerPage.getByRole("button", { name: "开始项目", exact: true }),
    ).toHaveCount(0);

    await viewerPage
      .getByRole("tab", { name: "项目需求", exact: true })
      .click();
    await expect(
      viewerPage.getByText(`只读范围 ${stamp}`, { exact: true }),
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("button", { name: "关联已有私人需求", exact: true }),
    ).toHaveCount(0);

    await viewerPage
      .getByRole("tab", { name: "执行任务", exact: true })
      .click();
    await expect(
      viewerPage.getByText(`只读任务 ${stamp}`, { exact: true }),
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("button", { name: "拆分任务", exact: true }),
    ).toHaveCount(0);

    await viewerPage
      .getByRole("tab", { name: "项目工时", exact: true })
      .click();
    await expect(
      viewerPage.getByRole("heading", { name: "项目工时", exact: true }),
    ).toBeVisible();

    await viewerPage
      .getByRole("tab", { name: "交付验收", exact: true })
      .click();
    await expect(
      viewerPage.getByRole("heading", { name: "本次交付范围", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewerPage.getByRole("button", { name: "确认范围", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewerPage.getByRole("button", { name: "提交验收", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewerPage.getByRole("button", { name: "新增批次", exact: true }),
    ).toHaveCount(0);

    await viewerPage
      .getByRole("tab", { name: "项目动态", exact: true })
      .click();
    await expect(
      viewerPage
        .getByRole("region", { name: "项目动态", exact: true })
        .getByText("只读", { exact: true }),
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("button", { name: "刷新", exact: true }),
    ).toBeVisible();

    await viewerPage
      .getByRole("tab", { name: "项目资料", exact: true })
      .click();
    await expect(
      viewerPage
        .getByRole("region", { name: "项目资料", exact: true })
        .getByText("只读", { exact: true }),
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("button", { name: "新增资料", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewerPage.getByRole("button", { name: "复制我的会议", exact: true }),
    ).toHaveCount(0);
  } finally {
    await Promise.allSettled([ownerContext.close(), viewerContext.close()]);
  }
});

test("项目动态接口失败后可以重试恢复", async ({ page, request }) => {
  const response = await request.post("/api/projects", {
    data: { name: `S4 动态重试 ${Date.now()}` },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { project } = await response.json();
  let attempts = 0;
  await page.route(`**/api/projects/${project.id}/events*`, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "ACTIVITY_UNAVAILABLE",
            message: "动态服务暂时不可用",
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("tab", { name: "项目动态", exact: true }).click();
  const activity = page.getByRole("region", { name: "项目动态", exact: true });
  await expect(
    activity.getByText("动态服务暂时不可用", { exact: true }),
  ).toBeVisible();
  await activity.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    activity.getByRole("heading", { name: "项目动态", exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

test("项目资料接口失败后可刷新恢复", async ({ page, request }) => {
  const stamp = Date.now();
  const response = await request.post("/api/projects", {
    data: { name: `S4 资料重试 ${stamp}` },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { project } = await response.json();
  const documentResponse = await request.post(
    `/api/projects/${project.id}/documents`,
    {
      data: {
        kind: "note",
        title: `刷新后显示的项目笔记 ${stamp}`,
        content: "资料接口恢复后可以再次加载。",
      },
    },
  );
  expect(documentResponse.status(), await documentResponse.text()).toBe(201);

  let attempts = 0;
  await page.route(`**/api/projects/${project.id}/documents`, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "DOCUMENTS_UNAVAILABLE",
            message: "项目资料服务暂时不可用",
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/projects/${project.id}`);
  await page.getByRole("tab", { name: "项目资料", exact: true }).click();
  const documents = page.getByRole("region", { name: "项目资料", exact: true });
  await expect(
    documents.getByText("项目资料服务暂时不可用", { exact: true }),
  ).toBeVisible();
  await documents.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    documents.getByText(`刷新后显示的项目笔记 ${stamp}`, { exact: true }),
  ).toBeVisible();
  await expect(
    documents.getByText("项目资料服务暂时不可用", { exact: true }),
  ).toHaveCount(0);
  expect(attempts).toBe(2);
});
