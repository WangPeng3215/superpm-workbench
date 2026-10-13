import { z } from "zod";

export const requirementTypes = [
  "feature",
  "improvement",
  "bug",
  "refactor",
  "other",
] as const;
export const priorities = ["P0", "P1", "P2", "P3"] as const;
export const requirementStatuses = [
  "not_started",
  "in_progress",
  "blocked",
  "paused",
  "completed",
  "cancelled",
] as const;
export const stages = ["analysis", "design", "development", "testing"] as const;
export type Stage = (typeof stages)[number];
export type RequirementStatus = (typeof requirementStatuses)[number];
export const typeLabels: Record<(typeof requirementTypes)[number], string> = {
  feature: "新功能",
  improvement: "优化",
  bug: "Bug",
  refactor: "重构",
  other: "其他",
};
export const statusLabels: Record<RequirementStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  blocked: "阻塞",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已作废",
};
export const stageLabels: Record<Stage, string> = {
  analysis: "需求分析",
  design: "UI 设计",
  development: "开发跟进",
  testing: "需求测试",
};
export const stageDescriptions: Record<Stage, string> = {
  analysis: "澄清目标与边界，整理待确认事项、方案和分析产物。",
  design: "管理设计方案、设计稿版本和设计确认。",
  development: "记录实现进展、问题、风险与需求变更。",
  testing: "维护测试用例、执行记录与修复后的复测历史。",
};

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "无效日期");
const nullableDate = dateSchema.nullable();
export const requirementCreateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "请输入需求名称")
      .max(200, "需求名称最多 200 字"),
    type: z.enum(requirementTypes).default("feature"),
    priority: z.enum(priorities).default("P2"),
    description: z.string().max(50000, "描述最多 50000 字").default(""),
    status: z.enum(requirementStatuses).default("not_started"),
    currentStage: z.enum(stages).default("analysis"),
    parentId: z.number().int().positive().nullable().default(null),
    proposedAt: dateSchema,
    expectedAt: nullableDate.default(null),
    startedAt: nullableDate.default(null),
    completedAt: nullableDate.default(null),
    plannedReleaseAt: nullableDate.default(null),
    releasedAt: nullableDate.default(null),
  })
  .strict();
export const requirementUpdateSchema = requirementCreateSchema
  .partial()
  .extend({ stageNote: z.string().trim().max(2000).optional() })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "stageNote"),
    "请提交需要更新的字段",
  );
export const requirementListSchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    type: z.enum(requirementTypes).optional(),
    priority: z.enum(priorities).optional(),
    status: z.enum(requirementStatuses).optional(),
    currentStage: z.enum(stages).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z
      .enum([
        "requirementNo",
        "name",
        "priority",
        "status",
        "type",
        "currentStage",
        "proposedAt",
        "expectedAt",
        "updatedAt",
      ])
      .default("updatedAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();
export type RequirementCreate = z.input<typeof requirementCreateSchema>;
export type RequirementCreateParsed = z.output<typeof requirementCreateSchema>;
export type RequirementUpdate = z.input<typeof requirementUpdateSchema>;
export type RequirementListQuery = z.input<typeof requirementListSchema>;
export type RequirementListParsed = z.output<typeof requirementListSchema>;

export interface Requirement extends RequirementCreateParsed {
  id: number;
  requirementNo: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface RequirementTree extends Requirement {
  children: Requirement[];
}
export interface RequirementListResult {
  items: RequirementTree[];
  total: number;
  page: number;
  pageSize: number;
  matchedCount: number;
}
export interface StageHistory {
  id: number;
  requirementId: number;
  fromStage: Stage;
  toStage: Stage;
  actor: string;
  note: string;
  createdAt: string;
}
export interface SystemInfo {
  version: string;
  databasePath: string;
  workspacePath: string;
  schemaVersion: number;
  modules: { key: string; name: string; status: "available" | "planned" }[];
}
export interface ApiErrorResponse {
  error: { code: string; message: string; details?: unknown };
}
