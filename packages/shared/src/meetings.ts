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
export const meetingTimeSchema = z
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

export const meetingTitleSchema = z
  .string()
  .trim()
  .min(1, "请输入会议标题")
  .max(meetingTitleMaxLength, `会议标题最多 ${meetingTitleMaxLength} 字`);
export const meetingTypeSchema = z.enum(meetingTypes);
export const meetingRequirementIdsSchema = z
  .array(z.number().int().positive())
  .max(
    meetingRequirementMaxCount,
    `最多关联 ${meetingRequirementMaxCount} 个需求`,
  )
  .transform((ids) => [...new Set(ids)]);
export const meetingContentHtmlSchema = z
  .string()
  .max(meetingContentMaxLength, "会议记录内容过长");

export const meetingCreateFields = {
  title: meetingTitleSchema,
  type: meetingTypeSchema,
  meetingTime: meetingTimeSchema,
  requirementIds: meetingRequirementIdsSchema.default([]),
  contentHtml: meetingContentHtmlSchema.default(""),
};
export const meetingUpdateFields = {
  title: meetingTitleSchema.optional(),
  type: meetingTypeSchema.optional(),
  meetingTime: meetingTimeSchema.optional(),
  requirementIds: meetingRequirementIdsSchema.optional(),
  contentHtml: meetingContentHtmlSchema.optional(),
};

export const meetingCreateSchema = z.object(meetingCreateFields).strict();

export const meetingUpdateSchema = z
  .object(meetingUpdateFields)
  .strict()
  .refine((value) => Object.keys(value).length > 0, "请提交需要更新的字段");

export const meetingListSchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    type: meetingTypeSchema.optional(),
  })
  .strict();

const meetingRangeTimeSchema = z
  .string()
  .datetime({ offset: true, message: "时间格式应为 ISO 8601" })
  .transform((value) => new Date(value).toISOString());

const meetingRangeRefinement = (value: {
  startTime?: string;
  endTime?: string;
}) => !value.startTime || !value.endTime || value.startTime <= value.endTime;
const MEETING_RANGE_MESSAGE = "结束时间不能早于开始时间";

export const meetingQuerySchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    type: meetingTypeSchema.optional(),
    startTime: meetingRangeTimeSchema.optional(),
    endTime: meetingRangeTimeSchema.optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine(meetingRangeRefinement, MEETING_RANGE_MESSAGE);

export const meetingSearchSchema = z
  .object({
    q: z.string().trim().min(1, "请输入搜索关键词").max(200),
    type: meetingTypeSchema.optional(),
    startTime: meetingRangeTimeSchema.optional(),
    endTime: meetingRangeTimeSchema.optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine(meetingRangeRefinement, MEETING_RANGE_MESSAGE);

export type MeetingCreate = z.input<typeof meetingCreateSchema>;
export type MeetingCreateParsed = z.output<typeof meetingCreateSchema>;
export type MeetingUpdate = z.input<typeof meetingUpdateSchema>;
export type MeetingListQuery = z.input<typeof meetingListSchema>;
export type MeetingQuery = z.input<typeof meetingQuerySchema>;
export type MeetingQueryParsed = z.output<typeof meetingQuerySchema>;
export type MeetingSearch = z.input<typeof meetingSearchSchema>;
export type MeetingSearchParsed = z.output<typeof meetingSearchSchema>;

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

export interface MeetingQueryResult {
  items: MeetingSummary[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// 需求引用/关联的统一解析结果：exists=false 表示需求已删除或不存在。
export interface RequirementReferenceState {
  id: number;
  requirementNo: string | null;
  name: string | null;
  exists: boolean;
}
