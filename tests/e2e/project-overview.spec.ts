import { expect, test } from "@playwright/test";

test("项目概览显示真实逾期任务并打开对应任务详情", async ({ page }) => {
  const projectResponse = await page.request.post("/api/projects", {
    data: { name: "概览验收：逾期任务" },
  });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const { project } = await projectResponse.json();
  const title = "概览入口定位的执行任务";
  const taskResponse = await page.request.post(
    "/api/projects/" + project.id + "/tasks",
    {
      data: {
        title,
        type: "development",
        assigneeUserId: project.ownerUserId,
        confirmerUserId: project.ownerUserId,
        dueDate: "2000-01-01",
      },
    },
  );
  expect(taskResponse.status(), await taskResponse.text()).toBe(201);
  await page.goto("/projects/" + project.id);
  const overview = page.getByRole("region", { name: "项目概览", exact: true });
  const risk = overview.getByRole("button", { name: /逾期/ });
  await expect(risk).toHaveCount(1);
  await risk.click();
  await expect(
    page.getByRole("tab", { name: "执行任务", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog", { name: title })).toBeVisible();
});

test("项目概览空态与长名称在窄屏保持可用", async ({ page, request }) => {
  const name = "窄屏概览项目" + "很长".repeat(60);
  const created = await request.post("/api/projects", { data: { name } });
  expect(created.status(), await created.text()).toBe(201);
  const { project } = await created.json();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/projects/" + project.id);
  const overview = page.getByRole("region", { name: "项目概览", exact: true });
  await expect(overview).toBeVisible();
  await expect(page.locator(".identity h1")).toHaveAttribute("title", name);
  await expect(overview.getByText("当前没有可统计的承诺需求", { exact: true })).toBeVisible();
  await expect(overview.getByText("确认范围", { exact: true })).toBeVisible();
  await expect(overview.getByText("当前没有需要关注的风险", { exact: true })).toBeVisible();
  const fitsViewport = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  );
  expect(fitsViewport).toBe(true);
});

test("项目概览接口失败后可重试恢复", async ({ page, request }) => {
  const created = await request.post("/api/projects", {
    data: { name: "概览错误恢复" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { project } = await created.json();
  let attempts = 0;
  await page.route("**/api/projects/" + project.id + "/overview", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "OVERVIEW_UNAVAILABLE", message: "概览服务暂时不可用" },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/projects/" + project.id);
  const overview = page.getByRole("region", { name: "项目概览", exact: true });
  await expect(overview.getByText("概览服务暂时不可用", { exact: true })).toBeVisible();
  await overview.getByRole("button", { name: "重试", exact: true }).click();
  await expect(overview.getByRole("heading", { name: "当前交付范围", exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test("项目资料可创建并在项目动态中显示具体动作", async ({ page, request }) => {
  const projectResponse = await request.post("/api/projects", {
    data: { name: "资料与动态联动验收" },
  });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const { project } = await projectResponse.json();

  await page.goto("/projects/" + project.id);
  await page.getByRole("tab", { name: "项目资料", exact: true }).click();
  await page.getByRole("button", { name: "新增资料" }).first().click();
  await page.getByRole("menuitem", { name: "项目笔记", exact: true }).click();
  await page.getByLabel("标题").fill("联调记录");
  await page.getByLabel("正文").fill("资料面板已正常保存。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("联调记录", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "项目动态", exact: true }).click();
  await expect(page.getByText("新增了项目资料", { exact: true })).toBeVisible();
});
