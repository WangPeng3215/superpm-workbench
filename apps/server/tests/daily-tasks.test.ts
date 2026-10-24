import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dailyLimitSeconds,
  type DailyTask,
  type DailyTaskDay,
} from "@superpm/shared";
import { migrate } from "../src/db/migrate.js";
import { DailyTaskService } from "../src/services/daily-tasks.js";
import {
  businessDate,
  businessDayEnd,
  zonedDateTime,
} from "../src/services/business-time.js";

const DATE = "2026-10-24";

describe("daily task service", () => {
  let directory: string;
  let db: Database.Database;
  let now: Date;
  let service: DailyTaskService;

  const createService = () => new DailyTaskService(db, { now: () => now });
  const createTask = (title: string, overrides: Record<string, unknown> = {}) =>
    service.create({
      title,
      planDate: DATE,
      estimatedMinutes: 60,
      ...overrides,
    }) as DailyTask;
  const insertCompletedEntry = (taskId: number, start: string, end: string) => {
    const startedAt = zonedDateTime(DATE, start);
    const endedAt = zonedDateTime(DATE, end);
    const duration = Math.floor(
      (endedAt.getTime() - startedAt.getTime()) / 1000,
    );
    const timestamp = now.toISOString();
    db.prepare(
      `INSERT INTO daily_time_entries
        (task_id, started_at, ended_at, duration_seconds, status, end_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'completed', 'manual', ?, ?)`,
    ).run(
      taskId,
      startedAt.toISOString(),
      endedAt.toISOString(),
      duration,
      timestamp,
      timestamp,
    );
  };
  const entryRows = () =>
    db.prepare("SELECT * FROM daily_time_entries ORDER BY id").all() as {
      id: number;
      status: string;
      duration_seconds: number;
      ended_at: string | null;
      end_reason: string | null;
    }[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "superpm-daily-"));
    db = new Database(join(directory, "test.sqlite"));
    migrate(db);
    now = zonedDateTime(DATE, "09:00:00");
    service = createService();
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates, lists and orders tasks for a plan date", () => {
    const first = createTask("任务一", {
      plannedStartAt: "09:00",
      plannedEndAt: "10:00",
      description: "补充说明",
    });
    const second = createTask("任务二", { estimatedMinutes: 30 });
    expect(first.status).toBe("pending");
    expect(first.sortOrder).toBe(0);
    expect(second.sortOrder).toBe(1);
    let day = service.day(DATE) as DailyTaskDay;
    expect(day.tasks.map((task) => task.title)).toEqual(["任务一", "任务二"]);
    expect(day.stats).toMatchObject({
      totalCount: 2,
      completedCount: 0,
      plannedMinutes: 90,
      percent: 0,
    });
    service.reorder({ date: DATE, ids: [second.id, first.id] });
    day = service.day(DATE);
    expect(day.tasks.map((task) => task.title)).toEqual(["任务二", "任务一"]);
    const updated = service.update(first.id, {
      title: "任务一（改）",
      estimatedMinutes: 90,
    }) as DailyTask;
    expect(updated).toMatchObject({
      title: "任务一（改）",
      estimatedMinutes: 90,
      status: "pending",
    });
  });

  it("rejects invalid task input and mismatched ordering", () => {
    expect(() => createTask(" ", {})).toThrowError(/任务名称/);
    expect(() => createTask("任务", { estimatedMinutes: 45 })).toThrowError(
      /0.5 小时/,
    );
    expect(() =>
      createTask("任务", {
        plannedStartAt: "10:00",
        plannedEndAt: "09:00",
      }),
    ).toThrowError(/结束时间/);
    const task = createTask("任务");
    expect(() =>
      service.reorder({ date: DATE, ids: [task.id, task.id] }),
    ).toThrowError(/排序列表/);
  });

  it("links a live requirement and drops the link when it is deleted", () => {
    const timestamp = now.toISOString();
    const requirementId = Number(
      db
        .prepare(
          `INSERT INTO requirements
            (requirement_no, name, type, priority, description, description_html,
             status, current_stage, proposed_at, created_at, updated_at)
           VALUES ('REQ-0001', '关联需求', 'feature', 'medium', '', '',
             'draft', 'analysis', '2026-10-01', ?, ?)`,
        )
        .run(timestamp, timestamp).lastInsertRowid,
    );
    const task = createTask("关联任务", { requirementId });
    expect(task.requirement).toMatchObject({
      id: requirementId,
      requirementNo: "REQ-0001",
      name: "关联需求",
    });
    db.prepare("UPDATE requirements SET deleted_at = ? WHERE id = ?").run(
      timestamp,
      requirementId,
    );
    expect(service.day(DATE).tasks[0].requirement).toBeNull();
  });

  it("keeps one active timer and restores it after reload", () => {
    const first = createTask("任务一");
    const second = createTask("任务二");
    service.start(first.id);
    expect(() => service.start(second.id)).toThrowError(/正在计时/);
    now = zonedDateTime(DATE, "09:10:00");
    const active = service.activeState();
    expect(active.activeTimer).toMatchObject({
      taskId: first.id,
      taskTitle: "任务一",
      elapsedSeconds: 600,
    });
    expect(service.day(DATE).tasks[0].status).toBe("in_progress");
    service.stop(first.id);
    expect(service.activeState().activeTimer).toBeNull();
    expect(service.day(DATE).tasks[0].status).toBe("completed");
    // 重复结束按幂等处理
    expect(service.stop(first.id).activeTimer).toBeNull();
    service.start(second.id);
    expect(service.activeState().activeTimer?.taskId).toBe(second.id);
  });

  it("ends the timer at 18:00 and completes the task", () => {
    const task = createTask("任务");
    now = zonedDateTime(DATE, "17:50:00");
    service.start(task.id);
    now = zonedDateTime(DATE, "18:10:00");
    const day = service.day(DATE);
    expect(day.activeTimer).toBeNull();
    expect(day.tasks[0].status).toBe("completed");
    expect(day.tasks[0].actualSeconds).toBe(600);
    const [entry] = entryRows();
    expect(entry).toMatchObject({
      status: "completed",
      end_reason: "auto_18_00",
      ended_at: businessDayEnd(DATE).toISOString(),
      duration_seconds: 600,
    });
    expect(service.reconcile()).toEqual([]);
    expect(entryRows()).toHaveLength(1);
  });

  it("rejects starting at or after 18:00", () => {
    const task = createTask("任务");
    now = zonedDateTime(DATE, "18:00:00");
    expect(() => service.start(task.id)).toThrowError(/18:00/);
  });

  it("compensates an active timer missed across an application restart", () => {
    const task = createTask("跨重启任务");
    now = zonedDateTime(DATE, "17:00:00");
    service.start(task.id);
    service = createService();
    now = zonedDateTime("2026-10-27", "09:00:00");
    expect(service.reconcile()).toHaveLength(1);
    const day = service.day(DATE);
    expect(day.tasks[0].status).toBe("completed");
    expect(day.tasks[0].actualSeconds).toBe(3600);
    expect(day.activeTimer).toBeNull();
    expect(entryRows()[0]).toMatchObject({
      end_reason: "auto_18_00",
      ended_at: businessDayEnd(DATE).toISOString(),
    });
  });

  it("caps the timer at the daily 8 hour limit", () => {
    const task = createTask("任务");
    const other = createTask("已计入任务");
    insertCompletedEntry(other.id, "09:00:00", "16:30:00");
    now = zonedDateTime(DATE, "17:00:00");
    service.start(task.id);
    now = zonedDateTime(DATE, "17:40:00");
    const day = service.day(DATE);
    expect(day.activeTimer).toBeNull();
    expect(day.stats.actualSeconds).toBe(dailyLimitSeconds);
    expect(day.stats.remainingSeconds).toBe(0);
    expect(day.tasks.find((item) => item.id === task.id)).toMatchObject({
      status: "completed",
      actualSeconds: 1800,
    });
    expect(entryRows()[1]).toMatchObject({
      end_reason: "daily_limit",
      duration_seconds: 1800,
    });
    // 满额后不能再开始
    expect(() => service.start(task.id)).toThrowError(/8 小时/);
  });

  it("validates manual corrections, keeps an audit and refreshes statistics", () => {
    const task = createTask("任务");
    now = zonedDateTime(DATE, "09:00:00");
    service.start(task.id);
    now = zonedDateTime(DATE, "10:00:00");
    service.stop(task.id);
    const entry = entryRows()[0];
    const result = service.updateTimeEntry(entry.id, {
      startedAt: zonedDateTime(DATE, "09:30:00").toISOString(),
      endedAt: zonedDateTime(DATE, "10:30:00").toISOString(),
      reason: "会议顺延",
    });
    expect(result.entry.durationSeconds).toBe(3600);
    expect(result.day.stats.actualSeconds).toBe(3600);
    const audit = db
      .prepare("SELECT * FROM daily_time_entry_audits WHERE entry_id = ?")
      .get(entry.id) as Record<string, unknown>;
    expect(audit).toMatchObject({
      reason: "会议顺延",
      before_started_at: zonedDateTime(DATE, "09:00:00").toISOString(),
      after_ended_at: zonedDateTime(DATE, "10:30:00").toISOString(),
    });
    // 跨日拒绝
    expect(() =>
      service.updateTimeEntry(entry.id, {
        startedAt: zonedDateTime(DATE, "17:00:00").toISOString(),
        endedAt: zonedDateTime("2026-10-25", "09:00:00").toISOString(),
        reason: "",
      }),
    ).toThrowError(/跨自然日/);
    // 超过 18:00 拒绝
    expect(() =>
      service.updateTimeEntry(entry.id, {
        startedAt: zonedDateTime(DATE, "17:00:00").toISOString(),
        endedAt: zonedDateTime(DATE, "18:10:00").toISOString(),
        reason: "",
      }),
    ).toThrowError(/18:00/);
  });

  it("rejects overlapping or over-limit corrections", () => {
    const first = createTask("任务一");
    const second = createTask("任务二");
    insertCompletedEntry(first.id, "09:00:00", "10:00:00");
    insertCompletedEntry(second.id, "10:30:00", "11:00:00");
    const firstEntry = entryRows()[0];
    expect(() =>
      service.updateTimeEntry(firstEntry.id, {
        startedAt: zonedDateTime(DATE, "09:00:00").toISOString(),
        endedAt: zonedDateTime(DATE, "10:45:00").toISOString(),
        reason: "",
      }),
    ).toThrowError(/重叠/);
    // 其余记录合计 7.5 小时，把当前记录改为 1 小时会超过每日上限
    const third = createTask("任务三");
    insertCompletedEntry(third.id, "03:00:00", "10:00:00");
    expect(() =>
      service.updateTimeEntry(firstEntry.id, {
        startedAt: zonedDateTime(DATE, "11:30:00").toISOString(),
        endedAt: zonedDateTime(DATE, "12:30:00").toISOString(),
        reason: "",
      }),
    ).toThrowError(/8 小时/);
  });

  it("archives tasks with history and keeps the hours in statistics", () => {
    const task = createTask("已完成任务");
    now = zonedDateTime(DATE, "09:00:00");
    service.start(task.id);
    now = zonedDateTime(DATE, "10:00:00");
    service.stop(task.id);
    const result = service.remove(task.id);
    expect(result).toEqual({ archived: true });
    const day = service.day(DATE);
    expect(day.tasks).toHaveLength(0);
    expect(day.stats.actualSeconds).toBe(3600);
    expect(day.summaryText).toContain("已完成任务");
    // 无工时任务直接删除
    const empty = createTask("空任务");
    expect(service.remove(empty.id)).toEqual({ archived: false });
  });

  it("refuses to delete an active task", () => {
    const task = createTask("计时中任务");
    service.start(task.id);
    expect(() => service.remove(task.id)).toThrowError(/正在计时/);
  });

  it("builds the daily work summary from actual entries", () => {
    const done = createTask("优化需求详情页 UI", { estimatedMinutes: 120 });
    const open = createTask("完成每日任务数据库设计", { estimatedMinutes: 60 });
    now = zonedDateTime(DATE, "09:00:00");
    service.start(done.id);
    now = zonedDateTime(DATE, "11:00:00");
    service.stop(done.id);
    const text = service.summaryText(DATE).text;
    expect(text).toBe(
      [
        "【每日工作总结】2026-10-24",
        "",
        "一、已完成工作",
        "1. 优化需求详情页 UI（2.0 小时）",
        "",
        "二、未完成工作",
        "1. 完成每日任务数据库设计",
        "",
        "三、工时统计",
        "实际工作时长：2.0 小时",
      ].join("\n"),
    );
    expect(text).not.toContain("完成每日任务数据库设计（");
    expect(open.status).toBe("pending");
  });

  it("aggregates the month calendar by plan date and actual work date", () => {
    const task = createTask("任务");
    createTask("另一天的任务", { planDate: "2026-10-25" });
    now = zonedDateTime(DATE, "09:00:00");
    service.start(task.id);
    now = zonedDateTime(DATE, "10:30:00");
    service.stop(task.id);
    const calendar = service.calendar("2026-10");
    expect(calendar.today).toBe(DATE);
    expect(calendar.days).toHaveLength(31);
    expect(calendar.days.find((day) => day.date === DATE)).toMatchObject({
      taskCount: 1,
      completedCount: 1,
      actualSeconds: 5400,
      hasActive: false,
    });
    expect(
      calendar.days.find((day) => day.date === "2026-10-25"),
    ).toMatchObject({ taskCount: 1, completedCount: 0, actualSeconds: 0 });
  });

  it("uses the business date rather than the UTC date near midnight", () => {
    now = zonedDateTime(DATE, "00:30:00");
    createTask("凌晨任务");
    expect(service.today()).toBe(DATE);
    expect(businessDate(now)).toBe(DATE);
    expect(service.calendar("2026-10").days[23]).toMatchObject({
      date: DATE,
      taskCount: 1,
    });
    // 18:00 后不再允许开始计时
    now = zonedDateTime(DATE, "23:30:00");
    expect(service.today()).toBe(DATE);
    expect(() => service.start(service.day(DATE).tasks[0].id)).toThrowError(
      /18:00/,
    );
    now = zonedDateTime("2026-10-25", "00:10:00");
    expect(service.today()).toBe("2026-10-25");
  });
});
