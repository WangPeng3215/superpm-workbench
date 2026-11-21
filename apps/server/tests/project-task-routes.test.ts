import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";
import { zonedDateTime } from "../src/services/business-time.js";

describe("project task HTTP routes", () => {
  let app: FastifyInstance;
  let directory: string;
  let owner: { id: number; cookie: string };
  let assignee: { id: number; cookie: string };
  let outsider: { id: number; cookie: string };
  let projectId: number;
  let taskId: number;
  let taskVersion: number;
  let now: Date;

  async function register(username: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username, password: "secret123" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const cookie = response.cookies
      .map((item) => item.name + "=" + item.value)
      .join("; ");
    const me = await app.inject({ url: "/api/auth/me", headers: { cookie } });
    return { id: me.json().id as number, cookie };
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-project-task-routes-"));
    now = zonedDateTime("2026-11-20", "10:00");
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
      dailyTaskNow: () => now,
    });
    owner = await register("taskrouteowner");
    assignee = await register("taskrouteassignee");
    outsider = await register("taskrouteoutsider");

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: owner.cookie },
      payload: { name: "Task routes project" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const project = created.json().project as { id: number; version: number };
    projectId = project.id;

    const member = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/members`,
      headers: { cookie: owner.cookie },
      payload: {
        userId: assignee.id,
        roles: ["contributor"],
        expectedVersion: project.version,
      },
    });
    expect(member.statusCode, member.body).toBe(200);

    const createdTask = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      headers: { cookie: owner.cookie, "idempotency-key": "create-route-task" },
      payload: {
        title: "Implement login",
        type: "development",
        assigneeUserId: assignee.id,
        confirmerUserId: owner.id,
      },
    });
    expect(createdTask.statusCode, createdTask.body).toBe(201);
    taskId = createdTask.json().id;
    taskVersion = createdTask.json().version;
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  it("allows project members to list and read tasks while hiding them from outsiders", async () => {
    const listed = await app.inject({
      url: `/api/projects/${projectId}/tasks`,
      headers: { cookie: assignee.cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(
      listed.json().items.map((item: { id: number }) => item.id),
    ).toContain(taskId);

    const detail = await app.inject({
      url: `/api/project-tasks/${taskId}`,
      headers: { cookie: assignee.cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ id: taskId, projectId });

    const outsiderDetail = await app.inject({
      url: `/api/project-tasks/${taskId}`,
      headers: { cookie: outsider.cookie },
    });
    expect(outsiderDetail.statusCode).toBe(404);
  });

  it("routes the assigned member's daily plan and reuses the task/date pair", async () => {
    const payload = {
      date: "2026-11-20",
      expectedVersion: taskVersion,
      plannedStartAt: "09:00",
      plannedEndAt: "09:30",
      estimatedMinutes: 30,
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/project-tasks/${taskId}/daily-plans`,
      headers: { cookie: assignee.cookie },
      payload,
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({
      projectTaskId: taskId,
      planDate: payload.date,
    });

    const replay = await app.inject({
      method: "POST",
      url: `/api/project-tasks/${taskId}/daily-plans`,
      headers: { cookie: assignee.cookie },
      payload,
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().id).toBe(first.json().id);

    const outsiderPlan = await app.inject({
      method: "POST",
      url: `/api/project-tasks/${taskId}/daily-plans`,
      headers: { cookie: outsider.cookie },
      payload,
    });
    expect(outsiderPlan.statusCode).toBe(404);

    const start = await app.inject({
      method: "POST",
      url: `/api/daily-tasks/${first.json().id}/start`,
      headers: { cookie: assignee.cookie },
    });
    expect(start.statusCode, start.body).toBe(200);
    now = zonedDateTime("2026-11-20", "10:30");
    const stop = await app.inject({
      method: "POST",
      url: `/api/daily-tasks/${first.json().id}/stop`,
      headers: { cookie: assignee.cookie },
    });
    expect(stop.statusCode, stop.body).toBe(200);

    const worklog = await app.inject({
      url: `/api/projects/${projectId}/worklog`,
      headers: { cookie: owner.cookie },
    });
    expect(worklog.statusCode, worklog.body).toBe(200);
    expect(worklog.json()).toMatchObject({
      totalSeconds: 30 * 60,
      items: [
        {
          projectTaskId: taskId,
          totalSeconds: 30 * 60,
        },
      ],
    });

    const outsiderWorklog = await app.inject({
      url: `/api/projects/${projectId}/worklog`,
      headers: { cookie: outsider.cookie },
    });
    expect(outsiderWorklog.statusCode).toBe(404);
  });
});
