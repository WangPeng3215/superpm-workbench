import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type {
  Issue,
  IssueAssetListResult,
  IssueDetail,
  IssueListResult,
} from "@superpm/shared";
import { createApp } from "../src/app";
import { authedInject } from "./auth-helper";

describe("issues API with real SQLite", () => {
  let app: FastifyInstance;
  let directory: string;
  const create = async (payload: object = { name: "需求工作台", proposedAt: "2026-10-15" }) => {
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
        phase: "design",
        title: "按钮样式与设计稿不一致",
        ...(payload ?? {}),
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as Issue;
  };
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

  it("returns empty lists for a requirement without any issue", async () => {
    const requirement = await create();
    const all = (
      await app.inject(`/api/requirements/${requirement.id}/issues`)
    ).json<IssueListResult>();
    expect(all).toMatchObject({ total: 0 });
    expect(all.items).toEqual([]);
    // 各阶段过滤同样为空数组
    for (const phase of ["design", "development", "testing"]) {
      const scoped = (
        await app.inject(
          `/api/requirements/${requirement.id}/issues?phase=${phase}`,
        )
      ).json<IssueListResult>();
      expect(scoped.total).toBe(0);
      expect(scoped.items).toEqual([]);
    }
  });
  it("creates issues with an initial system activity and rejects invalid phases", async () => {
    const requirement = await create();
    const issue = await createIssue(requirement.id, {
      description: "间距偏差 4px",
      issueType: "ui",
    });
    expect(issue).toMatchObject({
      requirementId: requirement.id,
      phase: "design",
      status: "pending",
      title: "按钮样式与设计稿不一致",
      description: "间距偏差 4px",
      issueType: "ui",
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
    // 需求分析阶段不允许创建问题
    const rejected = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/issues`,
      payload: { phase: "analysis", title: "不该被创建" },
    });
    expect(rejected.statusCode).toBe(400);
    // 空标题被拒绝
    const noTitle = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/issues`,
      payload: { phase: "design", title: "  " },
    });
    expect(noTitle.statusCode).toBe(400);
  });
  it("transitions status freely without solution and persists description as a md file", async () => {
    const requirement = await create();
    const issue = await createIssue(requirement.id, {
      description: "间距偏差 4px",
    });
    // 创建后正文落盘为 md 文件（description/description_html 列不再写入）
    const mdPath = join(
      directory,
      "workspace",
      "requirements",
      String(requirement.id),
      "issues",
      `${issue.id}.md`,
    );
    expect(readFileSync(mdPath, "utf8")).toBe("间距偏差 4px");
    // 无解决说明直接标记解决：四态自由流转，写 resolved_at 与状态历史
    const resolved = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}`,
      payload: { status: "resolved" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json<Issue>()).toMatchObject({ status: "resolved" });
    expect(resolved.json<Issue>().resolvedAt).toBeTruthy();
    let detail = (
      await app.inject(`/api/requirements/${requirement.id}/issues/${issue.id}`)
    ).json<IssueDetail>();
    expect(
      detail.activities.find((item) => item.activityType === "status_change"),
    ).toMatchObject({ oldStatus: "pending", newStatus: "resolved" });
    // 已解决 → 测试中 → 待处理：任意方向可流转；回到待处理清空解决时间
    const testing = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}`,
      payload: { status: "testing" },
    });
    expect(testing.statusCode).toBe(200);
    expect(testing.json<Issue>()).toMatchObject({ status: "testing" });
    const reopened = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}`,
      payload: { status: "pending" },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json<Issue>()).toMatchObject({
      status: "pending",
      resolvedAt: null,
    });
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
    // 详情中的正文来自 md 文件
    detail = (
      await app.inject(`/api/requirements/${requirement.id}/issues/${issue.id}`)
    ).json<IssueDetail>();
    expect(detail.description).toBe("<p>新正文内容</p>");
    // closed 状态已退役：非法枚举被拒绝
    const closed = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}`,
      payload: { status: "closed" },
    });
    expect(closed.statusCode).toBe(400);
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
  it("lists issues with phase and status filters and soft-deletes cleanly", async () => {
    const requirement = await create();
    const designIssue = await createIssue(requirement.id, { title: "设计问题一" });
    await createIssue(requirement.id, { title: "设计问题二" });
    await createIssue(requirement.id, {
      phase: "development",
      title: "接口报错",
    });
    // phase 过滤
    const design = (
      await app.inject(`/api/requirements/${requirement.id}/issues?phase=design`)
    ).json<IssueListResult>();
    expect(design.total).toBe(2);
    // status 过滤
    const inProgress = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/issues/${designIssue.id}`,
      payload: { status: "processing" },
    });
    expect(inProgress.statusCode).toBe(200);
    const processing = (
      await app.inject(
        `/api/requirements/${requirement.id}/issues?status=processing`,
      )
    ).json<IssueListResult>();
    expect(processing.items.map((item) => item.id)).toEqual([designIssue.id]);
    // 全部列表
    const all = (
      await app.inject(`/api/requirements/${requirement.id}/issues`)
    ).json<IssueListResult>();
    expect(all.total).toBe(3);
    // 软删除：列表消失，行保留且不可访问
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${requirement.id}/issues/${designIssue.id}`,
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
          `/api/requirements/${requirement.id}/issues/${designIssue.id}`,
        )
      ).statusCode,
    ).toBe(404);
    // 二次删除：软删行不可见，返回 404
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${requirement.id}/issues/${designIssue.id}`,
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
      (
        await app.inject(`/api/requirements/${second.id}/issues/${issue.id}`)
      ).statusCode,
    ).toBe(404);
    // 更新与删除同样受需求归属约束
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/requirements/${second.id}/issues/${issue.id}`,
          payload: { title: "越权修改" },
        })
      ).statusCode,
    ).toBe(404);
    // 更新标题成功路径
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${first.id}/issues/${issue.id}`,
      payload: { title: "修正后的问题标题" },
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
    return response.json() as { id: number; name: string; relativePath: string };
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
    const folder = folderResponse.json() as { id: number; relativePath: string };
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
    expect([...list.items.map((item) => item.assetId)].sort((a, b) => a - b)).toEqual(
      [assetId, folder.id].sort((a, b) => a - b),
    );
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
    const foreignArtifact = await createArtifact(second.id, "别的需求的文件.md");
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
      (
        await app.inject(`/api/artifacts/nodes/${assetId}`)
      ).statusCode,
    ).toBe(200);
  });
});
