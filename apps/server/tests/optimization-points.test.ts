import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  OptimizationPoint,
  OptimizationPointConversion,
  OptimizationPointSummary,
  Requirement,
  RequirementOptimizationPointRef,
} from "@superpm/shared";
import { createApp } from "../src/app.js";
import { authedInject } from "./auth-helper.js";

describe("optimization points HTTP API", () => {
  let app: FastifyInstance;
  let directory: string;
  let workspacePath: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-optimization-"));
    workspacePath = join(directory, "workspace");
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath,
      logger: false,
      serveWeb: false,
    });
    await authedInject(app);
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      name: "需求列表操作繁琐",
      module: "需求管理",
      description:
        "需求列表的批量操作需要逐行点击，效率偏低。\n优化思路：增加行内快捷操作与批量选择。",
      descriptionHtml:
        "<p>需求列表的批量操作需要逐行点击，效率偏低。</p><p>优化思路：增加行内快捷操作与批量选择。</p>",
      remark: "",
      ...overrides,
    };
  }

  async function createPoint(
    overrides: Record<string, unknown> = {},
  ): Promise<OptimizationPoint> {
    const response = await app.inject({
      method: "POST",
      url: "/api/optimization-points",
      payload: payload(overrides),
    });
    expect(response.statusCode).toBe(201);
    return response.json<OptimizationPoint>();
  }

  it("requires a session", async () => {
    const bare = await createApp({
      databasePath: join(directory, "bare.sqlite"),
      workspacePath: join(directory, "bare-workspace"),
      logger: false,
      serveWeb: false,
    });
    try {
      expect((await bare.inject("/api/optimization-points")).statusCode).toBe(
        401,
      );
      expect(
        (
          await bare.inject({
            method: "POST",
            url: "/api/optimization-points",
            payload: payload(),
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await bare.close();
    }
  });

  it("creates a pending point and allows an empty module", async () => {
    const created = await createPoint({ module: "" });
    expect(created.status).toBe("pending");
    expect(created.module).toBe("");
    expect(created.requirement).toBeNull();
    expect(created.createdAt).toBe(created.updatedAt);

    const detail = await app.inject(`/api/optimization-points/${created.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<OptimizationPoint>()).toMatchObject({
      id: created.id,
      description:
        "需求列表的批量操作需要逐行点击，效率偏低。\n优化思路：增加行内快捷操作与批量选择。",
      descriptionHtml:
        "<p>需求列表的批量操作需要逐行点击，效率偏低。</p><p>优化思路：增加行内快捷操作与批量选择。</p>",
    });
  });

  it("rejects an empty name or description", async () => {
    const noName = await app.inject({
      method: "POST",
      url: "/api/optimization-points",
      payload: payload({ name: "   " }),
    });
    expect(noName.statusCode).toBe(400);
    const noDescription = await app.inject({
      method: "POST",
      url: "/api/optimization-points",
      payload: payload({ description: "" }),
    });
    expect(noDescription.statusCode).toBe(400);
  });

  it("searches by name, filters by status and sorts by updated time", async () => {
    const first = await createPoint({ name: "首页加载慢" });
    const second = await createPoint({ name: "导出按钮不明显" });
    await app.inject({
      method: "PATCH",
      url: `/api/optimization-points/${first.id}`,
      payload: { status: "evaluating" },
    });

    const all = (await app.inject("/api/optimization-points")).json<
      OptimizationPointSummary[]
    >();
    // 更新时间倒序：刚改过状态的那条排在最前
    expect(all.map((item) => item.id)).toEqual([first.id, second.id]);

    const searched = (await app.inject("/api/optimization-points?q=导出")).json<
      OptimizationPointSummary[]
    >();
    expect(searched.map((item) => item.id)).toEqual([second.id]);

    const evaluating = (
      await app.inject("/api/optimization-points?status=evaluating")
    ).json<OptimizationPointSummary[]>();
    expect(evaluating.map((item) => item.id)).toEqual([first.id]);
  });

  it("keeps status transitions inside the four editable states", async () => {
    const created = await createPoint();

    for (const status of ["evaluating", "postponed", "rejected", "pending"]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/optimization-points/${created.id}`,
        payload: { status },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<OptimizationPoint>().status).toBe(status);
    }

    // 「已转正式需求」只能由转换产生
    const manual = await app.inject({
      method: "PATCH",
      url: `/api/optimization-points/${created.id}`,
      payload: { status: "converted" },
    });
    expect(manual.statusCode).toBe(400);
    expect(manual.json().error.message).toContain("转为正式需求");
  });

  it("converts through the existing requirement creation flow", async () => {
    const created = await createPoint();
    const response = await app.inject({
      method: "POST",
      url: `/api/optimization-points/${created.id}/convert`,
      payload: { name: "需求列表支持批量操作" },
    });
    expect(response.statusCode).toBe(200);
    const conversion = response.json<OptimizationPointConversion>();
    expect(conversion.point.status).toBe("converted");
    expect(conversion.point.requirement).toMatchObject({
      id: conversion.requirement.id,
      exists: true,
    });
    expect(conversion.requirement.requirementNo).toMatch(/^REQ-\d{4}$/);
    expect(conversion.requirement.name).toBe("需求列表支持批量操作");
    expect(conversion.requirement.workspaceReady).toBe(true);

    // 复用正式需求创建流程：记录存在、类型为优化、正文整段继承为需求详情
    const requirement = (
      await app.inject(`/api/requirements/${conversion.requirement.id}`)
    ).json<Requirement>();
    expect(requirement.type).toBe("improvement");
    expect(requirement.description).toBe(created.description);
    expect(requirement.descriptionHtml).toBe(created.descriptionHtml);

    // 复用目录初始化：需求文件夹与默认目录都已建好
    const root = join(
      workspacePath,
      "requirements",
      `${requirement.requirementNo} ${requirement.name}`,
    );
    expect(existsSync(root)).toBe(true);
    const entries = readdirSync(root);
    for (const name of [
      "需求记忆.md",
      "images",
      "需求分析",
      "PRD",
      "原型图",
      "资料",
    ])
      expect(entries).toContain(name);

    // 需求详情可反查来源优化点
    const reversed = (
      await app.inject(
        `/api/requirements/${conversion.requirement.id}/optimization-points`,
      )
    ).json<RequirementOptimizationPointRef[]>();
    expect(reversed).toHaveLength(1);
    expect(reversed[0]).toMatchObject({
      id: created.id,
      status: "converted",
    });

    // 不允许重复转换
    const again = await app.inject({
      method: "POST",
      url: `/api/optimization-points/${created.id}/convert`,
      payload: {},
    });
    expect(again.statusCode).toBe(409);

    // 已转换且关联有效时不允许直接改状态
    const statusChange = await app.inject({
      method: "PATCH",
      url: `/api/optimization-points/${created.id}`,
      payload: { status: "postponed" },
    });
    expect(statusChange.statusCode).toBe(409);
  });

  it("keeps the association traceable after the requirement is removed", async () => {
    const created = await createPoint();
    const conversion = (
      await app.inject({
        method: "POST",
        url: `/api/optimization-points/${created.id}/convert`,
        payload: {},
      })
    ).json<OptimizationPointConversion>();

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/requirements/${conversion.requirement.id}`,
    });
    expect(removed.statusCode).toBe(204);

    // 关联被清理，优化点保留原始内容与状态，可重新转换
    const detail = (
      await app.inject(`/api/optimization-points/${created.id}`)
    ).json<OptimizationPoint>();
    expect(detail.requirement).toBeNull();
    expect(detail.status).toBe("converted");
    expect(detail.description).toBe(created.description);

    const second = await app.inject({
      method: "POST",
      url: `/api/optimization-points/${created.id}/convert`,
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    const reconverted = second.json<OptimizationPointConversion>();
    expect(reconverted.point.requirement?.exists).toBe(true);
    expect(reconverted.requirement.id).not.toBe(conversion.requirement.id);
  });

  it("removes a point without touching its requirement", async () => {
    const created = await createPoint();
    const conversion = (
      await app.inject({
        method: "POST",
        url: `/api/optimization-points/${created.id}/convert`,
        payload: {},
      })
    ).json<OptimizationPointConversion>();

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/optimization-points/${created.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await app.inject(`/api/optimization-points/${created.id}`)).statusCode,
    ).toBe(404);
    // 删除正式需求时不会级联删除优化点，反向同理：删除优化点不动正式需求
    expect(
      (await app.inject(`/api/requirements/${conversion.requirement.id}`))
        .statusCode,
    ).toBe(200);
  });
});
