import { test, expect, type Page } from "@playwright/test";

function stageSelect(page: Page) {
  return page
    .locator("label.field")
    .filter({ has: page.getByText("当前阶段", { exact: true }) })
    .locator(".el-select");
}

test("普通成员协作、外人隔离、降为只读及移除后清理详情", async ({
  browser,
}) => {
  const contexts = await Promise.all(
    [0, 1, 2].map(() =>
      browser.newContext({ baseURL: "http://127.0.0.1:3012" }),
    ),
  );
  try {
    const users = [];
    const stamp = Date.now();
    for (const [index, context] of contexts.entries()) {
      const registration = await context.request.post("/api/auth/register", {
        data: { username: `ordinary_${stamp}_${index}`, password: "secret123" },
      });
      expect(registration.ok()).toBeTruthy();
      users.push(await registration.json());
    }
    const [owner, member, outsider] = contexts;
    let project = (
      await (
        await owner.request.post("/api/projects", {
          data: { name: `普通账号协作${stamp}` },
        })
      ).json()
    ).project;
    const added = await owner.request.post(
      `/api/projects/${project.id}/members`,
      {
        data: {
          userId: users[1].id,
          roles: ["product_owner"],
          expectedVersion: project.version,
        },
      },
    );
    expect(added.ok()).toBeTruthy();
    project = (await added.json()).project;
    const requirement = await (
      await owner.request.post("/api/requirements", {
        data: {
          name: `协作需求${stamp}`,
          projectId: project.id,
          description: "团队正文",
          descriptionHtml: "<p>团队正文</p>",
          proposedAt: "2026-11-19",
        },
      })
    ).json();
    const page = await member.newPage();
    await page.goto(`/requirements/${requirement.id}`);
    await expect(
      page.getByRole("heading", { name: requirement.name, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: /^验收标准/ })
      .fill("普通产品负责人补充验收标准");
    await expect
      .poll(
        async () =>
          (
            await (
              await owner.request.get(`/api/requirements/${requirement.id}`)
            ).json()
          ).acceptanceCriteria,
      )
      .toBe("普通产品负责人补充验收标准");
    const deniedPage = await outsider.newPage();
    await deniedPage.goto(`/requirements/${requirement.id}`);
    await expect(
      deniedPage.getByText("该需求已不可访问，已清理内容和本地草稿。"),
    ).toBeVisible();
    await expect(
      deniedPage.getByRole("heading", { name: requirement.name, exact: true }),
    ).toHaveCount(0);
    const demoted = await owner.request.patch(
      `/api/projects/${project.id}/members/${users[1].id}`,
      {
        data: {
          userId: users[1].id,
          roles: ["viewer"],
          expectedVersion: project.version,
        },
      },
    );
    expect(demoted.ok()).toBeTruthy();
    project = (await demoted.json()).project;
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "需求名称", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("textbox", { name: /^验收标准/ }),
    ).toBeDisabled();
    await expect(stageSelect(page).getByRole("combobox")).toBeDisabled();
    await expect(page.locator(".detail-desc .tiptap")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await expect(
      page.getByRole("button", { name: "立即保存", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: "test-results/project-viewer-detail.png",
      fullPage: true,
      animations: "disabled",
    });
    const removed = await owner.request.delete(
      `/api/projects/${project.id}/members/${users[1].id}`,
      { data: { expectedVersion: project.version } },
    );
    expect(removed.ok()).toBeTruthy();
    await page.reload();
    await expect(
      page.getByText("该需求已不可访问，已清理内容和本地草稿。"),
    ).toBeVisible();
    await expect(page.locator(".detail-desc .tiptap")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: requirement.name, exact: true }),
    ).toHaveCount(0);
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});

test("详情跳过或退回阶段必须确认原因，取消不改动服务端", async ({
  page,
  request,
}) => {
  const requirement = await (
    await request.post("/api/requirements", {
      data: { name: `阶段原因${Date.now()}`, proposedAt: "2026-11-19" },
    })
  ).json();
  await page.goto(`/requirements/${requirement.id}`);
  await stageSelect(page).click();
  await page.getByRole("option", { name: "开发跟进", exact: true }).click();
  let prompt = page.getByRole("dialog", { name: "阶段变更原因" });
  await expect(prompt).toBeVisible();
  expect(
    (await (await request.get(`/api/requirements/${requirement.id}`)).json())
      .currentStage,
  ).toBe("analysis");
  await prompt.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".head-stage")).toHaveText("需求分析");
  for (const [label, value, reason] of [
    ["开发跟进", "development", "已有设计说明，确认跳过设计阶段"],
    ["需求分析", "analysis", "客户新增信息，退回分析确认"],
  ]) {
    await stageSelect(page).click();
    await page.getByRole("option", { name: label, exact: true }).click();
    prompt = page.getByRole("dialog", { name: "阶段变更原因" });
    await prompt.getByRole("textbox").fill(reason);
    await prompt.getByRole("button", { name: "确认变更", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`/api/requirements/${requirement.id}`)
            ).json()
          ).currentStage,
      )
      .toBe(value);
  }
  const history = await (
    await request.get(`/api/requirements/${requirement.id}/history`)
  ).json();
  expect(history.map((entry: { note: string }) => entry.note)).toEqual([
    "已有设计说明，确认跳过设计阶段",
    "客户新增信息，退回分析确认",
  ]);
});

test("BUG004 迟到的引用解析不会覆盖已输入正文", async ({ page, request }) => {
  const target = await (
    await request.post("/api/requirements", {
      data: { name: `引用目标${Date.now()}`, proposedAt: "2026-11-19" },
    })
  ).json();
  const source = await (
    await request.post("/api/requirements", {
      data: {
        name: "引用延迟输入验证",
        proposedAt: "2026-11-19",
        description: "保存的旧正文",
        descriptionHtml: `<p>保存的旧正文<span data-requirement-id="${target.id}" data-requirement-name="旧引用名称" data-requirement-code="${target.requirementNo}">旧引用名称</span></p>`,
      },
    })
  ).json();
  const resolving = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/requirements/references?**", async (route) => {
    const response = await route.fetch();
    resolving.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.goto(`/requirements/${source.id}`);
  await resolving.promise;
  const editor = page.locator(".detail-desc .tiptap");
  const input = "引用解析尚未返回时继续输入的新正文";
  await editor.fill(input);
  const response = page.waitForResponse("**/api/requirements/references?**");
  release.resolve();
  await response;
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/requirements/${source.id}`)).json())
          .description,
    )
    .toBe(input);
  await expect(editor).toHaveText(input);
  const saved = await (
    await request.get(`/api/requirements/${source.id}`)
  ).json();
  expect(saved).toMatchObject({
    type: source.type,
    priority: source.priority,
    status: source.status,
    currentStage: source.currentStage,
  });
  await page.reload();
  await expect(editor).toHaveText(input);
  await expect(page.locator(".head-stage")).toHaveText("需求分析");
  for (const label of ["新功能", "P2", "未开始", "需求分析"]) {
    await expect(
      page
        .locator(".detail-fields .el-select__selected-item")
        .getByText(label, { exact: true }),
    ).toBeVisible();
  }
  await page.screenshot({
    path: "test-results/bug004-reference-delay.png",
    fullPage: true,
    animations: "disabled",
  });
});
