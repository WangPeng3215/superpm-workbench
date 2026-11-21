import { test, expect } from "@playwright/test";
test("项目权限回查暂不可用暂停行内保存并保留会话草稿", async ({
  page,
  request,
}) => {
  const project = (
    await (
      await request.post("/api/projects", {
        data: { name: `权限暂停${Date.now()}` },
      })
    ).json()
  ).project;
  const name = `权限回查行内${Date.now()}`;
  const item = await (
    await request.post("/api/requirements", {
      data: { name, proposedAt: "2026-11-20", projectId: project.id },
    })
  ).json();
  await page.goto("/requirements");
  await page.getByRole("button", { name, exact: true }).click();
  const input = page
    .locator("tr.editing-row")
    .getByRole("textbox", { name: "需求名称", exact: true });
  await expect(input).toBeVisible();
  await page.route(`**/api/projects/${project.id}`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "TEMPORARY", message: "暂不可用" } },
    }),
  );
  await input.fill(`${name}未丢失`);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.locator(".error-alert")).toContainText("本地草稿已保留");
  await expect(input).toHaveValue(`${name}未丢失`);
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith("superpm.requirement-table-draft"))
        .some((key) => sessionStorage.getItem(key)?.includes("未丢失")),
    ),
  ).toBe(true);
  expect(
    (await (await request.get(`/api/requirements/${item.id}`)).json()).name,
  ).toBe(name);
  await page.unroute(`**/api/projects/${project.id}`);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/requirements/${item.id}`)).json()).name,
    )
    .toBe(`${name}未丢失`);
});
test("创建项目响应丢失后重试只创建一次", async ({ page, request }) => {
  const name = `创建响应丢失${Date.now()}`;
  const keys: string[] = [];
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 1) {
      await route.fetch();
      return route.abort("failed");
    }
    await route.continue();
  });
  await page.goto("/projects");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("项目名称").fill(name);
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("无法连接本地服务");
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  expect(keys[0]).toBeTruthy();
  expect(keys).toEqual([keys[0], keys[0]]);
  expect(
    (
      await (
        await request.get(`/api/projects?q=${encodeURIComponent(name)}`)
      ).json()
    ).total,
  ).toBe(1);
});
test("行内冲突刷新恢复草稿，跳阶段先确认原因", async ({ page, request }) => {
  const name = `行内草稿${Date.now()}`;
  const item = await (
    await request.post("/api/requirements", {
      data: { name, proposedAt: "2026-11-20" },
    })
  ).json();
  await page.goto("/requirements");
  const nameButton = page.getByRole("button", { name, exact: true });
  await nameButton.click();
  await request.patch(`/api/requirements/${item.id}`, {
    data: { name: `${name}服务端`, expectedVersion: item.version },
  });
  const input = page
    .locator("tr.editing-row")
    .getByRole("textbox", { name: "需求名称", exact: true });
  await input.fill(`${name}本地`);
  await expect(page.getByRole("alert")).toContainText("本地草稿已保留");
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(input).toHaveValue(`${name}本地`);
  await expect(page.getByRole("alert")).toContainText("本地会话草稿已恢复");
  expect(
    (await (await request.get(`/api/requirements/${item.id}`)).json()).name,
  ).toBe(`${name}服务端`);
  await page
    .getByRole("button", { name: "放弃未保存修改", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "放弃修改", exact: true })
    .click();
  await page
    .getByRole("button", { name: `${name}服务端`, exact: true })
    .click();
  const stage = page
    .locator("tr.editing-row")
    .getByRole("combobox", { name: "当前阶段", exact: true });
  await stage.press("ArrowDown");
  await page.getByRole("option", { name: "开发跟进", exact: true }).click();
  const reason = page.getByRole("dialog", { name: "阶段变更原因" });
  await expect(reason).toBeVisible();
  expect(
    (await (await request.get(`/api/requirements/${item.id}`)).json())
      .currentStage,
  ).toBe("analysis");
  await reason.getByRole("textbox").fill("业务已完成线下设计确认");
  await reason.getByRole("button", { name: "确认变更", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/requirements/${item.id}`)).json())
          .currentStage,
    )
    .toBe("development");
  expect(
    (
      await (await request.get(`/api/requirements/${item.id}/history`)).json()
    ).some(
      (entry: { note: string }) => entry.note === "业务已完成线下设计确认",
    ),
  ).toBe(true);
});
test("项目生命周期显式记录原因且取消后可归档与重开", async ({
  page,
  request,
}) => {
  const created = await (
    await request.post("/api/projects", {
      data: { name: `项目生命周期${Date.now()}` },
    })
  ).json();
  const id = created.project.id;
  await page.goto(`/projects/${id}`);
  await page.getByRole("button", { name: "开始项目", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "开始项目", exact: true })
    .click();
  await expect(page.locator(".project-status .el-tag").first()).toHaveText(
    "进行中",
  );
  await expect(page.getByRole("button", { name: "结项项目", exact: true })).toBeVisible();
  for (const [button, reason, expected] of [
    ["暂停项目", "等待业务确认", "已暂停"],
    ["恢复项目", "业务已确认", "进行中"],
    ["取消项目", "业务方向调整", "已取消"],
  ]) {
    await page.getByRole("button", { name: button, exact: true }).click();
    const prompt = page.getByRole("dialog");
    await prompt.getByRole("textbox").fill(reason);
    await prompt.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.locator(".project-status .el-tag").first()).toHaveText(
      expected,
    );
  }
  await expect(page.getByLabel("项目名称", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "归档项目", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "解除归档", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "解除归档", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await page.getByRole("button", { name: "重开项目", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("重新确认推进");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(page.locator(".project-status .el-tag").first()).toHaveText(
    "进行中",
  );
  await expect(page.getByLabel("项目名称", { exact: true })).toBeEnabled();
  expect(
    (await (await request.get(`/api/projects/${id}/events`)).json()).items.map(
      (event: { action: string }) => event.action,
    ),
  ).toEqual(
    expect.arrayContaining([
      "project_start",
      "project_pause",
      "project_resume",
      "project_cancel",
      "project_archived",
      "project_restored",
      "project_reopen",
    ]),
  );
});
test("默认交付验收通过后可结项并重开，保留结项历史", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const created = await (
    await request.post("/api/projects", {
      data: { name: `默认交付结项${stamp}` },
    })
  ).json();
  const projectId = created.project.id as number;
  const requirement = await (
    await request.post("/api/requirements", {
      data: {
        name: `默认交付范围${stamp}`,
        proposedAt: "2026-11-20",
        projectId,
        acceptanceCriteria: "用户可完成登录并看到首页",
      },
    })
  ).json();
  const projectRequirements = await (
    await request.get(`/api/requirements?projectId=${projectId}&page=1&pageSize=100`)
  ).json();
  expect(projectRequirements.items.map((item: { id: number }) => item.id)).toContain(
    requirement.id,
  );

  await page.goto(`/projects/${projectId}`);
  await page.getByRole("button", { name: "开始项目", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "开始项目", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "结项项目", exact: true }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "交付验收", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "交付验收" });
  await expect(panel.getByText("默认交付", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "确认范围", exact: true }).click();
  await page
    .getByRole("dialog", { name: "确认交付范围" })
    .locator("label.el-checkbox")
    .filter({ hasText: `默认交付范围${stamp}` })
    .click();
  await page
    .getByRole("dialog", { name: "确认交付范围" })
    .getByRole("button", { name: "确认范围", exact: true })
    .click();

  await panel.getByRole("button", { name: "提交验收", exact: true }).click();
  const submission = page.getByRole("dialog", { name: "提交交付验收" });
  await submission.getByLabel("不可变文本证据").fill("版本 1.0 已部署，登录验收通过");
  await submission.getByRole("button", { name: "提交给验收人", exact: true }).click();
  await expect(panel.getByRole("heading", { name: /待验收/ })).toBeVisible();
  await panel
    .locator("label.el-radio-button")
    .filter({ hasText: /^通过$/ })
    .click();
  await expect(
    panel.getByRole("button", { name: "提交验收结果", exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "提交验收结果", exact: true })
    .click();
  await expect(panel.getByText("通过", { exact: true })).toBeVisible();
  expect(
    (await (await request.get(`/api/deliveries/${(await request.get(`/api/projects/${projectId}/deliveries`).then((r) => r.json())).items[0].id}/acceptance-rounds`)).json())[0].status,
  ).toBe("passed");

  await page.getByRole("button", { name: "结项项目", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("默认交付已验收通过");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(page.locator(".project-status .el-tag").first()).toHaveText(
    "已结项",
  );
  expect(
    (await (await request.get(`/api/projects/${projectId}/closures`)).json()).map(
      (closure: { action: string }) => closure.action,
    ),
  ).toEqual(["close"]);

  await page.getByRole("button", { name: "重开项目", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("继续维护项目");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(page.locator(".project-status .el-tag").first()).toHaveText(
    "进行中",
  );
  expect(
    (await (await request.get(`/api/projects/${projectId}/closures`)).json()).map(
      (closure: { action: string }) => closure.action,
    ),
  ).toEqual(["close", "reopen"]);
  expect(
    (await (await request.get(`/api/projects/${projectId}/events`)).json()).items.map(
      (event: { action: string }) => event.action,
    ),
  ).toEqual(expect.arrayContaining(["project_closed", "project_reopen"]));
  expect(requirement.projectId).toBe(projectId);
});

test("验收不通过关联问题后可重新提交并通过", async ({ page, request }) => {
  const stamp = Date.now();
  const created = await (
    await request.post("/api/projects", { data: { name: `验收重提项目${stamp}` } })
  ).json();
  const projectId = created.project.id as number;
  const requirement = await (
    await request.post("/api/requirements", {
      data: {
        name: `验收重提范围${stamp}`,
        proposedAt: "2026-11-20",
        projectId,
        acceptanceCriteria: "页面展示用户资料",
      },
    })
  ).json();
  const issue = await (
    await request.post(`/api/requirements/${requirement.id}/issues`, {
      data: { title: `用户资料未展示${stamp}`, description: "缺少资料区块" },
    })
  ).json();
  const issueList = await (
    await request.get(`/api/requirements/${requirement.id}/issues`)
  ).json();
  expect(issueList.items.map((item: { id: number }) => item.id)).toContain(
    issue.id,
  );

  await page.goto(`/projects/${projectId}`);
  await page.getByRole("button", { name: "开始项目", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "开始项目", exact: true }).click();
  await page.getByRole("tab", { name: "交付验收", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "交付验收" });
  await panel.getByRole("button", { name: "确认范围", exact: true }).click();
  await page
    .getByRole("dialog", { name: "确认交付范围" })
    .locator("label.el-checkbox")
    .filter({ hasText: `验收重提范围${stamp}` })
    .click();
  await page.getByRole("dialog", { name: "确认交付范围" }).getByRole("button", { name: "确认范围", exact: true }).click();

  const submitRound = async (evidence: string) => {
    await panel.getByRole("button", { name: "提交验收", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "提交交付验收" });
    await dialog.getByLabel("不可变文本证据").fill(evidence);
    await dialog.getByRole("button", { name: "提交给验收人", exact: true }).click();
    await expect(panel.getByRole("heading", { name: /待验收/ })).toBeVisible();
  };
  const selectOutcome = async (label: string) =>
    panel
      .locator("label.el-radio-button")
      .filter({ hasText: new RegExp(`^${label}$`) });

  await submitRound("首轮验收发现问题");
  await (await selectOutcome("不通过")).click();
  await panel.getByPlaceholder("填写不通过原因").fill("资料区块未显示");
  await panel.locator(".acceptance-section .el-select").click();
  await page.getByRole("option", { name: issue.title, exact: true }).click();
  await panel.getByRole("button", { name: "提交验收结果", exact: true }).click();

  const delivery = (await (await request.get(`/api/projects/${projectId}/deliveries`)).json()).items[0];
  const rounds = await (await request.get(`/api/deliveries/${delivery.id}/acceptance-rounds`)).json();
  expect(rounds[0].status).toBe("failed");
  expect(rounds[0].items[0]).toMatchObject({
    result: "failed",
    reason: "资料区块未显示",
    issueId: issue.id,
  });

  await submitRound("资料区块已修复并重新验收");
  await (await selectOutcome("通过")).click();
  await panel.getByRole("button", { name: "提交验收结果", exact: true }).click();
  const completedRounds = await (
    await request.get(`/api/deliveries/${delivery.id}/acceptance-rounds`)
  ).json();
  expect(completedRounds.map((round: { status: string }) => round.status)).toEqual(["failed", "passed"]);
  expect(completedRounds[1].items[0].result).toBe("passed");
});
test("私人需求整树先预览再确认共享", async ({ page, request }) => {
  const stamp = Date.now();
  const root = await (
    await request.post("/api/requirements", {
      data: { name: `待共享主需求${stamp}`, proposedAt: "2026-11-19" },
    })
  ).json();
  const child = await (
    await request.post("/api/requirements", {
      data: {
        name: `待共享子需求${stamp}`,
        parentId: root.id,
        proposedAt: "2026-11-19",
      },
    })
  ).json();
  const created = await (
    await request.post("/api/projects", {
      data: { name: `共享目标项目${stamp}` },
    })
  ).json();
  const id = created.project.id;
  await page.goto(`/projects/${id}`);
  await page.getByRole("tab", { name: "项目需求", exact: true }).click();
  await page
    .getByRole("button", { name: "关联已有私人需求", exact: true })
    .click();
  const picker = page.getByRole("dialog");
  await picker.getByRole("textbox", { name: "搜索私人需求" }).fill(root.name);
  await picker.getByRole("button", { name: "搜索", exact: true }).click();
  await picker.getByText(root.name, { exact: true }).click();
  await picker
    .getByRole("button", { name: "预览共享范围", exact: true })
    .click();
  await expect(picker.getByText(root.name, { exact: true })).toBeVisible();
  await expect(picker.getByText(child.name, { exact: true })).toBeVisible();
  await expect(picker.getByText(/项目有效成员将可以按角色访问/)).toBeVisible();
  expect(
    (await (await request.get(`/api/requirements/${root.id}`)).json())
      .projectId,
  ).toBeNull();
  await picker
    .getByRole("button", { name: "确认共享并关联", exact: true })
    .click();
  await expect(picker).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: root.name, exact: true }),
  ).toBeVisible();
  expect(
    (await (await request.get(`/api/requirements/${root.id}`)).json())
      .projectId,
  ).toBe(id);
  expect(
    (await (await request.get(`/api/requirements/${child.id}`)).json())
      .projectId,
  ).toBe(id);
});

test("项目延迟保存保留新输入并用最新版本排队", async ({ page, request }) => {
  const created = await (
    await request.post("/api/projects", {
      data: { name: `并发编辑项目${Date.now()}` },
    })
  ).json();
  const id = created.project.id,
    versions: number[] = [];
  await page.route(`**/api/projects/${id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      versions.push(route.request().postDataJSON().expectedVersion);
      if (versions.length === 1)
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });
  await page.goto(`/projects/${id}`);
  const input = page.getByLabel("项目目标", { exact: true });
  await input.fill("第一次编辑");
  await expect.poll(() => versions.length).toBe(1);
  await input.fill("保存期间继续输入");
  await expect(page.locator(".save-state")).toHaveText("已自动保存");
  await expect(input).toHaveValue("保存期间继续输入");
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/projects/${id}`)).json()).project.goal,
    )
    .toBe("保存期间继续输入");
  expect(versions).toEqual([1, 2]);
  await page.screenshot({
    path: "test-results/projects-overview.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("项目版本冲突保留本地草稿且不会自动覆盖服务器", async ({
  page,
  request,
}) => {
  const created = await (
    await request.post("/api/projects", {
      data: { name: `冲突项目${Date.now()}` },
    })
  ).json();
  const id = created.project.id;
  await page.goto(`/projects/${id}`);
  await expect(
    page.getByRole("heading", { name: created.project.name }),
  ).toBeVisible();
  expect(
    (
      await request.patch(`/api/projects/${id}`, {
        data: { goal: "其他成员的新目标", expectedVersion: 1 },
      })
    ).ok(),
  ).toBeTruthy();
  await page.getByLabel("项目目标", { exact: true }).fill("我的未保存目标");
  await expect(page.locator(".save-state")).toHaveText("存在版本冲突");
  await expect(
    page.getByRole("button", { name: "复制本地草稿" }),
  ).toBeVisible();
  await expect(page.getByLabel("项目目标", { exact: true })).toHaveValue(
    "我的未保存目标",
  );
  expect(
    (await (await request.get(`/api/projects/${id}`)).json()).project.goal,
  ).toBe("其他成员的新目标");
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.locator(".save-state")).toHaveText("存在版本冲突");
  await expect(page.getByLabel("项目目标", { exact: true })).toHaveValue(
    "我的未保存目标",
  );
});
test("真实项目自动保存、成员维护和固定项目需求作用域", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString();
  const username = `prj${suffix.slice(-9)}`;
  const registered = await request.post("/api/auth/register", {
    data: { username, password: "secret123", displayName: `协作成员${suffix}` },
  });
  expect(registered.ok()).toBeTruthy();
  const candidate = await registered.json();
  await request.post("/api/auth/login", {
    data: { username: "admin", password: "admin123" },
  });
  const name = `项目闭环${suffix}`;
  await page.goto("/projects");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByRole("dialog").getByLabel("项目名称").fill(name);
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建项目", exact: true })
    .click();
  const projectDetail = await (await created).json();
  const projectId = projectDetail.project.id;
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByLabel("项目目标", { exact: true }).fill("第一阶段协作目标");
  await expect(page.locator(".save-state")).toContainText("已自动保存");
  const saved = await (await request.get(`/api/projects/${projectId}`)).json();
  expect(saved.project.goal).toBe("第一阶段协作目标");
  expect(saved.project.version).toBe(2);
  await page.getByRole("button", { name: new RegExp("^成员 ") }).click();
  const membersDialog = page.getByRole("dialog", { name: "项目成员" });
  await membersDialog
    .getByRole("combobox", { name: "搜索项目成员账号" })
    .fill(username);
  await page
    .getByRole("option", {
      name: `${candidate.displayName}（${username}）`,
      exact: true,
    })
    .click();
  await membersDialog
    .getByRole("combobox", { name: "新增成员角色" })
    .press("ArrowDown");
  await page.getByRole("option", { name: "产品负责人", exact: true }).click();
  await page.keyboard.press("Escape");
  await membersDialog
    .getByRole("button", { name: "添加成员", exact: true })
    .click();
  await expect(
    membersDialog.getByText(candidate.displayName, { exact: true }),
  ).toBeVisible();
  const memberState = await (
    await request.get(`/api/projects/${projectId}`)
  ).json();
  expect(
    memberState.members.find(
      (member: { userId: number }) => member.userId === candidate.id,
    ).roles,
  ).toEqual(expect.arrayContaining(["contributor", "product_owner"]));
  await membersDialog
    .getByRole("combobox", { name: "主要产品负责人" })
    .press("ArrowDown");
  await page
    .getByRole("option", { name: candidate.displayName, exact: true })
    .click();
  await membersDialog
    .getByRole("button", { name: "保存主要负责人", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/projects/${projectId}`)).json()).project
          .productOwnerUserId,
    )
    .toBe(candidate.id);
  await membersDialog
    .getByRole("button", { name: "完成", exact: true })
    .click();
  await page.getByRole("tab", { name: "项目需求", exact: true }).click();
  await page.getByRole("button", { name: "添加需求", exact: true }).click();
  const reqName = `项目内需求${suffix}`;
  await page
    .locator("tr.editing-row")
    .getByRole("textbox", { name: "需求名称" })
    .fill(reqName);
  const reqResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/requirements") &&
      response.request().method() === "POST",
  );
  await page
    .locator("tr.editing-row")
    .getByRole("button", { name: "创建", exact: true })
    .click();
  const requirement = await (await reqResponse).json();
  expect(requirement.projectId).toBe(projectId);
  expect(requirement.version).toBe(1);
  await expect(
    page.getByRole("button", { name: reqName, exact: true }),
  ).toBeVisible();
  const resetResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/requirements?") &&
      new URL(response.url()).searchParams.get("projectId") ===
        String(projectId),
  );
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await resetResponse;
  const privateReq = await request.post("/api/requirements", {
    data: { name: `私人需求${suffix}`, proposedAt: "2026-11-19" },
  });
  expect(privateReq.ok()).toBeTruthy();
  await page.goto("/requirements");
  await page
    .locator(".filter-fields .el-form-item")
    .filter({ hasText: /^项目/ })
    .locator(".el-select")
    .click();
  await page.getByRole("option", { name, exact: true }).click();
  const filterResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/requirements?") &&
      new URL(response.url()).searchParams.get("projectId") ===
        String(projectId) &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await filterResponse;
  await expect(page.locator(".el-loading-mask:visible")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: reqName, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `私人需求${suffix}`, exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/projects-global-requirements.png",
    fullPage: true,
    animations: "disabled",
  });
  const row = page
    .getByRole("button", { name: reqName, exact: true })
    .locator("xpath=ancestor::tr");
  await row.getByRole("button", { name: "详情", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/requirements/${requirement.id}$`));
  await page.reload();
  await expect(
    page.getByRole("heading", { name: reqName, exact: true }),
  ).toBeVisible();
  const assignee = page
    .locator("label.field")
    .filter({ has: page.getByText("需求负责人", { exact: true }) })
    .getByRole("combobox");
  const developerField = page
    .locator("label.field")
    .filter({ has: page.getByText("开发负责人", { exact: true }) });
  await assignee.press("ArrowDown");
  await page
    .getByRole("option", { name: candidate.displayName, exact: true })
    .click();
  await developerField.getByRole("combobox").press("ArrowDown");
  const developerOptions = page.locator(
    `#${await developerField.getByRole("combobox").getAttribute("aria-controls")}`,
  );
  await developerOptions
    .getByRole("option", { name: candidate.displayName, exact: true })
    .click();
  const acceptance = page
    .locator("label.field")
    .filter({ has: page.getByText("验收标准", { exact: true }) })
    .getByRole("textbox");
  await acceptance.fill("责任移交后可读取项目资料，验收按约定用例通过");
  await expect
    .poll(async () => {
      const current = await (
        await request.get(`/api/requirements/${requirement.id}`)
      ).json();
      return [
        current.assigneeUserId,
        current.developerUserId,
        current.acceptanceCriteria,
      ];
    })
    .toEqual([
      candidate.id,
      candidate.id,
      "责任移交后可读取项目资料，验收按约定用例通过",
    ]);
  await developerField.hover();
  await developerField.locator(".el-select__clear").click();
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(`/api/requirements/${requirement.id}`)
          ).json()
        ).developerUserId,
    )
    .toBeNull();
  await page.reload();
  await expect(assignee.locator("xpath=ancestor::label")).toContainText(
    candidate.displayName,
  );
  await expect(developerField.getByRole("combobox")).toHaveValue("");
  await expect(acceptance).toHaveValue(
    "责任移交后可读取项目资料，验收按约定用例通过",
  );
  await page.screenshot({
    path: "test-results/projects-requirement-detail.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.goto("/requirements");
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/requirements/${requirement.id}`) &&
      response.request().method() === "DELETE",
  );
  await page
    .getByRole("button", { name: reqName, exact: true })
    .locator("xpath=ancestor::tr")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  expect((await deleteResponse).ok()).toBe(true);
  await expect(
    page.getByRole("button", { name: reqName, exact: true }),
  ).toHaveCount(0);
});
test("项目名称即可创建，列表查询按钮同一行且进入唯一项目详情", async ({
  page,
}) => {
  const project = {
    id: 101,
    projectNo: "PRJ-0101",
    name: "项目协作初版",
    goal: "",
    scopeSummary: "",
    customerName: "",
    customerContact: "",
    plannedStartDate: null,
    targetDeliveryDate: null,
    ownerUserId: 1,
    productOwnerUserId: 1,
    status: "planning",
    previousStatus: null,
    version: 1,
    archivedAt: null,
    createdBy: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const detail = {
    project,
    members: [
      {
        projectId: 101,
        userId: 1,
        displayName: "测试负责人",
        username: "test",
        roles: ["owner", "product_owner"],
        status: "active",
        accountStatus: "active",
      },
    ],
    capabilities: {
      canEditProject: true,
      canManageMembers: true,
      canManageRequirements: true,
    },
  };
  await page.route("**/api/projects**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/projects") {
      if (route.request().method() === "POST")
        expect(route.request().postDataJSON()).toEqual({ name: project.name });
      return route.fulfill({
        json:
          route.request().method() === "POST"
            ? detail
            : { items: [], total: 0, page: 1, pageSize: 20 },
      });
    }
    if (url.pathname.endsWith("/events"))
      return route.fulfill({
        json: { items: [], hasMore: false, nextCursor: null },
      });
    return route.fulfill({ json: detail });
  });
  await page.goto("/projects");
  await expect(
    page.getByRole("heading", { name: "项目管理", exact: true }),
  ).toHaveCount(0);
  const query = await page
    .getByRole("button", { name: "查询", exact: true })
    .boundingBox();
  const create = await page
    .getByRole("button", { name: "新建项目", exact: true })
    .boundingBox();
  expect(Math.abs(query!.y - create!.y)).toBeLessThan(2);
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByRole("dialog").getByLabel("项目名称").fill(project.name);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建项目", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp("/projects/101$"));
  await expect(
    page.getByRole("heading", { name: project.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "提交验收", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "结项", exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 900, height: 900 });
  const backToList = page.getByRole("button", {
    name: "返回项目列表",
    exact: true,
  });
  await expect(backToList).toBeVisible();
  const projectHeader = await page.locator(".project-header").boundingBox();
  expect(projectHeader?.height).toBeLessThanOrEqual(28);
  await page.screenshot({
    path: "test-results/projects-header-narrow.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 800, height: 900 });
  const compactHeader = await page.locator(".project-header").boundingBox();
  expect(compactHeader?.height).toBeLessThanOrEqual(28);
  await expect(backToList).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileHeader = await page.locator(".project-header").boundingBox();
  expect(mobileHeader?.height).toBeLessThanOrEqual(40);
  await expect(backToList).toBeVisible();
  const headerScroll = page.locator(".header-scroll");
  await expect(headerScroll).toBeVisible();
  await page.screenshot({
    path: "test-results/projects-header-mobile-initial.png",
    fullPage: true,
    animations: "disabled",
  });
  await headerScroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const backVisibility = await backToList.evaluate((button) => {
    const header = button.closest(".project-header");
    if (!header) return null;
    const scroll = header.querySelector(".header-scroll");
    if (!scroll) return null;
    const buttonRect = button.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    return {
      visible:
        buttonRect.left >= headerRect.left &&
        buttonRect.right <= scrollRect.left &&
        buttonRect.top >= headerRect.top &&
        buttonRect.bottom <= headerRect.bottom,
      button: { left: buttonRect.left, right: buttonRect.right },
      header: { left: headerRect.left, right: headerRect.right },
      scroll: { left: scroll.scrollLeft, width: scroll.scrollWidth },
      position: getComputedStyle(button).position,
      className: button.className,
    };
  });
  expect(backVisibility).toMatchObject({ visible: true });
  expect(backVisibility?.scroll.left).toBeGreaterThan(0);
  await page.screenshot({
    path: "test-results/projects-header-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await backToList.click();
  await expect(page).toHaveURL(new RegExp("/projects$"));
  await expect(
    page.getByRole("button", { name: "新建项目", exact: true }),
  ).toBeVisible();
  await page.goto("/projects/101");
  await expect(backToList).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const desktopHeader = await page.locator(".project-header").boundingBox();
  expect(desktopHeader?.height).toBeLessThanOrEqual(28);
  await expect(backToList).toBeVisible();
  await backToList.click();
  await expect(page).toHaveURL(new RegExp("/projects$"));
  await expect(page.locator(".el-loading-mask:visible")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "新建项目", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/projects-list-compact.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("项目详情可打开交付验收面板", async ({ page, request }) => {
  const created = await (
    await request.post("/api/projects", {
      data: { name: `交付验收面板${Date.now()}` },
    })
  ).json();
  await page.goto(`/projects/${created.project.id}`);
  const deliveryTab = page.getByRole("tab", {
    name: "交付验收",
    exact: true,
  });
  await expect(deliveryTab).toBeEnabled();
  await deliveryTab.click();
  await expect(
    page
      .getByRole("tabpanel", { name: "交付验收" })
      .getByText("默认交付", { exact: true }),
  ).toBeVisible();
});

test("交付面板可新增批次并显示服务端结果", async ({ page, request }) => {
  const created = await (
    await request.post("/api/projects", {
      data: { name: `交付批次操作${Date.now()}` },
    })
  ).json();
  const projectId = created.project.id as number;
  const batchName = `补充批次${Date.now()}`;
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("tab", { name: "交付验收", exact: true }).click();
  await page.getByRole("button", { name: "新增批次", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增交付批次" });
  await dialog.getByLabel("批次名称").fill(batchName);
  await dialog.getByRole("button", { name: "创建批次", exact: true }).click();
  await expect(
    page.getByRole("tabpanel", { name: "交付验收" }).locator(".panel-toolbar").getByText(batchName, { exact: true }),
  ).toBeVisible();
  const listed = await request.get(`/api/projects/${projectId}/deliveries`);
  expect((await listed.json()).items.map((item: { name: string }) => item.name)).toContain(batchName);
});
