import { z } from "zod";

export const onlineToolCategories = [
  "diagram",
  "mindmap",
  "document",
  "productivity",
  "other",
] as const;
export type OnlineToolCategory = (typeof onlineToolCategories)[number];
export const onlineToolCategoryLabels: Record<OnlineToolCategory, string> = {
  diagram: "绘图",
  mindmap: "思维导图",
  document: "文档",
  productivity: "效率",
  other: "其他",
};

// 图标只能取内置 key，不接受用户上传 SVG 或脚本，渲染端按白名单映射组件。
export const onlineToolIconKeys = [
  "tool",
  "diagram",
  "mindmap",
  "document",
  "markdown",
  "table",
  "code",
  "api",
  "thunder",
  "cloud",
  "experiment",
  "compass",
] as const;
export type OnlineToolIconKey = (typeof onlineToolIconKeys)[number];
export const onlineToolIconLabels: Record<OnlineToolIconKey, string> = {
  tool: "工具箱",
  diagram: "流程图",
  mindmap: "思维导图",
  document: "文档",
  markdown: "Markdown",
  table: "表格",
  code: "代码",
  api: "接口",
  thunder: "效率",
  cloud: "云端",
  experiment: "实验",
  compass: "导航",
};

export const onlineToolNameMaxLength = 50;
export const onlineToolDescriptionMaxLength = 120;
export const onlineToolUrlMaxLength = 2048;

/** 仅允许 http/https 且带主机名的地址，拒绝 javascript:/data:/file: 等协议。 */
export function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

/** 取出域名用于识别目标站点；解析失败时回退原值。 */
export function onlineToolHost(value: string): string {
  try {
    return new URL(value.trim()).host;
  } catch {
    return value;
  }
}

const nameSchema = z
  .string()
  .trim()
  .min(1, "请输入工具名称")
  .max(onlineToolNameMaxLength, `工具名称最多 ${onlineToolNameMaxLength} 字`);
const urlSchema = z
  .string()
  .trim()
  .min(1, "请输入工具网址")
  .max(onlineToolUrlMaxLength, "工具网址过长")
  .refine(isAllowedExternalUrl, "请输入以 http:// 或 https:// 开头的有效网址");
const iconSchema = z.enum(onlineToolIconKeys).nullable();
const categorySchema = z.enum(onlineToolCategories);
const descriptionSchema = z
  .string()
  .trim()
  .max(
    onlineToolDescriptionMaxLength,
    `工具简介最多 ${onlineToolDescriptionMaxLength} 字`,
  );

export const onlineToolCreateSchema = z
  .object({
    name: nameSchema,
    url: urlSchema,
    icon: iconSchema.default(null),
    category: categorySchema,
    description: descriptionSchema.default(""),
    enabled: z.boolean().default(true),
    isFavorite: z.boolean().default(false),
  })
  .strict();

export const onlineToolUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    url: urlSchema.optional(),
    icon: iconSchema.optional(),
    category: categorySchema.optional(),
    description: descriptionSchema.optional(),
    enabled: z.boolean().optional(),
    isFavorite: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "请提交需要更新的字段");

export const onlineToolOrderSchema = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
  })
  .strict()
  .refine(
    (value) => new Set(value.ids).size === value.ids.length,
    "排序列表包含重复工具",
  );

export type OnlineToolCreate = z.input<typeof onlineToolCreateSchema>;
export type OnlineToolCreateParsed = z.output<typeof onlineToolCreateSchema>;
export type OnlineToolUpdate = z.input<typeof onlineToolUpdateSchema>;
export type OnlineToolUpdateParsed = z.output<typeof onlineToolUpdateSchema>;

export interface OnlineTool {
  id: number;
  name: string;
  url: string;
  icon: OnlineToolIconKey | null;
  category: OnlineToolCategory;
  description: string;
  enabled: boolean;
  isFavorite: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
