import { z } from "zod";

export const noteTypes = ["inspiration", "work_memo"] as const;
export type NoteType = (typeof noteTypes)[number];
export const noteTypeLabels: Record<NoteType, string> = {
  inspiration: "灵感",
  work_memo: "工作备忘",
};

export const noteColors = [
  "yellow",
  "pink",
  "blue",
  "green",
  "purple",
  "slate",
] as const;
export type NoteColor = (typeof noteColors)[number];
export const noteColorLabels: Record<NoteColor, string> = {
  yellow: "暖黄",
  pink: "浅粉",
  blue: "雾蓝",
  green: "薄荷",
  purple: "淡紫",
  slate: "云灰",
};

export const noteTitleMaxLength = 120;
export const noteContentMaxLength = 20_000;

const titleSchema = z
  .string()
  .max(noteTitleMaxLength, `便签标题最多 ${noteTitleMaxLength} 字`);
const contentSchema = z
  .string()
  .max(noteContentMaxLength, "便签内容过长，最多 20000 字");

export const noteTitleSchema = titleSchema;
export const noteContentSchema = contentSchema;
export const noteTypeSchema = z.enum(noteTypes);
export const noteColorSchema = z.enum(noteColors);

const queryBoolean = z
  .union([
    z.boolean(),
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ])
  .default(false);

export const noteListSchema = z.object({ archived: queryBoolean }).strict();

export const noteCreateFields = {
  title: titleSchema.default(""),
  content: contentSchema.default(""),
  type: noteTypeSchema.default("inspiration"),
  color: noteColorSchema.default("yellow"),
  isPinned: z.boolean().default(false),
};
export const noteUpdateFields = {
  title: titleSchema.optional(),
  content: contentSchema.optional(),
  type: noteTypeSchema.optional(),
  color: noteColorSchema.optional(),
  isPinned: z.boolean().optional(),
  isArchived: z.boolean().optional(),
};

export const noteCreateSchema = z.object(noteCreateFields).strict();

export const noteUpdateSchema = z
  .object(noteUpdateFields)
  .strict()
  .refine((value) => Object.keys(value).length > 0, "请提交需要更新的字段");

export const noteArchivedFilterSchema = z
  .union([z.boolean(), z.literal("all")], {
    errorMap: () => ({ message: "归档筛选只能是 true、false 或 all" }),
  })
  .default(false);

export const noteQuerySchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    type: noteTypeSchema.optional(),
    isPinned: z.boolean().optional(),
    isArchived: noteArchivedFilterSchema,
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const noteSearchSchema = noteQuerySchema.extend({
  q: z.string().trim().min(1, "请输入搜索关键词").max(200),
});

export type NoteCreate = z.input<typeof noteCreateSchema>;
export type NoteCreateParsed = z.output<typeof noteCreateSchema>;
export type NoteUpdate = z.input<typeof noteUpdateSchema>;
export type NoteUpdateParsed = z.output<typeof noteUpdateSchema>;
export type NoteQuery = z.input<typeof noteQuerySchema>;
export type NoteQueryParsed = z.output<typeof noteQuerySchema>;
export type NoteSearch = z.input<typeof noteSearchSchema>;
export type NoteSearchParsed = z.output<typeof noteSearchSchema>;
export type NoteArchivedFilter = z.output<typeof noteArchivedFilterSchema>;

/** 转任务后回填的目标任务；exists=false 表示任务已被删除，可再次转换。 */
export interface NoteConvertedTask {
  id: number;
  title: string;
  planDate: string;
  exists: boolean;
}

export interface Note {
  id: number;
  title: string;
  content: string;
  type: NoteType;
  color: NoteColor;
  isPinned: boolean;
  isArchived: boolean;
  convertedTaskId: number | null;
  convertedTask: NoteConvertedTask | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** 列表投影：不返回完整正文，只带截断预览与正文长度。 */
export interface NoteSummary {
  id: number;
  title: string;
  preview: string;
  contentLength: number;
  type: NoteType;
  color: NoteColor;
  isPinned: boolean;
  isArchived: boolean;
  convertedTaskId: number | null;
  convertedTask: NoteConvertedTask | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface NoteConvertResult {
  note: Note;
  task: { id: number; title: string; planDate: string };
  created: boolean;
}

export interface NoteQueryResult {
  items: NoteSummary[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
