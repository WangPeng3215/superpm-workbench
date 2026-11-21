import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";

describe("项目与需求协作（普通账号）", () => {
  let app: FastifyInstance;
  let directory: string;
  let a: { id: number; cookie: string };
  let b: typeof a;
  let c: typeof a;
  async function register(username: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username, password: "secret123" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const cookie = response.cookies
      .map((x) => `${x.name}=${x.value}`)
      .join("; ");
    const me = await app.inject({ url: "/api/auth/me", headers: { cookie } });
    return { id: me.json().id as number, cookie };
  }
  function as(
    user: typeof a,
    method: string,
    url: string,
    payload?: unknown,
    key?: string,
  ) {
    return app.inject({
      method: method as "GET",
      url,
      headers: {
        cookie: user.cookie,
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  async function createProject() {
    const r = await as(a, "POST", "/api/projects", { name: "B端交付项目" });
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  }
  async function add(project: any, user: typeof a, roles: string[]) {
    const r = await as(a, "POST", `/api/projects/${project.id}/members`, {
      userId: user.id,
      roles,
      expectedVersion: project.version,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().project;
  }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-projects-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    a = await register("alice");
    b = await register("bravo");
    c = await register("charlie");
  });
  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  it("名称即可建项目，默认双角色、版本、编号；外人不可见", async () => {
    const detail = await createProject();
    const p = detail.project;
    expect(p).toMatchObject({
      projectNo: "PRJ-0001",
      name: "B端交付项目",
      status: "planning",
      ownerUserId: a.id,
      productOwnerUserId: a.id,
      version: 1,
    });
    expect(detail.members[0].roles).toEqual(
      expect.arrayContaining(["owner", "product_owner"]),
    );
    expect(detail.capabilities.canEditProject).toBe(true);
    expect((await as(b, "GET", "/api/projects")).json().total).toBe(0);
    expect((await as(b, "GET", `/api/projects/${p.id}`)).statusCode).toBe(404);
    expect((await as(a, "GET", "/api/projects")).json().total).toBe(1);
  });
  it("项目编辑必须有角色和正确版本；日期合并验证，归档可恢复", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["viewer"]);
    expect(
      (
        await as(b, "PATCH", `/api/projects/${p.id}`, {
          name: "越权",
          expectedVersion: p.version,
        })
      ).statusCode,
    ).toBe(403);
    const r = await as(a, "PATCH", `/api/projects/${p.id}`, {
      plannedStartDate: "2026-11-20",
      targetDeliveryDate: "2026-11-30",
      expectedVersion: p.version,
    });
    expect(r.statusCode, r.body).toBe(200);
    p = r.json().project;
    expect(
      (
        await as(a, "PATCH", `/api/projects/${p.id}`, {
          name: "旧稿",
          expectedVersion: p.version - 1,
        })
      ).json().error.code,
    ).toBe("VERSION_CONFLICT");
    expect(
      (
        await as(a, "PATCH", `/api/projects/${p.id}`, {
          targetDeliveryDate: "2026-11-19",
          expectedVersion: p.version,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await as(a, "PATCH", `/api/projects/${p.id}/archive`, {
          archived: true,
          expectedVersion: p.version,
        })
      ).statusCode,
    ).toBe(409);
    const cancelled = await as(a, "POST", `/api/projects/${p.id}/lifecycle`, {
      action: "cancel",
      reason: "终止本期",
      expectedVersion: p.version,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    p = cancelled.json().project;
    const archived = await as(a, "PATCH", `/api/projects/${p.id}/archive`, {
      archived: true,
      expectedVersion: p.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    p = archived.json().project;
    expect((await as(a, "GET", "/api/projects")).json().total).toBe(0);
    expect(
      (await as(a, "GET", "/api/projects?view=archived")).json().total,
    ).toBe(1);
    expect(
      (
        await as(a, "PATCH", `/api/projects/${p.id}`, {
          name: "归档写入",
          expectedVersion: p.version,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await as(a, "PATCH", `/api/projects/${p.id}/archive`, {
          archived: false,
          expectedVersion: p.version,
        })
      ).statusCode,
    ).toBe(200);
  });
  it("项目需求共享可见、版本CAS；私有仍私有；viewer不能写", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["product_owner"]);
    p = await add(p, c, ["viewer"]);
    const privateReq = (
      await as(a, "POST", "/api/requirements", {
        name: "个人草稿",
        proposedAt: "2026-11-19",
      })
    ).json();
    const response = await as(a, "POST", "/api/requirements", {
      name: "共享需求",
      projectId: p.id,
      proposedAt: "2026-11-19",
    });
    expect(response.statusCode, response.body).toBe(201);
    const req = response.json();
    expect(req).toMatchObject({
      projectId: p.id,
      assigneeUserId: a.id,
      version: 1,
    });
    expect((await as(b, "GET", `/api/requirements/${req.id}`)).statusCode).toBe(
      200,
    );
    expect(
      (await as(b, "GET", `/api/requirements/${privateReq.id}`)).statusCode,
    ).toBe(404);
    expect(
      (await as(b, "GET", `/api/requirements?projectId=${p.id}`)).json().items,
    ).toHaveLength(1);
    expect(
      (await as(b, "GET", "/api/requirements?unassigned=true")).json().items,
    ).toHaveLength(0);
    expect(
      (
        await as(c, "PATCH", `/api/requirements/${req.id}`, {
          name: "不可改",
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await as(b, "PATCH", `/api/requirements/${req.id}`, { name: "缺版本" }))
        .statusCode,
    ).toBe(428);
    const saved = await as(b, "PATCH", `/api/requirements/${req.id}`, {
      name: "新版本",
      expectedVersion: 1,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().version).toBe(2);
    const conflict = await as(a, "PATCH", `/api/requirements/${req.id}`, {
      name: "旧版本",
      expectedVersion: 1,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.details.current.name).toBe("新版本");
  });
  it("私人需求整树预览后原子共享，旧令牌与跨项目parent被拒", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["product_owner"]);
    const parent = (
      await as(a, "POST", "/api/requirements", {
        name: "个人主需",
        proposedAt: "2026-11-19",
      })
    ).json();
    const child = (
      await as(a, "POST", "/api/requirements", {
        name: "子需求",
        parentId: parent.id,
        proposedAt: "2026-11-19",
      })
    ).json();
    const preview = await as(
      a,
      "POST",
      `/api/projects/${p.id}/requirements/share-preview`,
      { rootRequirementId: parent.id },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().requirements).toHaveLength(2);
    const shared = await as(
      a,
      "POST",
      `/api/projects/${p.id}/requirements/share`,
      {
        token: preview.json().token,
        confirmed: true,
        expectedVersion: p.version,
      },
    );
    expect(shared.statusCode, shared.body).toBe(200);
    expect(
      (await as(b, "GET", `/api/requirements/${child.id}`)).json().projectId,
    ).toBe(p.id);
    expect(
      (
        await as(a, "POST", `/api/projects/${p.id}/requirements/share`, {
          token: preview.json().token,
          confirmed: true,
          expectedVersion: shared.json().project.version,
        })
      ).statusCode,
    ).toBe(409);
    const other = (
      await as(a, "POST", "/api/requirements", {
        name: "私人父项",
        proposedAt: "2026-11-19",
      })
    ).json();
    expect(
      (
        await as(a, "PATCH", `/api/requirements/${child.id}`, {
          parentId: other.id,
          expectedVersion: 2,
        })
      ).statusCode,
    ).toBe(409);
  });
  it("移除/降为只读须先移交责任，原作者退出立即失去访问", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["owner", "product_owner"]);
    const req = (
      await as(a, "POST", "/api/requirements", {
        name: "待交接",
        projectId: p.id,
        proposedAt: "2026-11-19",
      })
    ).json();
    const blocked = await as(
      a,
      "PATCH",
      `/api/projects/${p.id}/members/${b.id}`,
      { userId: b.id, roles: ["viewer"], expectedVersion: p.version },
    );
    expect(blocked.statusCode, blocked.body).toBe(200);
    p = blocked.json().project;
    p = await add(p, b, ["owner", "product_owner"]);
    const leads = await as(a, "PATCH", `/api/projects/${p.id}/leads`, {
      ownerUserId: b.id,
      productOwnerUserId: b.id,
      expectedVersion: p.version,
    });
    expect(leads.statusCode, leads.body).toBe(200);
    p = leads.json().project;
    const removal = await as(
      b,
      "DELETE",
      `/api/projects/${p.id}/members/${a.id}`,
      { expectedVersion: p.version },
    );
    expect(removal.statusCode).toBe(409);
    expect(removal.json().error.code).toBe("RESPONSIBILITY_TRANSFER_REQUIRED");
    expect(
      (
        await as(b, "PATCH", `/api/requirements/${req.id}`, {
          assigneeUserId: b.id,
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    const removed = await as(
      b,
      "DELETE",
      `/api/projects/${p.id}/members/${a.id}`,
      { expectedVersion: p.version },
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await as(a, "GET", `/api/requirements/${req.id}`)).statusCode).toBe(
      404,
    );
    expect((await as(a, "GET", `/api/projects/${p.id}`)).statusCode).toBe(404);
    expect(
      (
        await as(b, "DELETE", `/api/projects/${p.id}/members/${b.id}`, {
          expectedVersion: removed.json().project.version,
        })
      ).statusCode,
    ).toBe(409);
  });
  it("viewer 降级或移除前必须移交未完成任务责任，已结束任务不阻断", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["contributor"]);
    const createTask = async (title: string) => {
      const response = await as(a, "POST", `/api/projects/${p.id}/tasks`, {
        title,
        type: "development",
        assigneeUserId: b.id,
        confirmerUserId: b.id,
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json() as { id: number; version: number };
    };
    const activeTask = await createTask("待移交任务");
    const demotion = await as(
      a,
      "PATCH",
      `/api/projects/${p.id}/members/${b.id}`,
      { userId: b.id, roles: ["viewer"], expectedVersion: p.version },
    );
    expect(demotion.statusCode).toBe(409);
    expect(demotion.json().error).toMatchObject({
      code: "RESPONSIBILITY_TRANSFER_REQUIRED",
      details: {
        obligations: [
          { type: "project_task_assignee", id: activeTask.id },
          { type: "project_task_confirmer", id: activeTask.id },
        ],
      },
    });
    const removal = await as(
      a,
      "DELETE",
      `/api/projects/${p.id}/members/${b.id}`,
      { expectedVersion: p.version },
    );
    expect(removal.statusCode).toBe(409);
    expect(removal.json().error.code).toBe("RESPONSIBILITY_TRANSFER_REQUIRED");

    const cancelledTask = await createTask("已取消任务");
    const cancel = await as(
      a,
      "POST",
      `/api/project-tasks/${cancelledTask.id}/actions`,
      {
        action: "cancel",
        expectedVersion: cancelledTask.version,
        reason: "历史责任保留",
      },
    );
    expect(cancel.statusCode, cancel.body).toBe(200);

    const completedTask = await createTask("已完成任务");
    const start = await as(
      b,
      "POST",
      `/api/project-tasks/${completedTask.id}/actions`,
      { action: "start", expectedVersion: completedTask.version },
    );
    expect(start.statusCode, start.body).toBe(200);
    const submit = await as(
      b,
      "POST",
      `/api/project-tasks/${completedTask.id}/actions`,
      {
        action: "submit",
        expectedVersion: start.json().version,
        summary: "完成",
      },
    );
    expect(submit.statusCode, submit.body).toBe(200);
    const approve = await as(
      b,
      "POST",
      `/api/project-tasks/${completedTask.id}/actions`,
      { action: "approve", expectedVersion: submit.json().version },
    );
    expect(approve.statusCode, approve.body).toBe(200);

    const transfer = await as(
      a,
      "PATCH",
      `/api/project-tasks/${activeTask.id}`,
      {
        assigneeUserId: a.id,
        confirmerUserId: a.id,
        expectedVersion: activeTask.version,
      },
    );
    expect(transfer.statusCode, transfer.body).toBe(200);
    p = (await as(a, "GET", `/api/projects/${p.id}`)).json().project;
    const demoted = await as(
      a,
      "PATCH",
      `/api/projects/${p.id}/members/${b.id}`,
      { userId: b.id, roles: ["viewer"], expectedVersion: p.version },
    );
    expect(demoted.statusCode, demoted.body).toBe(200);
    p = demoted.json().project;
    const removed = await as(
      a,
      "DELETE",
      `/api/projects/${p.id}/members/${b.id}`,
      { expectedVersion: p.version },
    );
    expect(removed.statusCode, removed.body).toBe(200);
  });

  it("成员降级时在同一命令中原子移交任务责任并保留审计与幂等", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["contributor"]);
    const created = await as(a, "POST", `/api/projects/${p.id}/tasks`, {
      title: "同事务移交任务",
      type: "development",
      assigneeUserId: b.id,
      confirmerUserId: b.id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const task = created.json();
    const payload = {
      userId: b.id,
      roles: ["viewer"],
      expectedVersion: p.version,
      taskTransfers: [
        {
          taskId: task.id,
          expectedVersion: task.version,
          assigneeUserId: a.id,
          confirmerUserId: a.id,
        },
      ],
    };
    const changed = await as(
      a,
      "PATCH",
      `/api/projects/${p.id}/members/${b.id}`,
      payload,
      "member-transfer-once",
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().project.version).toBe(p.version + 1);
    expect(
      changed.json().members.find((member: any) => member.userId === b.id)
        .roles,
    ).toEqual(["viewer"]);

    const transferred = await as(a, "GET", `/api/project-tasks/${task.id}`);
    expect(transferred.statusCode, transferred.body).toBe(200);
    expect(transferred.json()).toMatchObject({
      assigneeUserId: a.id,
      confirmerUserId: a.id,
      version: task.version + 1,
      actions: [
        { action: "created" },
        {
          action: "edit",
          changes: {
            assigneeUserId: { before: b.id, after: a.id },
            confirmerUserId: { before: b.id, after: a.id },
          },
        },
      ],
    });

    const replay = await as(
      a,
      "PATCH",
      `/api/projects/${p.id}/members/${b.id}`,
      payload,
      "member-transfer-once",
    );
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().project.version).toBe(p.version + 1);
    expect(
      (await as(a, "GET", `/api/project-tasks/${task.id}`)).json().actions,
    ).toHaveLength(2);
  });

  it("移除成员可在同一事务中移交未完成任务责任", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["contributor"]);
    const created = await as(a, "POST", `/api/projects/${p.id}/tasks`, {
      title: "移除时一并移交",
      type: "testing",
      assigneeUserId: b.id,
      confirmerUserId: b.id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const task = created.json();
    const removed = await as(
      a,
      "DELETE",
      `/api/projects/${p.id}/members/${b.id}`,
      {
        expectedVersion: p.version,
        taskTransfers: [
          {
            taskId: task.id,
            expectedVersion: task.version,
            assigneeUserId: a.id,
            confirmerUserId: a.id,
          },
        ],
      },
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect(
      removed.json().members.some((member: any) => member.userId === b.id),
    ).toBe(false);
    expect(removed.json().project.version).toBe(p.version + 1);
    const transferred = await as(a, "GET", `/api/project-tasks/${task.id}`);
    expect(transferred.json()).toMatchObject({
      assigneeUserId: a.id,
      confirmerUserId: a.id,
      version: task.version + 1,
      actions: [
        { action: "created" },
        {
          action: "edit",
          changes: {
            assigneeUserId: { before: b.id, after: a.id },
            confirmerUserId: { before: b.id, after: a.id },
          },
        },
      ],
    });
  });

  it("任务移交中遇到过期任务版本时回滚此前任务更新与成员降级", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["contributor"]);
    const createTask = async (title: string) => {
      const response = await as(a, "POST", `/api/projects/${p.id}/tasks`, {
        title,
        type: "development",
        assigneeUserId: b.id,
        confirmerUserId: b.id,
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    };
    const first = await createTask("先移交");
    const stale = await createTask("版本过期");
    const response = await as(
      a,
      "PATCH",
      `/api/projects/${p.id}/members/${b.id}`,
      {
        userId: b.id,
        roles: ["viewer"],
        expectedVersion: p.version,
        taskTransfers: [
          {
            taskId: first.id,
            expectedVersion: first.version,
            assigneeUserId: a.id,
            confirmerUserId: a.id,
          },
          {
            taskId: stale.id,
            expectedVersion: stale.version + 1,
            assigneeUserId: a.id,
            confirmerUserId: a.id,
          },
        ],
      },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("VERSION_CONFLICT");
    const project = await as(a, "GET", `/api/projects/${p.id}`);
    expect(project.json().project.version).toBe(p.version);
    expect(
      project.json().members.find((member: any) => member.userId === b.id)
        .roles,
    ).toContain("contributor");
    for (const task of [first, stale]) {
      const after = await as(a, "GET", `/api/project-tasks/${task.id}`);
      expect(after.json()).toMatchObject({
        assigneeUserId: b.id,
        confirmerUserId: b.id,
        version: task.version,
      });
      expect(after.json().actions).toHaveLength(1);
    }
  });

  it("任务移交审计写入失败时回滚已写入的任务和成员变更", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["contributor"]);
    const createTask = async (title: string) => {
      const response = await as(a, "POST", `/api/projects/${p.id}/tasks`, {
        title,
        type: "development",
        assigneeUserId: b.id,
        confirmerUserId: b.id,
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    };
    const first = await createTask("审计成功前一项");
    const second = await createTask("审计失败项");
    const inspection = new Database(join(directory, "test.sqlite"));
    inspection.exec(
      `CREATE TRIGGER reject_task_transfer_audit BEFORE INSERT ON project_task_actions WHEN NEW.task_id=${second.id} AND NEW.action='edit' BEGIN SELECT RAISE(ABORT, 'forced transfer audit failure'); END`,
    );
    try {
      const response = await as(
        a,
        "PATCH",
        `/api/projects/${p.id}/members/${b.id}`,
        {
          userId: b.id,
          roles: ["viewer"],
          expectedVersion: p.version,
          taskTransfers: [
            {
              taskId: first.id,
              expectedVersion: first.version,
              assigneeUserId: a.id,
              confirmerUserId: a.id,
            },
            {
              taskId: second.id,
              expectedVersion: second.version,
              assigneeUserId: a.id,
              confirmerUserId: a.id,
            },
          ],
        },
      );
      expect(response.statusCode).toBe(500);
      const project = await as(a, "GET", `/api/projects/${p.id}`);
      expect(project.json().project.version).toBe(p.version);
      expect(
        project.json().members.find((member: any) => member.userId === b.id)
          .roles,
      ).toContain("contributor");
      for (const task of [first, second]) {
        const after = await as(a, "GET", `/api/project-tasks/${task.id}`);
        expect(after.json()).toMatchObject({
          assigneeUserId: b.id,
          confirmerUserId: b.id,
          version: task.version,
        });
        expect(after.json().actions).toHaveLength(1);
      }
    } finally {
      inspection.exec("DROP TRIGGER reject_task_transfer_audit");
      inspection.close();
    }
  });

  it("任务移交目标缺少相应的执行或确认能力时拒绝整次成员变更", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["contributor"]);
    p = await add(p, c, ["viewer"]);
    const created = await as(a, "POST", `/api/projects/${p.id}/tasks`, {
      title: "不可移交给只读成员",
      type: "development",
      assigneeUserId: b.id,
      confirmerUserId: b.id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const task = created.json();
    const response = await as(
      a,
      "DELETE",
      `/api/projects/${p.id}/members/${b.id}`,
      {
        expectedVersion: p.version,
        taskTransfers: [
          {
            taskId: task.id,
            expectedVersion: task.version,
            assigneeUserId: c.id,
            confirmerUserId: a.id,
          },
        ],
      },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("INVALID_TRANSFER_TARGET");
    const invalidConfirmer = await as(
      a,
      "DELETE",
      `/api/projects/${p.id}/members/${b.id}`,
      {
        expectedVersion: p.version,
        taskTransfers: [
          {
            taskId: task.id,
            expectedVersion: task.version,
            assigneeUserId: a.id,
            confirmerUserId: c.id,
          },
        ],
      },
    );
    expect(invalidConfirmer.statusCode).toBe(409);
    expect(invalidConfirmer.json().error).toMatchObject({
      code: "INVALID_TRANSFER_TARGET",
      details: { responsibility: "confirmer" },
    });
    const project = await as(a, "GET", `/api/projects/${p.id}`);
    expect(project.json().project.version).toBe(p.version);
    expect(
      project.json().members.some((member: any) => member.userId === b.id),
    ).toBe(true);
    expect(
      (await as(a, "GET", `/api/project-tasks/${task.id}`)).json(),
    ).toMatchObject({
      assigneeUserId: b.id,
      confirmerUserId: b.id,
      version: task.version,
    });
  });

  it("同版本并发修改只成功一次，并发移除不会丢失最后负责人", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["owner", "product_owner"]);
    const edits = await Promise.all([
      as(a, "PATCH", `/api/projects/${p.id}`, {
        name: "A 的修改",
        expectedVersion: p.version,
      }),
      as(b, "PATCH", `/api/projects/${p.id}`, {
        name: "B 的修改",
        expectedVersion: p.version,
      }),
    ]);
    expect(edits.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    p = (await as(a, "GET", `/api/projects/${p.id}`)).json().project;
    const removals = await Promise.all([
      as(a, "DELETE", `/api/projects/${p.id}/members/${b.id}`, {
        expectedVersion: p.version,
      }),
      as(b, "DELETE", `/api/projects/${p.id}/members/${a.id}`, {
        expectedVersion: p.version,
      }),
    ]);
    expect(removals.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(
      removals.every((r) => [200, 403, 404, 409].includes(r.statusCode)),
    ).toBe(true);
    const current = await as(a, "GET", `/api/projects/${p.id}`);
    expect(current.statusCode, current.body).toBe(200);
    const detail = current.json();
    expect(detail.project.version).toBe(p.version + 1);
    expect(
      detail.members.filter(
        (m: { status: string; accountStatus: string; roles: string[] }) =>
          m.status === "active" &&
          m.accountStatus === "active" &&
          m.roles.includes("owner"),
      ),
    ).toHaveLength(1);
    expect(detail.project.ownerUserId).toBe(a.id);
  });
  it("创建幂等不重复项目，重复键不同内容拒绝；运维只读不等于业务角色", async () => {
    const first = await as(
      a,
      "POST",
      "/api/projects",
      { name: "幂等项目" },
      "create-once",
    );
    expect(first.statusCode, first.body).toBe(201);
    const replay = await as(
      a,
      "POST",
      "/api/projects",
      { name: "幂等项目" },
      "create-once",
    );
    expect(replay.json().project.id).toBe(first.json().project.id);
    expect(
      (
        await as(
          a,
          "POST",
          "/api/projects",
          { name: "另一个项目" },
          "create-once",
        )
      ).statusCode,
    ).toBe(409);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "admin123" },
    });
    const admin = {
      id: 0,
      cookie: login.cookies.map((x) => `${x.name}=${x.value}`).join("; "),
    };
    const p = first.json().project;
    expect((await as(admin, "GET", `/api/projects/${p.id}`)).statusCode).toBe(
      200,
    );
    expect(
      (
        await as(admin, "PATCH", `/api/projects/${p.id}`, {
          name: "运维越权",
          expectedVersion: p.version,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("私人会议和今日安排可引用共享需求，但仍为本人私有，退出后摘要立即不可用", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["viewer"]);
    const req = (
      await as(a, "POST", "/api/requirements", {
        name: "团队客户名称",
        projectId: p.id,
        proposedAt: "2026-11-19",
      })
    ).json();
    const meeting = await as(b, "POST", "/api/meetings", {
      title: "私人跟进纪要",
      type: "weekly",
      meetingTime: "2026-11-19T10:00:00+08:00",
      requirementIds: [req.id],
      contentHtml: "<p>仅本人可见</p>",
    });
    expect(meeting.statusCode, meeting.body).toBe(201);
    expect(meeting.json().requirements[0].name).toBe("团队客户名称");
    const task = await as(b, "POST", "/api/daily-tasks", {
      title: "私人日安排",
      planDate: "2026-11-19",
      estimatedMinutes: 30,
      requirementId: req.id,
    });
    expect(task.statusCode, task.body).toBe(201);
    expect(task.json().requirement.name).toBe("团队客户名称");
    expect(
      (await as(a, "GET", `/api/meetings/${meeting.json().id}`)).statusCode,
    ).toBe(404);
    const removed = await as(
      a,
      "DELETE",
      `/api/projects/${p.id}/members/${b.id}`,
      { expectedVersion: p.version },
    );
    expect(removed.statusCode, removed.body).toBe(200);
    const oldMeeting = await as(b, "GET", `/api/meetings/${meeting.json().id}`);
    expect(oldMeeting.statusCode).toBe(200);
    expect(oldMeeting.json().requirements).toEqual([]);
    const day = await as(b, "GET", "/api/daily-tasks?date=2026-11-19");
    expect(day.statusCode, day.body).toBe(200);
    expect(day.json().tasks[0].requirement).toBeNull();
    expect(JSON.stringify(day.json())).not.toContain("团队客户名称");
  });
  it("候选账号受成员能力和最小搜索字数限制，生命周期不提前开放验收", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["product_owner"]);
    expect(
      (await as(b, "GET", `/api/projects/${p.id}/member-candidates?q=char`))
        .statusCode,
    ).toBe(403);
    expect(
      (await as(a, "GET", `/api/projects/${p.id}/member-candidates?q=c`))
        .statusCode,
    ).toBe(400);
    const candidates = await as(
      a,
      "GET",
      `/api/projects/${p.id}/member-candidates?q=char`,
    );
    expect(candidates.statusCode, candidates.body).toBe(200);
    expect(candidates.json().items[0]).toEqual({
      id: c.id,
      username: "charlie",
      displayName: "charlie",
    });
    const started = await as(a, "POST", `/api/projects/${p.id}/lifecycle`, {
      action: "start",
      expectedVersion: p.version,
    });
    expect(started.statusCode, started.body).toBe(200);
    p = started.json().project;
    expect(
      (
        await as(a, "POST", `/api/projects/${p.id}/lifecycle`, {
          action: "submit_acceptance",
          expectedVersion: p.version,
        })
      ).statusCode,
    ).toBe(409);
    const paused = await as(a, "POST", `/api/projects/${p.id}/lifecycle`, {
      action: "pause",
      reason: "等客户反馈",
      expectedVersion: p.version,
    });
    expect(paused.statusCode, paused.body).toBe(200);
    p = paused.json().project;
    const resumed = await as(a, "POST", `/api/projects/${p.id}/lifecycle`, {
      action: "resume",
      reason: "收到反馈",
      expectedVersion: p.version,
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json().project.status).toBe("active");
    const events = await as(a, "GET", `/api/projects/${p.id}/events`);
    expect(events.statusCode, events.body).toBe(200);
    expect(events.json().items[0].actorNameSnapshot).toBe("alice");
  });
  it("预览后增删子需求使共享令牌失效，不能借令牌替他人分享或更换目标", async () => {
    let p = (await createProject()).project;
    p = await add(p, b, ["product_owner"]);
    const root = (
      await as(a, "POST", "/api/requirements", {
        name: "树快照",
        proposedAt: "2026-11-19",
      })
    ).json();
    const preview = (
      await as(a, "POST", `/api/projects/${p.id}/requirements/share-preview`, {
        rootRequirementId: root.id,
      })
    ).json();
    expect(
      (
        await as(
          b,
          "POST",
          `/api/projects/${p.id}/requirements/share-preview`,
          { rootRequirementId: root.id },
        )
      ).statusCode,
    ).toBe(404);
    await as(a, "POST", "/api/requirements", {
      name: "新子需求",
      parentId: root.id,
      proposedAt: "2026-11-19",
    });
    const stale = await as(
      a,
      "POST",
      `/api/projects/${p.id}/requirements/share`,
      { token: preview.token, confirmed: true, expectedVersion: p.version },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("PREVIEW_STALE");
    expect(
      (await as(b, "GET", `/api/requirements/${root.id}`)).statusCode,
    ).toBe(404);
    expect(
      (await as(a, "GET", `/api/requirements/${root.id}`)).json().projectId,
    ).toBeNull();
  });
  it("取消命令幂等重试只留一条事件，取消后可重开；归档仍阻止状态写入", async () => {
    const p = (await createProject()).project;
    const payload = {
      action: "cancel",
      reason: "范围暂不确定",
      expectedVersion: p.version,
    };
    const cancelled = await as(
      a,
      "POST",
      `/api/projects/${p.id}/lifecycle`,
      payload,
      "cancel-once",
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const replay = await as(
      a,
      "POST",
      `/api/projects/${p.id}/lifecycle`,
      payload,
      "cancel-once",
    );
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().project.version).toBe(
      cancelled.json().project.version,
    );
    const events = await as(a, "GET", `/api/projects/${p.id}/events`);
    expect(
      events
        .json()
        .items.filter((e: { action: string }) => e.action === "project_cancel"),
    ).toHaveLength(1);
    const reopened = await as(a, "POST", `/api/projects/${p.id}/lifecycle`, {
      action: "reopen",
      reason: "新范围已确认",
      expectedVersion: cancelled.json().project.version,
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reopened.json().project.status).toBe("active");
  });
  it("创建幂等结果在退出后重新鉴权，不能取回原项目", async () => {
    const detail = await as(
      a,
      "POST",
      "/api/projects",
      { name: "退出后回放" },
      "create-sensitive",
    );
    let p = detail.json().project;
    p = await add(p, b, ["owner", "product_owner"]);
    p = (
      await as(a, "PATCH", `/api/projects/${p.id}/leads`, {
        ownerUserId: b.id,
        productOwnerUserId: b.id,
        expectedVersion: p.version,
      })
    ).json().project;
    expect(
      (
        await as(b, "DELETE", `/api/projects/${p.id}/members/${a.id}`, {
          expectedVersion: p.version,
        })
      ).statusCode,
    ).toBe(200);
    const replay = await as(
      a,
      "POST",
      "/api/projects",
      { name: "退出后回放" },
      "create-sensitive",
    );
    expect(replay.statusCode, replay.body).toBe(404);
  });
  it("项目查询按字面搜索和稳定游标分页；版本缺失明确返回428", async () => {
    let p = (await createProject()).project;
    expect(
      (await as(a, "PATCH", `/api/projects/${p.id}`, { name: "缺版本" }))
        .statusCode,
    ).toBe(428);
    for (let index = 0; index < 31; index++) {
      const saved = await as(a, "PATCH", `/api/projects/${p.id}`, {
        goal: "第" + index + "版",
        expectedVersion: p.version,
      });
      expect(saved.statusCode, saved.body).toBe(200);
      p = saved.json().project;
    }
    expect((await as(a, "GET", "/api/projects?q=%25")).json().total).toBe(0);
    const page1 = (await as(a, "GET", `/api/projects/${p.id}/events`)).json();
    expect(page1.items).toHaveLength(30);
    expect(page1.hasMore).toBe(true);
    const page2 = (
      await as(
        a,
        "GET",
        `/api/projects/${p.id}/events?cursor=${page1.nextCursor}`,
      )
    ).json();
    expect(page2.items).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
    expect(
      new Set([...page1.items, ...page2.items].map((e) => e.id)).size,
    ).toBe(32);
  });
  it("需求跳过或退回阶段必须说明，正常下一阶段可直接推进", async () => {
    const p = (await createProject()).project;
    const req = (
      await as(a, "POST", "/api/requirements", {
        name: "有原因的阶段流转",
        projectId: p.id,
        proposedAt: "2026-11-19",
      })
    ).json();
    expect(
      (
        await as(a, "PATCH", `/api/requirements/${req.id}`, {
          currentStage: "development",
          expectedVersion: req.version,
        })
      ).statusCode,
    ).toBe(400);
    const next = await as(a, "PATCH", `/api/requirements/${req.id}`, {
      currentStage: "design",
      expectedVersion: req.version,
    });
    expect(next.statusCode, next.body).toBe(200);
    expect(
      (
        await as(a, "PATCH", `/api/requirements/${req.id}`, {
          currentStage: "analysis",
          expectedVersion: next.json().version,
        })
      ).statusCode,
    ).toBe(400);
    const back = await as(a, "PATCH", `/api/requirements/${req.id}`, {
      currentStage: "analysis",
      stageNote: "重新澄清客户范围",
      expectedVersion: next.json().version,
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(
      (await as(a, "GET", `/api/requirements/${req.id}/history`)).json()[1],
    ).toMatchObject({
      actor: "alice",
      actorUserId: a.id,
      note: "重新澄清客户范围",
    });
  });
});
