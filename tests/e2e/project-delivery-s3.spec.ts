import {
  expect,
  test,
  type Page,
  type APIRequestContext,
} from "@playwright/test";

async function createScopedProject(
  request: APIRequestContext,
  page: Page,
  stamp: number,
) {
  const created = await request.post("/api/projects", {
    data: { name: `S3 验收项目 ${stamp}` },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { project } = await created.json();
  const requirementResponse = await request.post("/api/requirements", {
    data: {
      name: `S3 验收范围 ${stamp}`,
      proposedAt: "2026-11-21",
      acceptanceCriteria: "页面显示项目交付内容",
      projectId: project.id,
    },
  });
  expect(requirementResponse.status(), await requirementResponse.text()).toBe(
    201,
  );
  const requirement = await requirementResponse.json();

  await page.goto(`/projects/${project.id}`);
  await page.getByRole("tab", { name: "交付验收", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "交付验收" });
  await panel.getByRole("button", { name: "确认范围", exact: true }).click();
  const scopeDialog = page.getByRole("dialog", { name: "确认交付范围" });
  await scopeDialog
    .locator("label.el-checkbox")
    .filter({ hasText: requirement.name })
    .click();
  await scopeDialog
    .getByRole("button", { name: "确认范围", exact: true })
    .click();
  await expect(
    panel.getByText(requirement.name, { exact: true }),
  ).toBeVisible();
  const deliveryResult = await request.get(
    `/api/projects/${project.id}/deliveries`,
  );
  const delivery = (await deliveryResult.json()).items[0];
  return { project, requirement, delivery, panel };
}

test("客户确认作为外部信息保存，并与系统提交人与验收记录人分开", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const { project, requirement, delivery, panel } = await createScopedProject(
    request,
    page,
    stamp,
  );

  await panel.getByRole("button", { name: "提交验收", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "提交交付验收" });
  await dialog.getByLabel("不可变文本证据").fill("版本 1.0 已部署");
  await dialog.getByLabel("客户确认人").fill("王女士");
  await dialog.getByLabel("身份说明").fill("客户项目负责人");
  const confirmedAt = dialog.getByLabel("确认时间");
  await confirmedAt.fill("2026-11-21 10:00:00");
  await confirmedAt.press("Enter");
  await dialog.getByLabel("确认凭证文本").fill("客户邮件确认本次交付");
  await dialog
    .getByRole("button", { name: "提交给验收人", exact: true })
    .click();
  await expect(panel.getByRole("heading", { name: /待验收/ })).toBeVisible();

  await panel
    .locator("label.el-radio-button")
    .filter({ hasText: /^通过$/ })
    .click();
  await panel
    .getByRole("button", { name: "提交验收结果", exact: true })
    .click();
  const roundsResponse = await request.get(
    `/api/deliveries/${delivery.id}/acceptance-rounds`,
  );
  expect(roundsResponse.ok()).toBeTruthy();
  const [round] = await roundsResponse.json();
  expect(round).toMatchObject({
    status: "passed",
    submittedBy: project.ownerUserId,
    customerConfirmation: {
      confirmedByName: "王女士",
      confirmedByRole: "客户项目负责人",
      evidence: { content: "客户邮件确认本次交付", immutable: true },
    },
    items: [{ result: "passed", recordedBy: project.ownerUserId }],
  });
  expect(round.customerConfirmation.confirmedByName).not.toBe(
    String(round.submittedBy),
  );
  expect(round.items[0].requirementId).toBe(requirement.id);
  const history = panel.locator(".history-section");
  await expect(history).toContainText("客户确认人");
  await expect(history).toContainText("王女士");
  await expect(history).toContainText("系统提交人");
  await expect(history).toContainText("系统验收人");
});

test("项目负责人可标记交付阻断并接受当前问题版本风险", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const { project, requirement, delivery, panel } = await createScopedProject(
    request,
    page,
    stamp,
  );
  const issueResponse = await request.post(
    `/api/requirements/${requirement.id}/issues`,
    { data: { title: `阻断问题 ${stamp}`, description: "交付前需接受风险" } },
  );
  expect(issueResponse.status(), await issueResponse.text()).toBe(201);
  const issue = await issueResponse.json();
  await page.reload();
  await page.getByRole("tab", { name: "交付验收", exact: true }).click();

  await expect(panel.locator(".blocker-create")).toBeVisible();
  await panel.locator(".blocker-create .el-select").click();
  await page.getByRole("option", { name: issue.title, exact: true }).click();
  await panel.getByPlaceholder("说明对交付的影响").fill("可能延迟客户上线");
  await panel.getByRole("button", { name: "标记阻断", exact: true }).click();
  await expect(panel.getByText("阻断中", { exact: true })).toBeVisible();

  await panel.getByRole("button", { name: "接受风险", exact: true }).click();
  const prompt = page.locator(".el-message-box:visible");
  await prompt.getByRole("textbox").fill("客户确认接受短期上线风险");
  await prompt.getByRole("button", { name: "确定", exact: true }).click();
  await expect(panel.getByText("已接受风险", { exact: true })).toBeVisible();

  const blockersResponse = await request.get(
    `/api/deliveries/${delivery.id}/blocking-issues`,
  );
  expect(blockersResponse.ok()).toBeTruthy();
  const [blocker] = await blockersResponse.json();
  expect(blocker).toMatchObject({
    issueId: issue.id,
    impact: "可能延迟客户上线",
    riskAcceptance: {
      acceptedBy: project.ownerUserId,
      reason: "客户确认接受短期上线风险",
      evidence: { content: "客户确认接受短期上线风险", immutable: true },
    },
  });
  const closureResponse = await request.get(
    `/api/projects/${project.id}/closure-check`,
  );
  expect(closureResponse.ok()).toBeTruthy();
  expect(
    (await closureResponse.json()).blockers.some(
      (item: { kind: string; id: number }) =>
        item.kind === "blocking_issue" && item.id === blocker.id,
    ),
  ).toBe(false);
});

test("待验收时可修订范围并让旧轮次失效", async ({ page, request }) => {
  const stamp = Date.now();
  const { project, requirement, delivery, panel } = await createScopedProject(
    request,
    page,
    stamp,
  );
  const nextRequirementResponse = await request.post("/api/requirements", {
    data: {
      name: `S3 修订后范围 ${stamp}`,
      proposedAt: "2026-11-21",
      acceptanceCriteria: "修订后的范围可验收",
      projectId: project.id,
    },
  });
  expect(
    nextRequirementResponse.status(),
    await nextRequirementResponse.text(),
  ).toBe(201);
  const nextRequirement = await nextRequirementResponse.json();
  const followUpResponse = await request.post(
    `/api/projects/${project.id}/deliveries`,
    { data: { name: `S3 后续批次 ${stamp}` } },
  );
  expect(followUpResponse.status(), await followUpResponse.text()).toBe(201);
  const followUpDelivery = await followUpResponse.json();
  await page.reload();
  await page.getByRole("tab", { name: "交付验收", exact: true }).click();
  const detailResponse = await request.get(`/api/projects/${project.id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const projectDetail = await detailResponse.json();
  const ownerName = String(
    projectDetail.members.find(
      (member: { userId: number; roles: string[] }) =>
        member.userId === project.ownerUserId && member.roles.includes("owner"),
    )?.displayName ?? "",
  );
  expect(ownerName).toBeTruthy();

  await panel.getByRole("button", { name: "提交验收", exact: true }).click();
  const submission = page.getByRole("dialog", { name: "提交交付验收" });
  await submission.getByLabel("不可变文本证据").fill("待验收范围版本 1");
  await submission
    .getByRole("button", { name: "提交给验收人", exact: true })
    .click();
  await expect(panel.getByRole("heading", { name: /待验收/ })).toBeVisible();

  const adjustScope = panel.getByRole("button", {
    name: "调整范围",
    exact: true,
  });
  await expect(adjustScope).toBeEnabled();
  await adjustScope.click();
  const scopeDialog = page.getByRole("dialog", { name: "修订交付范围" });
  await scopeDialog
    .locator("label.el-checkbox")
    .filter({ hasText: requirement.name })
    .click();
  await scopeDialog
    .locator("label.el-checkbox")
    .filter({ hasText: nextRequirement.name })
    .click();
  await scopeDialog
    .getByPlaceholder("填写本次范围变更原因")
    .fill("依据客户确认调整范围");
  const disposition = scopeDialog.locator(".scope-disposition");
  await disposition.locator(".el-select").nth(0).click();
  await page.getByRole("option", { name: "延期", exact: true }).click();
  await disposition
    .getByPlaceholder("填写处置原因")
    .fill("需求转入下一交付范围");
  await disposition.locator(".el-select").nth(1).click();
  await page
    .getByRole("option", { name: followUpDelivery.name, exact: true })
    .click();
  await scopeDialog
    .getByRole("button", { name: "保存范围修订", exact: true })
    .click();

  const deliveryResponse = await request.get(`/api/deliveries/${delivery.id}`);
  expect(deliveryResponse.ok()).toBeTruthy();
  const updatedDelivery = await deliveryResponse.json();
  expect(updatedDelivery.scopeVersion).toMatchObject({
    version: 2,
    items: [{ requirementId: nextRequirement.id }],
  });
  const roundsResponse = await request.get(
    `/api/deliveries/${delivery.id}/acceptance-rounds`,
  );
  const rounds = await roundsResponse.json();
  expect(rounds).toHaveLength(1);
  expect(rounds[0]).toMatchObject({
    status: "superseded",
    items: [{ requirementId: requirement.id }],
  });
  expect(
    updatedDelivery.scopeVersion.changes?.find(
      (change: { requirementId: number }) =>
        change.requirementId === requirement.id,
    ),
  ).toMatchObject({
    type: "postpone",
    followUpDeliveryId: followUpDelivery.id,
    reason: "需求转入下一交付范围",
  });
  expect(rounds[0].scopeVersionId).not.toBe(updatedDelivery.scopeVersion.id);
  expect(updatedDelivery.version).toBeGreaterThan(delivery.version);
  await expect(panel.locator(".history-section")).toContainText(
    `范围修订人：${ownerName}`,
  );
  const staleResult = await request.post(
    `/api/acceptance-rounds/${rounds[0].id}/results`,
    {
      data: {
        expectedVersion: updatedDelivery.version,
        scopeVersionId: rounds[0].scopeVersionId,
        results: [
          { scopeItemId: rounds[0].items[0].scopeItemId, result: "passed" },
        ],
      },
    },
  );
  expect(staleResult.status()).toBe(409);
  expect((await staleResult.json()).error.code).toBe("ACCEPTANCE_SUPERSEDED");
  expect(
    (await (await request.get(`/api/deliveries/${delivery.id}`)).json())
      .version,
  ).toBe(updatedDelivery.version);
});
