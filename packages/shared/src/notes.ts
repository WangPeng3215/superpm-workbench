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

const queryBoolean = z
  .union([
    z.boolean(),
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ])
  .default(false);

export const noteListSchema = z.object({ archived: queryBoolean }).strict();

export const noteCreateSchema = z
  .object({
    title: titleSchema.default(""),
    content: contentSchema.default(""),
    type: z.enum(noteTypes).default("inspiration"),
    color: z.enum(noteColors).default("yellow"),
    isPinned: z.boolean().default(false),
  })
  .strict();

export const noteUpdateSchema = z
  .object({
    title: titleSchema.optional(),
    content: contentSchema.optional(),
    type: z.enum(noteTypes).optional(),
    color: z.enum(noteColors).optional(),
    isPinned: z.boolean().optional(),
    isArchived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "请提交需要更新的字段");

export type NoteCreate = z.input<typeof noteCreateSchema>;
export type NoteCreateParsed = z.output<typeof noteCreateSchema>;
export type NoteUpdate = z.input<typeof noteUpdateSchema>;
export type NoteUpdateParsed = z.output<typeof noteUpdateSchema>;

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

export interface NoteConvertResult {
  note: Note;
  task: { id: number; title: string; planDate: string };
  created: boolean;
}
