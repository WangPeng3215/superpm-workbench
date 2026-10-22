import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { dateFields } from "@superpm/shared";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  Requirement,
  RequirementFile,
  RequirementFileList,
  RequirementListResult,
} from "@superpm/shared";
import Database from "better-sqlite3";
import { createApp } from "../src/app";
import { authedInject } from "./auth-helper";
import { requirementRootRelative } from "./workspace-helper";

describe("requirements API with real SQLite", () => {
  let app: FastifyInstance;
  let directory: string;
  const input = (name = "需求工作台") => ({ name, proposedAt: "2026-10-13" });
  const create = async (payload: object = input()) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json<Requirement>();
  };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-test-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    // 登录种子账号，包装 inject 自动携带会话 Cookie
    await authedInject(app);
  });
  afterEach(async () => {
    if (app) await app.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("creates unique immutable business numbers and persists on restart", async () => {
    const first = await create();
    const second = await create(input("版本管理"));
    expect(first.requirementNo).toBe("REQ-0001");
    expect(second.requirementNo).toBe("REQ-0002");
    await app.close();
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    await authedInject(app);
    const saved = await app.inject(`/api/requirements/${first.id}`);
    expect(saved.json().name).toBe("需求工作台");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${first.id}`,
      payload: { requirementNo: "REQ-9999" },
    });
    expect(response.statusCode).toBe(400);
  });
  it("patches only submitted fields and separates stages from statuses", async () => {
    const requirement = await create();
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}`,
      payload: { currentStage: "testing", stageNote: "验证主链路" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: requirement.name,
      status: "not_started",
      currentStage: "testing",
    });
    const history = await app.inject(
      `/api/requirements/${requirement.id}/history`,
    );
    expect(history.json()).toEqual([
      expect.objectContaining({
        fromStage: "analysis",
        toStage: "testing",
        note: "验证主链路",
        actor: "local-user",
      }),
    ]);
    await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}`,
      payload: { status: "blocked" },
    });
    expect(
      (await app.inject(`/api/requirements/${requirement.id}/history`)).json(),
    ).toHaveLength(1);
  });
  it("supports two levels and protects parents from deletion", async () => {
    const parent = await create();
    const child = await create({ ...input("搜索筛选"), parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    const grandchild = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { ...input(), parentId: child.id },
    });
    expect(grandchild.statusCode).toBe(409);
    const parentDelete = await app.inject({
      method: "DELETE",
      url: `/api/requirements/${parent.id}`,
    });
    expect(parentDelete.statusCode).toBe(409);
    const reparent = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${parent.id}`,
      payload: { parentId: child.id },
    });
    expect(reparent.statusCode).toBe(409);
    expect((await app.inject(`/api/requirements/${child.id}`)).statusCode).toBe(
      200,
    );
  });
  it("returns the parent and children used for relationship rendering", async () => {
    const parent = await create(input("父需求"));
    const child = await create({ ...input("子需求"), parentId: parent.id });
    const parentRelations = (
      await app.inject(`/api/requirements/${parent.id}/relations`)
    ).json();
    expect(parentRelations.parent).toBeNull();
    expect(
      parentRelations.children.map((item: Requirement) => item.id),
    ).toEqual([child.id]);
    const childRelations = (
      await app.inject(`/api/requirements/${child.id}/relations`)
    ).json();
    expect(childRelations.parent.id).toBe(parent.id);
    expect(childRelations.children).toEqual([]);
    expect(
      (await app.inject("/api/requirements/999/relations")).statusCode,
    ).toBe(404);
  });
  it("soft deletes children, excludes them from queries, never reuses numbers", async () => {
    const parent = await create();
    const child = await create({ ...input("子需求"), parentId: parent.id });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${child.id}`,
        })
      ).statusCode,
    ).toBe(204);
    expect((await app.inject(`/api/requirements/${child.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject("/api/requirements")).json<RequirementListResult>()
        .items[0].children,
    ).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${parent.id}`,
        })
      ).statusCode,
    ).toBe(204);
    expect((await create(input("新需求"))).requirementNo).toBe("REQ-0003");
  });
  it("filters children while preserving their parent and paginates roots", async () => {
    const parent = await create(input("文件管理"));
    const child = await create({
      ...input("设计稿版本"),
      priority: "P0",
      parentId: parent.id,
    });
    await create(input("每日任务"));
    const response = await app.inject(
      "/api/requirements?q=设计稿&priority=P0&pageSize=1",
    );
    const data = response.json<RequirementListResult>();
    expect(data.total).toBe(1);
    expect(data.matchedCount).toBe(1);
    expect(data.items[0].id).toBe(parent.id);
    expect(data.items[0].children[0].id).toBe(child.id);
    expect(
      (
        await app.inject("/api/requirements?pageSize=1")
      ).json<RequirementListResult>().items,
    ).toHaveLength(1);
    expect(
      (
        await app.inject(`/api/requirements?q=${parent.requirementNo}`)
      ).json<RequirementListResult>().items[0].id,
    ).toBe(parent.id);
  });
  it("rejects invalid names, dates, enum values and foreign parents", async () => {
    for (const payload of [
      { ...input("  ") },
      { ...input(), proposedAt: "2026-02-30" },
      { ...input(), status: "unknown" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/requirements",
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/requirements",
          payload: { ...input(), parentId: 999 },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject("/api/requirements?pageSize=1000")).statusCode,
    ).toBe(400);
    expect((await app.inject("/api/requirements/not-an-id")).statusCode).toBe(
      400,
    );
    expect((await app.inject("/api/requirements/999")).statusCode).toBe(404);
  });
  it("returns system paths and a health response without writing sample data", async () => {
    expect((await app.inject("/api/health")).json()).toMatchObject({
      status: "ok",
    });
    expect((await app.inject("/api/system")).json()).toMatchObject({
      schemaVersion: 12,
      workspacePath: join(directory, "workspace"),
    });
    expect((await app.inject("/api/requirements")).json().total).toBe(0);
  });
  it("rejects moving a parent with children under another root", async () => {
    const first = await create(input("父需求一"));
    await create({ ...input("子需求"), parentId: first.id });
    const second = await create(input("父需求二"));
    const response = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${first.id}`,
      payload: { parentId: second.id },
    });
    expect(response.statusCode).toBe(409);
    expect(
      (await app.inject(`/api/requirements/${first.id}`)).json().parentId,
    ).toBeNull();
  });
  it("returns JSON errors for unknown API routes and malformed JSON", async () => {
    const unknown = await app.inject("/api/unknown");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("NOT_FOUND");
    const malformed = await app.inject({
      method: "POST",
      url: "/api/requirements",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("VALIDATION_ERROR");
  });
  it("rolls back requirement and history when auditing fails", async () => {
    const requirement = await create();
    const inspection = new Database(join(directory, "test.sqlite"));
    inspection.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON requirement_audit BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;",
    );
    const response = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}`,
      payload: { name: "不应保存", currentStage: "design" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({
      code: "INTERNAL_ERROR",
      message: "服务器内部错误",
    });
    expect(
      (await app.inject(`/api/requirements/${requirement.id}`)).json(),
    ).toMatchObject({ name: requirement.name, currentStage: "analysis" });
    expect(
      (await app.inject(`/api/requirements/${requirement.id}/history`)).json(),
    ).toHaveLength(0);
    inspection.close();
  });
  it("persists descriptions as Tiptap JSON with exact multiline text roundtrip", async () => {
    const description = "第一段\n\n第三段\n";
    const requirement = await create({ ...input(), description });
    expect(requirement.description).toBe(description);
    const inspection = new Database(join(directory, "test.sqlite"));
    const raw = inspection
      .prepare("SELECT description FROM requirements WHERE id=?")
      .get(requirement.id) as { description: string };
    inspection.close();
    expect(JSON.parse(raw.description)).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "第一段" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "第三段" }] },
        { type: "paragraph" },
      ],
    });
    expect(
      (await app.inject("/api/requirements")).json().items[0].description,
    ).toBe(description);
    const child = await create({
      ...input("子需求"),
      parentId: requirement.id,
      description,
    });
    expect(
      (await app.inject("/api/requirements")).json().items[0].children[0]
        .description,
    ).toBe(description);
    const update = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${child.id}`,
      payload: { description: "\n修改内容" },
    });
    expect(update.json().description).toBe("\n修改内容");
    expect(
      (await app.inject(`/api/requirements/${child.id}`)).json().description,
    ).toBe("\n修改内容");
    const legacy = new Database(join(directory, "test.sqlite"));
    legacy
      .prepare("UPDATE requirements SET description=? WHERE id=?")
      .run("旧版纯文本", requirement.id);
    legacy.close();
    expect(
      (await app.inject(`/api/requirements/${requirement.id}`)).json()
        .description,
    ).toBe("旧版纯文本");
  });
  it("filters inclusive ranges and sorts every business date field", async () => {
    const early = await create({
      ...input("较早需求"),
      ...Object.fromEntries(dateFields.map((key) => [key, "2026-01-10"])),
    });
    const later = await create({
      ...input("较晚需求"),
      ...Object.fromEntries(dateFields.map((key) => [key, "2026-02-10"])),
    });
    for (const key of dateFields) {
      const range = await app.inject(
        `/api/requirements?${key}From=2026-02-10&${key}To=2026-02-10`,
      );
      expect(range.statusCode).toBe(200);
      expect(range.json().items.map((item: Requirement) => item.id)).toEqual([
        later.id,
      ]);
      const ascending = await app.inject(
        `/api/requirements?sortBy=${key}&sortOrder=asc`,
      );
      expect(
        ascending.json().items.map((item: Requirement) => item.id),
      ).toEqual([early.id, later.id]);
    }
  });
  it("roundtrips rich descriptions and versioned stage content with local Markdown files", async () => {
    const requirement = await create({
      ...input(),
      descriptionHtml: "<h2>目标</h2><p><strong>支持行内编辑</strong></p>",
    });
    expect(requirement.descriptionHtml).toContain("<strong>");
    const initial = (
      await app.inject(`/api/requirements/${requirement.id}/workspace`)
    ).json();
    const payload = {
      ...initial,
      designUrl: "https://www.figma.com/design/example",
      analysis: { analysisText: "# 背景\n范围", prdText: "# PRD" },
      testing: [
        {
          id: crypto.randomUUID(),
          title: "保存异常",
          bodyHtml: "<p>问题</p>",
          answerHtml: "<p>已修复</p>",
          status: "resolved",
          createdAt: new Date().toISOString(),
          linkedChildId: null,
        },
      ],
    };
    const saved = await app.inject({
      method: "PUT",
      url: `/api/requirements/${requirement.id}/workspace`,
      payload,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().version).toBe(1);
    expect(
      readFileSync(
        join(
          directory,
          "workspace",
          ...(await requirementRootRelative(app, requirement.id)).split("/"),
          "analysis",
          "analysis.md",
        ),
        "utf8",
      ),
    ).toBe(payload.analysis.analysisText);
    const conflict = await app.inject({
      method: "PUT",
      url: `/api/requirements/${requirement.id}/workspace`,
      payload,
    });
    expect(conflict.statusCode).toBe(409);
    const reloaded = (
      await app.inject(`/api/requirements/${requirement.id}/workspace`)
    ).json();
    expect(reloaded.testing[0]).toMatchObject({
      title: "保存异常",
      status: "resolved",
    });
    expect(
      (await app.inject(`/api/requirements/${requirement.id}`)).json()
        .descriptionHtml,
    ).toBe(requirement.descriptionHtml);
  });
  it("stores supported image bytes locally and rejects invalid image payloads and names", async () => {
    const requirement = await create();
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfEsAAAAASUVORK5CYII=";
    const image = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/images`,
      payload: { mime: "image/png", data },
    });
    expect(image.statusCode).toBe(200);
    const url = image.json().url;
    expect(
      existsSync(
        join(
          directory,
          "workspace",
          ...(await requirementRootRelative(app, requirement.id)).split("/"),
          "images",
          url.split("/").pop(),
        ),
      ),
    ).toBe(true);
    const download = await app.inject(url);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.rawPayload).toEqual(Buffer.from(data, "base64"));
    const invalid = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/images`,
      payload: {
        mime: "image/png",
        data: Buffer.from("html").toString("base64"),
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      (
        await app.inject(
          `/api/requirements/${requirement.id}/images/invalid.png`,
        )
      ).statusCode,
    ).toBe(404);
  });
  it("creates link entries and enforces per-category entry kinds", async () => {
    const requirement = await create();
    const link = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "design",
        category: "designLink",
        name: "Figma 设计稿",
        resourceType: "link",
        linkUrl: "https://www.figma.com/design/example",
      },
    });
    expect(link.statusCode).toBe(201);
    expect(link.json()).toMatchObject({
      kind: "link",
      resourceType: "link",
      storageType: "external",
      status: "draft",
      isFinal: false,
      linkUrl: "https://www.figma.com/design/example",
      fileName: "",
    });
    // 仅链接分类不接受文件条目
    const rejected = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "design",
        category: "designLink",
        name: "原型",
        data: Buffer.from("html").toString("base64"),
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("VALIDATION_ERROR");
    // 链接条目没有文件内容可读写
    const fileId = link.json().id;
    const content = await app.inject(
      `/api/requirements/${requirement.id}/files/${fileId}/content`,
    );
    expect(content.statusCode).toBe(400);
    // 删除为软删除：列表消失，索引行保留
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${requirement.id}/files/${fileId}`,
        })
      ).statusCode,
    ).toBe(204);
    const inspection = new Database(join(directory, "test.sqlite"));
    const row = inspection
      .prepare(
        "SELECT is_deleted, resource_type FROM requirement_files WHERE id=?",
      )
      .get(fileId) as { is_deleted: number; resource_type: string };
    inspection.close();
    expect(row).toMatchObject({ is_deleted: 1, resource_type: "link" });
    const groups = (
      await app.inject(`/api/requirements/${requirement.id}/files?phase=design`)
    ).json<RequirementFileList>().groups;
    expect(
      groups.find((group) => group.category === "designLink")!.files,
    ).toHaveLength(0);
  });
  it("creates text assets stored in the database with full content roundtrip", async () => {
    const requirement = await create();
    const created = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "testing",
        category: "testReport",
        name: "冒烟测试记录",
        resourceType: "text",
        textContent: "# 冒烟测试\n\n全部通过。",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      resourceType: "text",
      storageType: "database",
      textContent: null,
      fileName: "",
    });
    const fileId = created.json().id;
    const content = await app.inject(
      `/api/requirements/${requirement.id}/files/${fileId}/content`,
    );
    expect(content.statusCode).toBe(200);
    expect(content.json().content).toContain("全部通过");
    // 文本保存更新库内容而非磁盘
    const saved = await app.inject({
      method: "PUT",
      url: `/api/requirements/${requirement.id}/files/${fileId}/content`,
      payload: { content: "# 冒烟测试\n\n更新后的记录。" },
    });
    expect(saved.statusCode).toBe(200);
    const reread = await app.inject(
      `/api/requirements/${requirement.id}/files/${fileId}/content`,
    );
    expect(reread.json().content).toContain("更新后的记录");
    // 超长文本被拒绝（200KB 上限）
    const tooLong = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "testing",
        category: "testReport",
        name: "超长记录",
        resourceType: "text",
        textContent: "a".repeat(200001),
      },
    });
    expect(tooLong.statusCode).toBe(400);
    // raw 接口对文本资源拒绝
    expect(
      (
        await app.inject(
          `/api/requirements/${requirement.id}/files/${fileId}/raw`,
        )
      ).statusCode,
    ).toBe(400);
  });
  it("archives assets via status and projects isFinal from status", async () => {
    const requirement = await create();
    const created = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "development",
        category: "technicalDoc",
        name: "联调说明",
        resourceType: "text",
        textContent: "接口约定。",
        isFinal: true,
      },
    });
    const fileId = created.json().id;
    // isFinal 输入兼容：映射为 status=final
    expect(created.json()).toMatchObject({ status: "final", isFinal: true });
    // 归档：isFinal 投影随之变为 false
    const archived = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/files/${fileId}`,
      payload: { status: "archived" },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      status: "archived",
      isFinal: false,
    });
    // 同时提交 isFinal 与 status 被拒绝
    const conflict = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/files/${fileId}`,
      payload: { isFinal: true, status: "draft" },
    });
    expect(conflict.statusCode).toBe(400);
    // missing 不可手工设置
    const missing = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/files/${fileId}`,
      payload: { status: "missing" },
    });
    expect(missing.statusCode).toBe(400);
  });
  it("soft-deletes files keeping them on disk and hides them from lists", async () => {
    const requirement = await create();
    const created = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "analysis",
        category: "other",
        name: "参考资料.pdf",
        data: Buffer.from("pdf-bytes").toString("base64"),
      },
    });
    expect(created.statusCode).toBe(201);
    const file = created.json() as RequirementFile;
    // 新文件统一落 files/ 目录并记录相对路径；需求根目录按「需求编号 + 名称」命名
    const rootRelative = await requirementRootRelative(app, requirement.id);
    expect(file.relativePath).toBe(`${rootRelative}/files/${file.fileName}`);
    const absolute = join(
      directory,
      "workspace",
      ...file.relativePath!.split("/"),
    );
    expect(existsSync(absolute)).toBe(true);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${requirement.id}/files/${file.id}`,
        })
      ).statusCode,
    ).toBe(204);
    // 列表中消失，磁盘文件保留
    const groups = (
      await app.inject(
        `/api/requirements/${requirement.id}/files?phase=analysis&all=true`,
      )
    ).json<RequirementFileList>().groups;
    expect(
      groups.find((group) => group.category === "other")!.files,
    ).toHaveLength(0);
    expect(existsSync(absolute)).toBe(true);
    // 二次删除：软删后的行不再可见，返回 404
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${requirement.id}/files/${file.id}`,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("roundtrips text content near the 200KB limit", async () => {
    const requirement = await create();
    const content = "测".repeat(200000);
    const created = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "testing",
        category: "testReport",
        name: "大容量测试记录",
        resourceType: "text",
        textContent: content,
      },
    });
    expect(created.statusCode).toBe(201);
    const fileId = created.json().id;
    const fetched = await app.inject(
      `/api/requirements/${requirement.id}/files/${fileId}/content`,
    );
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().content).toBe(content);
    // 再次写入同样长度的新内容仍成功（更新路径同样在上限内）
    const next = "更".repeat(200000);
    const saved = await app.inject({
      method: "PUT",
      url: `/api/requirements/${requirement.id}/files/${fileId}/content`,
      payload: { content: next },
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (
        await app.inject(
          `/api/requirements/${requirement.id}/files/${fileId}/content`,
        )
      ).json().content,
    ).toBe(next);
  });
  it("marks local files as missing and returns 404 once the disk file disappears", async () => {
    const requirement = await create();
    const created = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "analysis",
        category: "other",
        name: "丢失的文件.pdf",
        mime: "application/pdf",
        data: Buffer.from("%PDF-1.4").toString("base64"),
      },
    });
    expect(created.statusCode).toBe(201);
    const file = created.json() as RequirementFile;
    const absolute = join(
      directory,
      "workspace",
      ...file.relativePath!.split("/"),
    );
    expect(existsSync(absolute)).toBe(true);
    rmSync(absolute);
    // raw 与 content 均返回 404
    expect(
      (
        await app.inject(
          `/api/requirements/${requirement.id}/files/${file.id}/raw`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject(
          `/api/requirements/${requirement.id}/files/${file.id}/content`,
        )
      ).statusCode,
    ).toBe(404);
    // 行被标记 status=missing（不删行、不重复标记）
    const inspection = new Database(join(directory, "test.sqlite"));
    const row = inspection
      .prepare("SELECT status, is_deleted FROM requirement_files WHERE id=?")
      .get(file.id) as { status: string; is_deleted: number };
    inspection.close();
    expect(row).toMatchObject({ status: "missing", is_deleted: 0 });
    // 列表可见且带 missing 状态
    const groups = (
      await app.inject(
        `/api/requirements/${requirement.id}/files?phase=analysis&all=true`,
      )
    ).json<RequirementFileList>().groups;
    const listed = groups
      .find((group) => group.category === "other")!
      .files.find((item) => item.id === file.id);
    expect(listed).toMatchObject({ status: "missing", isFinal: false });
  });
  it("returns the full category skeleton with empty groups when nothing is stored", async () => {
    const requirement = await create();
    const all = (
      await app.inject(
        `/api/requirements/${requirement.id}/files?phase=all&all=true`,
      )
    ).json<RequirementFileList>();
    expect(all.groups).toHaveLength(7);
    expect(all.groups.map((group) => group.category)).toEqual([
      "record",
      "prototype",
      "prd",
      "mindMap",
      "flowchart",
      "uiAssets",
      "other",
    ]);
    expect(
      all.groups.every(
        (group) => group.total === 0 && group.files.length === 0,
      ),
    ).toBe(true);
    expect(all.editorFile).toBeNull();
  });
  it("rejects file payloads just above the 5MB limit", async () => {
    const requirement = await create();
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 7).toString("base64");
    const rejected = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "analysis",
        category: "other",
        name: "超大文件.zip",
        mime: "application/zip",
        data: oversized,
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("VALIDATION_ERROR");
    // 恰好 5MB 仍被接受
    const exact = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "analysis",
        category: "other",
        name: "恰好上限.zip",
        mime: "application/zip",
        data: Buffer.alloc(5 * 1024 * 1024, 7).toString("base64"),
      },
    });
    expect(exact.statusCode).toBe(201);
  });
  it("keeps stage groups aligned with the new category catalog", async () => {
    const requirement = await create();
    const design = (
      await app.inject(`/api/requirements/${requirement.id}/files?phase=design`)
    ).json<RequirementFileList>();
    expect(design.groups.map((group) => group.category)).toEqual([
      "designLink",
      "uiAssets",
      "designNote",
      "prototype",
      "other",
    ]);
    const testing = (
      await app.inject(
        `/api/requirements/${requirement.id}/files?phase=testing`,
      )
    ).json<RequirementFileList>();
    expect(testing.groups.map((group) => group.category)).toEqual([
      "testReport",
      "testData",
      "testEvidence",
      "other",
    ]);
    // 分析记录仍是 analysis 阶段的默认编辑器文件
    const analysis = (
      await app.inject(
        `/api/requirements/${requirement.id}/files?phase=analysis`,
      )
    ).json<RequirementFileList>();
    expect(analysis.editorFile).toMatchObject({
      name: "分析记录",
      fileName: "analysis-record.md",
      status: "final",
      isFinal: true,
    });
  });
});
