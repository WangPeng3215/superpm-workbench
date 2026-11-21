import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";

describe("project documents and artifacts", () => {
  let app: FastifyInstance;
  let directory: string;
  let owner: Awaited<ReturnType<typeof register>>;
  let viewer: Awaited<ReturnType<typeof register>>;
  let outsider: Awaited<ReturnType<typeof register>>;
  let projectId: number;
  let base: string;

  async function register(username: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username, password: "secret123" },
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      id: response.json().id as number,
      cookie: response.cookies.map(({ name, value }) => name + "=" + value).join("; "),
    };
  }

  const send = (method: HTTPMethods, url: string, payload?: object, actor = owner) =>
    app.inject({ method, url, payload, headers: { cookie: actor.cookie } });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-project-documents-"));
    app = await createApp({ databasePath: join(directory, "db.sqlite"), workspacePath: join(directory, "workspace"), logger: false, serveWeb: false });
    owner = await register("project-doc-owner");
    viewer = await register("project-doc-viewer");
    outsider = await register("project-doc-outsider");
    const created = await send("POST", "/api/projects", { name: "Shared project" });
    expect(created.statusCode, created.body).toBe(201);
    projectId = created.json().project.id;
    base = "/api/projects/" + projectId;
    const added = await send("POST", base + "/members", { userId: viewer.id, roles: ["viewer"], expectedVersion: created.json().project.version });
    expect(added.statusCode, added.body).toBe(200);
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  it("shares versioned documents with project readers and keeps document IDs project scoped", async () => {
    const doc = { kind: "decision", title: "Agreed scope", content: "Ship one module" };
    const created = await send("POST", base + "/documents", doc);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const path = base + "/documents/" + id;
    expect((await send("GET", base + "/documents", undefined, viewer)).json().items).toEqual([
      expect.objectContaining({ id, title: doc.title, version: 1, createdBy: owner.id }),
    ]);
    expect((await send("GET", path, undefined, viewer)).json().content).toBe(doc.content);
    expect((await send("PATCH", path, { title: "No", expectedVersion: 1 }, viewer)).statusCode).toBe(403);
    expect((await send("GET", path, undefined, outsider)).statusCode).toBe(404);
    const other = (await send("POST", "/api/projects", { name: "Other project" })).json().project;
    expect((await send("GET", "/api/projects/" + other.id + "/documents/" + id)).statusCode).toBe(404);
    expect((await send("POST", base + "/documents", { kind: "link", title: "Bad URL", url: "javascript:alert(1)" })).statusCode).toBe(400);
    expect((await send("POST", base + "/documents", { kind: "link", title: "Guide", url: "https://example.com/guide" })).statusCode).toBe(201);
    expect((await send("PATCH", path, { content: "Revised", expectedVersion: 1 })).json()).toMatchObject({ version: 2, updatedBy: owner.id });
    const stale = await send("PATCH", path, { content: "Overwrite", expectedVersion: 1 });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.details.current.content).toBe("Revised");
    expect((await send("DELETE", path, { expectedVersion: 2 })).statusCode).toBe(204);
    expect((await send("GET", path, undefined, viewer)).statusCode).toBe(404);
    const events = (await send("GET", base + "/events", undefined, viewer)).json().items;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "project_document_updated", payload: { documentId: id }, actorNameSnapshot: "project-doc-owner" }),
      expect.objectContaining({ action: "project_document_deleted", payload: { documentId: id } }),
    ]));
    const detail = (await send("GET", base)).json();
    const cancelled = await send("POST", base + "/lifecycle", { action: "cancel", reason: "Project ended", expectedVersion: detail.project.version });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const readonly = await send("POST", base + "/documents", doc);
    expect(readonly.statusCode, readonly.body).toBe(409);
    expect(readonly.json().error.code).toBe("PROJECT_READ_ONLY");
  });

  it("copies only an explicitly confirmed, owned meeting into an independent project snapshot", async () => {
    const payload = { title: "Private planning", type: "group", meetingTime: "2026-11-20T09:00:00.000Z", contentHtml: "<p>Private body</p>" };
    const created = await send("POST", "/api/meetings", payload);
    expect(created.statusCode, created.body).toBe(201);
    const meetingId = created.json().id;
    const otherMeeting = (await send("POST", "/api/meetings", { ...payload, title: "Other secret" }, outsider)).json().id;
    const copy = base + "/documents/copy-meeting";
    expect((await send("GET", "/api/meetings/" + meetingId, undefined, viewer)).statusCode).toBe(404);
    expect((await send("GET", base + "/documents", undefined, viewer)).json().items).toEqual([]);
    const unauthorized = await send("POST", copy, { meetingId: otherMeeting, confirmed: true });
    expect(unauthorized.statusCode, unauthorized.body).toBe(404);
    expect(unauthorized.body).not.toContain("Other secret");
    expect((await send("POST", copy, { meetingId, confirmed: false })).statusCode).toBe(400);
    const snapshot = await send("POST", copy, { meetingId, confirmed: true });
    expect(snapshot.statusCode, snapshot.body).toBe(201);
    expect(snapshot.json()).toMatchObject({ kind: "meeting", title: payload.title, content: payload.contentHtml, meetingTime: payload.meetingTime });
    expect(snapshot.json()).not.toHaveProperty("meetingId");
    expect((await send("PATCH", "/api/meetings/" + meetingId, { contentHtml: "<p>New private body</p>" })).statusCode).toBe(200);
    expect((await send("DELETE", "/api/meetings/" + meetingId)).statusCode).toBe(204);
    const read = await send("GET", base + "/documents/" + snapshot.json().id, undefined, viewer);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().content).toBe(payload.contentHtml);
    const events = (await send("GET", base + "/events", undefined, viewer)).json().items;
    expect(events[0]).toMatchObject({ action: "project_meeting_copied", payload: { documentId: snapshot.json().id } });
    expect(JSON.stringify(events[0])).not.toContain("Private body");
  });

  it("aggregates only artifacts from live, accessible requirements in the selected project", async () => {
    const shared = await send("POST", "/api/requirements", { name: "Shared requirement", proposedAt: "2026-11-20", projectId });
    expect(shared.statusCode, shared.body).toBe(201);
    const privateReq = await send("POST", "/api/requirements", { name: "Private requirement", proposedAt: "2026-11-20" });
    expect(privateReq.statusCode, privateReq.body).toBe(201);
    for (const requirement of [shared.json(), privateReq.json()]) {
      const file = await send("POST", "/api/requirements/" + requirement.id + "/artifacts/files", { parentId: null, name: "project-plan.md", initialContent: "Artifact test" });
      expect(file.statusCode, file.body).toBe(201);
      const link = await send("POST", "/api/requirements/" + requirement.id + "/artifacts/links", { folderNodeId: null, name: "Design link", url: "https://example.com/design" });
      expect(link.statusCode, link.body).toBe(201);
    }
    const response = await send("GET", base + "/artifacts", undefined, viewer);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "file", name: "project-plan.md", requirementId: shared.json().id }),
      expect.objectContaining({ kind: "link", name: "Design link", requirementId: shared.json().id }),
    ]));
    expect(response.json().items).toHaveLength(2);
    expect(response.body).not.toContain("Private requirement");
    const node = response.json().items.find((item: {kind: string}) => item.kind === "file");
    expect((await send("GET", "/api/artifacts/nodes/" + node.id + "/raw", undefined, viewer)).body).toBe("Artifact test");
    expect((await send("GET", base + "/artifacts", undefined, outsider)).statusCode).toBe(404);
  });
});
