import { z } from "zod";
import { dailyDateSchema, dailyEstimatedMinuteMax, dailyEstimatedMinuteMin, dailyTimeSchema } from "./daily-tasks.js";
import { dateSchema } from "./dates.js";

export const projectTaskTypes = ["design", "development", "testing", "deployment", "other"] as const;
export type ProjectTaskType = (typeof projectTaskTypes)[number];
export const projectTaskStatuses = ["pending", "in_progress", "pending_confirmation", "completed", "blocked", "cancelled"] as const;
export type ProjectTaskStatus = (typeof projectTaskStatuses)[number];
export const projectTaskActions = ["start", "block", "resume", "submit", "approve", "return", "cancel", "reopen"] as const;
export type ProjectTaskAction = (typeof projectTaskActions)[number];
export const projectTaskEvidenceKinds = ["external_link", "artifact_node", "requirement_file"] as const;
export type ProjectTaskEvidenceKind = (typeof projectTaskEvidenceKinds)[number];
const positiveId = z.number().int().positive();
const taskVersionSchema = z.number().int().positive();

const projectTaskEvidenceBaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("external_link"), url: z.string().trim().url().max(2048), label: z.string().trim().max(200).optional() }).strict(),
  z.object({ kind: z.literal("artifact_node"), id: positiveId }).strict(),
  z.object({ kind: z.literal("requirement_file"), id: positiveId }).strict(),
]);
export const projectTaskEvidenceSchema = projectTaskEvidenceBaseSchema.superRefine((value, ctx) => {
  if (value.kind !== "external_link") return;
  const parsed = new URL(value.url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "仅支持 HTTP 或 HTTPS 链接" });
  if (parsed.username || parsed.password) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "链接不能包含账号凭据" });
});
export type ProjectTaskEvidence = z.infer<typeof projectTaskEvidenceSchema>;

export const projectTaskCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  type: z.enum(projectTaskTypes),
  assigneeUserId: positiveId,
  confirmerUserId: positiveId,
  requirementId: positiveId.optional(),
  dueDate: dateSchema.nullable().default(null),
}).strict();
export type ProjectTaskCreate = z.input<typeof projectTaskCreateSchema>;

export const projectTaskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  type: z.enum(projectTaskTypes).optional(),
  assigneeUserId: positiveId.optional(),
  confirmerUserId: positiveId.optional(),
  requirementId: positiveId.nullable().optional(),
  dueDate: dateSchema.nullable().optional(),
  expectedVersion: taskVersionSchema,
}).strict().superRefine((value, ctx) => {
  if (!Object.keys(value).some((key) => key !== "expectedVersion")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "请提交需要更新的字段" });
});
export type ProjectTaskUpdate = z.input<typeof projectTaskUpdateSchema>;

export const projectTaskActionSchema = z.object({
  action: z.enum(projectTaskActions),
  expectedVersion: taskVersionSchema,
  reason: z.string().trim().max(2000).optional(),
  summary: z.string().trim().max(8000).optional(),
  evidence: z.array(projectTaskEvidenceSchema).max(50).optional(),
}).strict().superRefine((value, ctx) => {
  if (["block", "return", "cancel", "reopen"].includes(value.action) && !value.reason?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "此操作需要填写原因" });
  if (value.action === "submit" && !value.summary?.trim() && !value.evidence?.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "提交时请填写处理说明或添加产物" });
  if (value.action !== "submit" && (value.summary !== undefined || value.evidence !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "此操作不接受提交内容" });
});
export type ProjectTaskActionInput = z.input<typeof projectTaskActionSchema>;

export const projectTaskListSchema = z.object({
  assigneeUserId: z.coerce.number().int().positive().optional(),
  confirmerUserId: z.coerce.number().int().positive().optional(),
  requirementId: z.coerce.number().int().positive().optional(),
  status: z.enum(projectTaskStatuses).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ProjectTaskListQuery = z.input<typeof projectTaskListSchema>;

export const projectTaskDailyPlanSchema = z.object({
  date: dailyDateSchema,
  expectedVersion: taskVersionSchema,
  plannedStartAt: dailyTimeSchema.nullable().optional(),
  plannedEndAt: dailyTimeSchema.nullable().optional(),
  estimatedMinutes: z.number().int().min(dailyEstimatedMinuteMin).max(dailyEstimatedMinuteMax).default(dailyEstimatedMinuteMin),
}).strict().superRefine((value, ctx) => {
  if (value.plannedStartAt && value.plannedEndAt && value.plannedStartAt >= value.plannedEndAt) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "结束时间必须晚于开始时间" });
  if (Boolean(value.plannedStartAt) !== Boolean(value.plannedEndAt)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "请同时填写开始与结束时间" });
});
export type ProjectTaskDailyPlanInput = z.input<typeof projectTaskDailyPlanSchema>;

export interface ProjectTaskCapabilities {
  canEdit: boolean;
  canPlan: boolean;
  actions: ProjectTaskAction[];
}
export type ProjectTaskEvidenceReference = ProjectTaskEvidence & { displayName: string };
export interface ProjectTaskReview {
  id: number;
  reviewerUserId: number;
  result: "approved" | "returned";
  reason: string;
  createdAt: string;
}
export interface ProjectTaskSubmission {
  id: number;
  submittedBy: number;
  summary: string;
  evidence: ProjectTaskEvidenceReference[];
  createdAt: string;
  review: ProjectTaskReview | null;
}
export interface ProjectTaskActionRecord {
  id: number;
  action: ProjectTaskAction | "created" | "edit";
  actorUserId: number;
  actorNameSnapshot: string;
  reason: string;
  changes?: Record<string, unknown>;
  createdAt: string;
}
export interface ProjectTask {
  id: number;
  projectId: number;
  requirementId: number | null;
  title: string;
  description: string;
  type: ProjectTaskType;
  assigneeUserId: number;
  confirmerUserId: number;
  dueDate: string | null;
  status: ProjectTaskStatus;
  previousStatus: ProjectTaskStatus | null;
  version: number;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  capabilities: ProjectTaskCapabilities;
}
export interface ProjectTaskDetail extends ProjectTask {
  submissions: ProjectTaskSubmission[];
  actions: ProjectTaskActionRecord[];
}
export interface ProjectTaskList {
  items: ProjectTask[];
  total: number;
  canCreate: boolean;
}
