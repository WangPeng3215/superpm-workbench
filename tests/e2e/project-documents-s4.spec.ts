import { expect, test } from "@playwright/test";

test("项目资料支持决策、链接，并可从资料动态跳回资料页", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/projects", {
    data: { name: `S4.2 资料联动-${Date.now()}` },
  });
  expect(created.status(), await created.text()).toBe(201);
  const project = (await created.json()).project;

  await page.goto(`/projects/${project.id}`);
  await page.getByRole("tab", { name: "项目资料", exact: true }).click();

  await page.getByRole("button", { name: "新增资料" }).first().click();
  await page.getByRole("menuitem", { name: "决策记录", exact: true }).click();
  await page.getByLabel("标题").fill("确定采用项目资料聚合");
  await page.getByLabel("正文").fill("决策正文可被项目成员查看。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByText("确定采用项目资料聚合", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "新增资料" }).first().click();
  await page.getByRole("menuitem", { name: "外部链接", exact: true }).click();
  await page.getByLabel("标题").fill("产品设计链接");
  await page.getByLabel("链接地址").fill("https://example.com/design");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "产品设计链接", exact: true }),
  ).toHaveAttribute("href", "https://example.com/design");

  await page.getByRole("tab", { name: "项目动态", exact: true }).click();
  const activity = page.getByRole("region", { name: "项目动态", exact: true });
  const createdEvent = activity.getByRole("button", {
    name: "新增了项目资料",
    exact: true,
  });
  await expect(createdEvent).toHaveCount(2);
  await createdEvent.last().click();
  await expect(
    page.getByRole("tab", { name: "项目资料", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText("确定采用项目资料聚合", { exact: true }),
  ).toBeVisible();
});

test("复制私人会议后生成独立项目纪要并记录动态", async ({ page, request }) => {
  const projectResponse = await request.post("/api/projects", {
    data: { name: `S4.2 会议快照-${Date.now()}` },
  });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const project = (await projectResponse.json()).project;
  const title = `仅复制一次的会议-${Date.now()}`;
  const meetingResponse = await request.post("/api/meetings", {
    data: {
      title,
      type: "weekly",
      meetingTime: new Date().toISOString(),
      contentHtml: "<p>私人会议正文不会继续同步。</p>",
      requirementIds: [],
    },
  });
  expect(meetingResponse.status(), await meetingResponse.text()).toBe(201);

  await page.goto(`/projects/${project.id}`);
  await page.getByRole("tab", { name: "项目资料", exact: true }).click();
  await page.getByRole("button", { name: "复制我的会议", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择要复制的私人会议" });
  await expect(picker.getByText(title, { exact: true })).toBeVisible();
  await picker.getByRole("row", { name: new RegExp(title) }).click();
  await picker
    .getByRole("button", { name: "复制为项目纪要", exact: true })
    .click();

  const confirm = page.getByRole("dialog", { name: "复制为项目纪要" });
  await confirm.getByRole("button", { name: "确认复制", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(picker).toBeHidden();
  await expect(
    page
      .getByRole("tabpanel", { name: "项目资料" })
      .getByRole("listitem")
      .getByText(title, { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "项目动态", exact: true }).click();
  const activity = page.getByRole("region", { name: "项目动态", exact: true });
  const copiedEvent = activity.getByRole("button", {
    name: "复制了项目会议纪要",
    exact: true,
  });
  await expect(copiedEvent).toBeVisible();
  await copiedEvent.click();
  await expect(
    page.getByRole("tab", { name: "项目资料", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});
