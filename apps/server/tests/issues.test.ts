import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type {
  ArtifactImageUploadResult,
  Issue,
  IssueAssetListResult,
  IssueDetail,
  IssueListResult,
} from "@superpm/shared";
import { createApp } from "../src/app";
import { authedInject } from "./auth-helper";
import { requirementRootPath } from "./workspace-helper";

describe("issues API with real SQLite", () => {
  let app: FastifyInstance;
  let directory: string;
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfEsAAAAASUVORK5CYII=";
  const create = async (
    payload: object = { name: "需求工作台", proposedAt: "2026-10-15" },
  ) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as Issue;
  };
  const createIssue = async (requirementId: number, payload?: object) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/issues`,
      payload: {
        stage: "design",
        title: "按钮样式与设计稿不一致",
        ...(payload ?? {}),
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as Issue;
  };
  const patchIssue = (
    requirementId: number,
    issueId: number,
    payload: object,
  ) =>
    app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirementId}/issues/${issueId}`,
      payload,
    });
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-issues-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
    });
    // 登录种子账号，包装 inject 自动携带会话 Cookie
    await authedInject(app);
  });
  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns empty lists and zero counts for a requirement without any issue", async () => {
    const requirement = await create();
    const all = (
      await app.inject(`/api/requirements/${requirement.id}/issues`)
    ).json<IssueListResult>();
    expect(all).toEqual({
      items: [],
      total: 0,
      statusCounts: {
        pending: 0,
        to_confirm: 0,
        processing: 0,
        resolved: 0,
        wont_fix: 0,
      },
    });
    // 四阶段、状态与类型过滤同样为空数组
    for (const stage of ["analysis", "design", "development", "testing"]) {
      const scoped = (
        await app.inject(
          `/api/requirements/${requirement.id}/issues?stage=${stage}`,
        )
      ).json<IssueListResult>();
      expect(scoped.total).toBe(0);
      expect(scoped.items).toEqual([]);
    }
    for (const status of ["pending", "processing", "resolved"]) {
      const scoped = (
        await app.inject(
          `/api/requirements/${requirement.id}/issues?status=${status}`,
        )
      ).json<IssueListResult>();
      expect(scoped.total).toBe(0);
    }
    const typed = (
      await app.inject(`/api/requirements/${requirement.id}/issues?type=ui`)
    ).json<IssueListResult>();
    expect(typed.items).toEqual([]);
  });
  it("creates issues with an initial system activity and validates the new enums", async () => {
    const requirement = await create();
    const issue = await createIssue(requirement.id, {
      description: "间距偏差 4px",
      type: "ui",
    });
    expect(issue).toMatchObject({
      requirementId: requirement.id,
      stage: "design",
      status: "pending",
      title: "按钮样式与设计稿不一致",
      description: "间距偏差 4px",
      type: "ui",
      solution: "",
      issueKey: null,
      isDeleted: false,
      resolvedAt: null,
    });
    // 创建即产生一条 system 历史
    const detail = (
      await app.inject(`/api/requirements/${requirement.id}/issues/${issue.id}`)
    ).json<IssueDetail>();
    expect(detail.activities).toHaveLength(1);
    expect(detail.activities[0]).toMatchObject({
      activityType: "system",
      actorType: "system",
    });
    // 未指定阶段时取需求当前阶段（默认需求分析），四阶段均可记录问题
    const defaulted = (
      await app.inject({
        method: "POST",
        url: `/api/requirements/${requirement.id}/issues`,
        payload: { title: "未指定阶段的问题" },
      })
    ).json<Issue>();
    expect(defaulted.stage).toBe("analysis");
    const analysisStage = await createIssue(requirement.id, {
      stage: "analysis",
      type: "analysis",
      title: "需求分析阶段的问题",
    });
    expect(analysisStage).toMatchObject({
      stage: "analysis",
      type: "analysis",
    });
    // 非法阶段、类型与空标题被拒绝
    for (const payload of [
      { stage: "deploy", title: "非法阶段" },
      { stage: "design", type: "defect", title: "旧类型" },
      { stage: "design", title: "  " },
      { stage: "design" },
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: `/api/requirements/${requirement.id}/issues`,
        payload,
      });
      expect(rejected.statusCode).toBe(400);
    }
  });
  it("requires a solution before resolving and treats wont_fix as not resolved", async () => {
    const requirement = await create();
    const issue = await createIssue(requirement.id);
    // 无解决方案不能标记已解决
    const blocked = await patchIssue(requirement.id, issue.id, {
      status: "resolved",
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(blocked.json().error.message).toContain("解决方案");
    // 先保存解决方案：独立于状态更新，并写一条 solution 历史
    const saved = await patchIssue(requirement.id, issue.id, {
      solution: "按新稿执行，验收通过",
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<Issue>()).toMatchObject({
      solution: "按新稿执行，验收通过",
      status: "pending",
    });
    // 同时提交空方案与已解决同样被拒绝（以合并后的方案为准）
    const emptied = await patchIssue(requirement.id, issue.id, {
      solution: "",
      status: "resolved",
    });
    expect(emptied.statusCode).toBe(400);
    // 有方案后允许解决，写 resolved_at 与状态历史
    const resolved = await patchIssue(requirement.id, issue.id, {
      status: "resolved",
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json<Issue>()).toMatchObject({ status: "resolved" });
    expect(resolved.json<Issue>().resolvedAt).toBeTruthy();
    // 暂不处理不是已解决：不要求方案，且清空解决时间
    const wontFix = await patchIssue(requirement.id, issue.id, {
      status: "wont_fix",
    });
    expect(wontFix.statusCode).toBe(200);
    expect(wontFix.json<Issue>()).toMatchObject({
      status: "wont_fix",
      resolvedAt: null,
    });
    // 标题/阶段/类型可独立更新
    const processing = await patchIssue(requirement.id, issue.id, {
      title: "重新描述的问题",
      stage: "analysis",
      type: "other",
      status: "processing",
    });
    expect(processing.statusCode).toBe(200);
    expect(processing.json<Issue>()).toMatchObject({
      title: "重新描述的问题",
      stage: "analysis",
      type: "other",
      status: "processing",
    });
    const detail = (
      await app.inject(`/api/requirements/${requirement.id}/issues/${issue.id}`)
    ).json<IssueDetail>();
    expect(
      detail.activities.filter((item) => item.activityType === "solution"),
    ).toHaveLength(1);
    const statusChanges = detail.activities.filter(
      (item) => item.activityType === "status_change",
    );
    expect(statusChanges.map((item) => [item.oldStatus, item.newStatus])).toEqual(
      [
        ["pending", "resolved"],
        ["resolved", "wont_fix"],
        ["wont_fix", "processing"],
      ],
    );
    // 旧枚举与任意值都被拒绝
    for (const status of ["open", "closed", "testing", "in_progress"]) {
      const legacy = await patchIssue(requirement.id, issue.id, { status });
      expect(legacy.statusCode).toBe(400);
    }
    // 空更新被拒绝
    expect(
      (await patchIssue(requirement.id, issue.id, {})).statusCode,
    ).toBe(400);
  });
  it("persists description to a md file and supports direct content endpoints", async () => {
    const requirement = await create();
    const issue = await createIssue(requirement.id, {
      description: "间距偏差 4px",
    });
    // 创建后正文落盘为 md 文件（description/description_html 列不再写入）；
    // 需求根目录按「需求编号 + 名称」命名，经目录映射接口解析
    const rootPath = await requirementRootPath(
      app,
      join(directory, "workspace"),
      requirement.id,
    );
    const mdPath = join(rootPath, "issues", `${issue.id}.md`);
    expect(readFileSync(mdPath, "utf8")).toBe("间距偏差 4px");
    // 正文端点：GET 读取 md 文件内容，PUT 写入并刷新 updated_at
    const got = await app.inject(
      `/api/requirements/${requirement.id}/issues/${issue.id}/description`,
    );
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual({ content: "间距偏差 4px" });
    const put = await app.inject({
      method: "PUT",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}/description`,
      payload: { content: "<p>新正文内容</p>" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().updatedAt).toBeTruthy();
    expect(readFileSync(mdPath, "utf8")).toBe("<p>新正文内容</p>");
    // PATCH 的 description 字段同样落盘
    const patched = await patchIssue(requirement.id, issue.id, {
      description: "## 复现步骤\n\n1. 打开页面",
    });
    expect(patched.statusCode).toBe(200);
    expect(readFileSync(mdPath, "utf8")).toBe("## 复现步骤\n\n1. 打开页面");
    // 详情中的正文来自 md 文件
    const detail = (
      await app.inject(`/api/requirements/${requirement.id}/issues/${issue.id}`)
    ).json<IssueDetail>();
    expect(detail.description).toBe("## 复现步骤\n\n1. 打开页面");
    const list = (
      await app.inject(`/api/requirements/${requirement.id}/issues`)
    ).json<IssueListResult>();
    expect(list.items[0].description).toBe("## 复现步骤\n\n1. 打开页面");
  });
  it("appends comments without rewriting history and updates timestamps", async () => {
    const requirement = await create();
    const issue = await createIssue(requirement.id);
    const before = (
      await app.inject(`/api/requirements/${requirement.id}/issues/${issue.id}`)
    ).json<IssueDetail>();
    const commented = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}/activities`,
      payload: { content: "已与设计师确认，按新稿执行" },
    });
    expect(commented.statusCode).toBe(200);
    const after = commented.json<IssueDetail>();
    expect(after.activities).toHaveLength(before.activities.length + 1);
    const comment = after.activities[after.activities.length - 1];
    expect(comment).toMatchObject({
      activityType: "comment",
      content: "已与设计师确认，按新稿执行",
      actorType: "user",
    });
    // 活动历史按时间正序追加，早期记录不受影响
    expect(after.activities[0].activityType).toBe("system");
    expect(after.updatedAt >= before.updatedAt).toBe(true);
    // 空评论被拒绝
    const empty = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}/activities`,
      payload: { content: "" },
    });
    expect(empty.statusCode).toBe(400);
  });
  it("lists issues with stage/status/type/keyword filters, counts and updated-desc order", async () => {
    const requirement = await create();
    const ui = await createIssue(requirement.id, {
      stage: "design",
      type: "ui",
      title: "按钮样式不一致",
      description: "登录页间距偏差 4px",
    });
    const development = await createIssue(requirement.id, {
      stage: "development",
      type: "development",
      title: "接口报错",
      description: "保存时返回 500",
    });
    const testing = await createIssue(requirement.id, {
      stage: "testing",
      type: "testing",
      title: "回归失败",
      description: "冒烟用例未通过",
    });
    // 直接固定 updated_at，验证列表严格按最近更新时间倒序
    const inspection = new Database(join(directory, "test.sqlite"));
    const setUpdatedAt = inspection.prepare(
      "UPDATE issues SET updated_at=? WHERE id=?",
    );
    setUpdatedAt.run("2026-10-01T00:00:00.000Z", development.id);
    setUpdatedAt.run("2026-10-02T00:00:00.000Z", testing.id);
    setUpdatedAt.run("2026-10-03T00:00:00.000Z", ui.id);
    inspection.close();
    const ordered = (
      await app.inject(`/api/requirements/${requirement.id}/issues`)
    ).json<IssueListResult>();
    expect(ordered.items.map((item) => item.id)).toEqual([
      ui.id,
      testing.id,
      development.id,
    ]);
    // 状态筛选：待确认新枚举可自由流转，计数不受状态筛选影响
    expect(
      (await patchIssue(requirement.id, ui.id, { status: "processing" }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await patchIssue(requirement.id, development.id, {
          status: "resolved",
          solution: "已修复空指针",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await patchIssue(requirement.id, testing.id, { status: "to_confirm" })
      ).statusCode,
    ).toBe(200);
    const all = (
      await app.inject(`/api/requirements/${requirement.id}/issues`)
    ).json<IssueListResult>();
    expect(all.total).toBe(3);
    expect(all.statusCounts).toEqual({
      pending: 0,
      to_confirm: 1,
      processing: 1,
      resolved: 1,
      wont_fix: 0,
    });
    const processing = (
      await app.inject(
        `/api/requirements/${requirement.id}/issues?status=processing`,
      )
    ).json<IssueListResult>();
    expect(processing.items.map((item) => item.id)).toEqual([ui.id]);
    // 状态筛选不改变计数，供状态标签展示实时数量
    expect(processing.statusCounts).toEqual(all.statusCounts);
    // 阶段 / 类型 / 关键词（标题与正文）过滤
    const byStage = (
      await app.inject(
        `/api/requirements/${requirement.id}/issues?stage=development`,
      )
    ).json<IssueListResult>();
    expect(byStage.items.map((item) => item.id)).toEqual([development.id]);
    const byType = (
      await app.inject(
        `/api/requirements/${requirement.id}/issues?type=ui`,
      )
    ).json<IssueListResult>();
    expect(byType.items.map((item) => item.id)).toEqual([ui.id]);
    const byDescription = (
      await app.inject(
        `/api/requirements/${requirement.id}/issues?q=${encodeURIComponent("间距")}`,
      )
    ).json<IssueListResult>();
    expect(byDescription.items.map((item) => item.id)).toEqual([ui.id]);
    const byTitle = (
      await app.inject(
        `/api/requirements/${requirement.id}/issues?q=${encodeURIComponent("接口")}`,
      )
    ).json<IssueListResult>();
    expect(byTitle.items.map((item) => item.id)).toEqual([development.id]);
    // 组合过滤：阶段 + 状态，计数按阶段收窄
    const combined = (
      await app.inject(
        `/api/requirements/${requirement.id}/issues?stage=design&status=resolved`,
      )
    ).json<IssueListResult>();
    expect(combined.total).toBe(0);
    expect(combined.statusCounts).toMatchObject({
      processing: 1,
      to_confirm: 0,
      resolved: 0,
    });
    // 软删除：列表消失，行保留且不可访问
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${requirement.id}/issues/${ui.id}`,
        })
      ).statusCode,
    ).toBe(204);
    const remaining = (
      await app.inject(`/api/requirements/${requirement.id}/issues`)
    ).json<IssueListResult>();
    expect(remaining.total).toBe(2);
    expect(
      (
        await app.inject(
          `/api/requirements/${requirement.id}/issues/${ui.id}`,
        )
      ).statusCode,
    ).toBe(404);
    // 二次删除：软删行不可见，返回 404
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${requirement.id}/issues/${ui.id}`,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("scopes issues to their own requirement", async () => {
    const first = await create({ name: "需求一", proposedAt: "2026-10-15" });
    const second = await create({ name: "需求二", proposedAt: "2026-10-15" });
    const issue = await createIssue(first.id);
    // 跨需求访问被拒绝
    expect(
      (await app.inject(`/api/requirements/${second.id}/issues/${issue.id}`))
        .statusCode,
    ).toBe(404);
    // 更新与删除同样受需求归属约束
    expect(
      (await patchIssue(second.id, issue.id, { title: "越权修改" })).statusCode,
    ).toBe(404);
    // 更新标题成功路径
    const renamed = await patchIssue(first.id, issue.id, {
      title: "修正后的问题标题",
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Issue>().title).toBe("修正后的问题标题");
  });
  // 通过 artifacts 体系建一个知识库文件（问题关联已切换到 artifact_nodes）
  const createArtifact = async (requirementId: number, name: string) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/artifacts/files`,
      payload: { parentId: null, name },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      id: number;
      name: string;
      relativePath: string;
    };
  };
  it("links artifacts to issues with dedup and keeps nodes untouched after unlink", async () => {
    const requirement = await create();
    const issue = await createIssue(requirement.id);
    const artifact = await createArtifact(requirement.id, "问题截图.md");
    const assetId = artifact.id;
    // 关联成功：返回关联信息与节点投影（含类型与相对路径）
    const linked = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}/assets`,
      payload: { assetId, relationType: "evidence" },
    });
    expect(linked.statusCode).toBe(201);
    expect(linked.json()).toMatchObject({
      issueId: issue.id,
      assetId,
      relationType: "evidence",
    });
    expect(linked.json().asset).toMatchObject({
      id: assetId,
      nodeType: "file",
      name: "问题截图.md",
      relativePath: "问题截图.md",
    });
    // 重复关联被拒绝（联合主键去重）
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}/assets`,
      payload: { assetId },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("CONFLICT");
    // 文件夹与文件均可关联
    const folderResponse = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/artifacts/folders`,
      payload: { parentId: null, name: "设计稿" },
    });
    expect(folderResponse.statusCode).toBe(201);
    const folder = folderResponse.json() as {
      id: number;
      relativePath: string;
    };
    const folderLinked = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}/assets`,
      payload: { assetId: folder.id },
    });
    expect(folderLinked.statusCode).toBe(201);
    expect(folderLinked.json().asset).toMatchObject({
      nodeType: "folder",
      relativePath: "设计稿",
    });
    // 关联列表
    const list = (
      await app.inject(
        `/api/requirements/${requirement.id}/issues/${issue.id}/assets`,
      )
    ).json<IssueAssetListResult>();
    expect(list.total).toBe(2);
    // assetId 取自关联行（SELECT 别名 asset_id），前端解除关联依赖该字段
    expect(
      [...list.items.map((item) => item.assetId)].sort((a, b) => a - b),
    ).toEqual([assetId, folder.id].sort((a, b) => a - b));
    // 取消关联后产出物本体不受影响：节点仍可直接再次关联
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${requirement.id}/issues/${issue.id}/assets/${assetId}`,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject(
          `/api/requirements/${requirement.id}/issues/${issue.id}/assets`,
        )
      ).json<IssueAssetListResult>().total,
    ).toBe(1);
    const relink = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}/assets`,
      payload: { assetId },
    });
    expect(relink.statusCode).toBe(201);
    // 二次取消后重复取消返回 404
    await app.inject({
      method: "DELETE",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}/assets/${assetId}`,
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${requirement.id}/issues/${issue.id}/assets/${assetId}`,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("validates ownership and cleans links when artifact nodes are deleted", async () => {
    const first = await create({ name: "需求一", proposedAt: "2026-10-15" });
    const second = await create({ name: "需求二", proposedAt: "2026-10-15" });
    const issue = await createIssue(first.id);
    const foreignArtifact = await createArtifact(
      second.id,
      "别的需求的文件.md",
    );
    // 跨需求关联被拒绝
    const cross = await app.inject({
      method: "POST",
      url: `/api/requirements/${first.id}/issues/${issue.id}/assets`,
      payload: { assetId: foreignArtifact.id },
    });
    expect(cross.statusCode).toBe(404);
    // 本需求资源关联后删除节点：关联行级联清理，节点不存在不可再次关联
    const asset = await createArtifact(first.id, "将被删除的文件.md");
    const assetId = asset.id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/requirements/${first.id}/issues/${issue.id}/assets`,
          payload: { assetId },
        })
      ).statusCode,
    ).toBe(201);
    await app.inject({
      method: "DELETE",
      url: `/api/artifacts/nodes/${assetId}`,
    });
    expect(
      (
        await app.inject(
          `/api/requirements/${first.id}/issues/${issue.id}/assets`,
        )
      ).json<IssueAssetListResult>().total,
    ).toBe(0);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/requirements/${first.id}/issues/${issue.id}/assets`,
          payload: { assetId },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("protects images referenced by issue descriptions and solutions", async () => {
    const requirement = await create();
    const issue = await createIssue(requirement.id, {
      description: "问题正文",
    });
    const uploaded = (
      await app.inject({
        method: "POST",
        url: `/api/requirements/${requirement.id}/artifacts/images`,
        payload: {
          nodeId: null,
          mime: "image/png",
          data: png,
          fileName: "现场截图.png",
        },
      })
    ).json<ArtifactImageUploadResult>();
    // 解决方案引用图片：删除被拦截并指出问题来源
    expect(
      (
        await patchIssue(requirement.id, issue.id, {
          solution: `![现场截图](${uploaded.relativePath})`,
        })
      ).statusCode,
    ).toBe(200);
    const blockedBySolution = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/nodes/${uploaded.node.id}`,
    });
    expect(blockedBySolution.statusCode).toBe(409);
    expect(blockedBySolution.json().error.message).toContain(
      `问题 #${issue.id}`,
    );
    // 问题描述 md 文件引用图片同样受保护
    expect(
      (
        await patchIssue(requirement.id, issue.id, {
          solution: "",
          description: `![现场截图](${uploaded.relativePath})`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/artifacts/nodes/${uploaded.node.id}`,
        })
      ).statusCode,
    ).toBe(409);
    // 解除引用后可删除图片
    expect(
      (
        await patchIssue(requirement.id, issue.id, {
          description: "",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/artifacts/nodes/${uploaded.node.id}`,
        })
      ).statusCode,
    ).toBe(204);
  });
  it("cleans up link rows when an issue is soft-deleted", async () => {
    const requirement = await create();
    const issue = await createIssue(requirement.id);
    const artifact = await createArtifact(requirement.id, "日志附件.md");
    const assetId = artifact.id;
    await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}/assets`,
      payload: { assetId },
    });
    // 删除问题后关联行随之清理
    await app.inject({
      method: "DELETE",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}`,
    });
    const inspection = new Database(join(directory, "test.sqlite"));
    const rows = inspection
      .prepare(
        "SELECT COUNT(*) AS count FROM issue_artifact_links WHERE issue_id=?",
      )
      .get(issue.id) as { count: number };
    inspection.close();
    expect(rows.count).toBe(0);
    // 产出物本体不受问题删除影响：节点详情仍可访问
    expect(
      (await app.inject(`/api/artifacts/nodes/${assetId}`)).statusCode,
    ).toBe(200);
  });
});
