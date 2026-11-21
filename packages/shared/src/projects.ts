import { z } from "zod";
import { dateSchema } from "./dates.js";

export const projectStatuses = [
  "planning",
  "active",
  "awaiting_acceptance",
  "closed",
  "paused",
  "cancelled",
] as const;
export type ProjectStatus = (typeof projectStatuses)[number];
export const projectStatusLabels: Record<ProjectStatus, string> = {
  planning: "筹备中",
  active: "进行中",
  awaiting_acceptance: "待验收",
  closed: "已结项",
  paused: "已暂停",
  cancelled: "已取消",
};

export const projectRoles = [
  "owner",
  "product_owner",
  "contributor",
  "viewer",
] as const;
export type ProjectRole = (typeof projectRoles)[number];
export const projectRoleLabels: Record<ProjectRole, string> = {
  owner: "项目负责人",
  product_owner: "产品负责人",
  contributor: "执行成员",
  viewer: "只读成员",
};

export const projectVersionSchema = z.number().int().positive();
const projectFieldsSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "请输入项目名称")
      .max(200, "项目名称最多 200 字"),
    goal: z.string().max(5000).default(""),
    scopeSummary: z.string().max(5000).default(""),
    customerName: z.string().trim().max(200).default(""),
    customerContact: z.string().trim().max(2000).default(""),
    plannedStartDate: dateSchema.nullable().default(null),
    targetDeliveryDate: dateSchema.nullable().default(null),
  })
  .strict();

function checkDateOrder(
  value: {
    plannedStartDate?: string | null;
    targetDeliveryDate?: string | null;
  },
  context: z.RefinementCtx,
) {
  if (
    value.plannedStartDate &&
    value.targetDeliveryDate &&
    value.targetDeliveryDate < value.plannedStartDate
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetDeliveryDate"],
      message: "目标交付日不能早于计划开始日",
    });
  }
}

export const projectCreateSchema =
  projectFieldsSchema.superRefine(checkDateOrder);
export const projectUpdateSchema = projectFieldsSchema
  .partial()
  .extend({
    expectedVersion: projectVersionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    checkDateOrder(value, context);
    if (!Object.keys(value).some((key) => key !== "expectedVersion")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "请提交需要更新的字段",
      });
    }
  });
export type ProjectCreate = z.input<typeof projectCreateSchema>;
export type ProjectCreateParsed = z.output<typeof projectCreateSchema>;
export type ProjectUpdate = z.input<typeof projectUpdateSchema>;

const memberRolesSchema = z
  .array(z.enum(projectRoles))
  .min(1)
  .max(4)
  .refine((roles) => new Set(roles).size === roles.length, "角色不能重复");
export const projectTaskResponsibilityTransferSchema = z
  .object({
    taskId: z.number().int().positive(),
    expectedVersion: projectVersionSchema,
    assigneeUserId: z.number().int().positive().optional(),
    confirmerUserId: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.assigneeUserId === undefined &&
      value.confirmerUserId === undefined
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "请至少指定一项需要移交的任务责任",
      });
  });
export type ProjectTaskResponsibilityTransfer = z.input<
  typeof projectTaskResponsibilityTransferSchema
>;
const taskTransfersSchema = z.array(projectTaskResponsibilityTransferSchema);
export const projectMemberWriteSchema = z
  .object({
    userId: z.number().int().positive(),
    roles: memberRolesSchema,
    expectedVersion: projectVersionSchema,
    taskTransfers: taskTransfersSchema.optional(),
  })
  .strict();
export type ProjectMemberWrite = z.input<typeof projectMemberWriteSchema>;
export const projectMemberRemoveSchema = z
  .object({
    expectedVersion: projectVersionSchema,
    taskTransfers: taskTransfersSchema.optional(),
  })
  .strict();
export type ProjectMemberRemove = z.input<typeof projectMemberRemoveSchema>;

export const projectLeadsUpdateSchema = z
  .object({
    ownerUserId: z.number().int().positive(),
    productOwnerUserId: z.number().int().positive(),
    expectedVersion: projectVersionSchema,
  })
  .strict();
export type ProjectLeadsUpdate = z.input<typeof projectLeadsUpdateSchema>;

export const projectLifecycleActions = [
  "start",
  "pause",
  "resume",
  "cancel",
  "submit_acceptance",
  "close",
  "reopen",
] as const;
export type ProjectLifecycleAction = (typeof projectLifecycleActions)[number];
const actionsRequiringReason: ReadonlySet<ProjectLifecycleAction> = new Set([
  "pause",
  "resume",
  "cancel",
  "close",
  "reopen",
]);
export const projectLifecycleSchema = z
  .object({
    action: z.enum(projectLifecycleActions),
    expectedVersion: projectVersionSchema,
    reason: z.string().trim().max(2000).default(""),
  })
  .strict()
  .superRefine((value, context) => {
    if (actionsRequiringReason.has(value.action) && !value.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "请填写操作原因或结论",
      });
    }
  });
export type ProjectLifecycleInput = z.input<typeof projectLifecycleSchema>;

export const projectArchiveSchema = z
  .object({
    archived: z.boolean(),
    expectedVersion: projectVersionSchema,
  })
  .strict();
export type ProjectArchiveInput = z.input<typeof projectArchiveSchema>;

export const projectListSchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    view: z.enum(["all", "owned", "participating", "archived"]).default("all"),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z
      .enum([
        "projectNo",
        "name",
        "targetDeliveryDate",
        "createdAt",
        "updatedAt",
      ])
      .default("updatedAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();
export type ProjectListQuery = z.input<typeof projectListSchema>;
export type ProjectListParsed = z.output<typeof projectListSchema>;

export interface Project extends ProjectCreateParsed {
  id: number;
  projectNo: string;
  ownerUserId: number;
  productOwnerUserId: number;
  status: ProjectStatus;
  previousStatus: ProjectStatus | null;
  version: number;
  archivedAt: string | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  projectId: number;
  userId: number;
  username: string;
  displayName: string;
  roles: ProjectRole[];
  status: "active" | "removed";
  accountStatus: "active" | "disabled";
  joinedAt: string;
  removedAt: string | null;
}

export interface ProjectCapabilities {
  canEditProject: boolean;
  canManageMembers: boolean;
  canManageRequirements: boolean;
  canManageProjectTasks: boolean;
  canPrepareDelivery: boolean;
  canConfirmScope: boolean;
  canCloseProject: boolean;
}

export interface ProjectDetail {
  project: Project;
  members: ProjectMember[];
  capabilities: ProjectCapabilities;
}

export interface ProjectOverview {
  project: Project;
  requirements: {
    total: number;
    byStatus: Record<string, number>;
    completed: number;
    blocked: number;
  };
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    pending: number;
    blocked: number;
    overdue: number;
  };
  deliveries: {
    total: number;
    byStatus: Record<string, number>;
    active: number;
    awaitingAcceptance: number;
  };
  deliveryScope: {
    state: "unconfirmed" | "empty" | "confirmed";
    total: number | null;
    executionCompleted: number | null;
    executionPercent: number | null;
    accepted: number | null;
    acceptancePercent: number | null;
    failed: number | null;
    unconfirmedDeliveries: number;
  };
  risks: {
    items: {
      key: string;
      kind: "requirement" | "task" | "delivery";
      id: number;
      title: string;
      reasons: ("blocked" | "overdue" | "failed_acceptance" | "blocking_issue" | "scope_follow_up")[];
    }[];
    blockedRequirements: number[];
    blockedTasks: number[];
    overdueTasks: number[];
    failedDeliveries: number[];
    overdueDeliveries: number[];
  };
  myActions: {
    items: {
      id: number;
      kind: "task" | "delivery";
      action: "submit" | "confirm" | "accept" | "confirm_scope";
      title: string;
      dueDate?: string | null;
    }[];
  };
  recentEvents: {
    id: number;
    action: string;
    actorNameSnapshot: string;
    createdAt: string;
    payload: Record<string, unknown>;
  }[];
}

export interface ProjectListResult {
  items: Project[];
  total: number;
  page: number;
  pageSize: number;
}
