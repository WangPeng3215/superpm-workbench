import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type {
  ArtifactImageUploadResult,
  ArtifactNode,
  RequirementWorkspaceState,
} from "@superpm/shared";
import { createApp } from "../src/app";
import { authedInject } from "./auth-helper";
import {
  requirementRootPath,
  requirementRootRelative,
} from "./workspace-helper";

// 开发文档 V1.1 §12：需求物理目录自动初始化、可读命名、系统级资源保护、图片相对路径
describe("requirement directory (§12)", () => {
  let app: FastifyInstance;
  let directory: string;
  let workspacePath: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-reqdir-"));
    workspacePath = join(directory, "workspace");
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath,
      logger: false,
    });
    await authedInject(app);
  });
  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function createRequirement(name = "登录改造需求") {
    const response = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { name, proposedAt: "2026-10-21" },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: number; requirementNo: string };
  }
  const directoryState = async (id: number) =>
    (
      await app.inject({
        method: "GET",
        url: `/api/requirements/${id}/directory`,
      })
    ).json() as RequirementWorkspaceState;
  const listRoot = async (id: number) =>
    (
      await app.inject({
        method: "GET",
        url: `/api/requirements/${id}/artifacts`,
      })
    ).json() as { folders: ArtifactNode[]; files: ArtifactNode[] };
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfEsAAAAASUVORK5CYII=";
  const uploadImage = async (
    requirementId: number,
    payload: { nodeId: number | null; fileName?: string },
  ) =>
    (
      await app.inject({
        method: "POST",
        url: `/api/requirements/${requirementId}/artifacts/images`,
        payload: { mime: "image/png", data: png, ...payload },
      })
    ).json() as ArtifactImageUploadResult;

  it("创建需求时自动生成可读命名的根目录与全部默认资源", async () => {
    const requirement = await createRequirement();
    const root = await requirementRootPath(app, workspacePath, requirement.id);
    // 物理目录名：需求编号 + 空格 + 需求名称（文档 §12.2）
    expect(root.endsWith(`${requirement.requirementNo} 登录改造需求`)).toBe(
      true,
    );
    for (const name of [
      "需求记忆.md",
      "images",
      "需求分析",
      "PRD",
      "原型图",
      "资料",
    ])
      expect(existsSync(join(root, name))).toBe(true);
    const state = await directoryState(requirement.id);
    expect(state).toMatchObject({
      requirementId: requirement.id,
      directoryName: `${requirement.requirementNo} 登录改造需求`,
      relativePath: `requirements/${requirement.requirementNo} 登录改造需求`,
      status: "completed",
      directoryExists: true,
      missingResources: [],
    });
    expect(state.initializedAt).toBeTruthy();
    // 索引同步：默认目录与需求记忆都可见
    const tree = await listRoot(requirement.id);
    expect(tree.folders.map((item) => item.name).sort()).toEqual(
      ["PRD", "images", "原型图", "资料", "需求分析"].sort(),
    );
    expect(tree.files.map((item) => item.name)).toContain("需求记忆.md");
  });

  it("初始化失败时记录阶段与原因，修复后可重试成功", async () => {
    const requirement = await createRequirement();
    const relative = await requirementRootRelative(app, requirement.id);
    const root = join(workspacePath, ...relative.split("/"));
    // 用同名普通文件占住需求根目录位置，制造初始化失败
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, "占位", "utf8");
    const inspection = new Database(join(directory, "test.sqlite"));
    inspection.prepare("DELETE FROM requirement_directories").run();
    inspection.close();
    const failed = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/directory/initialize`,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error.code).toBe("WORKSPACE_INIT_FAILED");
    // 失败状态与阶段可诊断，不会被误报为成功
    const state = await directoryState(requirement.id);
    expect(state.status).toBe("failed");
    expect(state.failureStage).toBeTruthy();
    expect(state.failureReason).toBeTruthy();
    expect(state.initializedAt).toBeNull();
    // 排除障碍后重试成功
    rmSync(root, { force: true });
    const retried = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/directory/initialize`,
    });
    expect(retried.statusCode).toBe(200);
    const recovered = retried.json<RequirementWorkspaceState>();
    expect(recovered.status).toBe("completed");
    expect(recovered.failureStage).toBeNull();
    expect(existsSync(join(root, "需求记忆.md"))).toBe(true);
  });

  it("初始化幂等：重复初始化不覆盖用户内容，也不重复建同名资源", async () => {
    const requirement = await createRequirement();
    const root = await requirementRootPath(app, workspacePath, requirement.id);
    const memoryPath = join(root, "需求记忆.md");
    writeFileSync(memoryPath, "# 用户手写内容", "utf8");
    writeFileSync(join(root, "需求分析", "笔记.md"), "# 笔记", "utf8");
    const again = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/directory/initialize`,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<RequirementWorkspaceState>().status).toBe("completed");
    // 用户内容不被覆盖
    expect(readFileSync(memoryPath, "utf8")).toBe("# 用户手写内容");
    expect(readFileSync(join(root, "需求分析", "笔记.md"), "utf8")).toBe(
      "# 笔记",
    );
  });

  it("普通刷新不重建用户删除的默认目录，只有修复默认结构才补建", async () => {
    const requirement = await createRequirement();
    const root = await requirementRootPath(app, workspacePath, requirement.id);
    rmSync(join(root, "资料"), { recursive: true });
    rmSync(join(root, "需求记忆.md"));
    // 刷新索引：不得擅自重建（文档 §12.1）
    await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/artifacts/refresh`,
      payload: {},
    });
    expect(existsSync(join(root, "资料"))).toBe(false);
    expect(existsSync(join(root, "需求记忆.md"))).toBe(false);
    // 状态查询能识别缺失资源，供前端提示修复
    const missing = await directoryState(requirement.id);
    expect(missing.missingResources).toEqual(
      expect.arrayContaining(["需求记忆.md", "资料"]),
    );
    // 显式修复才补建
    const repaired = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/directory/repair`,
    });
    expect(repaired.statusCode).toBe(200);
    expect(existsSync(join(root, "资料"))).toBe(true);
    expect(existsSync(join(root, "需求记忆.md"))).toBe(true);
    expect(repaired.json<RequirementWorkspaceState>().missingResources).toEqual(
      [],
    );
  });

  it("需求记忆文件是系统级资源：可编辑但不可删除、重命名或移动", async () => {
    const requirement = await createRequirement();
    const tree = await listRoot(requirement.id);
    const memory = tree.files.find((item) => item.name === "需求记忆.md")!;
    expect(memory).toBeTruthy();
    // 内容可编辑保存
    const saved = await app.inject({
      method: "PUT",
      url: `/api/artifacts/nodes/${memory.id}/content`,
      payload: { content: "# 上下文摘要\n\n- 已确认：登录改造\n" },
    });
    expect(saved.statusCode).toBe(200);
    // 普通文件操作一律禁止
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/nodes/${memory.id}`,
    });
    expect(remove.statusCode).toBe(409);
    expect(remove.json().error.message).toContain("需求记忆");
    const rename = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/nodes/${memory.id}`,
      payload: { name: "记忆.md" },
    });
    expect(rename.statusCode).toBe(409);
    const move = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${memory.id}/move`,
      payload: {
        targetParentId: tree.folders.find((f) => f.name === "资料")!.id,
      },
    });
    expect(move.statusCode).toBe(409);
    // 内容保持用户写入的版本
    const content = (
      await app.inject({
        method: "GET",
        url: `/api/artifacts/nodes/${memory.id}/content`,
      })
    ).json() as { content: string };
    expect(content.content).toContain("已确认：登录改造");
  });

  it("普通文件夹可自由重命名、移动与删除", async () => {
    const requirement = await createRequirement();
    const tree = await listRoot(requirement.id);
    const analysis = tree.folders.find((item) => item.name === "需求分析")!;
    const prd = tree.folders.find((item) => item.name === "PRD")!;
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/nodes/${analysis.id}`,
      payload: { name: "调研" },
    });
    expect(renamed.statusCode).toBe(200);
    const moved = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${analysis.id}/move`,
      payload: { targetParentId: prd.id },
    });
    expect(moved.statusCode).toBe(200);
    // 多层级子目录同样允许
    const nested = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/artifacts/folders`,
      payload: { parentId: prd.id, name: "二级" },
    });
    expect(nested.statusCode).toBe(201);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/nodes/${analysis.id}?recursive=true`,
    });
    expect(removed.statusCode).toBe(204);
  });

  it("images 目录是系统级资源：不可删除、重命名或移动", async () => {
    const requirement = await createRequirement();
    const tree = await listRoot(requirement.id);
    const images = tree.folders.find((item) => item.name === "images")!;
    expect(images).toBeTruthy();
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/nodes/${images.id}`,
    });
    expect(remove.statusCode).toBe(409);
    expect(remove.json().error.message).toContain("images");
    const rename = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/nodes/${images.id}`,
      payload: { name: "图片" },
    });
    expect(rename.statusCode).toBe(409);
    const move = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${images.id}/move`,
      payload: { targetParentId: null },
    });
    expect(move.statusCode).toBe(409);
    // 目录与索引都还在
    const root = await requirementRootPath(app, workspacePath, requirement.id);
    expect(existsSync(join(root, "images"))).toBe(true);
  });

  it("图片上传写入需求 images/ 并返回相对当前文档目录的路径", async () => {
    const requirement = await createRequirement();
    // 根目录文档：引用 images/xxx.png
    const rootFile = (
      await app.inject({
        method: "POST",
        url: `/api/requirements/${requirement.id}/artifacts/files`,
        payload: { parentId: null, name: "总览.md" },
      })
    ).json() as ArtifactNode;
    const atRoot = await uploadImage(requirement.id, {
      nodeId: rootFile.id,
      fileName: "流程 图.png",
    });
    expect(atRoot.relativePath).toMatch(/^images\/[^/]+\.png$/);
    expect(atRoot.markdown).toContain(atRoot.relativePath);
    // 子目录文档：引用 ../images/xxx.png
    const tree = await listRoot(requirement.id);
    const analysis = tree.folders.find((item) => item.name === "需求分析")!;
    const nested = (
      await app.inject({
        method: "POST",
        url: `/api/requirements/${requirement.id}/artifacts/files`,
        payload: { parentId: analysis.id, name: "分析记录.md" },
      })
    ).json() as ArtifactNode;
    const inNested = await uploadImage(requirement.id, { nodeId: nested.id });
    expect(inNested.relativePath.startsWith("../images/")).toBe(true);
    // 同名图片不静默覆盖：文件名追加安全后缀
    const duplicate = await uploadImage(requirement.id, {
      nodeId: rootFile.id,
      fileName: "流程 图.png",
    });
    expect(duplicate.relativePath).not.toBe(atRoot.relativePath);
    expect(duplicate.relativePath).toMatch(/^images\/.+-1\.png$/);
    // 相对路径可被读取接口按文档目录解析
    const preview = await app.inject({
      method: "GET",
      url: `/api/requirements/${requirement.id}/artifacts/image?path=${encodeURIComponent(inNested.relativePath)}&nodeId=${nested.id}`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toBe("image/png");
    // 拒绝伪造图片与越界路径
    const fake = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/artifacts/images`,
      payload: {
        nodeId: null,
        mime: "image/png",
        data: Buffer.from("not-png").toString("base64"),
      },
    });
    expect(fake.statusCode).toBe(400);
    const escape = await app.inject({
      method: "GET",
      url: `/api/requirements/${requirement.id}/artifacts/image?path=${encodeURIComponent("../../secret.png")}&nodeId=${nested.id}`,
    });
    expect(escape.statusCode).toBe(400);
  });

  it("图片仍被文档引用时阻止删除，并提示引用来源", async () => {
    const requirement = await createRequirement();
    const doc = (
      await app.inject({
        method: "POST",
        url: `/api/requirements/${requirement.id}/artifacts/files`,
        payload: { parentId: null, name: "说明.md" },
      })
    ).json() as ArtifactNode;
    const uploaded = await uploadImage(requirement.id, {
      nodeId: doc.id,
      fileName: "架构.png",
    });
    await app.inject({
      method: "PUT",
      url: `/api/artifacts/nodes/${doc.id}/content`,
      payload: { content: `# 说明\n\n![架构](${uploaded.relativePath})\n` },
    });
    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/nodes/${uploaded.node.id}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain("说明.md");
    // 解除引用后可以删除
    await app.inject({
      method: "PUT",
      url: `/api/artifacts/nodes/${doc.id}/content`,
      payload: { content: "# 说明\n" },
    });
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/nodes/${uploaded.node.id}`,
    });
    expect(removed.statusCode).toBe(204);
  });

  it("文档移动到子目录后自动修正图片相对路径", async () => {
    const requirement = await createRequirement();
    const doc = (
      await app.inject({
        method: "POST",
        url: `/api/requirements/${requirement.id}/artifacts/files`,
        payload: { parentId: null, name: "记录.md" },
      })
    ).json() as ArtifactNode;
    const uploaded = await uploadImage(requirement.id, {
      nodeId: doc.id,
      fileName: "时序.png",
    });
    await app.inject({
      method: "PUT",
      url: `/api/artifacts/nodes/${doc.id}/content`,
      payload: { content: `# 记录\n\n![时序](${uploaded.relativePath})\n` },
    });
    const tree = await listRoot(requirement.id);
    const analysis = tree.folders.find((item) => item.name === "需求分析")!;
    const moved = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${doc.id}/move`,
      payload: { targetParentId: analysis.id },
    });
    expect(moved.statusCode).toBe(200);
    const saved = (
      await app.inject({
        method: "GET",
        url: `/api/artifacts/nodes/${doc.id}/content`,
      })
    ).json() as { content: string };
    const rebased = `../${uploaded.relativePath}`;
    expect(saved.content).toContain(rebased);
    // 移动后的相对路径仍能定位到同一图片
    const preview = await app.inject({
      method: "GET",
      url: `/api/requirements/${requirement.id}/artifacts/image?path=${encodeURIComponent(rebased)}&nodeId=${doc.id}`,
    });
    expect(preview.statusCode).toBe(200);
  });

  it("目录改名或移动后，后代文档内的图片相对路径同步修正", async () => {
    const requirement = await createRequirement();
    const tree = await listRoot(requirement.id);
    const analysis = tree.folders.find((item) => item.name === "需求分析")!;
    // 需求分析/子目录/记录.md 引用 images/ 下的图片
    const sub = (
      await app.inject({
        method: "POST",
        url: `/api/requirements/${requirement.id}/artifacts/folders`,
        payload: { parentId: analysis.id, name: "子目录" },
      })
    ).json() as ArtifactNode;
    const doc = (
      await app.inject({
        method: "POST",
        url: `/api/requirements/${requirement.id}/artifacts/files`,
        payload: { parentId: sub.id, name: "记录.md" },
      })
    ).json() as ArtifactNode;
    const uploaded = await uploadImage(requirement.id, {
      nodeId: doc.id,
      fileName: "时序.png",
    });
    // 上传结果里的相对路径已经以当前文档目录为基准
    const original = uploaded.relativePath;
    await app.inject({
      method: "PUT",
      url: `/api/artifacts/nodes/${doc.id}/content`,
      payload: { content: `# 记录\n\n![时序](${original})\n` },
    });
    // 把「需求分析」整体移入「资料」：后代文档层级加深一层
    const material = tree.folders.find((item) => item.name === "资料")!;
    const moved = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${analysis.id}/move`,
      payload: { targetParentId: material.id },
    });
    expect(moved.statusCode).toBe(200);
    const readDoc = async () =>
      (
        await app.inject({
          method: "GET",
          url: `/api/artifacts/nodes/${doc.id}/content`,
        })
      ).json() as { content: string };
    // 层级加深一层：引用需要多退一级
    const deeper = `../${original}`;
    expect((await readDoc()).content).toContain(deeper);
    const preview = await app.inject({
      method: "GET",
      url: `/api/requirements/${requirement.id}/artifacts/image?path=${encodeURIComponent(deeper)}&nodeId=${doc.id}`,
    });
    expect(preview.statusCode).toBe(200);
    // 移回根目录后引用恢复为原来的层级
    const restored = await app.inject({
      method: "POST",
      url: `/api/artifacts/nodes/${analysis.id}/move`,
      payload: { targetParentId: null },
    });
    expect(restored.statusCode).toBe(200);
    expect((await readDoc()).content).toContain(original);
  });

  it("存量数字目录被收养重命名为可读目录，文件随目录迁移", async () => {
    const requirement = await createRequirement();
    const relative = await requirementRootRelative(app, requirement.id);
    const directoryName = relative.split("/")[1];
    const root = join(workspacePath, ...relative.split("/"));
    const legacy = join(workspacePath, "requirements", String(requirement.id));
    // 还原成迁移前的旧库形态：目录为数字名、映射表为空
    renameSync(root, legacy);
    writeFileSync(join(legacy, "旧文件.md"), "# 旧内容", "utf8");
    const inspection = new Database(join(directory, "test.sqlite"));
    inspection.prepare("DELETE FROM requirement_directories").run();
    inspection.close();
    // 再次解析映射：收养改名，文件随目录一起迁移
    const state = await directoryState(requirement.id);
    expect(state.directoryName).toBe(directoryName);
    expect(existsSync(root)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(root, "旧文件.md"), "utf8")).toBe("# 旧内容");
    // 索引刷新后能识别迁移过来的文件
    await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/artifacts/refresh`,
      payload: {},
    });
    const tree = await listRoot(requirement.id);
    expect(tree.files.map((item) => item.name)).toContain("旧文件.md");
  });
});
