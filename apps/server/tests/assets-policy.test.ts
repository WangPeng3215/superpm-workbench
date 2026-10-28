import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  resolveCategoryOpenAction,
  type CategoryOpenAction,
} from "@superpm/shared";
import { authedInject } from "./auth-helper";

// 本文件只验证“显式关闭”时的本地打开策略：在加载应用前设置，保证 403 分支可预期。
let createApp!: (typeof import("../src/app"))["createApp"];
beforeAll(async () => {
  vi.stubEnv("SUPERPM_ALLOW_SYSTEM_OPEN", "0");
  ({ createApp } = await import("../src/app"));
});
afterAll(() => vi.unstubAllEnvs());

// 打开策略（补充文档 3.2）：空 / 单文件 / 唯一确认版 / 多确认或无确认 → 全部列表
describe("resolveCategoryOpenAction", () => {
  it("returns empty for no files", () => {
    expect(resolveCategoryOpenAction([])).toEqual({ action: "empty" });
  });
  it("opens the single file directly even without confirmation", () => {
    expect(
      resolveCategoryOpenAction([{ id: 7, isFinal: false }]),
    ).toEqual<CategoryOpenAction>({ action: "open_single", assetId: 7 });
  });
  it("opens the only confirmed file among many", () => {
    expect(
      resolveCategoryOpenAction([
        { id: 1, isFinal: false },
        { id: 2, isFinal: true },
        { id: 3, isFinal: false },
      ]),
    ).toEqual<CategoryOpenAction>({ action: "open_single", assetId: 2 });
  });
  it("shows all files with multiple confirmations", () => {
    const action = resolveCategoryOpenAction([
      { id: 1, isFinal: true },
      { id: 2, isFinal: true },
    ]);
    expect(action).toEqual<CategoryOpenAction>({
      action: "show_all",
      needsConfirm: false,
    });
  });
  it("asks for confirmation when several files exist but none is confirmed", () => {
    const action = resolveCategoryOpenAction([
      { id: 1, isFinal: false },
      { id: 2, isFinal: false },
    ]);
    expect(action).toEqual<CategoryOpenAction>({
      action: "show_all",
      needsConfirm: true,
    });
  });
});

// 服务端链接协议白名单：恶意协议在创建时被拒绝
describe("external link protocol whitelist", () => {
  let app: FastifyInstance;
  let directory: string;
  let requirementId: number;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-links-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
    });
    // 登录种子账号，包装 inject 自动携带会话 Cookie
    await authedInject(app);
    const requirement = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { name: "需求工作台", proposedAt: "2026-10-15" },
    });
    requirementId = requirement.json().id;
  });
  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const createLink = (url: string) =>
    app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/files`,
      payload: {
        phase: "design",
        category: "designLink",
        name: "设计稿",
        resourceType: "link",
        linkUrl: url,
        isFinal: false,
      },
    });
  it("accepts http/https/ftp links", async () => {
    expect((await createLink("https://figma.com/x")).statusCode).toBe(201);
    expect((await createLink("http://axure.local/p")).statusCode).toBe(201);
    expect((await createLink("ftp://files.local/a.zip")).statusCode).toBe(201);
  });
  it("accepts unreachable domain URLs without availability checks", async () => {
    // .invalid 顶级域保证不可解析：服务端只做协议白名单，不探测可达性
    const unreachable = await createLink(
      "https://nonexistent-host-a8f3e2.invalid/deep/path?asset=1",
    );
    expect(unreachable.statusCode).toBe(201);
    expect(unreachable.json()).toMatchObject({
      resourceType: "link",
      storageType: "external",
      status: "draft",
      linkUrl: "https://nonexistent-host-a8f3e2.invalid/deep/path?asset=1",
    });
  });
  it("rejects javascript/data/relative protocols", async () => {
    expect((await createLink("javascript:alert(1)")).statusCode).toBe(400);
    expect((await createLink("data:text/html,<b>x</b>")).statusCode).toBe(400);
    expect((await createLink("/relative/path")).statusCode).toBe(400);
    expect((await createLink("  ")).statusCode).toBe(400);
  });
});

// 本地默认程序打开（补充文档 5.4）：显式关闭时一律 403
describe("local system open endpoint", () => {
  let app: FastifyInstance;
  let directory: string;
  let requirementId: number;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-open-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
    });
    await authedInject(app);
    const requirement = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { name: "需求工作台", proposedAt: "2026-10-15" },
    });
    requirementId = requirement.json().id;
  });
  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it("returns 403 when the switch is explicitly off", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/files`,
      payload: {
        phase: "analysis",
        category: "other",
        name: "说明.pdf",
        mime: "application/pdf",
        data: Buffer.from("%PDF-1.4").toString("base64"),
        isFinal: false,
      },
    });
    const fileId = created.json().id;
    const response = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/files/${fileId}/open`,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });
});
