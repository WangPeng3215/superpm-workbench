import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";

describe("共享需求资源 HTTP 权限和版本", () => {
  let app: FastifyInstance;
  let directory: string;
  type Actor = { id: number; cookie: string };
  let owner: Actor, product: Actor, viewer: Actor, outsider: Actor;
  let projectId: number, projectVersion: number, requirementId: number;
  function call(
    actor: Actor,
    method: string,
    url: string,
    payload?: unknown,
    key?: string,
  ) {
    return app.inject({
      method: method as "GET",
      url,
      headers: {
        cookie: actor.cookie,
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  async function register(username: string): Promise<Actor> {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username, password: "secret123" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const cookie = response.cookies
      .map((entry) => `${entry.name}=${entry.value}`)
      .join("; ");
    const me = await app.inject({ url: "/api/auth/me", headers: { cookie } });
    return { id: me.json().id, cookie };
  }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-resource-http-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    owner = await register("owner");
    product = await register("product");
    viewer = await register("viewer");
    outsider = await register("outsider");
    const created = await call(owner, "POST", "/api/projects", {
      name: "资源协作",
    });
    expect(created.statusCode, created.body).toBe(201);
    const project = created.json().project;
    projectId = project.id;
    projectVersion = project.version;
    for (const [actor, role] of [
      [product, "product_owner"],
      [viewer, "viewer"],
    ] as const) {
      const member = await call(
        owner,
        "POST",
        `/api/projects/${projectId}/members`,
        { userId: actor.id, roles: [role], expectedVersion: projectVersion },
      );
      expect(member.statusCode, member.body).toBe(200);
      projectVersion = member.json().project.version;
    }
    const requirement = await call(owner, "POST", "/api/requirements", {
      name: "共享资源",
      proposedAt: "2026-11-19",
      projectId,
    });
    expect(requirement.statusCode, requirement.body).toBe(201);
    requirementId = requirement.json().id;
  });
  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  it("成员按角色读写正文和元数据；外人与退出成员不能凭节点ID读取", async () => {
    const created = await call(
      owner,
      "POST",
      `/api/requirements/${requirementId}/artifacts/files`,
      { name: "team.md", initialContent: "initial" },
    );
    expect(created.statusCode, created.body).toBe(201);
    const node = created.json();
    const url = `/api/artifacts/nodes/${node.id}`;
    expect((await call(outsider, "GET", url)).statusCode).toBe(404);
    const read = await call(viewer, "GET", `${url}/content`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({
      content: "initial",
      version: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const raw = await call(viewer, "GET", `${url}/raw`);
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["cache-control"]).toBe("private, no-store");
    expect(
      (
        await call(viewer, "PUT", `${url}/content`, {
          content: "denied",
          expectedVersion: read.json().version,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(product, "PUT", `${url}/content`, {
          content: "missing",
          force: true,
        })
      ).statusCode,
    ).toBe(428);
    const saved = await call(product, "PUT", `${url}/content`, {
      content: "changed",
      expectedVersion: read.json().version,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().version).toBe(node.version + 1);
    const stale = await call(owner, "PUT", `${url}/content`, {
      content: "stale",
      expectedVersion: read.json().version,
      force: true,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe("VERSION_CONFLICT");
    const final = await call(product, "PATCH", `${url}/final`, {
      isFinal: true,
      expectedVersion: saved.json().version,
    });
    expect(final.statusCode, final.body).toBe(200);
    const removed = await call(
      owner,
      "DELETE",
      `/api/projects/${projectId}/members/${viewer.id}`,
      { expectedVersion: projectVersion },
    );
    expect(removed.statusCode, removed.body).toBe(200);
    for (const target of [
      url,
      `${url}/content`,
      `${url}/raw`,
      `/api/requirements/${requirementId}/directory`,
    ])
      expect((await call(viewer, "GET", target)).statusCode).toBe(404);
    const deleted = await call(
      product,
      "DELETE",
      `${url}?expectedVersion=${final.json().version}`,
    );
    expect(deleted.statusCode, deleted.body).toBe(204);
  });

  it("旧文件、链接和问题DELETE透传版本；讨论幂等键穿过HTTP边界", async () => {
    const file = await call(
      product,
      "POST",
      `/api/requirements/${requirementId}/files`,
      {
        phase: "analysis",
        category: "record",
        resourceType: "text",
        name: "旧资料",
        textContent: "initial",
      },
    );
    expect(file.statusCode, file.body).toBe(201);
    const fileUrl = `/api/requirements/${requirementId}/files/${file.json().id}`;
    const body = await call(viewer, "GET", `${fileUrl}/content`);
    expect(
      (
        await call(product, "PUT", `${fileUrl}/content`, {
          content: "changed",
          expectedVersion: body.json().version,
        })
      ).statusCode,
    ).toBe(200);
    const current = (await call(product, "GET", `${fileUrl}/content`)).json()
      .file;
    expect((await call(product, "DELETE", fileUrl)).statusCode).toBe(428);
    expect(
      (
        await call(
          product,
          "DELETE",
          `${fileUrl}?expectedVersion=${current.version}`,
        )
      ).statusCode,
    ).toBe(204);
    const link = await call(
      product,
      "POST",
      `/api/requirements/${requirementId}/artifacts/links`,
      { name: "资料链接", url: "https://example.com" },
    );
    expect(link.statusCode, link.body).toBe(201);
    expect(
      (
        await call(
          product,
          "DELETE",
          `/api/artifacts/links/${link.json().id}?expectedVersion=${link.json().version}`,
        )
      ).statusCode,
    ).toBe(204);
    const issue = await call(
      product,
      "POST",
      `/api/requirements/${requirementId}/issues`,
      { title: "问题" },
    );
    expect(issue.statusCode, issue.body).toBe(201);
    const issueUrl = `/api/requirements/${requirementId}/issues/${issue.json().id}`;
    expect(
      (
        await call(product, "POST", `${issueUrl}/activities`, {
          content: "讨论",
        })
      ).json().error.code,
    ).toBe("IDEMPOTENCY_KEY_REQUIRED");
    for (let i = 0; i < 2; i++)
      expect(
        (
          await call(
            product,
            "POST",
            `${issueUrl}/activities`,
            { content: "讨论" },
            "discussion-once",
          )
        ).statusCode,
      ).toBe(200);
    expect(
      (await call(viewer, "GET", issueUrl))
        .json()
        .activities.filter(
          (entry: { activityType: string }) => entry.activityType === "comment",
        ),
    ).toHaveLength(1);
    expect(
      (
        await call(
          product,
          "DELETE",
          `${issueUrl}?expectedVersion=${issue.json().version}`,
        )
      ).statusCode,
    ).toBe(204);
  });
});
