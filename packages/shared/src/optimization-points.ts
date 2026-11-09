import { z } from "zod";

/**
 * 优化点（产品优化机会）：
 * 与正式需求是两个独立实体，先轻量记录、再评估筛选，评估通过后转为正式需求。
 * 只维护当前状态，不记录状态变更历史；所属模块为自由文本，不建立模块字典。
 */
export const optimizationPointStatuses = [
  "pending",
  "evaluating",
  "postponed",
  "rejected",
  "converted",
] as const;
export type OptimizationPointStatus =
  (typeof optimizationPointStatuses)[number];
export const optimizationPointStatusLabels: Record<
  OptimizationPointStatus,
  string
> = {
  pending: "待评估",
  evaluating: "评估中",
  postponed: "暂缓",
  rejected: "不采纳",
  converted: "已转正式需求",
};
// 可人工调整的状态：converted 只能由「转为正式需求」产生，不允许手工设置
export const editableOptimizationPointStatuses = [
  "pending",
  "evaluating",
  "postponed",
  "rejected",
] as const;

export const optimizationPointNameMaxLength = 200;
export const optimizationPointModuleMaxLength = 100;
// 正文（问题描述与优化思路合并）：与正式需求描述同一形态——富文本 HTML + 纯文本投影
export const optimizationPointDescriptionMaxLength = 50_000;
export const optimizationPointDescriptionHtmlMaxLength = 200_000;
export const optimizationPointRemarkMaxLength = 5_000;

const optimizationPointNameSchema = z
  .string()
  .trim()
  .min(1, "请输入优化点名称")
  .max(
    optimizationPointNameMaxLength,
    `优化点名称最多 ${optimizationPointNameMaxLength} 字`,
  );
// 所属模块为手工填写的自由文本，允许为空
const optimizationPointModuleSchema = z
  .string()
  .trim()
  .max(
    optimizationPointModuleMaxLength,
    `所属模块最多 ${optimizationPointModuleMaxLength} 字`,
  )
  .default("");
const optimizationPointDescriptionSchema = z
  .string()
  .trim()
  .min(1, "请填写优化点内容")
  .max(
    optimizationPointDescriptionMaxLength,
    `优化点内容最多 ${optimizationPointDescriptionMaxLength} 字`,
  );
// 正文的富文本版本：与 Markdown 同源，用于需求详情原样继承
const optimizationPointDescriptionHtmlSchema = z
  .string()
  .max(optimizationPointDescriptionHtmlMaxLength)
  .default("");
const optimizationPointRemarkSchema = z
  .string()
  .trim()
  .max(
    optimizationPointRemarkMaxLength,
    `备注最多 ${optimizationPointRemarkMaxLength} 字`,
  )
  .default("");

export const optimizationPointCreateSchema = z
  .object({
    name: optimizationPointNameSchema,
    module: optimizationPointModuleSchema,
    description: optimizationPointDescriptionSchema,
    descriptionHtml: optimizationPointDescriptionHtmlSchema,
    remark: optimizationPointRemarkSchema,
  })
  .strict();

// 状态由服务层校验流转规则（不可手工设为 converted）
export const optimizationPointUpdateSchema = z
  .object({
    name: optimizationPointNameSchema.optional(),
    module: optimizationPointModuleSchema.optional(),
    description: optimizationPointDescriptionSchema.optional(),
    descriptionHtml: optimizationPointDescriptionHtmlSchema.optional(),
    remark: optimizationPointRemarkSchema.optional(),
    status: z.enum(optimizationPointStatuses).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "请提交需要更新的字段");

export const optimizationPointListSchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    status: z.enum(optimizationPointStatuses).optional(),
  })
  .strict();

// 转换时允许确认需求名称；正文默认整段继承优化点内容，也可显式覆盖
export const optimizationPointConvertSchema = z
  .object({
    name: optimizationPointNameSchema.optional(),
    description: optimizationPointDescriptionSchema.optional(),
    descriptionHtml: optimizationPointDescriptionHtmlSchema.optional(),
  })
  .strict();

export type OptimizationPointCreate = z.input<
  typeof optimizationPointCreateSchema
>;
export type OptimizationPointCreateParsed = z.output<
  typeof optimizationPointCreateSchema
>;
export type OptimizationPointUpdate = z.input<
  typeof optimizationPointUpdateSchema
>;
export type OptimizationPointListQuery = z.input<
  typeof optimizationPointListSchema
>;
export type OptimizationPointListParsed = z.output<
  typeof optimizationPointListSchema
>;
export type OptimizationPointConvert = z.input<
  typeof optimizationPointConvertSchema
>;

// 关联的正式需求（已软删除时 exists=false，前端提示「关联需求已删除」）
export interface OptimizationPointRequirementRef {
  id: number;
  requirementNo: string;
  name: string;
  exists: boolean;
}

export interface OptimizationPointSummary {
  id: number;
  name: string;
  // 所属模块：自由文本，可为空字符串
  module: string;
  status: OptimizationPointStatus;
  requirement: OptimizationPointRequirementRef | null;
  // 问题描述摘要：列表展示用，避免把整段文本传给列表接口
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface OptimizationPoint extends OptimizationPointSummary {
  // 正文纯文本投影（编辑器 getText 结果）：用于搜索、摘要与无 HTML 时的回退
  description: string;
  // 正文富文本 HTML：页面渲染与转正式需求时的需求详情
  descriptionHtml: string;
  remark: string;
}

// 转换结果：workspaceReady=false 表示需求已建立但物理目录初始化失败，可在需求详情重试
export interface OptimizationPointConversion {
  point: OptimizationPoint;
  requirement: {
    id: number;
    requirementNo: string;
    name: string;
    workspaceReady: boolean;
  };
}

// 正式需求详情反查：来源优化点
export interface RequirementOptimizationPointRef {
  id: number;
  name: string;
  module: string;
  status: OptimizationPointStatus;
}
