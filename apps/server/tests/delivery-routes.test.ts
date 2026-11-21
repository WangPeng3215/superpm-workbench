import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";

describe("delivery routes", () => {
  let app: FastifyInstance;
  let directory: string;
  let cookie: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-delivery-routes-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "scope-owner", password: "secret123" },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    cookie = registered.cookies
      .map((item) => item.name + "=" + item.value)
      .join("; ");
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  const inject = (
    method: string,
    url: string,
    payload?: unknown,
    key?: string,
  ) =>
    app.inject({
      method: method as "GET",
      url,
      headers: {
        cookie,
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  it("lists the default delivery and creates another through the HTTP API", async () => {
    const projectResponse = await inject("POST", "/api/projects", {
      name: "Route delivery project",
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const projectId = projectResponse.json().project.id as number;
    const list = await inject(
      "GET",
      "/api/projects/" + projectId + "/deliveries",
    );
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({
      name: "默认交付",
      isDefault: true,
    });

    const created = await inject(
      "POST",
      "/api/projects/" + projectId + "/deliveries",
      { name: "第二批" },
      "route-delivery-create",
    );
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      name: "第二批",
      isDefault: false,
      acceptanceOwnerUserId: projectResponse.json().project.productOwnerUserId,
    });
  });

  it("confirms a shared leaf requirement and returns its immutable snapshot", async () => {
    const projectResponse = await inject("POST", "/api/projects", {
      name: "Scope route project",
    });
    const project = projectResponse.json().project;
    const requirementResponse = await inject("POST", "/api/requirements", {
      name: "HTTP scope requirement",
      description: "Snapshot body",
      acceptanceCriteria: "Must work",
      proposedAt: "2026-11-20",
    });
    expect(requirementResponse.statusCode, requirementResponse.body).toBe(201);
    const requirement = requirementResponse.json();
    const preview = await inject(
      "POST",
      "/api/projects/" + project.id + "/requirements/share-preview",
      { rootRequirementId: requirement.id },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    const share = await inject(
      "POST",
      "/api/projects/" + project.id + "/requirements/share",
      {
        token: preview.json().token,
        confirmed: true,
        expectedVersion: project.version,
      },
    );
    expect(share.statusCode, share.body).toBe(200);

    const defaultDelivery = (
      await inject("GET", "/api/projects/" + project.id + "/deliveries")
    ).json().items[0];
    const confirmation = await inject(
      "POST",
      "/api/deliveries/" + defaultDelivery.id + "/scope-confirmations",
      {
        expectedVersion: defaultDelivery.version,
        requirementIds: [requirement.id],
      },
      "scope-confirm-1",
    );
    expect(confirmation.statusCode, confirmation.body).toBe(200);
    expect(confirmation.json().scopeVersion.items[0]).toMatchObject({
      requirementId: requirement.id,
      requirementName: "HTTP scope requirement",
      acceptanceCriteria: "Must work",
    });
    expect(confirmation.json().scopeVersion.items[0].description).toContain(
      "Snapshot body",
    );
    expect(
      confirmation.json().scopeVersion.items[0].requirementVersion,
    ).toBeGreaterThan(1);
    expect(
      (await inject("GET", "/api/deliveries/" + defaultDelivery.id)).json()
        .scopeVersion.id,
    ).toBe(confirmation.json().scopeVersion.id);
    const sourceFile = await inject(
      "POST",
      "/api/requirements/" + requirement.id + "/files",
      {
        phase: "analysis",
        category: "record",
        resourceType: "text",
        name: "测试报告",
        textContent: "原始附件内容",
      },
    );
    expect(sourceFile.statusCode, sourceFile.body).toBe(201);

    const submitted = await inject(
      "POST",
      "/api/deliveries/" + defaultDelivery.id + "/acceptance-rounds",
      {
        expectedVersion: confirmation.json().version,
        scopeVersionId: confirmation.json().scopeVersion.id,
        deliveryNotes: "验收包 1.0",
        customerConfirmation: {
          confirmedByName: "客户张女士",
          confirmedByRole: "客户负责人",
          confirmedAt: "2026-11-21T02:00:00.000Z",
          evidence: {
            kind: "text",
            label: "客户确认",
            content: "客户确认范围",
          },
        },
        evidence: [
          { kind: "text", label: "发布说明", content: "SHA 固定的文本快照" },
          { kind: "url", label: "演示站点", url: "https://example.com/review" },
          {
            kind: "file",
            label: "测试报告快照",
            sourceResourceId: sourceFile.json().id,
          },
        ],
      },
      "route-acceptance-submit",
    );
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect(submitted.json().evidence[0]).toMatchObject({
      kind: "text",
      immutable: true,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const evidenceSnapshot = await inject(
      "GET",
      "/api/acceptance-rounds/" +
        submitted.json().id +
        "/evidence/" +
        submitted.json().evidence[0].id,
    );
    expect(evidenceSnapshot.statusCode, evidenceSnapshot.body).toBe(200);
    expect(evidenceSnapshot.body).toBe("SHA 固定的文本快照");
    expect(evidenceSnapshot.headers["cache-control"]).toBe("private, no-store");
    expect(evidenceSnapshot.headers["x-content-type-options"]).toBe("nosniff");
    expect(evidenceSnapshot.headers["content-disposition"]).toBe(
      'attachment; filename="acceptance-evidence"',
    );
    const fileEvidence = submitted
      .json()
      .evidence.find((item: { kind: string }) => item.kind === "file");
    expect(fileEvidence).toMatchObject({
      sourceKind: "requirement_file",
      sourceResourceId: sourceFile.json().id,
      immutable: true,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const sourceContent = await inject(
      "GET",
      `/api/requirements/${requirement.id}/files/${sourceFile.json().id}/content`,
    );
    const changedSource = await inject(
      "PUT",
      `/api/requirements/${requirement.id}/files/${sourceFile.json().id}/content`,
      {
        content: "修改后的附件内容",
        expectedVersion: sourceContent.json().version,
      },
    );
    expect(changedSource.statusCode, changedSource.body).toBe(200);
    const fileSnapshot = await inject(
      "GET",
      `/api/acceptance-rounds/${submitted.json().id}/evidence/${fileEvidence.id}`,
    );
    expect(fileSnapshot.statusCode, fileSnapshot.body).toBe(200);
    expect(fileSnapshot.body).toBe("原始附件内容");
    const rounds = await inject(
      "GET",
      "/api/deliveries/" + defaultDelivery.id + "/acceptance-rounds",
    );
    expect(rounds.statusCode, rounds.body).toBe(200);
    expect(rounds.json()[0].id).toBe(submitted.json().id);
    const confirmationEvidence = await inject(
      "GET",
      `/api/acceptance-rounds/${submitted.json().id}/customer-confirmation/evidence`,
    );
    expect(confirmationEvidence.statusCode, confirmationEvidence.body).toBe(
      200,
    );
    expect(confirmationEvidence.body).toBe("客户确认范围");
    expect(confirmationEvidence.headers["cache-control"]).toBe(
      "private, no-store",
    );
    const outsider = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "confirmation-outsider", password: "secret123" },
    });
    const denied = await app.inject({
      method: "GET",
      url: `/api/acceptance-rounds/${submitted.json().id}/customer-confirmation/evidence`,
      headers: {
        cookie: outsider.cookies
          .map((item) => item.name + "=" + item.value)
          .join("; "),
      },
    });
    expect([403, 404]).toContain(denied.statusCode);
    expect(denied.body).not.toContain("客户确认范围");
    const result = await inject(
      "POST",
      "/api/acceptance-rounds/" + submitted.json().id + "/results",
      {
        expectedVersion: submitted.json().deliveryVersion,
        scopeVersionId: submitted.json().scopeVersionId,
        results: submitted
          .json()
          .items.map((item: { scopeItemId: number }) => ({
            scopeItemId: item.scopeItemId,
            result: "passed",
          })),
      },
    );
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().status).toBe("passed");
    expect(
      (await inject("GET", "/api/deliveries/" + defaultDelivery.id)).json()
        .status,
    ).toBe("accepted");
  });

  it("exposes closure checks and history and dispatches close through delivery rules", async () => {
    const created = await inject("POST", "/api/projects", {
      name: "Closure route project",
    });
    expect(created.statusCode, created.body).toBe(201);
    const project = created.json();
    const base = "/api/projects/" + project.project.id;

    expect(project.capabilities.canCloseProject).toBe(true);
    const check = await inject("GET", base + "/closure-check");
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json()).toMatchObject({
      canClose: false,
      blockers: [
        expect.objectContaining({
          kind: "acceptance",
          reason: "尚未确认交付范围",
        }),
      ],
    });

    const history = await inject("GET", base + "/closures");
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json()).toEqual([]);

    const close = await inject(
      "POST",
      base + "/lifecycle",
      {
        action: "close",
        expectedVersion: project.project.version,
        reason: "尝试结项",
      },
      "route-close-blocked",
    );
    expect(close.statusCode).toBe(409);
    expect(close.json().error.code).toBe("CLOSURE_BLOCKED");
  });
});
