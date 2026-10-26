import { z } from "zod";

export const meetingTypes = [
  "weekly",
  "group",
  "requirement",
  "training",
] as const;
export type MeetingType = (typeof meetingTypes)[number];
export const meetingTypeLabels: Record<MeetingType, string> = {
  weekly: "周例会",
  group: "组例会",
  requirement: "需求沟通会议",
  training: "功能上线培训",
};

export const meetingTitleMaxLength = 200;
export const meetingContentMaxLength = 500_000;
export const meetingRequirementMaxCount = 100;

// 会议时间精确到分钟；统一转成 UTC ISO 字符串存储，展示端按本地时区格式化。
const meetingTimeSchema = z
  .string()
  .datetime({ offset: true, message: "请选择有效的会议时间" })
  .transform((value) => {
    const date = new Date(value);
    date.setSeconds(0, 0);
    return date.toISOString();
  })
  .refine(
    (value) => !Number.isNaN(new Date(value).getTime()),
    "请选择有效的会议时间",
  );

const titleSchema = z
  .string()
  .trim()
  .min(1, "请输入会议标题")
  .max(meetingTitleMaxLength, `会议标题最多 ${meetingTitleMaxLength} 字`);
const requirementIdsSchema = z
  .array(z.number().int().positive())
  .max(
    meetingRequirementMaxCount,
    `最多关联 ${meetingRequirementMaxCount} 个需求`,
  )
  .transform((ids) => [...new Set(ids)]);
const contentHtmlSchema = z
  .string()
  .max(meetingContentMaxLength, "会议记录内容过长");

export const meetingCreateSchema = z
  .object({
    title: titleSchema,
    type: z.enum(meetingTypes),
    meetingTime: meetingTimeSchema,
    requirementIds: requirementIdsSchema.default([]),
    contentHtml: contentHtmlSchema.default(""),
  })
  .strict();

export const meetingUpdateSchema = z
  .object({
    title: titleSchema.optional(),
    type: z.enum(meetingTypes).optional(),
    meetingTime: meetingTimeSchema.optional(),
    requirementIds: requirementIdsSchema.optional(),
    contentHtml: contentHtmlSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "请提交需要更新的字段");

export const meetingListSchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    type: z.enum(meetingTypes).optional(),
  })
  .strict();

export type MeetingCreate = z.input<typeof meetingCreateSchema>;
export type MeetingCreateParsed = z.output<typeof meetingCreateSchema>;
export type MeetingUpdate = z.input<typeof meetingUpdateSchema>;
export type MeetingListQuery = z.input<typeof meetingListSchema>;

export interface MeetingRequirementRef {
  id: number;
  requirementNo: string;
  name: string;
}

export interface MeetingSummary {
  id: number;
  title: string;
  type: MeetingType;
  meetingTime: string;
  summary: string;
  requirementCount: number;
  requirements: MeetingRequirementRef[];
  createdAt: string;
  updatedAt: string;
}

export interface Meeting extends MeetingSummary {
  contentHtml: string;
}

// 需求引用/关联的统一解析结果：exists=false 表示需求已删除或不存在。
export interface RequirementReferenceState {
  id: number;
  requirementNo: string | null;
  name: string | null;
  exists: boolean;
}
