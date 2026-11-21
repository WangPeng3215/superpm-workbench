import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";

describe("project overview aggregation", () => {
  let app: FastifyInstance;
  let directory: string;
  let owner: { id: number; cookie: string };
  let outsider: { id: number; cookie: string };
  let projectId: number;

  async function register(username: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username, password: "secret123" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const cookie = response.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const me = await app.inject({ url: "/api/auth/me", headers: { cookie } });
    return { id: me.json().id as number, cookie };
  }

  function inject(user: typeof owner, method: string, url: string, payload?: unknown) {
    return app.inject({
      method: method as "GET",
      url,
      headers: { cookie: user.cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-project-overview-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    owner = await register("overviewowner");
    outsider = await register("overviewoutsider");
    const created = await inject(owner, "POST", "/api/projects", { name: "真实聚合项目" });
    expect(created.statusCode, created.body).toBe(201);
    projectId = created.json().project.id;
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns counts from requirements, tasks, deliveries, and recent project events", async () => {
    const requirement = await inject(owner, "POST", "/api/requirements", {
      name: "已完成需求",
      projectId,
      status: "completed",
      proposedAt: "2026-11-20",
    });
    expect(requirement.statusCode, requirement.body).toBe(201);
    const task = await inject(owner, "POST", `/api/projects/${projectId}/tasks`, {
      title: "待确认任务",
      type: "testing",
      assigneeUserId: owner.id,
      confirmerUserId: owner.id,
    });
    expect(task.statusCode, task.body).toBe(201);
    const response = await inject(owner, "GET", `/api/projects/${projectId}/overview`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      project: { id: projectId, name: "真实聚合项目" },
      requirements: { total: 1, completed: 1 },
      tasks: { total: 1, pending: 1 },
      deliveries: { total: 1, byStatus: { planning: 1 } },
      recentEvents: expect.arrayContaining([
        expect.objectContaining({ action: "project_created" }),
      ]),
    });
  });

  it("hides overview from accounts without active project membership", async () => {
    const response = await inject(outsider, "GET", `/api/projects/${projectId}/overview`);
    expect(response.statusCode).toBe(404);
  });
});
