import { z } from "zod";

export const dailyTaskStatuses = [
  "pending",
  "in_progress",
  "completed",
] as const;
export type DailyTaskStatus = (typeof dailyTaskStatuses)[number];

export const dailyTaskStatusLabels: Record<DailyTaskStatus, string> = {
  pending: "待开始",
  in_progress: "进行中",
  completed: "已完成",
};

export const dailyTimeEntryStatuses = ["active", "completed"] as const;
export type DailyTimeEntryStatus = (typeof dailyTimeEntryStatuses)[number];

export const dailyTimeEntryEndReasons = [
  "manual",
  "auto_18_00",
  "daily_limit",
] as const;
export type DailyTimeEntryEndReason = (typeof dailyTimeEntryEndReasons)[number];

export const dailyTimeEntryEndReasonLabels: Record<
  DailyTimeEntryEndReason,
  string
> = {
  manual: "手动结束",
  auto_18_00: "18:00 自动结束",
  daily_limit: "达到每日 8 小时上限",
};

/** 业务日结束时间；当天此后不再允许开始计时。 */
export const dailyBusinessEndHour = 18;
/** 每日最多记录的实际工时（秒）。 */
export const dailyLimitSeconds = 8 * 60 * 60;
/** 预计工时最小增量（分钟）。 */
export const dailyEstimatedMinuteStep = 30;
/** 预计工时输入范围（分钟）。 */
export const dailyEstimatedMinuteMin = 30;
export const dailyEstimatedMinuteMax = 8 * 60;

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidCalendarDate(value: string) {
  if (!datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const dailyDateSchema = z
  .string()
  .trim()
  .refine(isValidCalendarDate, "日期格式应为 YYYY-MM-DD");

export const dailyMonthSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "月份格式应为 YYYY-MM");

export const dailyTimeSchema = z
  .string()
  .regex(timePattern, "时间格式应为 HH:mm");

const plannedRangeRefinement = (value: {
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
}) =>
  !value.plannedStartAt ||
  !value.plannedEndAt ||
  value.plannedStartAt < value.plannedEndAt;

const dailyTaskBaseSchema = z
  .object({
    title: z.string().trim().min(1, "请输入任务名称").max(200),
    description: z.string().max(4000).default(""),
    planDate: dailyDateSchema,
    requirementId: z.number().int().positive().nullable().optional(),
    plannedStartAt: dailyTimeSchema.nullable().optional(),
    plannedEndAt: dailyTimeSchema.nullable().optional(),
    estimatedMinutes: z
      .number()
      .int()
      .min(dailyEstimatedMinuteMin, "预计耗时至少 0.5 小时")
      .max(dailyEstimatedMinuteMax, "预计耗时最多 8 小时")
      .refine(
        (value) => value % dailyEstimatedMinuteStep === 0,
        "预计耗时需为 0.5 小时的倍数",
      ),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const dailyTaskCreateSchema = dailyTaskBaseSchema.refine(
  plannedRangeRefinement,
  { message: "计划结束时间必须晚于开始时间", path: ["plannedEndAt"] },
);
export const dailyTaskUpdateSchema = dailyTaskBaseSchema
  .partial()
  .extend({ status: z.enum(dailyTaskStatuses).optional() })
  .refine((value) => Object.keys(value).length > 0, "请提交需要更新的字段")
  .refine(plannedRangeRefinement, {
    message: "计划结束时间必须晚于开始时间",
    path: ["plannedEndAt"],
  });

export const dailyTaskOrderSchema = z
  .object({
    date: dailyDateSchema,
    ids: z.array(z.number().int().positive()).min(1).max(500),
  })
  .strict();

export const dailyTimeEntryUpdateSchema = z
  .object({
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
    reason: z.string().trim().max(200).default(""),
  })
  .strict();

export type DailyTaskCreate = z.input<typeof dailyTaskCreateSchema>;
export type DailyTaskCreateParsed = z.output<typeof dailyTaskCreateSchema>;
export type DailyTaskUpdate = z.input<typeof dailyTaskUpdateSchema>;
export type DailyTaskUpdateParsed = z.output<typeof dailyTaskUpdateSchema>;

export interface DailyTaskRequirementRef {
  id: number;
  requirementNo: string;
  name: string;
}

export interface DailyTimeEntry {
  id: number;
  taskId: number;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  status: DailyTimeEntryStatus;
  endReason: DailyTimeEntryEndReason | null;
  createdAt: string;
  updatedAt: string;
}

export interface DailyTask {
  id: number;
  title: string;
  description: string;
  planDate: string;
  requirementId: number | null;
  requirement: DailyTaskRequirementRef | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  estimatedMinutes: number;
  status: DailyTaskStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  actualSeconds: number;
  timeEntries: DailyTimeEntry[];
}

export interface DailyTaskStats {
  totalCount: number;
  completedCount: number;
  plannedMinutes: number;
  actualSeconds: number;
  remainingSeconds: number;
  dailyLimitSeconds: number;
  percent: number;
}

export interface ActiveDailyTimer {
  id: number;
  taskId: number;
  taskTitle: string;
  taskPlanDate: string;
  startedAt: string;
  elapsedSeconds: number;
  /** 18:00 或达到当日 8 小时额度的较早时刻，到达后由后端自动结束。 */
  autoEndAt: string;
}

export interface DailyTaskDay {
  date: string;
  today: string;
  timezone: string;
  tasks: DailyTask[];
  stats: DailyTaskStats;
  activeTimer: ActiveDailyTimer | null;
  summaryText: string;
}

export interface DailyTaskCalendarDay {
  date: string;
  taskCount: number;
  completedCount: number;
  actualSeconds: number;
  hasActive: boolean;
}

export interface DailyTaskCalendar {
  month: string;
  today: string;
  timezone: string;
  days: DailyTaskCalendarDay[];
}

export interface DailyTaskActiveState {
  today: string;
  timezone: string;
  activeTimer: ActiveDailyTimer | null;
}

export interface DailyTaskSummaryText {
  date: string;
  text: string;
}

export interface DailyTaskRef {
  id: number;
  title: string;
}
