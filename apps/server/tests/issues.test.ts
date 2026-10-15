import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
      issueType: "design",
    });
    expect(issue).toMatchObject({
      requirementId: requirement.id,
      phase: "design",
      status: "open",
      title: "按钮样式与设计稿不一致",
      description: "间距偏差 4px",
      issueType: "design",
      issueKey: null,
      isDeleted: false,
      resolvedAt: null,
      closedAt: null,
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
  it("enforces solution requirement when resolving and records status history", async () => {
    const requirement = await create();
    const issue = await createIssue(requirement.id);
    // 无解决说明直接标记解决被拒绝
    const noSolution = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}`,
      payload: { status: "resolved" },
    });
    expect(noSolution.statusCode).toBe(400);
    // 带解决说明标记解决：写 resolved_at 与 solution 历史
    const resolved = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}`,
      payload: { status: "resolved", solution: "调整间距为 8px 并重新导出切图" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json<Issue>()).toMatchObject({
      status: "resolved",
      solution: "调整间距为 8px 并重新导出切图",
    });
    expect(resolved.json<Issue>().resolvedAt).toBeTruthy();
    let detail = (
      await app.inject(`/api/requirements/${requirement.id}/issues/${issue.id}`)
    ).json<IssueDetail>();
    const statusChange = detail.activities.find(
      (item) => item.activityType === "status_change",
    );
    expect(statusChange).toMatchObject({
      oldStatus: "open",
      newStatus: "resolved",
    });
    const solutionActivity = detail.activities.find(
      (item) => item.activityType === "solution",
    );
    expect(solutionActivity?.content).toBe("调整间距为 8px 并重新导出切图");
    // 关闭不要求解决说明：关闭 ≠ 解决
    const closed = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}`,
      payload: { status: "closed" },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json<Issue>()).toMatchObject({
      status: "closed",
      closedAt: expect.any(String),
      solution: "调整间距为 8px 并重新导出切图",
    });
    // 重新打开：保留全部历史，清空解决时间
    const reopened = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}`,
      payload: { status: "open" },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json<Issue>()).toMatchObject({
      status: "open",
      resolvedAt: null,
      closedAt: null,
    });
    detail = (
      await app.inject(`/api/requirements/${requirement.id}/issues/${issue.id}`)
    ).json<IssueDetail>();
    expect(detail.activities.filter((item) => item.activityType === "status_change")).toHaveLength(3);
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
      payload: { status: "in_progress" },
    });
    expect(inProgress.statusCode).toBe(200);
    const processing = (
      await app.inject(
        `/api/requirements/${requirement.id}/issues?status=in_progress`,
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
  it("links assets to issues with dedup and keeps assets untouched after unlink", async () => {
    const requirement = await create();
    const issue = await createIssue(requirement.id);
    const asset = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "design",
        category: "uiAssets",
        name: "问题截图",
        data: Buffer.from("png-bytes").toString("base64"),
      },
    });
    const assetId = asset.json().id;
    // 关联成功：返回关联信息与产出物投影
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
    expect(linked.json().asset).toMatchObject({ id: assetId, name: "问题截图" });
    // 重复关联被拒绝（联合主键去重）
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/issues/${issue.id}/assets`,
      payload: { assetId },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("CONFLICT");
    // 关联列表
    const list = (
      await app.inject(
        `/api/requirements/${requirement.id}/issues/${issue.id}/assets`,
      )
    ).json<IssueAssetListResult>();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ assetId, relationType: "evidence" });
    // 取消关联后产出物本体不受影响
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
    ).toBe(0);
    expect(
      (
        await app.inject(
          `/api/requirements/${requirement.id}/files/${assetId}/content`,
        )
      ).statusCode,
    ).toBe(200);
    // 二次取消返回 404
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/requirements/${requirement.id}/issues/${issue.id}/assets/${assetId}`,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("validates ownership and hides deleted assets from issue links", async () => {
    const first = await create({ name: "需求一", proposedAt: "2026-10-15" });
    const second = await create({ name: "需求二", proposedAt: "2026-10-15" });
    const issue = await createIssue(first.id);
    const foreignAsset = await app.inject({
      method: "POST",
      url: `/api/requirements/${second.id}/files`,
      payload: {
        phase: "design",
        category: "uiAssets",
        name: "别的需求的文件",
        data: Buffer.from("x").toString("base64"),
      },
    });
    // 跨需求关联被拒绝
    const cross = await app.inject({
      method: "POST",
      url: `/api/requirements/${first.id}/issues/${issue.id}/assets`,
      payload: { assetId: foreignAsset.json().id },
    });
    expect(cross.statusCode).toBe(404);
    // 本需求资源关联后软删除：从关联列表隐藏，且不可再次关联
    const asset = await app.inject({
      method: "POST",
      url: `/api/requirements/${first.id}/files`,
      payload: {
        phase: "design",
        category: "uiAssets",
        name: "将被删除的文件",
        data: Buffer.from("y").toString("base64"),
      },
    });
    const assetId = asset.json().id;
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
      url: `/api/requirements/${first.id}/files/${assetId}`,
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
    const asset = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/files`,
      payload: {
        phase: "development",
        category: "other",
        name: "日志附件",
        data: Buffer.from("log").toString("base64"),
      },
    });
    const assetId = asset.json().id;
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
      .prepare("SELECT COUNT(*) AS count FROM issue_assets WHERE issue_id=?")
      .get(issue.id) as { count: number };
    inspection.close();
    expect(rows.count).toBe(0);
    // 产出物本体不受问题删除影响
    expect(
      (
        await app.inject(
          `/api/requirements/${requirement.id}/files/${assetId}/content`,
        )
      ).statusCode,
    ).toBe(200);
  });
});
