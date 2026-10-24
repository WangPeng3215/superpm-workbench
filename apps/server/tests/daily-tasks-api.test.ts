import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { DailyTask, DailyTaskDay } from "@superpm/shared";
import { createApp } from "../src/app.js";
import { authedInject } from "./auth-helper.js";

describe("daily tasks HTTP API", () => {
  let app: FastifyInstance;
  let directory: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-daily-api-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires a session", async () => {
    const response = await app.inject("/api/daily-tasks");
    expect(response.statusCode).toBe(401);
  });

  it("supports the daily task CRUD and reorder flow", async () => {
    await authedInject(app);
    const today = await app.inject("/api/daily-tasks");
    expect(today.statusCode).toBe(200);
    const empty = today.json<DailyTaskDay>();
    expect(empty.tasks).toEqual([]);
    expect(empty.date).toBe(empty.today);
    expect(empty.summaryText).toContain("【每日工作总结】");

    const created = await app.inject({
      method: "POST",
      url: "/api/daily-tasks",
      payload: {
        title: "接口任务",
        description: "说明",
        planDate: empty.today,
        estimatedMinutes: 60,
        plannedStartAt: "09:00",
        plannedEndAt: "10:00",
      },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json<DailyTask>();
    expect(task).toMatchObject({
      title: "接口任务",
      status: "pending",
      estimatedMinutes: 60,
    });

    const day = await app.inject(`/api/daily-tasks?date=${empty.today}`);
    expect(day.json<DailyTaskDay>().tasks).toHaveLength(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/daily-tasks/${task.id}`,
      payload: { estimatedMinutes: 90 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<DailyTask>().estimatedMinutes).toBe(90);

    const reordered = await app.inject({
      method: "PATCH",
      url: "/api/daily-tasks/order",
      payload: { date: empty.today, ids: [task.id] },
    });
    expect(reordered.statusCode).toBe(200);

    const summary = await app.inject(
      `/api/daily-tasks/summary-text?date=${empty.today}`,
    );
    expect(summary.json()).toMatchObject({
      date: empty.today,
      text: expect.stringContaining("【每日工作总结】"),
    });

    const active = await app.inject("/api/daily-tasks/active");
    expect(active.statusCode).toBe(200);
    expect(active.json()).toMatchObject({
      today: empty.today,
      activeTimer: null,
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/daily-tasks/${task.id}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ archived: false });
    expect(
      (
        await app.inject(`/api/daily-tasks?date=${empty.today}`)
      ).json<DailyTaskDay>().tasks,
    ).toHaveLength(0);
  });

  it("validates input and calendar parameters", async () => {
    await authedInject(app);
    const invalidEstimate = await app.inject({
      method: "POST",
      url: "/api/daily-tasks",
      payload: {
        title: "任务",
        planDate: "2026-10-24",
        estimatedMinutes: 45,
      },
    });
    expect(invalidEstimate.statusCode).toBe(400);
    expect(invalidEstimate.json().error.code).toBe("VALIDATION_ERROR");
    const invalidDate = await app.inject("/api/daily-tasks?date=2026-02-30");
    expect(invalidDate.statusCode).toBe(400);
    const calendar = await app.inject(
      "/api/daily-tasks/calendar?month=2026-10",
    );
    expect(calendar.statusCode).toBe(200);
    expect(calendar.json()).toMatchObject({ month: "2026-10" });
    expect(calendar.json().days).toHaveLength(31);
    expect(
      (await app.inject("/api/daily-tasks/calendar?month=2026-13")).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/daily-time-entries/999",
          payload: {
            startedAt: "2026-10-24T01:00:00.000Z",
            endedAt: "2026-10-24T02:00:00.000Z",
          },
        })
      ).statusCode,
    ).toBe(404);
  });
});
