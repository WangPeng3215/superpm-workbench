import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createScopedDatabase, runAsUser } from "../src/db/scope.js";
import { DailyTaskService } from "../src/services/daily-tasks.js";
import { ProjectTaskService } from "../src/services/project-tasks.js";
import { ProjectWorklogService } from "../src/services/project-worklog.js";
import { ProjectService } from "../src/services/projects.js";
import { businessDate, zonedDateTime } from "../src/services/business-time.js";

describe("project daily plans and worklogs", () => {
  let db: Database.Database;
  let now: Date;
  let projects: ProjectService;
  let projectTasks: ProjectTaskService;
  let dailyTasks: DailyTaskService;
  let worklog: ProjectWorklogService;
  let projectId: number;
  let taskId: number;
  const owner = 1;
  const assignee = 2;
  const outsider = 3;
  const as = <T>(userId: number, fn: () => T): T =>
    runAsUser({ userId, isAdmin: false }, fn);

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    now = zonedDateTime("2026-11-20", "09:00");
    const insertUser = db.prepare(
      "INSERT INTO users(username,display_name,password_hash,password_salt,created_at,updated_at) VALUES(?,?,'x','x','now','now')",
    );
    insertUser.run("owner", "项目负责人");
    insertUser.run("assignee", "执行人");
    insertUser.run("outsider", "外部账号");
    projects = new ProjectService(db);
    projectTasks = new ProjectTaskService(db);
    const dailyDb = createScopedDatabase(db);
    dailyTasks = new DailyTaskService(dailyDb, {
      now: () => now,
      projectTaskAccess: (id, purpose) =>
        projectTasks.assertDailyPlanAccess(id, purpose),
    });
    worklog = new ProjectWorklogService(db, dailyTasks, () => now);
    const project = as(
      owner,
      () => projects.create({ name: "客户交付" }, "create-project").project,
    );
    projectId = project.id;
    as(owner, () =>
      projects.writeMember(projectId, {
        userId: assignee,
        roles: ["contributor"],
        expectedVersion: project.version,
      }),
    );
    const task = as(owner, () =>
      projectTasks.create(projectId, {
        title: "实现登录",
        type: "development",
        assigneeUserId: assignee,
        confirmerUserId: owner,
      }),
    );
    taskId = task.id;
  });

  afterEach(() => db.close());

  it("rechecks project membership when starting an existing project plan", () => {
    const project = as(owner, () => projects.get(projectId).project);
    as(owner, () =>
      projects.lifecycle(projectId, {
        action: "start",
        expectedVersion: project.version,
      }),
    );
    const plan = as(assignee, () =>
      dailyTasks.planProjectTask(taskId, {
        date: businessDate(now),
        expectedVersion: 1,
      }),
    );
    db.prepare(
      "UPDATE project_members SET status='removed', removed_at='now' WHERE project_id=? AND user_id=?",
    ).run(projectId, assignee);

    expect(() => as(assignee, () => dailyTasks.start(plan.id))).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM daily_time_entries WHERE task_id=?",
        )
        .get(plan.id),
    ).toEqual({ count: 0 });
  });

  it("rejects planning and starting a project task after the assignee becomes viewer-only", () => {
    const date = businessDate(now);
    const existingPlan = as(assignee, () =>
      dailyTasks.planProjectTask(taskId, { date, expectedVersion: 1 }),
    );
    db.prepare(
      "DELETE FROM project_member_roles WHERE project_id=? AND user_id=?",
    ).run(projectId, assignee);
    db.prepare(
      "INSERT INTO project_member_roles(project_id,user_id,role) VALUES(?,?,'viewer')",
    ).run(projectId, assignee);

    expect(() =>
      as(assignee, () =>
        dailyTasks.planProjectTask(taskId, {
          date: "2026-11-21",
          expectedVersion: 1,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
    expect(() => as(assignee, () => dailyTasks.start(existingPlan.id))).toThrow(
      expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM daily_time_entries WHERE task_id=?",
        )
        .get(existingPlan.id),
    ).toEqual({ count: 0 });
  });

  it("same task and business day reuses a plan, while other dates create separate plans", () => {
    const date = businessDate(now);
    const plan = as(assignee, () =>
      dailyTasks.planProjectTask(taskId, {
        date,
        expectedVersion: 1,
        plannedStartAt: "09:00",
        plannedEndAt: "10:30",
        estimatedMinutes: 90,
      }),
    );
    const replay = as(assignee, () =>
      dailyTasks.planProjectTask(taskId, { date, expectedVersion: 1 }),
    );
    expect(replay.id).toBe(plan.id);
    expect(plan).toMatchObject({
      projectTaskId: taskId,
      requirementId: null,
      plannedStartAt: "09:00",
      plannedEndAt: "10:30",
      estimatedMinutes: 90,
    });
    const nextDay = as(assignee, () =>
      dailyTasks.planProjectTask(taskId, {
        date: "2026-11-21",
        expectedVersion: 1,
      }),
    );
    expect(nextDay.id).not.toBe(plan.id);
    expect(() =>
      as(assignee, () =>
        dailyTasks.planProjectTask(taskId, { date, expectedVersion: 99 }),
      ),
    ).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    expect(() =>
      as(outsider, () =>
        dailyTasks.planProjectTask(taskId, { date, expectedVersion: 1 }),
      ),
    ).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("attributes project worklog to the users who recorded it after task reassignment", () => {
    let project = as(owner, () => projects.get(projectId).project);
    project = as(
      owner,
      () =>
        projects.lifecycle(projectId, {
          action: "start",
          expectedVersion: project.version,
        }).project,
    );

    const assigneePlan = as(assignee, () =>
      dailyTasks.planProjectTask(taskId, {
        date: businessDate(now),
        expectedVersion: 1,
      }),
    );
    as(assignee, () => dailyTasks.start(assigneePlan.id));
    now = zonedDateTime("2026-11-20", "09:30");
    as(assignee, () => dailyTasks.stop(assigneePlan.id));

    as(owner, () =>
      projectTasks.update(taskId, { expectedVersion: 1, assigneeUserId: owner }),
    );
    const ownerPlan = as(owner, () =>
      dailyTasks.planProjectTask(taskId, {
        date: businessDate(now),
        expectedVersion: 2,
      }),
    );
    as(owner, () => dailyTasks.start(ownerPlan.id));
    now = zonedDateTime("2026-11-20", "10:00");
    as(owner, () => dailyTasks.stop(ownerPlan.id));

    expect(as(owner, () => worklog.get(projectId))).toEqual({
      totalSeconds: 60 * 60,
      items: [
        {
          projectTaskId: taskId,
          title: "实现登录",
          assigneeUserId: owner,
          assigneeName: "项目负责人",
          workerUserId: assignee,
          workerName: "执行人",
          totalSeconds: 30 * 60,
        },
        {
          projectTaskId: taskId,
          title: "实现登录",
          assigneeUserId: owner,
          assigneeName: "项目负责人",
          workerUserId: owner,
          workerName: "项目负责人",
          totalSeconds: 30 * 60,
        },
      ],
    });
  });

  it("allows planning while paused, blocks starting, and snapshots linked time for project-only aggregation", () => {
    let project = as(owner, () => projects.get(projectId).project);
    project = as(
      owner,
      () =>
        projects.lifecycle(projectId, {
          action: "start",
          expectedVersion: project.version,
        }).project,
    );
    project = as(
      owner,
      () =>
        projects.lifecycle(projectId, {
          action: "pause",
          reason: "等待客户确认",
          expectedVersion: project.version,
        }).project,
    );
    const firstPlan = as(assignee, () =>
      dailyTasks.planProjectTask(taskId, {
        date: businessDate(now),
        expectedVersion: 1,
      }),
    );
    expect(() => as(assignee, () => dailyTasks.start(firstPlan.id))).toThrow(
      expect.objectContaining({ code: "PROJECT_READ_ONLY" }),
    );
    project = as(
      owner,
      () =>
        projects.lifecycle(projectId, {
          action: "resume",
          reason: "客户已确认",
          expectedVersion: project.version,
        }).project,
    );
    expect(project.status).toBe("active");

    as(assignee, () => dailyTasks.start(firstPlan.id));
    now = zonedDateTime("2026-11-20", "10:00");
    as(assignee, () => dailyTasks.stop(firstPlan.id));
    db.prepare("UPDATE daily_tasks SET project_task_id=NULL WHERE id=?").run(
      firstPlan.id,
    );

    const personalPlan = as(assignee, () =>
      dailyTasks.create({
        title: "私人安排",
        planDate: "2026-11-20",
        estimatedMinutes: 30,
      }),
    );
    as(assignee, () => dailyTasks.start(personalPlan.id));
    now = zonedDateTime("2026-11-20", "10:30");
    as(assignee, () => dailyTasks.stop(personalPlan.id));

    const secondPlan = as(assignee, () =>
      dailyTasks.planProjectTask(taskId, {
        date: "2026-11-21",
        expectedVersion: 1,
      }),
    );
    now = zonedDateTime("2026-11-21", "09:00");
    as(assignee, () => dailyTasks.start(secondPlan.id));
    now = zonedDateTime("2026-11-21", "09:30");

    expect(as(owner, () => worklog.get(projectId))).toEqual({
      totalSeconds: 90 * 60,
      items: [
        {
          projectTaskId: taskId,
          title: "实现登录",
          assigneeUserId: assignee,
          assigneeName: "执行人",
          workerUserId: assignee,
          workerName: "执行人",
          totalSeconds: 90 * 60,
        },
      ],
    });
    now = zonedDateTime("2026-11-21", "18:30");
    expect(as(owner, () => worklog.get(projectId)).totalSeconds).toBe(
      9 * 60 * 60,
    );
    expect(() => as(outsider, () => worklog.get(projectId))).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});
