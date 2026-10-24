import type Database from "better-sqlite3";
import {
  dailyLimitSeconds,
  dailyTaskCreateSchema,
  dailyTaskOrderSchema,
  dailyTaskUpdateSchema,
  dailyTimeEntryUpdateSchema,
  type ActiveDailyTimer,
  type DailyTask,
  type DailyTaskActiveState,
  type DailyTaskCalendar,
  type DailyTaskCalendarDay,
  type DailyTaskDay,
  type DailyTaskStats,
  type DailyTaskStatus,
  type DailyTaskSummaryText,
  type DailyTimeEntry,
  type DailyTimeEntryEndReason,
  type DailyTimeEntryStatus,
} from "@superpm/shared";
import { DomainError } from "./requirements.js";
import {
  addMonths,
  businessDate,
  businessDayEnd,
  businessDayStart,
  businessMonth,
  businessTimeZone,
  daysInMonth,
  monthDates,
  nextBusinessDayStart,
} from "./business-time.js";

interface TaskRow {
  id: number;
  title: string;
  description: string;
  plan_date: string;
  requirement_id: number | null;
  planned_start_at: string | null;
  planned_end_at: string | null;
  estimated_minutes: number;
  status: DailyTaskStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  requirement_no: string | null;
  requirement_name: string | null;
}

interface TimeEntryRow {
  id: number;
  task_id: number;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  status: DailyTimeEntryStatus;
  end_reason: DailyTimeEntryEndReason | null;
  created_at: string;
  updated_at: string;
}

interface ActiveTimerRow extends TimeEntryRow {
  task_title: string;
  task_plan_date: string;
}

export interface DailyTaskServiceOptions {
  now?: () => Date;
}

function toTimeEntry(row: TimeEntryRow): DailyTimeEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    status: row.status,
    endReason: row.end_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatHours(seconds: number) {
  return (seconds / 3600).toFixed(1);
}

function floorSeconds(milliseconds: number) {
  return Math.max(0, Math.floor(milliseconds / 1000));
}

export class DailyTaskService {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database.Database,
    options: DailyTaskServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  create(input: unknown) {
    const parsed = dailyTaskCreateSchema.parse(input);
    this.assertRequirement(parsed.requirementId ?? null);
    this.assertPlannedRange(parsed.plannedStartAt, parsed.plannedEndAt);
    const timestamp = this.now().toISOString();
    const id = this.transaction(() => {
      const sortOrder =
        parsed.sortOrder ??
        ((
          this.db
            .prepare(
              "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM daily_tasks WHERE plan_date = ? AND deleted_at IS NULL",
            )
            .get(parsed.planDate) as { next: number }
        ).next as number);
      const result = this.db
        .prepare(
          `INSERT INTO daily_tasks
            (title, description, plan_date, requirement_id, planned_start_at, planned_end_at,
             estimated_minutes, status, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          parsed.title,
          parsed.description,
          parsed.planDate,
          parsed.requirementId ?? null,
          parsed.plannedStartAt ?? null,
          parsed.plannedEndAt ?? null,
          parsed.estimatedMinutes,
          sortOrder,
          timestamp,
          timestamp,
        );
      return Number(result.lastInsertRowid);
    });
    return this.getTask(id);
  }

  update(id: number, input: unknown) {
    const parsed = dailyTaskUpdateSchema.parse(input);
    return this.transaction(() => {
      const existing = this.taskRow(id);
      if (!existing) throw new DomainError("NOT_FOUND", "任务不存在", 404);
      const active = this.activeRowForTask(id);
      if (active && parsed.status && parsed.status !== "in_progress")
        throw new DomainError(
          "CONFLICT",
          "任务正在计时，请先结束计时再修改状态",
          409,
        );
      if (!active && parsed.status === "in_progress")
        throw new DomainError("CONFLICT", "请通过开始计时进入进行中状态", 409);
      const nextRequirementId =
        parsed.requirementId === undefined
          ? existing.requirement_id
          : parsed.requirementId;
      this.assertRequirement(nextRequirementId);
      const nextStart =
        parsed.plannedStartAt === undefined
          ? existing.planned_start_at
          : parsed.plannedStartAt;
      const nextEnd =
        parsed.plannedEndAt === undefined
          ? existing.planned_end_at
          : parsed.plannedEndAt;
      this.assertPlannedRange(nextStart, nextEnd);
      const assignments: string[] = [];
      const values: unknown[] = [];
      const columns: [keyof typeof parsed, string][] = [
        ["title", "title"],
        ["description", "description"],
        ["planDate", "plan_date"],
        ["requirementId", "requirement_id"],
        ["plannedStartAt", "planned_start_at"],
        ["plannedEndAt", "planned_end_at"],
        ["estimatedMinutes", "estimated_minutes"],
        ["status", "status"],
        ["sortOrder", "sort_order"],
      ];
      for (const [key, column] of columns) {
        if (parsed[key] === undefined) continue;
        assignments.push(`${column} = ?`);
        values.push(parsed[key] ?? null);
      }
      if (!assignments.length)
        throw new DomainError("VALIDATION_ERROR", "请提交需要更新的字段");
      assignments.push("updated_at = ?");
      values.push(this.now().toISOString(), id);
      this.db
        .prepare(
          `UPDATE daily_tasks SET ${assignments.join(", ")} WHERE id = ?`,
        )
        .run(...values);
      return this.getTask(id);
    });
  }

  remove(id: number) {
    return this.transaction(() => {
      const existing = this.taskRow(id);
      if (!existing) throw new DomainError("NOT_FOUND", "任务不存在", 404);
      if (this.activeRowForTask(id))
        throw new DomainError(
          "CONFLICT",
          "任务正在计时，请先结束计时再删除",
          409,
        );
      const entryCount = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM daily_time_entries WHERE task_id = ?",
          )
          .get(id) as { count: number }
      ).count;
      if (entryCount > 0) {
        const timestamp = this.now().toISOString();
        this.db
          .prepare(
            "UPDATE daily_tasks SET deleted_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(timestamp, timestamp, id);
        return { archived: true };
      }
      this.db.prepare("DELETE FROM daily_tasks WHERE id = ?").run(id);
      return { archived: false };
    });
  }

  reorder(input: unknown) {
    const parsed = dailyTaskOrderSchema.parse(input);
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id FROM daily_tasks WHERE plan_date = ? AND deleted_at IS NULL ORDER BY sort_order, id",
        )
        .all(parsed.date) as { id: number }[];
      const current = rows.map((row) => row.id).sort((a, b) => a - b);
      const requested = [...parsed.ids].sort((a, b) => a - b);
      if (
        current.length !== requested.length ||
        current.some((id, index) => id !== requested[index])
      )
        throw new DomainError(
          "CONFLICT",
          "排序列表与当日任务不一致，请刷新后重试",
          409,
        );
      const update = this.db.prepare(
        "UPDATE daily_tasks SET sort_order = ?, updated_at = ? WHERE id = ?",
      );
      const timestamp = this.now().toISOString();
      parsed.ids.forEach((id, index) => update.run(index, timestamp, id));
      return { ok: true };
    });
  }

  listTaskEntries(taskId: number) {
    this.taskRowOrThrow(taskId);
    return (
      this.db
        .prepare(
          "SELECT * FROM daily_time_entries WHERE task_id = ? ORDER BY started_at DESC, id DESC",
        )
        .all(taskId) as TimeEntryRow[]
    ).map(toTimeEntry);
  }

  day(date?: string): DailyTaskDay {
    const now = this.now();
    this.reconcile(now);
    return this.buildDay(date ?? businessDate(now), now);
  }

  today() {
    return businessDate(this.now());
  }

  currentMonth() {
    return businessMonth(this.now());
  }

  activeState(): DailyTaskActiveState {
    const now = this.now();
    this.reconcile(now);
    return {
      today: businessDate(now),
      timezone: businessTimeZone,
      activeTimer: this.activeTimer(now),
    };
  }

  calendar(month: string): DailyTaskCalendar {
    const now = this.now();
    this.reconcile(now);
    const firstDate = `${month}-01`;
    const nextMonth = addMonths(month, 1);
    const rangeStart = businessDayStart(firstDate);
    const rangeEnd = businessDayStart(`${nextMonth}-01`);
    const taskRows = this.db
      .prepare(
        `SELECT plan_date AS plan_date,
                COUNT(*) AS task_count,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count
         FROM daily_tasks
         WHERE plan_date >= ? AND plan_date <= ? AND deleted_at IS NULL
         GROUP BY plan_date`,
      )
      .all(
        firstDate,
        `${month}-${String(daysInMonth(month)).padStart(2, "0")}`,
      ) as {
      plan_date: string;
      task_count: number;
      completed_count: number;
    }[];
    const entries = this.db
      .prepare(
        "SELECT * FROM daily_time_entries WHERE started_at >= ? AND started_at < ?",
      )
      .all(rangeStart.toISOString(), rangeEnd.toISOString()) as TimeEntryRow[];
    const byDate = new Map<
      string,
      { actualSeconds: number; hasActive: boolean }
    >();
    for (const entry of entries) {
      const date = businessDate(new Date(entry.started_at));
      const item = byDate.get(date) ?? { actualSeconds: 0, hasActive: false };
      if (entry.status === "active") {
        item.hasActive = true;
        item.actualSeconds += this.elapsedSeconds(entry, now);
      } else {
        item.actualSeconds += entry.duration_seconds;
      }
      byDate.set(date, item);
    }
    const taskByDate = new Map(taskRows.map((row) => [row.plan_date, row]));
    const days: DailyTaskCalendarDay[] = monthDates(month).map((date) => {
      const task = taskByDate.get(date);
      const entry = byDate.get(date);
      return {
        date,
        taskCount: task?.task_count ?? 0,
        completedCount: task?.completed_count ?? 0,
        actualSeconds: entry?.actualSeconds ?? 0,
        hasActive: entry?.hasActive ?? false,
      };
    });
    return {
      month,
      today: businessDate(now),
      timezone: businessTimeZone,
      days,
    };
  }

  summaryText(date: string): DailyTaskSummaryText {
    const now = this.now();
    this.reconcile(now);
    const day = this.buildDay(date, now);
    return { date, text: day.summaryText };
  }

  start(taskId: number): DailyTaskActiveState {
    const now = this.now();
    this.reconcile(now);
    this.transaction(() => {
      const task = this.taskRowOrThrow(taskId);
      const active = this.activeRow();
      if (active)
        throw new DomainError(
          "CONFLICT",
          `“${this.activeTaskTitle(active)}”正在计时，请先结束当前计时`,
          409,
        );
      const today = businessDate(now);
      if (now.getTime() >= businessDayEnd(today).getTime())
        throw new DomainError("CONFLICT", "今天 18:00 后不能开始新的计时", 409);
      const usedSeconds = this.completedSecondsForDate(today);
      if (usedSeconds >= dailyLimitSeconds)
        throw new DomainError(
          "CONFLICT",
          "今日实际工时已达 8 小时上限，不能继续计时",
          409,
        );
      const timestamp = now.toISOString();
      this.db
        .prepare(
          `INSERT INTO daily_time_entries
            (task_id, started_at, ended_at, duration_seconds, status, end_reason, created_at, updated_at)
           VALUES (?, ?, NULL, 0, 'active', NULL, ?, ?)`,
        )
        .run(task.id, timestamp, timestamp, timestamp);
      this.db
        .prepare(
          "UPDATE daily_tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .run(timestamp, task.id);
    });
    return this.activeState();
  }

  stop(taskId: number): DailyTaskActiveState {
    const now = this.now();
    this.reconcile(now);
    this.transaction(() => {
      const task = this.taskRowOrThrow(taskId);
      const active = this.activeRow();
      if (!active) return;
      if (active.task_id !== task.id)
        throw new DomainError(
          "CONFLICT",
          `“${this.activeTaskTitle(active)}”正在计时，请先结束该任务`,
          409,
        );
      const boundary = this.activeBoundary(active);
      const endedAt =
        now.getTime() >= boundary.endAt.getTime() ? boundary.endAt : now;
      this.closeEntry(active, endedAt, boundary.endReason, now);
    });
    return this.activeState();
  }

  updateTimeEntry(entryId: number, input: unknown) {
    const parsed = dailyTimeEntryUpdateSchema.parse(input);
    const now = this.now();
    return this.transaction(() => {
      const entry = this.db
        .prepare("SELECT * FROM daily_time_entries WHERE id = ?")
        .get(entryId) as TimeEntryRow | undefined;
      if (!entry) throw new DomainError("NOT_FOUND", "工时记录不存在", 404);
      if (entry.status !== "completed")
        throw new DomainError(
          "CONFLICT",
          "进行中的计时不能直接修正，请先结束计时",
          409,
        );
      const startedAt = new Date(parsed.startedAt);
      const endedAt = new Date(parsed.endedAt);
      if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime()))
        throw new DomainError("VALIDATION_ERROR", "工时时间无效");
      if (endedAt.getTime() <= startedAt.getTime())
        throw new DomainError("VALIDATION_ERROR", "结束时间必须晚于开始时间");
      const date = businessDate(startedAt);
      if (date !== businessDate(endedAt))
        throw new DomainError("VALIDATION_ERROR", "单条工时记录不能跨自然日");
      if (date !== businessDate(new Date(entry.started_at)))
        throw new DomainError("VALIDATION_ERROR", "不能把工时记录改到其他日期");
      if (endedAt.getTime() > businessDayEnd(date).getTime())
        throw new DomainError(
          "VALIDATION_ERROR",
          "工时结束时间不能晚于当天 18:00",
        );
      if (startedAt.getTime() < businessDayStart(date).getTime())
        throw new DomainError(
          "VALIDATION_ERROR",
          "工时开始时间不能早于当天 00:00",
        );
      const dayStart = businessDayStart(date).toISOString();
      const dayEnd = nextBusinessDayStart(date).toISOString();
      const others = this.db
        .prepare(
          `SELECT * FROM daily_time_entries
           WHERE status = 'completed' AND id <> ? AND started_at >= ? AND started_at < ?`,
        )
        .all(entry.id, dayStart, dayEnd) as TimeEntryRow[];
      for (const other of others) {
        const otherStart = new Date(other.started_at).getTime();
        const otherEnd = other.ended_at
          ? new Date(other.ended_at).getTime()
          : otherStart + other.duration_seconds * 1000;
        if (startedAt.getTime() < otherEnd && endedAt.getTime() > otherStart)
          throw new DomainError(
            "CONFLICT",
            "该时间区间与其他工时记录重叠",
            409,
          );
      }
      const durationSeconds = floorSeconds(
        endedAt.getTime() - startedAt.getTime(),
      );
      const usedSeconds =
        others.reduce((sum, other) => sum + other.duration_seconds, 0) +
        durationSeconds;
      if (usedSeconds > dailyLimitSeconds)
        throw new DomainError(
          "CONFLICT",
          "修正后当日实际工时将超过 8 小时上限",
          409,
        );
      const timestamp = now.toISOString();
      this.db
        .prepare(
          `UPDATE daily_time_entries
           SET started_at = ?, ended_at = ?, duration_seconds = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          startedAt.toISOString(),
          endedAt.toISOString(),
          durationSeconds,
          timestamp,
          entry.id,
        );
      this.db
        .prepare(
          `INSERT INTO daily_time_entry_audits
            (entry_id, before_started_at, before_ended_at, after_started_at, after_ended_at, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.started_at,
          entry.ended_at,
          startedAt.toISOString(),
          endedAt.toISOString(),
          parsed.reason,
          timestamp,
        );
      const updated = this.db
        .prepare("SELECT * FROM daily_time_entries WHERE id = ?")
        .get(entryId) as TimeEntryRow;
      return { entry: toTimeEntry(updated), day: this.buildDay(date, now) };
    });
  }

  /** 关闭已到 18:00 或当日 8 小时上限的活动计时；可重复调用。 */
  reconcile(now = this.now()) {
    const active = this.activeRow();
    if (!active) return [] as number[];
    const boundary = this.activeBoundary(active);
    if (now.getTime() < boundary.endAt.getTime()) return [] as number[];
    this.transaction(() => {
      // 重新读取，避免并发关闭重复写入
      const current = this.activeRow();
      if (!current || current.id !== active.id) return;
      this.closeEntry(current, boundary.endAt, boundary.endReason, now);
    });
    return [active.id];
  }

  private closeEntry(
    row: ActiveTimerRow | TimeEntryRow,
    endedAt: Date,
    reason: DailyTimeEntryEndReason,
    now: Date,
  ) {
    const startedAt = new Date(row.started_at);
    const durationSeconds = floorSeconds(
      endedAt.getTime() - startedAt.getTime(),
    );
    const timestamp = now.toISOString();
    this.db
      .prepare(
        `UPDATE daily_time_entries
         SET ended_at = ?, duration_seconds = ?, status = 'completed', end_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(endedAt.toISOString(), durationSeconds, reason, timestamp, row.id);
    this.db
      .prepare(
        "UPDATE daily_tasks SET status = 'completed', updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(timestamp, row.task_id);
  }

  private buildDay(date: string, now: Date): DailyTaskDay {
    const taskRows = this.db
      .prepare(
        `SELECT t.*, r.requirement_no AS requirement_no, r.name AS requirement_name
         FROM daily_tasks t
         LEFT JOIN requirements r ON r.id = t.requirement_id AND r.deleted_at IS NULL
         WHERE t.plan_date = ? AND t.deleted_at IS NULL
         ORDER BY t.sort_order, t.id`,
      )
      .all(date) as TaskRow[];
    const rangeStart = businessDayStart(date).toISOString();
    const rangeEnd = nextBusinessDayStart(date).toISOString();
    const entryRows = this.db
      .prepare(
        `SELECT * FROM daily_time_entries
         WHERE started_at >= ? AND started_at < ?
         ORDER BY started_at DESC, id DESC`,
      )
      .all(rangeStart, rangeEnd) as TimeEntryRow[];
    const active = this.activeRow();
    return {
      date,
      today: businessDate(now),
      timezone: businessTimeZone,
      tasks: taskRows.map((row) => this.toTask(row, entryRows, active, now)),
      stats: this.stats(taskRows, entryRows, active, now),
      activeTimer: this.toActiveTimer(active, now),
      summaryText: this.buildSummary(date, taskRows, entryRows),
    };
  }

  private toTask(
    row: TaskRow,
    allEntries: TimeEntryRow[],
    active: ActiveTimerRow | null,
    now: Date,
  ): DailyTask {
    const entries = allEntries.filter((entry) => entry.task_id === row.id);
    let actualSeconds = entries.reduce(
      (sum, entry) =>
        sum +
        (entry.status === "completed"
          ? entry.duration_seconds
          : entry.id === active?.id
            ? this.elapsedSeconds(entry, now)
            : 0),
      0,
    );
    actualSeconds = Math.min(actualSeconds, dailyLimitSeconds);
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      planDate: row.plan_date,
      requirementId: row.requirement_id,
      requirement:
        row.requirement_id !== null && row.requirement_no
          ? {
              id: row.requirement_id,
              requirementNo: row.requirement_no,
              name: row.requirement_name ?? "",
            }
          : null,
      plannedStartAt: row.planned_start_at,
      plannedEndAt: row.planned_end_at,
      estimatedMinutes: row.estimated_minutes,
      status: row.status,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      actualSeconds,
      timeEntries: entries.map(toTimeEntry),
    };
  }

  private stats(
    tasks: TaskRow[],
    entries: TimeEntryRow[],
    active: ActiveTimerRow | null,
    now: Date,
  ): DailyTaskStats {
    const plannedMinutes = tasks.reduce(
      (sum, task) => sum + task.estimated_minutes,
      0,
    );
    let actualSeconds = 0;
    for (const entry of entries) {
      if (entry.status === "completed") actualSeconds += entry.duration_seconds;
      else if (entry.id === active?.id)
        actualSeconds += this.elapsedSeconds(entry, now);
    }
    actualSeconds = Math.min(actualSeconds, dailyLimitSeconds);
    return {
      totalCount: tasks.length,
      completedCount: tasks.filter((task) => task.status === "completed")
        .length,
      plannedMinutes,
      actualSeconds,
      remainingSeconds: Math.max(0, dailyLimitSeconds - actualSeconds),
      dailyLimitSeconds,
      percent:
        plannedMinutes > 0
          ? Math.min(
              100,
              Math.floor((actualSeconds / (plannedMinutes * 60)) * 100),
            )
          : 0,
    };
  }

  private toActiveTimer(
    active: ActiveTimerRow | null,
    now: Date,
  ): ActiveDailyTimer | null {
    if (!active) return null;
    const boundary = this.activeBoundary(active);
    return {
      id: active.id,
      taskId: active.task_id,
      taskTitle: active.task_title,
      taskPlanDate: active.task_plan_date,
      startedAt: active.started_at,
      elapsedSeconds: this.elapsedSeconds(active, now),
      autoEndAt: boundary.endAt.toISOString(),
    };
  }

  private activeTimer(now: Date) {
    return this.toActiveTimer(this.activeRow(), now);
  }

  private elapsedSeconds(entry: TimeEntryRow, now: Date) {
    const startedAt = new Date(entry.started_at).getTime();
    const boundary = this.activeBoundary(entry).endAt.getTime();
    const end = Math.min(now.getTime(), boundary);
    return floorSeconds(end - startedAt);
  }

  /**
   * 活动计时的结束边界：18:00 与“当日剩余额度用完的时刻”取较早者。
   * 结束原因按先到达的边界判定。
   */
  private activeBoundary(entry: TimeEntryRow) {
    const startedAt = new Date(entry.started_at);
    const date = businessDate(startedAt);
    const dayEnd = businessDayEnd(date);
    const usedSeconds = this.completedSecondsForDate(date, entry.id);
    const limitAt = new Date(
      startedAt.getTime() + Math.max(0, dailyLimitSeconds - usedSeconds) * 1000,
    );
    const endAt = dayEnd.getTime() <= limitAt.getTime() ? dayEnd : limitAt;
    return {
      endAt: new Date(Math.max(startedAt.getTime(), endAt.getTime())),
      endReason:
        dayEnd.getTime() <= limitAt.getTime()
          ? ("auto_18_00" as const)
          : ("daily_limit" as const),
    };
  }

  private completedSecondsForDate(date: string, excludeEntryId?: number) {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(SUM(duration_seconds), 0) AS total
         FROM daily_time_entries
         WHERE status = 'completed'
           AND started_at >= ? AND started_at < ?
           AND id <> ?`,
      )
      .get(
        businessDayStart(date).toISOString(),
        nextBusinessDayStart(date).toISOString(),
        excludeEntryId ?? 0,
      ) as { total: number };
    return rows.total;
  }

  private buildSummary(
    date: string,
    tasks: TaskRow[],
    entries: TimeEntryRow[],
  ) {
    const completedByTask = new Map<number, number>();
    let actualSeconds = 0;
    for (const entry of entries)
      if (entry.status === "completed") {
        actualSeconds += entry.duration_seconds;
        completedByTask.set(
          entry.task_id,
          (completedByTask.get(entry.task_id) ?? 0) + entry.duration_seconds,
        );
      }
    const liveIds = new Set(tasks.map((task) => task.id));
    const archivedIds = [...completedByTask.keys()].filter(
      (id) => !liveIds.has(id),
    );
    const archivedTitles = new Map<number, string>();
    if (archivedIds.length) {
      const placeholders = archivedIds.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT id, title FROM daily_tasks WHERE id IN (${placeholders})`,
        )
        .all(...archivedIds) as { id: number; title: string }[];
      for (const row of rows) archivedTitles.set(row.id, row.title);
    }
    const completed: { title: string; seconds: number }[] = [];
    const unfinished: { title: string }[] = [];
    for (const task of tasks) {
      if (task.status === "completed")
        completed.push({
          title: task.title,
          seconds: completedByTask.get(task.id) ?? 0,
        });
      else unfinished.push({ title: task.title });
    }
    for (const id of archivedIds)
      completed.push({
        title: archivedTitles.get(id) ?? `已归档任务 #${id}`,
        seconds: completedByTask.get(id) ?? 0,
      });
    const lines = [`【每日工作总结】${date}`, "", "一、已完成工作"];
    if (completed.length)
      completed.forEach((item, index) =>
        lines.push(
          `${index + 1}. ${item.title}（${formatHours(item.seconds)} 小时）`,
        ),
      );
    else lines.push("（无）");
    lines.push("", "二、未完成工作");
    if (unfinished.length)
      unfinished.forEach((item, index) =>
        lines.push(`${index + 1}. ${item.title}`),
      );
    else lines.push("（无）");
    lines.push(
      "",
      "三、工时统计",
      `实际工作时长：${formatHours(actualSeconds)} 小时`,
    );
    return lines.join("\n");
  }

  private activeRow(): ActiveTimerRow | null {
    const row = this.db
      .prepare(
        `SELECT e.*, t.title AS task_title, t.plan_date AS task_plan_date
         FROM daily_time_entries e
         JOIN daily_tasks t ON t.id = e.task_id
         WHERE e.status = 'active'
         LIMIT 1`,
      )
      .get() as ActiveTimerRow | undefined;
    return row ?? null;
  }

  private activeRowForTask(taskId: number) {
    return this.db
      .prepare(
        "SELECT * FROM daily_time_entries WHERE task_id = ? AND status = 'active'",
      )
      .get(taskId) as TimeEntryRow | undefined;
  }

  private activeTaskTitle(row: TimeEntryRow) {
    const task = this.db
      .prepare("SELECT title FROM daily_tasks WHERE id = ?")
      .get(row.task_id) as { title: string } | undefined;
    return task?.title ?? "其他任务";
  }

  private taskRow(id: number) {
    return this.db
      .prepare("SELECT * FROM daily_tasks WHERE id = ? AND deleted_at IS NULL")
      .get(id) as TaskRow | undefined;
  }

  private taskRowOrThrow(id: number) {
    const row = this.taskRow(id);
    if (!row) throw new DomainError("NOT_FOUND", "任务不存在", 404);
    return row;
  }

  private getTask(id: number) {
    const row = this.db
      .prepare(
        `SELECT t.*, r.requirement_no AS requirement_no, r.name AS requirement_name
         FROM daily_tasks t
         LEFT JOIN requirements r ON r.id = t.requirement_id AND r.deleted_at IS NULL
         WHERE t.id = ? AND t.deleted_at IS NULL`,
      )
      .get(id) as TaskRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "任务不存在", 404);
    const entries = this.db
      .prepare(
        "SELECT * FROM daily_time_entries WHERE task_id = ? ORDER BY started_at DESC, id DESC",
      )
      .all(id) as TimeEntryRow[];
    return this.toTask(row, entries, this.activeRow(), this.now());
  }

  private assertRequirement(requirementId: number | null) {
    if (requirementId === null || requirementId === undefined) return;
    const row = this.db
      .prepare(
        "SELECT id FROM requirements WHERE id = ? AND deleted_at IS NULL",
      )
      .get(requirementId);
    if (!row)
      throw new DomainError("VALIDATION_ERROR", "关联需求不存在或已删除");
  }

  private assertPlannedRange(
    start: string | null | undefined,
    end: string | null | undefined,
  ) {
    if (start && end && start >= end)
      throw new DomainError("VALIDATION_ERROR", "计划结束时间必须晚于开始时间");
  }

  private transaction<T>(fn: () => T) {
    return this.db.transaction(fn).immediate();
  }
}
