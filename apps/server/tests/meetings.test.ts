import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  Meeting,
  MeetingSummary,
  Requirement,
  RequirementReferenceState,
} from "@superpm/shared";
import { createApp } from "../src/app.js";
import { authedInject } from "./auth-helper.js";

describe("meetings HTTP API", () => {
  let app: FastifyInstance;
  let directory: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-meetings-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    await authedInject(app);
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function createRequirement(name: string): Promise<Requirement> {
    const response = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { name, proposedAt: "2026-10-01" },
    });
    expect(response.statusCode).toBe(201);
    return response.json<Requirement>();
  }

  function meetingPayload(overrides: Record<string, unknown> = {}) {
    return {
      title: "产品周例会",
      type: "weekly",
      meetingTime: "2026-10-26T10:30:45.000+08:00",
      requirementIds: [],
      contentHtml: "<p>同步本周进度</p>",
      ...overrides,
    };
  }

  async function createMeeting(
    overrides: Record<string, unknown> = {},
  ): Promise<Meeting> {
    const response = await app.inject({
      method: "POST",
      url: "/api/meetings",
      payload: meetingPayload(overrides),
    });
    expect(response.statusCode).toBe(201);
    return response.json<Meeting>();
  }

  it("requires a session", async () => {
    const bare = await createApp({
      databasePath: join(directory, "bare.sqlite"),
      workspacePath: join(directory, "bare-workspace"),
      logger: false,
      serveWeb: false,
    });
    try {
      expect((await bare.inject("/api/meetings")).statusCode).toBe(401);
      expect(
        (await bare.inject("/api/requirements/references?ids=1")).statusCode,
      ).toBe(401);
    } finally {
      await bare.close();
    }
  });

  it("creates, reads, updates and deletes meetings", async () => {
    const a = await createRequirement("登录改造");
    const b = await createRequirement("报表导出");

    const created = await createMeeting({
      title: "  产品周例会  ",
      requirementIds: [a.id, b.id, a.id],
    });
    // 时间统一为 UTC 并精确到分钟；重复关联去重
    expect(created).toMatchObject({
      title: "产品周例会",
      type: "weekly",
      meetingTime: "2026-10-26T02:30:00.000Z",
      requirementCount: 2,
      contentHtml: "<p>同步本周进度</p>",
    });
    expect(created.requirements.map((item) => item.id)).toEqual([a.id, b.id]);

    const list = (await app.inject("/api/meetings")).json<MeetingSummary[]>();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: created.id,
      requirementCount: 2,
      summary: "同步本周进度",
    });
    // 列表不返回完整正文
    expect(list[0]).not.toHaveProperty("contentHtml");

    const detail = (
      await app.inject(`/api/meetings/${created.id}`)
    ).json<Meeting>();
    expect(detail.contentHtml).toBe("<p>同步本周进度</p>");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${created.id}`,
      payload: {
        title: "产品周例会（改期）",
        requirementIds: [b.id],
        meetingTime: "2026-10-27T09:10:59+08:00",
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<Meeting>()).toMatchObject({
      title: "产品周例会（改期）",
      meetingTime: "2026-10-27T01:10:00.000Z",
      requirementCount: 1,
    });
    expect(patched.json<Meeting>().requirements.map((item) => item.id)).toEqual(
      [b.id],
    );

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/meetings/${created.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await app.inject("/api/meetings")).json<MeetingSummary[]>(),
    ).toEqual([]);
    expect((await app.inject(`/api/meetings/${created.id}`)).statusCode).toBe(
      404,
    );
  });

  it("validates title, type, time and associated requirements", async () => {
    for (const payload of [
      meetingPayload({ title: "   " }),
      meetingPayload({ type: "invalid" }),
      meetingPayload({ meetingTime: "2026-10-26 10:30" }),
      meetingPayload({ meetingTime: "not-a-date" }),
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/meetings",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }

    const missing = await app.inject({
      method: "POST",
      url: "/api/meetings",
      payload: meetingPayload({ requirementIds: [9999] }),
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain("关联的需求不存在");

    const meeting = await createMeeting();
    const emptyPatch = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}`,
      payload: {},
    });
    expect(emptyPatch.statusCode).toBe(400);
  });

  it("searches by title, filters by type and sorts stably by time", async () => {
    const first = await createMeeting({
      title: "十月周例会",
      type: "weekly",
      meetingTime: "2026-10-20T10:00:00+08:00",
    });
    const second = await createMeeting({
      title: "需求沟通：登录改造",
      type: "requirement",
      meetingTime: "2026-10-22T10:00:00+08:00",
    });
    const third = await createMeeting({
      title: "需求沟通：报表导出",
      type: "requirement",
      meetingTime: "2026-10-22T10:00:00+08:00",
    });

    // 同一会议时间用 ID 倒序稳定排序
    expect(
      (await app.inject("/api/meetings"))
        .json<MeetingSummary[]>()
        .map((item) => item.id),
    ).toEqual([third.id, second.id, first.id]);
    expect(
      (await app.inject(`/api/meetings?q=${encodeURIComponent("需求沟通")}`))
        .json<MeetingSummary[]>()
        .map((item) => item.id),
    ).toEqual([third.id, second.id]);
    expect(
      (await app.inject("/api/meetings?type=weekly"))
        .json<MeetingSummary[]>()
        .map((item) => item.id),
    ).toEqual([first.id]);
    // LIKE 通配符按字面量处理
    expect(
      (await app.inject("/api/meetings?q=%25")).json<MeetingSummary[]>(),
    ).toEqual([]);
  });

  it("resolves renamed references and clears associations when a requirement is deleted", async () => {
    const requirement = await createRequirement("旧名称");
    const meeting = await createMeeting({
      requirementIds: [requirement.id],
      contentHtml: `<p>讨论 <span data-requirement-id="${requirement.id}" data-requirement-name="旧名称" data-requirement-code="${requirement.requirementNo}">${requirement.requirementNo} · 旧名称</span></p>`,
    });

    await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}`,
      payload: { name: "新名称" },
    });
    const references = (
      await app.inject(
        `/api/requirements/references?ids=${requirement.id},9999`,
      )
    ).json<RequirementReferenceState[]>();
    expect(references).toEqual([
      {
        id: requirement.id,
        requirementNo: requirement.requirementNo,
        name: "新名称",
        exists: true,
      },
      { id: 9999, requirementNo: null, name: null, exists: false },
    ]);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/requirements/${requirement.id}`,
    });
    expect(removed.statusCode).toBe(204);
    // 需求删除后会议保留，关联清零，正文中的历史引用仍在
    const detail = (
      await app.inject(`/api/meetings/${meeting.id}`)
    ).json<Meeting>();
    expect(detail.requirementCount).toBe(0);
    expect(detail.contentHtml).toContain("旧名称");
    expect(
      (
        await app.inject(`/api/requirements/references?ids=${requirement.id}`)
      ).json<RequirementReferenceState[]>(),
    ).toEqual([
      {
        id: requirement.id,
        requirementNo: null,
        name: null,
        exists: false,
      },
    ]);
  });
});
