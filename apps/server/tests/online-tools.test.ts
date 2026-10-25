import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { OnlineTool } from "@superpm/shared";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { OnlineToolService } from "../src/services/online-tools.js";
import { authedInject } from "./auth-helper.js";

describe("online tool service", () => {
  let directory: string;
  let db: Database.Database;
  let service: OnlineToolService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "superpm-tools-"));
    db = new Database(join(directory, "test.sqlite"));
    migrate(db);
    service = new OnlineToolService(db);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function create(overrides: Record<string, unknown> = {}) {
    return service.create({
      name: "draw.io",
      url: "https://app.diagrams.net",
      category: "diagram",
      ...overrides,
    });
  }

  it("creates tools with defaults and appends sort order", () => {
    const first = create();
    expect(first).toMatchObject({
      name: "draw.io",
      icon: null,
      description: "",
      enabled: true,
      isFavorite: false,
      sortOrder: 0,
    });
    const second = create({ name: "Xmind", category: "mindmap" });
    expect(second.sortOrder).toBe(1);
  });

  it("keeps enabled and favorite independent", () => {
    const tool = create({ isFavorite: true });
    expect(service.favorites().map((item) => item.id)).toEqual([tool.id]);
    service.update(tool.id, { enabled: false });
    expect(service.favorites()).toEqual([]);
    // 停用后仍保留收藏标记，便于恢复
    expect(service.get(tool.id).isFavorite).toBe(true);
    service.update(tool.id, { enabled: true, isFavorite: false });
    expect(service.favorites()).toEqual([]);
    expect(service.list()).toHaveLength(1);
  });

  it("only accepts http and https urls", () => {
    for (const [index, url] of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///C:/Windows/System32/calc.exe",
      "ftp://example.com",
      "not a url",
    ].entries())
      expect(() => create({ name: `危险地址 ${index}`, url })).toThrowError();
  });

  it("rejects duplicate names", () => {
    create();
    expect(() => create({ url: "https://example.com" })).toThrowError(
      "工具名称已存在",
    );
    const other = create({ name: "Figma" });
    expect(() => service.update(other.id, { name: "draw.io" })).toThrowError(
      "工具名称已存在",
    );
  });

  it("reorders only favorite tools and validates ids", () => {
    const a = create({ name: "A", isFavorite: true });
    const b = create({ name: "B", isFavorite: true });
    const plain = create({ name: "C" });
    service.reorder({ ids: [b.id, a.id] });
    expect(service.favorites().map((item) => item.id)).toEqual([b.id, a.id]);
    expect(() => service.reorder({ ids: [a.id, a.id] })).toThrowError();
    expect(() => service.reorder({ ids: [plain.id] })).toThrowError(
      "只能调整快捷工具箱中工具的排序",
    );
    expect(() => service.reorder({ ids: [9999] })).toThrowError(
      "在线工具不存在",
    );
  });

  it("removes tools and reports missing ids", () => {
    const tool = create();
    service.remove(tool.id);
    expect(service.list()).toEqual([]);
    expect(() => service.get(tool.id)).toThrowError("在线工具不存在");
    expect(() => service.remove(tool.id)).toThrowError("在线工具不存在");
  });
});

describe("online tools HTTP API", () => {
  let app: FastifyInstance;
  let directory: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-tools-api-"));
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
    expect((await app.inject("/api/online-tools")).statusCode).toBe(401);
    expect((await app.inject("/api/online-tools/favorites")).statusCode).toBe(
      401,
    );
  });

  it("supports CRUD, favorites and ordering", async () => {
    await authedInject(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/online-tools",
      payload: {
        name: "ProcessOn",
        url: "https://www.processon.com",
        category: "diagram",
        description: "在线绘图",
        isFavorite: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const tool = created.json<OnlineTool>();
    expect(tool.isFavorite).toBe(true);

    const list = await app.inject("/api/online-tools");
    expect(list.json<OnlineTool[]>()).toHaveLength(1);
    const favorites = await app.inject("/api/online-tools/favorites");
    expect(favorites.json<OnlineTool[]>()[0].id).toBe(tool.id);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/online-tools/${tool.id}`,
      payload: { enabled: false, icon: "diagram" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<OnlineTool>()).toMatchObject({
      enabled: false,
      icon: "diagram",
    });
    // 停用后不再出现在快捷弹窗数据源
    expect(
      (await app.inject("/api/online-tools/favorites")).json<OnlineTool[]>(),
    ).toEqual([]);

    const order = await app.inject({
      method: "PATCH",
      url: "/api/online-tools/order",
      payload: { ids: [tool.id] },
    });
    expect(order.statusCode).toBe(200);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/online-tools/${tool.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await app.inject("/api/online-tools")).json<OnlineTool[]>(),
    ).toEqual([]);
  });

  it("rejects unsafe urls and duplicate names with readable errors", async () => {
    await authedInject(app);
    const unsafe = await app.inject({
      method: "POST",
      url: "/api/online-tools",
      payload: {
        name: "危险工具",
        url: "javascript:alert(1)",
        category: "other",
      },
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.body).toContain("http");

    await app.inject({
      method: "POST",
      url: "/api/online-tools",
      payload: {
        name: "重复名称",
        url: "https://example.com",
        category: "other",
      },
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/online-tools",
      payload: {
        name: "重复名称",
        url: "https://example.org",
        category: "other",
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toContain("工具名称已存在");
  });
});
