import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const baseURL = "http://127.0.0.1:3012";
const password = "secret123";

type TestClock = { date: string; time: string };

async function register(context: BrowserContext, username: string) {
  const response = await context.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: number; username: string }>;
}

async function setClock(context: BrowserContext, date: string, time: string) {
  const response = await context.request.post("/__test/clock", {
    data: { date, time },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<TestClock>;
}

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

async function openProjectTasks(page: Page, projectId: number) {
  await page.goto(`/projects/${projectId}`);
  await expect(page.locator(".project-header h1")).toBeVisible();
  await page.getByRole("tab", { name: "执行任务", exact: true }).click();
  await expect(page.locator(".tasks-panel")).toBeVisible();
}

async function openTask(page: Page, title: string) {
  const existingDrawer = page.locator(".el-drawer:visible");
  if (await existingDrawer.count()) {
    await existingDrawer.locator(".el-drawer__close-btn").click();
    await expect(existingDrawer).toBeHidden();
  }
  const row = page.locator(".task-table .el-table__row").filter({
    hasText: title,
  });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "查看", exact: true }).click();
  const drawer = page.locator(".el-drawer:visible");
  await expect(drawer).toContainText(title);
  return drawer;
}

async function planFromDrawer(page: Page, date?: string) {
  const drawer = page.locator(".el-drawer:visible");
  await drawer.getByRole("button", { name: "安排到今天" }).click();
  const dialog = page.getByRole("dialog", { name: "安排到个人日程" });
  await expect(dialog).toBeVisible();
  if (date) {
    const datePicker = dialog
      .locator(".el-form-item")
      .filter({ hasText: "业务日期" })
      .locator(".el-input__wrapper");
    await datePicker.click();
    await page
      .locator(".el-picker-panel:visible")
      .getByRole("button", { name: date })
      .click();
  }
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/daily-plans") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "安排并打开日程" }).click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBeTruthy();
  const taskDialog = page.getByRole("dialog", { name: "编辑任务" });
  await expect(taskDialog).toBeVisible();
  await taskDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(taskDialog).toBeHidden();
  await expect(dialog).toBeHidden();
  return response.json() as Promise<{
    id: number;
    planDate: string;
    status: string;
  }>;
}

async function confirmMessageBox(page: Page, buttonName: string) {
  const messageBox = page.locator(".el-message-box:visible");
  await expect(messageBox).toBeVisible();
  await messageBox
    .getByRole("button", { name: buttonName, exact: true })
    .click();
}

test("临时业务时钟严格拒绝非法日期、时间和额外字段", async ({ request }) => {
  const invalid = [
    { date: "2026-02-30", time: "10:00" },
    { date: "2026-2-03", time: "10:00" },
    { date: "2026-02-03", time: "24:00" },
    { date: "2026-02-03", time: "10:0" },
    { date: "2026-02-03", time: "10:00", extra: true },
  ];
  for (const body of invalid) {
    const response = await request.post("http://127.0.0.1:3012/__test/clock", {
      data: body,
    });
    expect(response.status(), JSON.stringify(body)).toBe(400);
  }
});

test("项目任务经跨账号退回重提后完成，跨日个人计时只汇总项目任务工时", async ({
  browser,
}) => {
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ baseURL })),
  );
  const [assigneeContext, confirmerContext] = contexts;
  let initialClock: TestClock | undefined;
  try {
    const stamp = Date.now();
    const assignee = await register(assigneeContext, `task_owner_${stamp}`);
    const confirmer = await register(
      confirmerContext,
      `task_reviewer_${stamp}`,
    );
    const assigneePage = await assigneeContext.newPage();
    const confirmerPage = await confirmerContext.newPage();

    const clockResponse = await assigneeContext.request.get(
      "/api/daily-tasks/active",
    );
    expect(clockResponse.ok()).toBeTruthy();
    const current = (await clockResponse.json()) as { today: string };
    const dayOne = current.today;
    const dayTwo = nextDate(dayOne);
    const beforeControl = await assigneeContext.request.get("/__test/clock");
    expect(beforeControl.ok()).toBeTruthy();
    initialClock = (await beforeControl.json()) as TestClock;

    await setClock(assigneeContext, dayOne, "10:00");
    await assigneePage.clock.install({
      time: new Date(`${dayOne}T10:00:00+08:00`),
    });

    const created = await assigneeContext.request.post("/api/projects", {
      data: { name: `跨日项目任务验收${stamp}` },
    });
    expect(created.ok()).toBeTruthy();
    let project = (await created.json()).project;
    const added = await assigneeContext.request.post(
      `/api/projects/${project.id}/members`,
      {
        data: {
          userId: confirmer.id,
          roles: ["product_owner"],
          expectedVersion: project.version,
        },
      },
    );
    expect(added.ok()).toBeTruthy();
    project = (await added.json()).project;

    const requirementResponse = await assigneeContext.request.post(
      "/api/requirements",
      {
        data: {
          name: `项目任务关联需求${stamp}`,
          projectId: project.id,
          description: "流程验收需求",
          descriptionHtml: "<p>流程验收需求</p>",
          proposedAt: dayOne,
        },
      },
    );
    expect(requirementResponse.ok()).toBeTruthy();
    const requirement = await requirementResponse.json();
    const originalRequirementState = {
      status: requirement.status,
      currentStage: requirement.currentStage,
    };

    await openProjectTasks(assigneePage, project.id);
    await assigneePage
      .getByRole("button", { name: "拆分任务", exact: true })
      .click();
    const form = assigneePage.getByRole("dialog", { name: "拆分项目任务" });
    const title = `跨日实现任务${stamp}`;
    await form.getByRole("textbox", { name: "任务名称" }).fill(title);
    await form
      .getByRole("textbox", { name: "任务说明" })
      .fill("由执行人与产品负责人跨账号确认");
    const requirementField = form
      .locator(".el-form-item")
      .filter({ hasText: "关联末级需求" });
    await requirementField.locator(".el-select").click();
    await assigneePage
      .getByRole("option", {
        name: `${requirement.requirementNo} · ${requirement.name}`,
        exact: true,
      })
      .click();
    const createResponsePromise = assigneePage.waitForResponse(
      (response) =>
        response.url().includes(`/projects/${project.id}/tasks`) &&
        response.request().method() === "POST",
    );
    await form.getByRole("button", { name: "保存任务", exact: true }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    const task = await createResponse.json();
    expect(task).toMatchObject({
      projectId: project.id,
      requirementId: requirement.id,
      assigneeUserId: assignee.id,
      confirmerUserId: confirmer.id,
      status: "pending",
    });

    let drawer = await openTask(assigneePage, title);
    await drawer.getByRole("button", { name: "开始处理" }).click();
    await confirmMessageBox(assigneePage, "开始处理");
    await expect(drawer).toContainText("进行中");

    // 同一项目任务在同一业务日重复安排时应复用原个人日程记录。
    const firstPlan = await planFromDrawer(assigneePage);
    expect(firstPlan.planDate).toBe(dayOne);
    await expect(assigneePage).toHaveURL(/tasks/);
    const firstDailyId = firstPlan.id;

    await openProjectTasks(assigneePage, project.id);
    drawer = await openTask(assigneePage, title);
    const duplicatePlan = await planFromDrawer(assigneePage);
    expect(duplicatePlan.id).toBe(firstDailyId);
    expect(duplicatePlan.planDate).toBe(dayOne);

    const dayOneCard = assigneePage
      .locator(".task-card")
      .filter({ hasText: title });
    await expect(dayOneCard).toBeVisible();
    await dayOneCard.getByRole("button", { name: "开始", exact: true }).click();
    await expect(assigneePage.locator(".timer-bar")).toBeVisible();
    await assigneePage.clock.fastForward(30 * 60 * 1000);
    await setClock(assigneeContext, dayOne, "10:30");
    await assigneePage
      .getByRole("button", { name: "结束", exact: true })
      .click();
    await expect(assigneePage.locator(".timer-bar")).toBeHidden();
    await expect(dayOneCard.getByText("已完成", { exact: true })).toBeVisible();
    let projectTaskAfterPersonalCompletion = await (
      await assigneeContext.request.get(`/api/project-tasks/${task.id}`)
    ).json();
    expect(projectTaskAfterPersonalCompletion.status).toBe("in_progress");

    // 第二个业务日由 harness 时钟推进；项目任务仍处于执行中。
    await setClock(assigneeContext, dayTwo, "10:00");
    await assigneePage.clock.setFixedTime(new Date(`${dayTwo}T10:00:00+08:00`));
    await openProjectTasks(assigneePage, project.id);
    drawer = await openTask(assigneePage, title);
    const secondPlan = await planFromDrawer(assigneePage);
    expect(secondPlan.planDate).toBe(dayTwo);
    expect(secondPlan.id).not.toBe(firstDailyId);
    const dayTwoCard = assigneePage
      .locator(".task-card")
      .filter({ hasText: title });
    await expect(dayTwoCard).toBeVisible();
    await dayTwoCard.getByRole("button", { name: "开始", exact: true }).click();
    await expect(assigneePage.locator(".timer-bar")).toBeVisible();
    await assigneePage.clock.fastForward(60 * 60 * 1000);
    await setClock(assigneeContext, dayTwo, "11:00");
    await assigneePage
      .getByRole("button", { name: "结束", exact: true })
      .click();
    await expect(assigneePage.locator(".timer-bar")).toBeHidden();
    await expect(dayTwoCard.getByText("已完成", { exact: true })).toBeVisible();
    projectTaskAfterPersonalCompletion = await (
      await assigneeContext.request.get(`/api/project-tasks/${task.id}`)
    ).json();
    expect(projectTaskAfterPersonalCompletion.status).toBe("in_progress");

    const dayOneData = await (
      await assigneeContext.request.get(`/api/daily-tasks?date=${dayOne}`)
    ).json();
    const dayTwoData = await (
      await assigneeContext.request.get(`/api/daily-tasks?date=${dayTwo}`)
    ).json();
    const firstDaily = dayOneData.tasks.find(
      (item: { id: number }) => item.id === firstDailyId,
    );
    const secondDaily = dayTwoData.tasks.find(
      (item: { id: number }) => item.id === secondPlan.id,
    );
    expect(firstDaily).toMatchObject({
      id: firstDailyId,
      planDate: dayOne,
      projectTaskId: task.id,
      status: "completed",
      actualSeconds: 30 * 60,
    });
    expect(secondDaily).toMatchObject({
      id: secondPlan.id,
      planDate: dayTwo,
      projectTaskId: task.id,
      status: "completed",
      actualSeconds: 60 * 60,
    });

    // 第二个账号能访问项目任务，但个人日程仍只返回自己的记录。
    for (const date of [dayOne, dayTwo]) {
      const privateDayResponse = await confirmerContext.request.get(
        `/api/daily-tasks?date=${date}`,
      );
      expect(privateDayResponse.ok()).toBeTruthy();
      const privateDay = await privateDayResponse.json();
      expect(privateDay.tasks).toEqual([]);
      expect(JSON.stringify(privateDay)).not.toContain(title);
    }

    await openProjectTasks(assigneePage, project.id);
    drawer = await openTask(assigneePage, title);
    await drawer.getByRole("button", { name: "提交确认", exact: true }).click();
    const submitDialog = assigneePage.getByRole("dialog", {
      name: "提交任务进展",
    });
    await submitDialog
      .getByRole("textbox", { name: "处理说明" })
      .fill("第一版实现已完成");
    await submitDialog
      .getByRole("button", { name: "提交确认", exact: true })
      .click();
    await expect(drawer).toContainText("待确认");

    await openProjectTasks(confirmerPage, project.id);
    await confirmerPage
      .getByRole("tab", { name: "待确认", exact: true })
      .click();
    drawer = await openTask(confirmerPage, title);
    await drawer.getByRole("button", { name: "退回修改", exact: true }).click();
    const returnBox = confirmerPage.locator(".el-message-box:visible");
    await expect(returnBox).toBeVisible();
    await returnBox.getByRole("textbox").fill("补充异常处理后重新提交");
    await returnBox.getByRole("button", { name: "确认", exact: true }).click();
    await expect(drawer).toContainText("进行中");
    await expect(drawer).toContainText("补充异常处理后重新提交");

    await openProjectTasks(assigneePage, project.id);
    drawer = await openTask(assigneePage, title);
    await drawer.getByRole("button", { name: "提交确认", exact: true }).click();
    const resubmitDialog = assigneePage.getByRole("dialog", {
      name: "提交任务进展",
    });
    await resubmitDialog
      .getByRole("textbox", { name: "处理说明" })
      .fill("已补充异常处理并完成复测");
    await resubmitDialog
      .getByRole("button", { name: "提交确认", exact: true })
      .click();
    await expect(drawer).toContainText("待确认");

    await openProjectTasks(confirmerPage, project.id);
    await confirmerPage
      .getByRole("tab", { name: "待确认", exact: true })
      .click();
    drawer = await openTask(confirmerPage, title);
    await drawer.getByRole("button", { name: "通过确认", exact: true }).click();
    await confirmMessageBox(confirmerPage, "通过确认");
    await expect(drawer).toContainText("已完成");
    await expect(drawer).toContainText("已退回");
    await expect(drawer).toContainText("已通过");

    const finalTask = await (
      await assigneeContext.request.get(`/api/project-tasks/${task.id}`)
    ).json();
    expect(finalTask.status).toBe("completed");
    expect(finalTask.submissions).toHaveLength(2);
    expect(
      finalTask.submissions.map(
        (item: { review: { result: string } }) => item.review.result,
      ),
    ).toEqual(["returned", "approved"]);
    expect(finalTask.submissions[0].review.reason).toBe(
      "补充异常处理后重新提交",
    );
    expect(
      finalTask.submissions.map((item: { summary: string }) => item.summary),
    ).toEqual(["第一版实现已完成", "已补充异常处理并完成复测"]);
    expect(
      finalTask.actions.map((item: { action: string }) => item.action),
    ).toEqual(["created", "start", "submit", "return", "submit", "approve"]);

    const finalRequirement = await (
      await assigneeContext.request.get(`/api/requirements/${requirement.id}`)
    ).json();
    expect(finalRequirement).toMatchObject(originalRequirementState);

    const worklogResponse = await assigneeContext.request.get(
      `/api/projects/${project.id}/worklog`,
    );
    expect(worklogResponse.ok()).toBeTruthy();
    const worklog = await worklogResponse.json();
    expect(worklog).toMatchObject({
      totalSeconds: 90 * 60,
      items: [
        {
          projectTaskId: task.id,
          title,
          assigneeUserId: assignee.id,
          totalSeconds: 90 * 60,
        },
      ],
    });

    await openProjectTasks(assigneePage, project.id);
    await assigneePage
      .getByRole("tab", { name: "项目工时", exact: true })
      .click();
    await expect(assigneePage.locator(".worklog .total strong")).toHaveText(
      "1 小时 30 分钟",
    );
    await expect(assigneePage.locator(".worklog .el-table__row")).toHaveCount(
      1,
    );
    await expect(assigneePage.locator(".worklog .el-table__row")).toContainText(
      title,
    );
  } finally {
    if (initialClock) {
      await setClock(
        assigneeContext,
        initialClock.date,
        initialClock.time,
      ).catch(() => undefined);
    }
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});
