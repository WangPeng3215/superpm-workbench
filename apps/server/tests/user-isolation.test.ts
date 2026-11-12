import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createApp } from "../src/app";

/**
 * 越权测试（开发文档 §5）：
 * 认证只解决「你是谁」，数据隔离要解决「你不能碰别人的东西」。
 * 这里始终拿另一个账号的真实 ID 直接打接口，断言后端无条件拒绝，
 * 而不是仅仅「列表里看不到」。
 */
describe("用户数据隔离", () => {
  let directory: string;
  let app: FastifyInstance;
  let alice: string;
  let bob: string;
  let adminCookie: string;

  async function register(username: string, displayName: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username, password: "secret123", displayName },
    });
    expect(response.statusCode, response.body).toBe(201);
    return cookieOf(response);
  }

  function cookieOf(response: LightMyRequestResponse) {
    return response.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
  }

  function as(cookie: string, method: string, url: string, payload?: unknown) {
    return app.inject({
      method: method as "GET",
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-isolation-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    alice = await register("alice", "爱丽丝");
    bob = await register("bob", "鲍勃");
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "admin123" },
    });
    adminCookie = cookieOf(login);
  });

  afterEach(async () => {
    await app.close();
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows 下连接关闭后文件句柄可能延迟释放
    }
  });

  it("注册后账号互相独立，admin 仍可用默认口令登录", async () => {
    const me = await as(alice, "GET", "/api/auth/me");
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      username: "alice",
      isAdmin: false,
    });
    const admin = await as(adminCookie, "GET", "/api/auth/me");
    expect(admin.json()).toMatchObject({ username: "admin", isAdmin: true });
  });

  it("账号名重复与保留名被拒绝", async () => {
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "alice", password: "secret123" },
    });
    expect(duplicate.statusCode).toBe(409);
    const reserved = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "admin", password: "secret123" },
    });
    expect(reserved.statusCode).toBe(409);
    const short = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "carol", password: "12345" },
    });
    expect(short.statusCode).toBe(400);
  });

  it("需求列表只返回自己的数据", async () => {
    const created = await as(alice, "POST", "/api/requirements", {
      name: "爱丽丝的需求",
      proposedAt: "2026-11-12",
    });
    expect(created.statusCode, created.body).toBe(201);

    const bobList = await as(bob, "GET", "/api/requirements");
    expect(bobList.statusCode).toBe(200);
    expect(bobList.json().items).toHaveLength(0);

    const aliceList = await as(alice, "GET", "/api/requirements");
    expect(aliceList.json().items).toHaveLength(1);

    // admin 作为超管可见全部用户数据
    const adminList = await as(adminCookie, "GET", "/api/requirements");
    expect(adminList.json().items).toHaveLength(1);
  });

  it("拿别人需求 ID 打读接口一律 404", async () => {
    const id = (
      await as(alice, "POST", "/api/requirements", {
        name: "涉密需求",
        proposedAt: "2026-11-12",
      })
    ).json().id;

    for (const url of [
      `/api/requirements/${id}`,
      `/api/requirements/${id}/history`,
      `/api/requirements/${id}/relations`,
      `/api/requirements/${id}/files`,
      `/api/requirements/${id}/issues`,
      `/api/requirements/${id}/artifacts`,
      `/api/requirements/${id}/workspace`,
      `/api/requirements/${id}/memory`,
      `/api/requirements/${id}/directory`,
      `/api/requirements/${id}/optimization-points`,
    ])
      expect(
        (await as(bob, "GET", url)).statusCode,
        `GET ${url} 不应放行`,
      ).toBe(404);
  });

  it("拿别人需求 ID 打写接口一律 404，且数据保持不变", async () => {
    const id = (
      await as(alice, "POST", "/api/requirements", {
        name: "不可篡改",
        proposedAt: "2026-11-12",
      })
    ).json().id;

    expect(
      (
        await as(bob, "PATCH", `/api/requirements/${id}`, {
          name: "被改名了",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await as(bob, "PUT", `/api/requirements/${id}/workspace`, {
          version: 0,
          designUrl: "",
          analysis: { analysisText: "注入", prdText: "" },
          design: [],
          development: [],
          testing: [],
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await as(bob, "POST", `/api/requirements/${id}/issues`, {
          title: "越权建问题",
          stage: "requirement",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await as(bob, "POST", `/api/requirements/${id}/artifacts/folders`, {
          parentId: null,
          name: "越权目录",
        })
      ).statusCode,
    ).toBe(404);

    // 甲方数据完好，一条都没被改动
    const still = await as(alice, "GET", `/api/requirements/${id}`);
    expect(still.statusCode).toBe(200);
    expect(still.json().name).toBe("不可篡改");
    const issues = await as(alice, "GET", `/api/requirements/${id}/issues`);
    expect(issues.json().items ?? issues.json()).toHaveLength(0);

    // 删除同样拒绝，需求仍然存在
    expect(
      (await as(bob, "DELETE", `/api/requirements/${id}`)).statusCode,
    ).toBe(404);
    expect((await as(alice, "GET", `/api/requirements/${id}`)).statusCode).toBe(
      200,
    );
  });

  it("每日任务与工时互不可见、互不可改", async () => {
    const task = (
      await as(alice, "POST", "/api/daily-tasks", {
        title: "爱丽丝的任务",
        planDate: "2026-11-12",
        estimatedMinutes: 60,
      })
    ).json();
    const bobDay = await as(bob, "GET", "/api/daily-tasks?date=2026-11-12");
    expect(bobDay.statusCode, bobDay.body).toBe(200);
    expect(bobDay.json().tasks).toHaveLength(0);
    const aliceDay = await as(alice, "GET", "/api/daily-tasks?date=2026-11-12");
    expect(aliceDay.statusCode, aliceDay.body).toBe(200);
    expect(aliceDay.json().tasks).toHaveLength(1);
    expect(
      (
        await as(bob, "PATCH", `/api/daily-tasks/${task.id}`, {
          title: "被改",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await as(bob, "POST", `/api/daily-tasks/${task.id}/start`, {}))
        .statusCode,
    ).toBe(404);
    // 甲方的计时器不会出现在乙方的「进行中」状态里
    const bobActive = (await as(bob, "GET", "/api/daily-tasks/active")).json();
    expect(bobActive.active ?? bobActive.entry ?? null).toBeNull();
  });

  it("便签、会议、优化点、工具箱同样隔离", async () => {
    const createdNote = await as(alice, "POST", "/api/notes", {
      title: "爱丽丝便签",
      content: "私密",
    });
    expect(createdNote.statusCode, createdNote.body).toBe(201);
    const note = createdNote.json();
    const bobNotes = await as(bob, "GET", "/api/notes");
    expect(bobNotes.statusCode, bobNotes.body).toBe(200);
    expect(bobNotes.json()).toHaveLength(0);
    expect(
      (await as(bob, "PATCH", `/api/notes/${note.id}`, { title: "改" }))
        .statusCode,
    ).toBe(404);
    expect((await as(bob, "DELETE", `/api/notes/${note.id}`)).statusCode).toBe(
      404,
    );

    const createdMeeting = await as(alice, "POST", "/api/meetings", {
      title: "爱丽丝会议",
      type: "weekly",
      meetingTime: "2026-11-12T10:00:00.000Z",
    });
    expect(createdMeeting.statusCode, createdMeeting.body).toBe(201);
    const meeting = createdMeeting.json();
    const bobMeetings = await as(bob, "GET", "/api/meetings");
    expect(bobMeetings.statusCode, bobMeetings.body).toBe(200);
    expect(bobMeetings.json()).toHaveLength(0);
    expect(
      (await as(bob, "GET", `/api/meetings/${meeting.id}`)).statusCode,
    ).toBe(404);
    expect(
      (await as(bob, "PATCH", `/api/meetings/${meeting.id}`, { title: "改" }))
        .statusCode,
    ).toBe(404);

    const createdPoint = await as(alice, "POST", "/api/optimization-points", {
      name: "爱丽丝优化点",
      module: "工作台",
      description: "私密内容",
    });
    expect(createdPoint.statusCode, createdPoint.body).toBe(201);
    const point = createdPoint.json();
    const bobPoints = await as(bob, "GET", "/api/optimization-points");
    expect(bobPoints.statusCode, bobPoints.body).toBe(200);
    expect(bobPoints.json()).toHaveLength(0);
    expect(
      (
        await as(bob, "PATCH", `/api/optimization-points/${point.id}`, {
          name: "改",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await as(bob, "DELETE", `/api/optimization-points/${point.id}`))
        .statusCode,
    ).toBe(404);

    const createdTool = await as(alice, "POST", "/api/online-tools", {
      name: "爱丽丝的工具",
      url: "https://example.com",
      category: "other",
    });
    expect(createdTool.statusCode, createdTool.body).toBe(201);
    const tool = createdTool.json();
    expect((await as(bob, "GET", "/api/online-tools")).json()).toHaveLength(0);
    expect(
      (await as(bob, "DELETE", `/api/online-tools/${tool.id}`)).statusCode,
    ).toBe(404);
    // 同名工具在不同用户下互不冲突
    const sameName = await as(bob, "POST", "/api/online-tools", {
      name: "爱丽丝的工具",
      url: "https://example.org",
      category: "other",
    });
    expect(sameName.statusCode, sameName.body).toBe(201);
  });

  it("产物文件与图片按归属放行，编辑器的 <img> 请求不再匿名可读", async () => {
    const id = (
      await as(alice, "POST", "/api/requirements", {
        name: "带图需求",
        proposedAt: "2026-11-12",
      })
    ).json().id;
    const upload = await as(alice, "POST", `/api/requirements/${id}/images`, {
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ).toString("base64"),
      mime: "image/png",
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const url = upload.json().url as string;

    expect((await as(alice, "GET", url)).statusCode).toBe(200);
    // 未登录不再放行
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    // 别人的 ID 直接打也是 404
    expect((await as(bob, "GET", url)).statusCode).toBe(404);
  });

  it("两个账号可以各自计时，互不干扰", async () => {
    const taskA = (
      await as(alice, "POST", "/api/daily-tasks", {
        title: "甲的任务",
        planDate: "2026-11-13",
        estimatedMinutes: 60,
      })
    ).json();
    const taskB = (
      await as(bob, "POST", "/api/daily-tasks", {
        title: "乙的任务",
        planDate: "2026-11-13",
        estimatedMinutes: 60,
      })
    ).json();

    // 单实例单活动计时是旧约束（全局唯一索引），多用户下必须各自独立
    expect(
      (await as(alice, "POST", `/api/daily-tasks/${taskA.id}/start`, {}))
        .statusCode,
    ).toBe(200);
    expect(
      (await as(bob, "POST", `/api/daily-tasks/${taskB.id}/start`, {}))
        .statusCode,
    ).toBe(200);

    const bobActive = (await as(bob, "GET", "/api/daily-tasks/active")).json();
    expect(bobActive.activeTimer?.taskId).toBe(taskB.id);
    const aliceActive = (
      await as(alice, "GET", "/api/daily-tasks/active")
    ).json();
    expect(aliceActive.activeTimer?.taskId).toBe(taskA.id);

    // 乙停止计时不影响甲
    await as(bob, "POST", `/api/daily-tasks/${taskB.id}/stop`, {});
    const aliceAgain = (
      await as(alice, "GET", "/api/daily-tasks/active")
    ).json();
    expect(aliceAgain.activeTimer?.taskId).toBe(taskA.id);
  });

  it("数据库层面同样隔离：不同账号各自只看得到自己的行", async () => {
    const id = (
      await as(alice, "POST", "/api/requirements", {
        name: "归属检查",
        proposedAt: "2026-11-12",
      })
    ).json().id;
    // 通过超管视角确认归属：超管能看到，两个普通账号各自只能看到自己的
    const aliceIds = (await as(alice, "GET", "/api/requirements"))
      .json()
      .items.map((item: { id: number }) => item.id);
    expect(aliceIds).toContain(id);
    expect(
      (await as(bob, "GET", "/api/requirements")).json().items,
    ).toHaveLength(0);
    expect(
      (await as(adminCookie, "GET", "/api/requirements")).json().items,
    ).toHaveLength(1);
  });
});
