import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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
import { requirementRootPath } from "./workspace-helper";

// 需求知识库（迁移 0007）：索引/磁盘一致性、路径安全、记忆保护、外部修改检测
describe("artifact service", () => {
  let app: FastifyInstance;
  let directory: string;
  let requirementId: number;
  let workspacePath: string;
  let rootPath: string;

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
    workspacePath = (
      await app.inject({ method: "GET", url: "/api/system" })
    ).json().workspacePath as string;
    // 需求物理目录按「需求编号 + 名称」命名，通过目录映射接口取真实路径
    rootPath = await requirementRootPath(app, workspacePath, requirementId);
  });
  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  // 物理目录名是「需求编号 + 需求名称」，经目录映射接口解析（迁移 0010）
  function requirementRoot() {
    return rootPath;
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
      payload: {
        parentId,
        name,
        ...(initialContent ? { initialContent } : {}),
      },
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
  async function upload(
    name: string,
    content: Buffer | string,
    parentId: number | null = null,
  ) {
    const params = new URLSearchParams({ name });
    if (parentId) params.set("parentId", String(parentId));
    return app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/upload?${params.toString()}`,
      headers: { "content-type": "application/octet-stream" },
      payload: typeof content === "string" ? Buffer.from(content) : content,
    });
  }
  // 测试直连数据库：模拟升级前已写入的历史 ~$ 索引记录
  function withDatabase<T>(work: (db: Database.Database) => T): T {
    const db = new Database(join(directory, "test.sqlite"));
    try {
      return work(db);
    } finally {
      db.close();
    }
  }
  function insertLegacyTemporaryNode(name: string): number {
    return withDatabase((db) => {
      const now = new Date().toISOString();
      const result = db
        .prepare(
          "INSERT INTO artifact_nodes(requirement_id, parent_id, node_type, name, relative_path, indexed_at, status, created_at, updated_at) VALUES (?, NULL, 'file', ?, ?, ?, 'normal', ?, ?)",
        )
        .run(requirementId, name, name, now, now, now);
      return Number(result.lastInsertRowid);
    });
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
    expect(
      root.files.some((file: { name: string }) => file.name === "需求记忆.md"),
    ).toBe(true);
  });

  it("创建文件夹与文件真实落盘并进入索引", async () => {
    const folder = await createFolder("研究资料");
    expect(folder.statusCode).toBe(201);
    const file = await createFile("调研笔记.md", folder.json().id, "# 调研\n");
    expect(file.statusCode).toBe(201);
    expect(existsSync(join(requirementRoot(), "研究资料"))).toBe(true);
    expect(existsSync(join(requirementRoot(), "研究资料", "调研笔记.md"))).toBe(
      true,
    );
    const dir = await list(folder.json().id);
    expect(dir.folders).toHaveLength(0);
    expect(dir.files).toHaveLength(1);
    expect(dir.files[0]).toMatchObject({
      name: "调研笔记.md",
      extension: ".md",
      sizeBytes: 9,
    });
  });

  it("新建文件未填写扩展名时默认创建 Markdown", async () => {
    const file = await createFile("无后缀笔记");
    expect(file.statusCode).toBe(201);
    expect(file.json()).toMatchObject({
      name: "无后缀笔记.md",
      extension: ".md",
      mimeType: "text/markdown; charset=utf-8",
    });
    expect(existsSync(join(requirementRoot(), "无后缀笔记.md"))).toBe(true);
    expect(existsSync(join(requirementRoot(), "无后缀笔记"))).toBe(false);
  });

  it("同级重名节点与同名链接被拒绝", async () => {
    await createFolder("方案.md");
    const duplicate = await createFile("方案");
    expect(duplicate.statusCode).toBe(409);
    const linkOnFolder = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/links`,
      payload: {
        folderNodeId: null,
        name: "方案.md",
        url: "https://example.com",
      },
    });
    expect(linkOnFolder.statusCode).toBe(409);
    const secondFolder = await createFolder("方案.md");
    expect(secondFolder.statusCode).toBe(409);
  });

  it("越界与非法名称被拒绝（含路径分隔符与父目录引用）", async () => {
    for (const name of [
      "../escape",
      "a/b",
      ".",
      "..",
      "名称<span>",
      "trailing.",
    ]) {
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
    expect(moved.json()).toMatchObject({
      parentId: null,
      relativePath: "子目录",
    });
    const details = await app.inject({
      method: "GET",
      url: `/api/artifacts/nodes/${grandChild.id}`,
    });
    expect(details.json().node.relativePath).toBe("子目录/孙文件.md");
    expect(existsSync(join(requirementRoot(), "子目录", "孙文件.md"))).toBe(
      true,
    );
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
      afterDelete.files.find((node: { id: number }) => node.id === file.id)
        .status,
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

  it("WPS 打开文档产生的 ~$ 临时文件不会登记为正式文档", async () => {
    const formal = (await createFile("合同.md", null, "# 合同")).json();
    const tempPath = join(requirementRoot(), "~$合同.docx");
    writeFileSync(tempPath, "wps-lock");
    // 进入目录触发轻量同步
    const afterList = await list();
    expect(
      afterList.files.some((node: { name: string }) =>
        node.name.startsWith("~$"),
      ),
    ).toBe(false);
    expect(
      afterList.files.find((node: { id: number }) => node.id === formal.id)
        .status,
    ).toBe("normal");
    // 显式刷新递归扫描同样不登记
    const refreshed = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/refresh`,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(
      (await list()).files.some((node: { name: string }) =>
        node.name.startsWith("~$"),
      ),
    ).toBe(false);
    // 不删除磁盘上的真实临时文件（由 WPS 自己管理）
    expect(existsSync(tempPath)).toBe(true);
  });

  it("WPS 关闭后临时文件删除，不产生缺失记录且正式文档保持正常", async () => {
    const formal = (await createFile("方案.md", null, "# 方案")).json();
    const tempPath = join(requirementRoot(), "~$方案.docx");
    writeFileSync(tempPath, "wps-lock");
    await list();
    rmSync(tempPath);
    const refreshed = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/refresh`,
    });
    expect(refreshed.statusCode).toBe(200);
    const files = (await list()).files;
    expect(
      files.find((node: { id: number }) => node.id === formal.id).status,
    ).toBe("normal");
    expect(
      files.some((node: { name: string }) => node.name.startsWith("~$")),
    ).toBe(false);
  });

  it("显式创建或上传 ~$ 文件被拒绝", async () => {
    const created = await createFile("~$合同.docx");
    expect(created.statusCode).toBe(400);
    expect(created.json().error.message).toContain("临时锁定文件");
    expect(existsSync(join(requirementRoot(), "~$合同.docx"))).toBe(false);
    const uploaded = await upload("~$合同.docx", "wps-lock");
    expect(uploaded.statusCode).toBe(400);
    expect(uploaded.json().error.message).toContain("临时锁定文件");
    expect(existsSync(join(requirementRoot(), "~$合同.docx"))).toBe(false);
  });

  it("清理历史 ~$ 临时记录：可重复执行，正式文档与问题关联不受影响", async () => {
    const formal = (await createFile("正式方案.md", null, "# 方案")).json();
    const issue = (
      await app.inject({
        method: "POST",
        url: `/api/requirements/${requirementId}/issues`,
        payload: { stage: "design", title: "历史临时记录清理验证" },
      })
    ).json();
    const linked = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/issues/${issue.id}/assets`,
      payload: { assetId: formal.id, relationType: "evidence" },
    });
    expect(linked.statusCode).toBe(201);
    const tempName = "~$正式方案.docx";
    const tempPath = join(requirementRoot(), tempName);
    writeFileSync(tempPath, "wps-crash-leftover");
    const tempId = insertLegacyTemporaryNode(tempName);
    withDatabase((db) => {
      db.prepare(
        "INSERT INTO issue_artifact_links(issue_id, artifact_id, relation_type, created_at) VALUES (?, ?, 'reference', ?)",
      ).run(issue.id, tempId, new Date().toISOString());
    });
    const first = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/refresh`,
    });
    expect(first.statusCode).toBe(200);
    const stateAfterFirst = withDatabase((db) => ({
      temp: db
        .prepare("SELECT id FROM artifact_nodes WHERE id=?")
        .get(tempId) as { id: number } | undefined,
      formal: db
        .prepare("SELECT id, status FROM artifact_nodes WHERE id=?")
        .get(formal.id) as { id: number; status: string } | undefined,
      formalLinks: db
        .prepare(
          "SELECT COUNT(*) AS total FROM issue_artifact_links WHERE artifact_id=?",
        )
        .get(formal.id) as { total: number },
      tempLinks: db
        .prepare(
          "SELECT COUNT(*) AS total FROM issue_artifact_links WHERE artifact_id=?",
        )
        .get(tempId) as { total: number },
    }));
    expect(stateAfterFirst.temp).toBeUndefined();
    expect(stateAfterFirst.formal).toMatchObject({
      id: formal.id,
      status: "normal",
    });
    expect(stateAfterFirst.formalLinks.total).toBe(1);
    expect(stateAfterFirst.tempLinks.total).toBe(0);
    // 只清理数据库记录，不删除磁盘文件
    expect(existsSync(tempPath)).toBe(true);
    // 再次刷新保持幂等，且不会把残留的 ~$ 文件重新登记
    const second = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/refresh`,
    });
    expect(second.statusCode).toBe(200);
    expect(
      withDatabase(
        (db) =>
          db
            .prepare("SELECT COUNT(*) AS total FROM artifact_nodes WHERE id=?")
            .get(tempId) as { total: number },
      ).total,
    ).toBe(0);
    expect(
      (await list()).files.some((node: { name: string }) =>
        node.name.startsWith("~$"),
      ),
    ).toBe(false);
  });

  it("服务启动时清理历史 ~$ 记录，重复启动保持幂等", async () => {
    const formal = (await createFile("启动保留.md", null, "内容")).json();
    const tempId = insertLegacyTemporaryNode("~$启动清理.docx");
    const options = {
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
    } as const;
    await app.close();
    app = await createApp(options);
    await authedInject(app);
    const afterFirstStart = withDatabase((db) => ({
      temp: db
        .prepare("SELECT id FROM artifact_nodes WHERE id=?")
        .get(tempId) as { id: number } | undefined,
      formal: db
        .prepare("SELECT id FROM artifact_nodes WHERE id=?")
        .get(formal.id) as { id: number } | undefined,
    }));
    expect(afterFirstStart.temp).toBeUndefined();
    expect(afterFirstStart.formal).toBeDefined();
    // 第二次启动不重复报错，正式文档仍在
    await app.close();
    app = await createApp(options);
    await authedInject(app);
    const afterSecondStart = withDatabase((db) => ({
      temp: db
        .prepare("SELECT id FROM artifact_nodes WHERE id=?")
        .get(tempId) as { id: number } | undefined,
      formal: db
        .prepare("SELECT id FROM artifact_nodes WHERE id=?")
        .get(formal.id) as { id: number } | undefined,
    }));
    expect(afterSecondStart.temp).toBeUndefined();
    expect(afterSecondStart.formal).toBeDefined();
  });

  it("正式文档删除标记 missing、恢复后回到 normal，重命名保持正常", async () => {
    const file = (await createFile("正式文档.md", null, "v1")).json();
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/nodes/${file.id}`,
      payload: { name: "正式文档-v2.md" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().relativePath).toBe("正式文档-v2.md");
    expect(existsSync(join(requirementRoot(), "正式文档-v2.md"))).toBe(true);
    expect(existsSync(join(requirementRoot(), "正式文档.md"))).toBe(false);
    // 外部删除 → missing
    rmSync(join(requirementRoot(), "正式文档-v2.md"));
    await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/refresh`,
    });
    let node = (await list()).files.find(
      (item: { id: number }) => item.id === file.id,
    );
    expect(node.status).toBe("missing");
    // 磁盘恢复 → normal
    writeFileSync(join(requirementRoot(), "正式文档-v2.md"), "v2");
    node = (await list()).files.find(
      (item: { id: number }) => item.id === file.id,
    );
    expect(node.status).toBe("normal");
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
      payload: {
        folderNodeId: folder.id,
        name: "内部链接",
        url: "https://example.com/a",
      },
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
    expect(updated.json()).toMatchObject({
      name: "产品文档 v2",
      description: null,
    });
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/links/${created.json().id}`,
    });
    expect(removed.statusCode).toBe(204);
    const root = await list();
    expect(root.links).toHaveLength(0);
  });

  it("最终版标记：文件与链接可切换并持久化，文件夹拒绝", async () => {
    const folder = (await createFolder("定稿资料")).json();
    const file = (
      await createFile("定稿方案.md", folder.id, "# 定稿\n")
    ).json();
    const link = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/links`,
      payload: {
        folderNodeId: folder.id,
        name: "定稿链接",
        url: "https://example.com/final",
      },
    });
    expect(link.statusCode).toBe(201);

    const marked = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/nodes/${file.id}/final`,
      payload: { isFinal: true },
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({ id: file.id, isFinal: true });
    const listed = await list(folder.id);
    expect(
      listed.files.find((item: { id: number }) => item.id === file.id),
    ).toMatchObject({ isFinal: true });

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/nodes/${file.id}/final`,
      payload: { isFinal: false },
    });
    expect(cleared.json().isFinal).toBe(false);

    const folderRejected = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/nodes/${folder.id}/final`,
      payload: { isFinal: true },
    });
    expect(folderRejected.statusCode).toBe(400);

    const linkMarked = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/links/${link.json().id}/final`,
      payload: { isFinal: true },
    });
    expect(linkMarked.statusCode).toBe(200);
    expect(linkMarked.json()).toMatchObject({ isFinal: true });
    const folderContents = await list(folder.id);
    expect(
      folderContents.links.find(
        (item: { id: number }) => item.id === link.json().id,
      ),
    ).toMatchObject({ isFinal: true });

    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/nodes/${file.id}/final`,
      payload: { isFinal: "yes" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("上传文件：子目录落盘、重名自动改名、非法名称与目标校验", async () => {
    const folder = (await createFolder("上传资料")).json();
    const content = "# 上传\n";
    const first = await upload("上传文档.md", content, folder.id);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      parentId: folder.id,
      name: "上传文档.md",
      extension: ".md",
      mimeType: "text/markdown; charset=utf-8",
      sizeBytes: Buffer.byteLength(content),
    });
    expect(
      readFileSync(join(requirementRoot(), "上传资料", "上传文档.md"), "utf8"),
    ).toBe(content);
    const listed = await list(folder.id);
    expect(
      listed.files.find((item: { id: number }) => item.id === first.json().id),
    ).toMatchObject({ name: "上传文档.md" });

    // 同名不覆盖，自动追加序号后再次落盘
    const second = await upload("上传文档.md", "第二份", folder.id);
    expect(second.statusCode).toBe(201);
    expect(second.json().name).toBe("上传文档-1.md");
    expect(
      readFileSync(
        join(requirementRoot(), "上传资料", "上传文档-1.md"),
        "utf8",
      ),
    ).toBe("第二份");

    // 二进制内容按原始字节落盘，未知扩展名以二进制返回
    const binaryContent = Buffer.from([0, 1, 2, 255]);
    const binary = await upload("原始数据.bin", binaryContent, folder.id);
    expect(binary.statusCode).toBe(201);
    expect(binary.json()).toMatchObject({
      extension: ".bin",
      mimeType: null,
      sizeBytes: 4,
    });
    const raw = await app.inject({
      method: "GET",
      url: `/api/artifacts/nodes/${binary.json().id}/raw`,
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.rawPayload.equals(binaryContent)).toBe(true);

    // 需求根目录也可直接上传
    const rootFile = await upload("根目录说明.txt", "root");
    expect(rootFile.statusCode).toBe(201);
    const root = await list();
    expect(
      root.files.some((item: { id: number }) => item.id === rootFile.json().id),
    ).toBe(true);

    const missingName = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/upload`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("x"),
    });
    expect(missingName.statusCode).toBe(400);
    const invalidName = await upload("越界/文件.txt", "x");
    expect(invalidName.statusCode).toBe(400);
    const badParent = await upload("x.txt", "x", 999999);
    expect(badParent.statusCode).toBe(404);
    const fileAsParent = await upload("x.txt", "x", first.json().id);
    expect(fileAsParent.statusCode).toBe(400);
    expect(existsSync(join(requirementRoot(), "上传资料", "越界"))).toBe(false);
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
