import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";
import { authedInject } from "./auth-helper";

// 需求知识库（迁移 0007）：索引/磁盘一致性、路径安全、记忆保护、外部修改检测
describe("artifact service", () => {
  let app: FastifyInstance;
  let directory: string;
  let requirementId: number;
  let workspacePath: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-artifacts-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
    });
    await authedInject(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { name: "知识库需求", proposedAt: "2026-10-15" },
    });
    requirementId = created.json().id;
    workspacePath = (await app.inject({ method: "GET", url: "/api/system" })).json()
      .workspacePath as string;
  });
  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function requirementRoot() {
    return join(workspacePath, "requirements", String(requirementId));
  }
  async function createFolder(name: string, parentId: number | null = null) {
    return app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/folders`,
      payload: { parentId, name },
    });
  }
  async function createFile(
    name: string,
    parentId: number | null = null,
    initialContent?: string,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/files`,
      payload: { parentId, name, ...(initialContent ? { initialContent } : {}) },
    });
  }
  async function list(parentId: number | null = null) {
    const query = parentId ? `?parentId=${parentId}` : "";
    const response = await app.inject({
      method: "GET",
      url: `/api/requirements/${requirementId}/artifacts${query}`,
    });
    return response.json();
  }

  it("创建需求时初始化需求记忆（模板落盘且含关键章节）", async () => {
    const memory = await app.inject({
      method: "GET",
      url: `/api/requirements/${requirementId}/memory`,
    });
    expect(memory.statusCode).toBe(200);
    const node = memory.json();
    expect(node.relativePath).toBe("需求记忆.md");
    const memoryPath = join(requirementRoot(), "需求记忆.md");
    expect(existsSync(memoryPath)).toBe(true);
    const content = readFileSync(memoryPath, "utf8");
    for (const section of [
      "已确认事实",
      "假设（待验证）",
      "重要决策及依据",
      "待确认问题",
      "下一步行动",
      "关联产出物",
    ]) {
      expect(content).toContain(section);
    }
    // 首目录列表也应包含记忆文件
    const root = await list();
    expect(root.files.some((file: { name: string }) => file.name === "需求记忆.md")).toBe(
      true,
    );
  });

  it("创建文件夹与文件真实落盘并进入索引", async () => {
    const folder = await createFolder("研究资料");
    expect(folder.statusCode).toBe(201);
    const file = await createFile("调研笔记.md", folder.json().id, "# 调研\n");
    expect(file.statusCode).toBe(201);
    expect(existsSync(join(requirementRoot(), "研究资料"))).toBe(true);
    expect(existsSync(join(requirementRoot(), "研究资料", "调研笔记.md"))).toBe(true);
    const dir = await list(folder.json().id);
    expect(dir.folders).toHaveLength(0);
    expect(dir.files).toHaveLength(1);
    expect(dir.files[0]).toMatchObject({
      name: "调研笔记.md",
      extension: ".md",
      sizeBytes: 9,
    });
  });

  it("同级重名节点与同名链接被拒绝", async () => {
    await createFolder("方案");
    const duplicate = await createFile("方案");
    expect(duplicate.statusCode).toBe(409);
    const linkOnFolder = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/links`,
      payload: { folderNodeId: null, name: "方案", url: "https://example.com" },
    });
    expect(linkOnFolder.statusCode).toBe(409);
    const secondFolder = await createFolder("方案");
    expect(secondFolder.statusCode).toBe(409);
  });

  it("越界与非法名称被拒绝（含路径分隔符与父目录引用）", async () => {
    for (const name of ["../escape", "a/b", ".", "..", "名称<span>", "trailing."]) {
      const response = await createFolder(name);
      expect(response.statusCode).toBe(400);
    }
    // 名称合法但 parent 越界到其它需求：父目录不存在
    const crossApp = await createFile("x.md", 999999);
    expect(crossApp.statusCode).toBe(404);
    expect(existsSync(join(workspacePath, "escape"))).toBe(false);
  });

  it("目录移动到自身子目录被拒绝；移动后 relative_path 级联更新", async () => {
    const parent = (await createFolder("父目录")).json();
    const child = (await createFolder("子目录", parent.id)).json();
    const grandChild = (await createFile("孙文件.md", child.id, "内容")).json();
    // 循环移动：父目录 → 自己的子目录
    const cycle = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${parent.id}/move`,
      payload: { targetParentId: child.id },
    });
    expect(cycle.statusCode).toBe(409);
    // 合法移动：子目录 → 根目录
    const moved = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${child.id}/move`,
      payload: { targetParentId: null },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ parentId: null, relativePath: "子目录" });
    const details = await app.inject({
      method: "GET",
      url: `/api/artifacts/nodes/${grandChild.id}`,
    });
    expect(details.json().node.relativePath).toBe("子目录/孙文件.md");
    expect(existsSync(join(requirementRoot(), "子目录", "孙文件.md"))).toBe(true);
  });

  it("需求记忆受保护：不可删除、不可重命名；普通文件删除后落盘消失", async () => {
    const memory = (
      await app.inject({
        method: "GET",
        url: `/api/requirements/${requirementId}/memory`,
      })
    ).json();
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/nodes/${memory.id}`,
    });
    expect(removed.statusCode).toBe(409);
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/nodes/${memory.id}`,
      payload: { name: "记忆备份.md" },
    });
    expect(renamed.statusCode).toBe(409);
    const file = (await createFile("临时.md", null, "x")).json();
    const removedFile = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/nodes/${file.id}`,
    });
    expect(removedFile.statusCode).toBe(204);
    expect(existsSync(join(requirementRoot(), "临时.md"))).toBe(false);
  });

  it("外部删除文件后被标记 missing，外部修改后标记 external_changed", async () => {
    const file = (await createFile("外部.md", null, "v1")).json();
    rmSync(join(requirementRoot(), "外部.md"));
    await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/refresh`,
    });
    const afterDelete = await list();
    expect(
      afterDelete.files.find((node: { id: number }) => node.id === file.id).status,
    ).toBe("missing");
    // 磁盘恢复且内容变化：刷新后元数据更新并标记 external_changed
    const restoredPath = join(requirementRoot(), "外部.md");
    writeFileSync(restoredPath, "外部改动后的内容");
    const past = new Date(Date.now() - 60_000);
    utimesSync(restoredPath, past, past);
    await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/refresh`,
    });
    const afterRestore = await list();
    const restored = afterRestore.files.find(
      (node: { id: number }) => node.id === file.id,
    );
    expect(restored.status).toBe("external_changed");
    expect(restored.sizeBytes).toBeGreaterThan(2);
  });

  it("编辑器按 nodeId 读写；外部修改后保存需 force 确认（不静默覆盖）", async () => {
    const file = (await createFile("笔记.md", null, "# 初始\n")).json();
    const saved = await app.inject({
      method: "PUT",
      url: `/api/artifacts/nodes/${file.id}/content`,
      payload: { content: "# 第二版\n" },
    });
    expect(saved.statusCode).toBe(200);
    const read = await app.inject({
      method: "GET",
      url: `/api/artifacts/nodes/${file.id}/content`,
    });
    expect(read.json().content).toBe("# 第二版\n");
    // 模拟外部程序修改（磁盘 mtime 晚于索引）
    const externalPath = join(requirementRoot(), "笔记.md");
    writeFileSync(externalPath, "外部内容", "utf8");
    const future = new Date(Date.now() + 60_000);
    utimesSync(externalPath, future, future);
    const conflict = await app.inject({
      method: "PUT",
      url: `/api/artifacts/nodes/${file.id}/content`,
      payload: { content: "覆盖内容" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("FILE_CONFLICT");
    const forced = await app.inject({
      method: "PUT",
      url: `/api/artifacts/nodes/${file.id}/content`,
      payload: { content: "覆盖内容", force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(readFileSync(externalPath, "utf8")).toBe("覆盖内容");
  });

  it("删除非空目录需递归确认，链接随目录一起清理", async () => {
    const folder = (await createFolder("带内容的目录")).json();
    await createFile("内部.md", folder.id, "内");
    const link = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/links`,
      payload: { folderNodeId: folder.id, name: "内部链接", url: "https://example.com/a" },
    });
    expect(link.statusCode).toBe(201);
    const shallow = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/nodes/${folder.id}`,
    });
    expect(shallow.statusCode).toBe(409);
    expect(shallow.json().error.message).toContain("2 个子项");
    const recursive = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/nodes/${folder.id}?recursive=1`,
    });
    expect(recursive.statusCode).toBe(204);
    expect(existsSync(join(requirementRoot(), "带内容的目录"))).toBe(false);
    const gone = await app.inject({
      method: "GET",
      url: `/api/artifacts/links/${link.json().id}`,
    });
    expect([400, 404]).toContain(gone.statusCode);
  });

  it("链接 CRUD：协议白名单拒绝恶意地址，更新与删除正常", async () => {
    const rejected = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/links`,
      payload: { folderNodeId: null, name: "恶意", url: "javascript:alert(1)" },
    });
    expect(rejected.statusCode).toBe(400);
    const created = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/links`,
      payload: {
        folderNodeId: null,
        name: "产品文档",
        url: "https://docs.example.com/x",
        description: "在线文档",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "产品文档",
      url: "https://docs.example.com/x",
      folderNodeId: null,
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/links/${created.json().id}`,
      payload: { name: "产品文档 v2", description: null },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "产品文档 v2", description: null });
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/links/${created.json().id}`,
    });
    expect(removed.statusCode).toBe(204);
    const root = await list();
    expect(root.links).toHaveLength(0);
  });

  it("名称搜索返回全需求范围匹配（含相对路径）", async () => {
    const folder = (await createFolder("资料库")).json();
    await createFile("调研笔记.md", folder.id, "x");
    await createFile("会议记录.md", null, "x");
    const result = await app.inject({
      method: "GET",
      url: `/api/requirements/${requirementId}/artifacts?q=${encodeURIComponent("笔记")}`,
    });
    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.files.map((file: { name: string }) => file.name)).toEqual([
      "调研笔记.md",
    ]);
    expect(body.files[0].relativePath).toBe("资料库/调研笔记.md");
  });
});
