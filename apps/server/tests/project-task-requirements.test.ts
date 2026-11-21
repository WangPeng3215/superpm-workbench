import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";

describe("project task requirement candidates", () => {
  let app: FastifyInstance;
  let directory: string;
  let user: { id: number; cookie: string };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-task-requirements-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "taskowner", password: "secret123" },
    });
    const cookie = created.cookies
      .map((c) => c.name + "=" + c.value)
      .join("; ");
    user = {
      id: (
        await app.inject({ url: "/api/auth/me", headers: { cookie } })
      ).json().id,
      cookie,
    };
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  it("offers only active leaf requirements from a project to its member", async () => {
    const auth = { cookie: user.cookie };
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: { name: "Task candidates" },
    });
    const projectId = project.json().project.id as number;
    const parent = await app.inject({
      method: "POST",
      url: "/api/requirements",
      headers: auth,
      payload: { name: "Parent", projectId, proposedAt: "2026-11-20" },
    });
    await app.inject({
      method: "POST",
      url: "/api/requirements",
      headers: auth,
      payload: {
        name: "Child",
        projectId,
        parentId: parent.json().id,
        proposedAt: "2026-11-20",
      },
    });
    const leaf = await app.inject({
      method: "POST",
      url: "/api/requirements",
      headers: auth,
      payload: { name: "Leaf", projectId, proposedAt: "2026-11-20" },
    });
    const candidates = await app.inject({
      url: "/api/projects/" + projectId + "/task-requirements",
      headers: auth,
    });
    expect(candidates.statusCode, candidates.body).toBe(200);
    expect(
      candidates.json().items.map((item: { id: number }) => item.id),
    ).toContain(leaf.json().id);
    expect(
      candidates.json().items.map((item: { id: number }) => item.id),
    ).not.toContain(parent.json().id);
  });
});
