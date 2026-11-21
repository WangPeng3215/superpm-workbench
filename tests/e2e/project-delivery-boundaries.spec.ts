import { expect, test } from "@playwright/test";

test("多批次禁止重复承诺，豁免保留批准人与后续责任", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const created = await request.post("/api/projects", {
    data: { name: `批次边界 ${stamp}` },
  });
  expect(created.status()).toBe(201);
  const { project } = await created.json();
  const requirements = [];
  for (const suffix of ["原范围", "保留范围"]) {
    const response = await request.post("/api/requirements", {
      data: {
        name: `${suffix} ${stamp}`,
        projectId: project.id,
        proposedAt: "2026-11-21",
        acceptanceCriteria: "按确认范围交付",
      },
    });
    expect(response.status()).toBe(201);
    requirements.push(await response.json());
  }
  const deliveries = await (
    await request.get(`/api/projects/${project.id}/deliveries`)
  ).json();
  const first = deliveries.items[0];
  const scoped = await request.post(
    `/api/deliveries/${first.id}/scope-confirmations`,
    {
      data: {
        expectedVersion: first.version,
        requirementIds: requirements.map((item) => item.id),
      },
    },
  );
  expect(scoped.ok(), await scoped.text()).toBeTruthy();
  const next = await request.post(`/api/projects/${project.id}/deliveries`, {
    data: { name: `后续批次 ${stamp}` },
  });
  expect(next.status()).toBe(201);
  const second = await next.json();
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("tab", { name: "交付验收", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "交付验收" });
  await panel.locator(".el-select").first().click();
  await page.getByRole("option", { name: second.name, exact: true }).click();
  await panel.getByRole("button", { name: "确认范围", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "确认交付范围" });
  await dialog
    .locator("label.el-checkbox")
    .filter({ hasText: requirements[0].name })
    .click();
  await dialog.getByRole("button", { name: "确认范围", exact: true }).click();
  await expect(
    panel.getByText("需求已被其他交付批次承诺", { exact: true }),
  ).toBeVisible();
  expect(
    (await (await request.get(`/api/deliveries/${second.id}`)).json())
      .scopeVersion,
  ).toBeNull();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await panel.locator(".el-select").first().click();
  await page
    .getByRole("option", { name: "默认交付（默认）", exact: true })
    .click();
  await panel.getByRole("button", { name: "调整范围", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "修订交付范围" });
  await dialog
    .locator("label.el-checkbox")
    .filter({ hasText: requirements[0].name })
    .click();
  await dialog
    .getByPlaceholder("填写本次范围变更原因")
    .fill("客户批准减少本期范围");
  const disposition = dialog.locator(".scope-disposition");
  await disposition.locator(".el-select").nth(0).click();
  await page.getByRole("option", { name: "豁免", exact: true }).click();
  await disposition
    .getByPlaceholder("填写处置原因")
    .fill("客户批准本期豁免，负责人继续跟踪");
  const detail = await (
    await request.get(`/api/projects/${project.id}`)
  ).json();
  const owner = detail.members.find(
    (member: { userId: number }) => member.userId === project.ownerUserId,
  );
  await disposition.locator(".el-select").nth(2).click();
  await page
    .getByRole("option", { name: owner.displayName, exact: true })
    .click();
  await disposition.getByPlaceholder("跟进日期").fill("2026-12-01");
  await disposition.getByPlaceholder("跟进日期").press("Enter");
  await dialog
    .getByRole("button", { name: "保存范围修订", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const updated = await (
    await request.get(`/api/deliveries/${first.id}`)
  ).json();
  expect(
    updated.scopeVersion.items.map(
      (item: { requirementId: number }) => item.requirementId,
    ),
  ).toEqual([requirements[1].id]);
  expect(updated.scopeVersion.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "waive",
        requirementId: requirements[0].id,
        createdBy: project.ownerUserId,
        followUpOwnerUserId: project.ownerUserId,
        followUpDate: "2026-12-01",
      }),
    ]),
  );
  const rounds = await (
    await request.get(`/api/deliveries/${first.id}/acceptance-rounds`)
  ).json();
  expect(rounds).toHaveLength(0);
  const closure = await (
    await request.get(`/api/projects/${project.id}/closure-check`)
  ).json();
  expect(closure.canClose).toBe(false);
});

test("普通产品成员不能代替指定验收人或接受负责人风险", async ({
  browser,
}, testInfo) => {
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ baseURL: "http://127.0.0.1:3012" })),
  );
  try {
    const stamp = Date.now();
    const users = [];
    for (const [index, context] of contexts.entries()) {
      const registered = await context.request.post("/api/auth/register", {
        data: {
          username: `s3_boundary_${stamp}_${index}`,
          password: "secret123",
        },
      });
      expect(registered.status()).toBe(201);
      users.push(await registered.json());
    }
    const [owner, product] = contexts;
    const request = owner.request;
    const project = (
      await (
        await request.post("/api/projects", {
          data: { name: `验收角色 ${stamp}` },
        })
      ).json()
    ).project;
    const added = await request.post(`/api/projects/${project.id}/members`, {
      data: {
        userId: users[1].id,
        roles: ["product_owner"],
        expectedVersion: project.version,
      },
    });
    expect(added.ok(), await added.text()).toBeTruthy();
    const requirementResponse = await request.post("/api/requirements", {
      data: {
        name: `角色边界需求 ${stamp}`,
        proposedAt: "2026-11-21",
        projectId: project.id,
        acceptanceCriteria: "由指定负责人验收",
      },
    });
    expect(requirementResponse.status()).toBe(201);
    const requirement = await requirementResponse.json();
    const first = (
      await (await request.get(`/api/projects/${project.id}/deliveries`)).json()
    ).items[0];
    const scoped = await (
      await request.post(`/api/deliveries/${first.id}/scope-confirmations`, {
        data: {
          expectedVersion: first.version,
          requirementIds: [requirement.id],
        },
      })
    ).json();
    const submission = {
      expectedVersion: scoped.version,
      scopeVersionId: scoped.scopeVersion.id,
      evidence: [{ kind: "text", label: "交付证据", content: "已部署" }],
      customerConfirmation: {
        confirmedByName: "客户李女士",
        confirmedByRole: "客户负责人",
        confirmedAt: "2026-11-21T02:00:00.000Z",
        evidence: {
          kind: "text",
          label: "客户回执",
          content: "确认本期范围",
        },
      },
    };
    const forged = await product.request.post(
      `/api/deliveries/${first.id}/acceptance-rounds`,
      { data: { ...submission, submittedBy: users[0].id } },
    );
    expect(forged.status()).toBe(400);
    const submitted = await product.request.post(
      `/api/deliveries/${first.id}/acceptance-rounds`,
      { data: submission },
    );
    expect(submitted.status(), await submitted.text()).toBe(201);
    const round = await submitted.json();
    expect(round.submittedBy).toBe(users[1].id);
    const page = await product.newPage();
    await page.goto(`/projects/${project.id}`);
    await page.getByRole("tab", { name: "交付验收", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "交付验收" });
    await expect(
      panel.getByText("当前账号不是指定验收人，验收结果为只读。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "提交验收结果", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "调整范围", exact: true }),
    ).toHaveCount(0);
    const results = {
      expectedVersion: round.deliveryVersion,
      scopeVersionId: round.scopeVersionId,
      results: [{ scopeItemId: round.items[0].scopeItemId, result: "passed" }],
    };
    expect(
      (
        await product.request.post(
          `/api/acceptance-rounds/${round.id}/results`,
          { data: results },
        )
      ).status(),
    ).toBe(403);
    const issue = await (
      await request.post(`/api/requirements/${requirement.id}/issues`, {
        data: { title: "仍需处理的问题" },
      })
    ).json();
    const current = await (
      await request.get(`/api/deliveries/${first.id}`)
    ).json();
    const blockerResponse = await request.post(
      `/api/deliveries/${first.id}/blocking-issues`,
      {
        data: {
          issueId: issue.id,
          expectedVersion: current.version,
          impact: "上线风险",
        },
      },
    );
    expect(blockerResponse.ok(), await blockerResponse.text()).toBeTruthy();
    const blocker = await blockerResponse.json();
    await page.reload();
    await page.getByRole("tab", { name: "交付验收", exact: true }).click();
    await expect(panel.getByText("阻断中", { exact: true })).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "接受风险", exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await product.request.post(
          `/api/delivery-blockers/${blocker.id}/risk-acceptances`,
          {
            data: {
              expectedVersion: blocker.version,
              reason: "擅自接受",
              evidence: { kind: "text", label: "证据", content: "无权" },
            },
          },
        )
      ).status(),
    ).toBe(403);
    expect(
      (
        await (
          await request.get(`/api/deliveries/${first.id}/acceptance-rounds`)
        ).json()
      )[0].status,
    ).toBe("pending");
    expect(
      (
        await (
          await request.get(`/api/deliveries/${first.id}/blocking-issues`)
        ).json()
      )[0].riskAcceptance,
    ).toBeNull();
    const ownerPage = await owner.newPage();
    await ownerPage.goto(`/projects/${project.id}`);
    await ownerPage.getByRole("tab", { name: "交付验收", exact: true }).click();
    const ownerPanel = ownerPage.getByRole("tabpanel", { name: "交付验收" });
    await ownerPanel
      .locator("label.el-radio-button")
      .filter({ hasText: /^通过$/ })
      .click();
    await ownerPanel
      .getByRole("button", { name: "提交验收结果", exact: true })
      .click();
    await expect(
      ownerPanel.getByRole("heading", { name: /待验收/ }),
    ).toHaveCount(0);
    const completed = (
      await (
        await request.get(`/api/deliveries/${first.id}/acceptance-rounds`)
      ).json()
    )[0];
    expect(completed).toMatchObject({
      status: "passed",
      submittedBy: users[1].id,
      completedBy: users[0].id,
      items: [{ recordedBy: users[0].id }],
    });
    const history = ownerPanel.locator(".history-section");
    await expect(history).toContainText(users[1].username);
    await expect(history).toContainText(users[0].username);
    await expect(history).toContainText("客户李女士");
    const proof = await request.get(
      `/api/acceptance-rounds/${completed.id}/customer-confirmation/evidence`,
    );
    expect(proof.ok()).toBeTruthy();
    expect(await proof.text()).toBe("确认本期范围");
    await ownerPage.screenshot({
      path: testInfo.outputPath("delivery-audit.png"),
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});

test("超过一百个根需求及叶子子需求均可纳入交付范围", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const created = await request.post("/api/projects", {
    data: { name: `完整范围 ${stamp}` },
  });
  expect(created.status()).toBe(201);
  const { project } = await created.json();
  const parentResponse = await request.post("/api/requirements", {
    data: {
      name: `父需求 ${stamp}`,
      projectId: project.id,
      proposedAt: "2026-11-21",
    },
  });
  expect(parentResponse.status()).toBe(201);
  const parent = await parentResponse.json();
  const childResponse = await request.post("/api/requirements", {
    data: {
      name: `叶子子需求 ${stamp}`,
      parentId: parent.id,
      projectId: project.id,
      proposedAt: "2026-11-21",
    },
  });
  expect(childResponse.status()).toBe(201);
  const child = await childResponse.json();
  let last;
  for (let index = 0; index < 101; index++) {
    const response = await request.post("/api/requirements", {
      data: {
        name: `根需求 ${stamp}-${index}`,
        projectId: project.id,
        proposedAt: "2026-11-21",
      },
    });
    expect(response.status()).toBe(201);
    last = await response.json();
  }
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("tab", { name: "交付验收", exact: true }).click();
  await page.getByRole("button", { name: "确认范围", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认交付范围" });
  const choices = dialog.locator("label.el-checkbox");
  await expect(choices.filter({ hasText: parent.name })).toHaveCount(0);
  await choices.filter({ hasText: child.name }).click();
  await choices.filter({ hasText: last.name }).click();
  await dialog.getByRole("button", { name: "确认范围", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const delivery = (
    await (await request.get(`/api/projects/${project.id}/deliveries`)).json()
  ).items[0];
  expect(
    delivery.scopeVersion.items.map(
      (item: { requirementId: number }) => item.requirementId,
    ),
  ).toEqual(expect.arrayContaining([child.id, last.id]));
  expect(delivery.scopeVersion.items).toHaveLength(2);
});
