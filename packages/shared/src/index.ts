import { z } from "zod";
import type { DataRootSystemInfo } from "./data-root-contract.js";

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
import { stages, type Stage } from "./stages.js";
export { stages, type Stage } from "./stages.js";
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
  online: "已上线",
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
export const dateFields = [
  "proposedAt",
  "startedAt",
  "expectedAt",
  "completedAt",
  "plannedReleaseAt",
  "releasedAt",
] as const;
export type DateField = (typeof dateFields)[number];
export const dateLabels: Record<DateField, string> = {
  proposedAt: "提出时间",
  startedAt: "开始时间",
  expectedAt: "预计完成时间",
  completedAt: "实际完成时间",
  plannedReleaseAt: "计划上线时间",
  releasedAt: "实际上线时间",
};
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
    descriptionHtml: z.string().max(200000).default(""),
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
    proposedAtFrom: dateSchema.optional(),
    proposedAtTo: dateSchema.optional(),
    startedAtFrom: dateSchema.optional(),
    startedAtTo: dateSchema.optional(),
    expectedAtFrom: dateSchema.optional(),
    expectedAtTo: dateSchema.optional(),
    completedAtFrom: dateSchema.optional(),
    completedAtTo: dateSchema.optional(),
    plannedReleaseAtFrom: dateSchema.optional(),
    plannedReleaseAtTo: dateSchema.optional(),
    releasedAtFrom: dateSchema.optional(),
    releasedAtTo: dateSchema.optional(),
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
        "startedAt",
        "completedAt",
        "plannedReleaseAt",
        "releasedAt",
        "createdAt",
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
export interface RequirementRelations {
  parent: Requirement | null;
  children: Requirement[];
}
export const fileCategories = [
  "record",
  "mindMap",
  "flowchart",
  "prototype",
  "prd",
  "other",
  "designLink",
  "uiAssets",
  "designNote",
  "uiIssues",
  "discussionRecord",
  "changeNote",
  "technicalDoc",
  "devIssues",
  "testReport",
  "testData",
  "testEvidence",
  "testIssues",
] as const;
export type FileCategory = (typeof fileCategories)[number];
export const fileCategoryLabels: Record<FileCategory, string> = {
  record: "需求分析文档",
  mindMap: "思维导图",
  flowchart: "流程图",
  prototype: "原型图",
  prd: "PRD",
  other: "其他",
  designLink: "设计稿链接",
  uiAssets: "UI 设计文件",
  designNote: "设计说明",
  uiIssues: "UI 问题记录",
  discussionRecord: "讨论记录",
  changeNote: "变更说明",
  technicalDoc: "技术文档",
  devIssues: "开发问题记录",
  testReport: "测试报告",
  testData: "测试数据",
  testEvidence: "测试凭证",
  testIssues: "测试问题记录",
};
// 分类到物理目录的映射：仅用于读取旧版分类目录下的存量文件，新文件统一落 files/ 目录
export const fileCategoryFolders: Record<FileCategory, string> = {
  record: "分析记录",
  mindMap: "思维导图",
  flowchart: "流程图",
  prototype: "原型图",
  prd: "PRD",
  other: "其他",
  designLink: "设计稿链接",
  uiAssets: "UI设计文件",
  designNote: "设计说明",
  uiIssues: "UI问题记录",
  discussionRecord: "讨论记录",
  changeNote: "变更说明",
  technicalDoc: "技术文档",
  devIssues: "开发问题记录",
  testReport: "测试报告",
  testData: "测试数据",
  testEvidence: "测试凭证",
  testIssues: "测试问题记录",
};
// 各阶段可用的分类集合（分类是纯标签，与物理目录解耦）；三个问题记录分类已退役，问题改由 Issue 体系管理
export const stageFileCategories: Record<Stage, FileCategory[]> = {
  analysis: ["record", "mindMap", "flowchart", "prototype", "prd", "other"],
  design: ["designLink", "uiAssets", "designNote", "prototype", "other"],
  development: ["discussionRecord", "changeNote", "technicalDoc", "other"],
  testing: ["testReport", "testData", "testEvidence", "other"],
  online: ["other"],
};
// 分类条目形态：file 仅文件、link 仅链接、text 仅文本、both 文件或链接均可
export const fileCategoryKinds: Record<
  FileCategory,
  "file" | "link" | "text" | "both"
> = {
  record: "file",
  mindMap: "file",
  flowchart: "file",
  prototype: "both",
  prd: "file",
  other: "both",
  designLink: "link",
  uiAssets: "both",
  designNote: "file",
  uiIssues: "file",
  discussionRecord: "file",
  changeNote: "file",
  technicalDoc: "file",
  devIssues: "file",
  testReport: "file",
  testData: "file",
  testEvidence: "file",
  testIssues: "file",
};
// 每个需求固定一份的分类文档：进入阶段时自动创建，展示名与物理名均固定
export interface CategoryDefaultDoc {
  name: string;
  fileName: string;
  template: string;
}
export const categoryDefaultDocs: Partial<
  Record<FileCategory, CategoryDefaultDoc>
> = {
  record: {
    name: "分析记录",
    fileName: "analysis-record.md",
    template: [
      "# 需求分析记录",
      "",
      "## 背景",
      "",
      "## 目标",
      "",
      "## 范围与边界",
      "",
      "## 待确认事项",
      "",
    ].join("\n"),
  },
};
export const analysisRecordName = "分析记录";
export const requirementFileCreateSchema = z
  .object({
    phase: z.enum(stages),
    category: z.enum(fileCategories),
    name: z.string().trim().min(1, "请输入文件名称").max(200),
    // 资源形态：file 落盘文件、link 仅存 URL、text 小型文本直接入库
    resourceType: z.enum(["file", "link", "text"]).default("file"),
    mime: z.string().trim().max(200).default("application/octet-stream"),
    data: z
      .string()
      .min(1, "文件内容不能为空")
      .max(7 * 1024 * 1024)
      .optional(),
    linkUrl: z.string().trim().max(2000).optional(),
    textContent: z.string().min(1, "文本内容不能为空").max(200000).optional(),
    isFinal: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    // 三种形态互斥：文件必须有内容，链接必须有合法 URL，文本必须有正文
    const issue = (message: string, path: string) =>
      ctx.addIssue({ code: "custom", message, path: [path] });
    if (value.resourceType === "file") {
      if (!value.data) issue("文件内容不能为空", "data");
      if (value.linkUrl) issue("文件条目不需要链接地址", "linkUrl");
      if (value.textContent) issue("文件条目不需要文本内容", "textContent");
    } else if (value.resourceType === "link") {
      if (!value.linkUrl) issue("请填写链接地址", "linkUrl");
      else if (!/^(https?|ftp):\/\/\S+$/i.test(value.linkUrl))
        issue("链接需以 http(s):// 或 ftp:// 开头", "linkUrl");
      if (value.data) issue("链接条目不需要文件内容", "data");
      if (value.textContent) issue("链接条目不需要文本内容", "textContent");
    } else {
      if (!value.textContent) issue("请填写文本内容", "textContent");
      if (value.data) issue("文本条目不需要文件内容", "data");
      if (value.linkUrl) issue("文本条目不需要链接地址", "linkUrl");
    }
  });
export const requirementFileUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "请输入文件名称").max(200).optional(),
    isFinal: z.boolean().optional(),
    description: z.string().trim().max(2000).optional(),
    // missing 由系统检测产生，不开放手工设置
    status: z.enum(["draft", "final", "archived"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "请提交需要更新的字段")
  .refine(
    (value) => !(value.isFinal !== undefined && value.status !== undefined),
    "isFinal 与 status 只能二选一",
  );
export const requirementFileContentSchema = z
  .object({ content: z.string().max(200000) })
  .strict();
export type AssetResourceType = "file" | "link" | "text";
export type AssetStorageType = "local" | "database" | "external";
export type AssetStatus = "draft" | "final" | "archived" | "missing";
export interface RequirementFile {
  id: number;
  requirementId: number;
  phase: Stage;
  category: FileCategory;
  name: string;
  // 资源形态：file 落盘文件、link 纯链接、text 库存文本
  resourceType: AssetResourceType;
  storageType: AssetStorageType;
  status: AssetStatus;
  // 兼容投影字段（过渡期保留）：kind=resourceType；isFinal=status==='final'
  kind: AssetResourceType;
  isFinal: boolean;
  fileName: string;
  relativePath: string | null;
  linkUrl: string | null;
  textContent: string | null;
  mimeType: string | null;
  description: string | null;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface RequirementFileGroup {
  category: FileCategory;
  label: string;
  total: number;
  files: RequirementFile[];
}
export interface RequirementFileList {
  phase: Stage | "all";
  all: boolean;
  groups: RequirementFileGroup[];
  editorFile: RequirementFile | null;
}
// 右栏产物区固定七分类（用户定稿，不随阶段切换）；defaultPhase 为创建条目时的归属阶段
export interface AssetCategoryDef {
  key: FileCategory;
  label: string;
  defaultPhase: Stage;
}
export const assetCategories: AssetCategoryDef[] = [
  { key: "record", label: "分析记录", defaultPhase: "analysis" },
  { key: "prototype", label: "原型图", defaultPhase: "analysis" },
  { key: "prd", label: "PRD", defaultPhase: "analysis" },
  { key: "mindMap", label: "思维导图", defaultPhase: "analysis" },
  { key: "flowchart", label: "流程图", defaultPhase: "analysis" },
  { key: "uiAssets", label: "UI 设计稿", defaultPhase: "design" },
  { key: "other", label: "其他文件", defaultPhase: "analysis" },
];
// 问题记录：所有需求阶段均可记录问题（V1.0 文档 §3）
export const issueStages = stages;
export type IssueStage = Stage;
export const issueStatuses = [
  "pending",
  "to_confirm",
  "processing",
  "resolved",
  "wont_fix",
] as const;
export type IssueStatus = (typeof issueStatuses)[number];
export const issueStatusLabels: Record<IssueStatus, string> = {
  pending: "待分析",
  to_confirm: "待确认",
  processing: "处理中",
  resolved: "已解决",
  wont_fix: "暂不处理",
};
export const issueTypes = [
  "analysis",
  "ui",
  "development",
  "testing",
  "other",
] as const;
export type IssueType = (typeof issueTypes)[number];
export const issueTypeLabels: Record<IssueType, string> = {
  analysis: "需求分析疑问",
  ui: "UI 设计疑问",
  development: "开发疑问",
  testing: "测试疑问",
  other: "其他",
};
export const issueActivityTypes = [
  "comment",
  "solution",
  "status_change",
  "system",
] as const;
export type IssueActivityType = (typeof issueActivityTypes)[number];
export const issueCreateSchema = z
  .object({
    // 未指定时默认取需求当前阶段（由服务层补齐）
    stage: z.enum(issueStages).optional(),
    title: z.string().trim().min(1, "请输入问题标题").max(200),
    // 描述（Markdown 原文）：迁移 0009 起权威存储为工作区 md 文件
    description: z.string().max(200000).default(""),
    type: z.enum(issueTypes).nullable().optional(),
  })
  .strict();
export const issueUpdateSchema = z
  .object({
    title: z.string().trim().min(1, "请输入问题标题").max(200).optional(),
    description: z.string().max(200000).optional(),
    stage: z.enum(issueStages).optional(),
    type: z.enum(issueTypes).nullable().optional(),
    status: z.enum(issueStatuses).optional(),
    // 解决方案/最终结论（Markdown 原文）；改为「已解决」前必须非空
    solution: z.string().max(200000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "请提交需要更新的字段");
export const issueCommentSchema = z
  .object({ content: z.string().trim().min(1, "请输入处理说明").max(10000) })
  .strict();
export interface Issue {
  id: number;
  requirementId: number;
  stage: IssueStage;
  issueKey: string | null;
  title: string;
  // 描述：工作区 md 文件内容（迁移 0009 起 description/description_html 列仅存量兼容）
  description: string;
  type: IssueType | null;
  status: IssueStatus;
  // 解决方案/最终结论：Markdown 原文（数据库列 solution）
  solution: string;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}
export interface IssueActivity {
  id: number;
  issueId: number;
  activityType: IssueActivityType;
  content: string;
  oldStatus: IssueStatus | null;
  newStatus: IssueStatus | null;
  actorType: "user" | "ai" | "system" | null;
  actorName: string | null;
  createdAt: string;
}
export interface IssueDetail extends Issue {
  activities: IssueActivity[];
}
export interface IssueListResult {
  items: Issue[];
  total: number;
  // 各状态数量（不计入 status 筛选，供状态筛选标签展示实时计数）
  statusCounts: Record<IssueStatus, number>;
  // 分页信息：limit 为 null 表示调用方未要求分页（返回全部匹配项）
  limit: number | null;
  offset: number;
  hasMore: boolean;
}
export interface IssueStats {
  total: number;
  // 未结束的问题：待分析 / 待确认 / 处理中
  open: number;
  resolved: number;
  wontFix: number;
  statusCounts: Record<IssueStatus, number>;
  byStage: Record<IssueStage, number>;
}
// 问题与产出物关联（artifacts 体系）：同一问题与同一 artifact 节点仅允许一条关联记录；
// assetId 指向 artifact_nodes.id，文件夹与文件均可关联
export const issueAssetRelations = [
  "evidence",
  "solution_material",
  "reference",
  "other",
] as const;
export type IssueAssetRelation = (typeof issueAssetRelations)[number];
export const issueAssetRelationLabels: Record<IssueAssetRelation, string> = {
  evidence: "问题凭证",
  solution_material: "解决材料",
  reference: "参考",
  other: "其他",
};
export const issueAssetLinkSchema = z
  .object({
    assetId: z.number().int().positive(),
    relationType: z.enum(issueAssetRelations).default("reference"),
  })
  .strict();
// 关联视图的节点投影：名称 + 类型 + 相对路径，用于文件夹 + 文件树形展示
export type IssueLinkedArtifact = Pick<
  ArtifactNode,
  "id" | "nodeType" | "name" | "relativePath"
>;
export interface IssueAssetLink {
  issueId: number;
  assetId: number;
  relationType: IssueAssetRelation;
  createdAt: string;
  asset: IssueLinkedArtifact;
}
export interface IssueAssetListResult {
  items: IssueAssetLink[];
  total: number;
}
// 产出物分类的统一打开策略（补充文档 3.2/3.3）：空态 / 单文件直开 / 唯一确认版直开 / 全部列表
export interface CategoryOpenAction {
  action: "empty" | "open_single" | "show_all";
  assetId?: number;
  // 文件数大于 1 且无确认版本时提示用户指定
  needsConfirm?: boolean;
}
export function resolveCategoryOpenAction(
  files: Pick<RequirementFile, "id" | "isFinal">[],
): CategoryOpenAction {
  if (files.length === 0) return { action: "empty" };
  if (files.length === 1)
    return { action: "open_single", assetId: files[0].id };
  const confirmed = files.filter((file) => file.isFinal);
  if (confirmed.length === 1)
    return { action: "open_single", assetId: confirmed[0].id };
  return { action: "show_all", needsConfirm: confirmed.length === 0 };
}
// 允许写入/打开的外部链接协议白名单（拒绝 javascript:/data: 等危险协议）
export function isSafeExternalUrl(url: string): boolean {
  return /^(https?|ftp):\/\/\S+$/i.test(url.trim());
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
export interface SystemInfo extends DataRootSystemInfo {
  version: string;
  databasePath: string;
  workspacePath: string;
  schemaVersion: number;
  systemOpenAvailable?: boolean;
  modules: { key: string; name: string; status: "available" | "planned" }[];
}
export interface ApiErrorResponse {
  error: { code: string; message: string; details?: unknown };
}
export const workspaceRecordSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    bodyHtml: z.string().max(200000),
    answerHtml: z.string().max(200000).default(""),
    status: z.enum(["open", "processing", "resolved"]).default("open"),
    createdAt: z.string().datetime(),
    linkedChildId: z.number().int().positive().nullable().default(null),
  })
  .strict();
export const stageWorkspaceSchema = z
  .object({
    version: z.number().int().nonnegative(),
    designUrl: z
      .string()
      .max(2000)
      .refine(
        (value) => !value || /^https?:\/\//i.test(value),
        "设计稿链接应以 http 或 https 开头",
      )
      .default(""),
    analysis: z
      .object({
        analysisText: z.string().max(200000).default(""),
        prdText: z.string().max(200000).default(""),
      })
      .strict(),
    design: z.array(workspaceRecordSchema).max(500),
    development: z.array(workspaceRecordSchema).max(500),
    testing: z.array(workspaceRecordSchema).max(500),
  })
  .strict();
export type StageWorkspace = z.infer<typeof stageWorkspaceSchema>;
// ===== 需求知识库（artifact_nodes / artifact_links，迁移 0007）=====
// 每个需求的物理根目录固定放置需求记忆文件，服务层按该文件名识别并保护
export const artifactMemoryName = "需求记忆.md";
export const artifactNodeTypes = ["folder", "file"] as const;
export type ArtifactNodeType = (typeof artifactNodeTypes)[number];
// normal 正常 / missing 磁盘缺失 / external_changed 外部修改 / conflict 冲突待处理
export const artifactStatuses = [
  "normal",
  "missing",
  "external_changed",
  "conflict",
] as const;
export type ArtifactStatus = (typeof artifactStatuses)[number];
export const artifactStatusLabels: Record<ArtifactStatus, string> = {
  normal: "正常",
  missing: "文件缺失",
  external_changed: "外部修改",
  conflict: "冲突",
};
// 节点名称校验：拒绝路径分隔符、Windows 保留字符、控制字符与首尾点空格
export const artifactNamePattern = /^[^\\/:*?"<>|\x00-\x1f]+$/;
export function isValidArtifactName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed !== name) return false;
  if (trimmed === "." || trimmed === ".." || trimmed.includes(".."))
    return false;
  if (/[. ]$/.test(trimmed)) return false;
  return artifactNamePattern.test(trimmed) && trimmed.length <= 200;
}
// 需求记忆模板（文档 4.3）：区分事实/假设/决策/待确认/下一步/关联产出物
export function requirementMemoryTemplate(requirementName: string): string {
  return [
    `# ${requirementName} · 需求记忆`,
    "",
    "> 需求记忆是当前状态的摘要，供人与 AI 快速读取。请区分「已确认事实」「假设」",
    "> 与「正式决策」；模型给出的建议不能自动标记为已确认决策，须经人工确认后归入决策章节。",
    "",
    "## 当前概况",
    "",
    "- 阶段：",
    "- 状态：",
    "- 更新时间：",
    "",
    "## 已确认事实",
    "",
    "- ",
    "",
    "## 假设（待验证）",
    "",
    "- ",
    "",
    "## 当前分析结论",
    "",
    "- ",
    "",
    "## 重要决策及依据",
    "",
    "- ",
    "",
    "## 待确认问题",
    "",
    "- ",
    "",
    "## 下一步行动",
    "",
    "- ",
    "",
    "## 关联产出物",
    "",
    "- ",
    "",
  ].join("\n");
}
export const artifactFolderCreateSchema = z
  .object({
    parentId: z.number().int().positive().nullable().default(null),
    name: z.string().min(1, "请输入文件夹名称").max(200, "名称最多 200 字"),
  })
  .strict();
export const artifactFileCreateSchema = z
  .object({
    parentId: z.number().int().positive().nullable().default(null),
    name: z.string().min(1, "请输入文件名称").max(200, "名称最多 200 字"),
    initialContent: z.string().max(200000).optional(),
  })
  .strict();
export const artifactRenameSchema = z
  .object({ name: z.string().min(1, "请输入名称").max(200, "名称最多 200 字") })
  .strict();
export const artifactMoveSchema = z
  .object({ targetParentId: z.number().int().positive().nullable() })
  .strict();
// 最终确认版本：仅文件与链接可标记，文件夹由服务层拒绝
export const artifactFinalSchema = z.object({ isFinal: z.boolean() }).strict();
// 文档管理上传：单文件上限，前端预检与服务端请求体限制共用
export const artifactUploadMaxBytes = 50 * 1024 * 1024;
export const artifactUploadMaxLabel = "50 MB";
// force：磁盘修改时间与索引不一致（外部修改）时，需显式确认才能覆盖保存
export const artifactContentSaveSchema = z
  .object({
    content: z.string().max(200000),
    force: z.boolean().default(false),
  })
  .strict();
export const artifactLinkCreateSchema = z
  .object({
    folderNodeId: z.number().int().positive().nullable().default(null),
    name: z
      .string()
      .trim()
      .min(1, "请输入链接名称")
      .max(200, "名称最多 200 字"),
    url: z.string().trim().min(1, "请填写链接地址").max(2000),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();
export const artifactLinkUpdateSchema = z
  .object({
    folderNodeId: z.number().int().positive().nullable().optional(),
    name: z.string().trim().min(1, "请输入链接名称").max(200).optional(),
    url: z.string().trim().max(2000).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "请提交需要更新的字段");
export const artifactRefreshSchema = z
  .object({ relativePath: z.string().max(2000).optional() })
  .strict();
export interface ArtifactNode {
  id: number;
  requirementId: number;
  parentId: number | null;
  nodeType: ArtifactNodeType;
  name: string;
  // 相对需求根目录的规范化路径，正斜杠分隔；根目录子项即文件名本身
  relativePath: string;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  indexedAt: string;
  status: ArtifactStatus;
  // 最终确认版本：仅文件可标记，文件夹恒为 false
  isFinal: boolean;
  createdAt: string;
  updatedAt: string;
  // 文件夹卡片的直接子项数（列表接口附加）
  childCount?: number;
}
export interface ArtifactLink {
  id: number;
  requirementId: number;
  folderNodeId: number | null;
  name: string;
  url: string;
  description: string | null;
  // 最终确认版本标记
  isFinal: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ArtifactBreadcrumbItem {
  // null 表示需求根目录
  id: number | null;
  name: string;
}
export interface ArtifactDirectory {
  requirementId: number;
  parentId: number | null;
  parentPath: string;
  breadcrumb: ArtifactBreadcrumbItem[];
  folders: ArtifactNode[];
  files: ArtifactNode[];
  links: ArtifactLink[];
  // 非空表示当前处于按名称的全需求范围搜索（结果跨目录，卡片展示相对路径）
  search: string;
  // 分页附加信息：total 为截断前各类数量，truncated 表示是否因 limit 被截断
  total?: { folders: number; files: number; links: number };
  truncated?: boolean;
}
export interface ArtifactNodeDetails {
  node: ArtifactNode;
  breadcrumb: ArtifactBreadcrumbItem[];
  descendantCount: number;
}
export interface ArtifactRefreshResult {
  added: number;
  updated: number;
  missing: number;
}
// 只读读取结果（MCP 复用）：kind 为 binary 时不返回内容，避免把二进制转成 base64
export interface ArtifactReadResult {
  node: ArtifactNode;
  breadcrumb: ArtifactBreadcrumbItem[];
  descendantCount: number;
  kind: "folder" | "text" | "binary";
  content: string | null;
  truncated: boolean;
  maxChars: number;
}
export const artifactMemoryStatuses = [
  "available",
  "not_initialized",
  "missing",
] as const;
export type ArtifactMemoryStatus = (typeof artifactMemoryStatuses)[number];
export interface ArtifactMemoryReadResult {
  requirementId: number;
  exists: boolean;
  status: ArtifactMemoryStatus;
  node: ArtifactNode | null;
  content: string;
  truncated: boolean;
  maxChars: number;
}
export interface ArtifactStats {
  folders: number;
  files: number;
  links: number;
  missing: number;
  externalChanged: number;
  memoryStatus: ArtifactMemoryStatus;
}
// ===== 需求物理目录映射与初始化（V1.1 文档 §12，迁移 0010）=====
// 物理根目录名 = 需求编号 + 空格 + 需求名称；数据库以需求 ID 关联，不依赖目录名识别需求
export const requirementImagesFolder = "images";
export const requirementDefaultFolders = [
  "需求分析",
  "PRD",
  "原型图",
  "资料",
] as const;
export const requirementWorkspaceStatuses = [
  "pending",
  "completed",
  "failed",
] as const;
export type RequirementWorkspaceStatus =
  (typeof requirementWorkspaceStatuses)[number];
export const requirementWorkspaceStatusLabels: Record<
  RequirementWorkspaceStatus,
  string
> = {
  pending: "待初始化",
  completed: "已初始化",
  failed: "初始化失败",
};
// 初始化阶段标识：失败时记录到该阶段，便于定位与重试
export const requirementWorkspaceStages = [
  "resolve",
  "create-directory",
  "memory",
  "folders",
  "index",
] as const;
export type RequirementWorkspaceStage =
  (typeof requirementWorkspaceStages)[number];
// 初始化阶段的中文名：失败时前端直接展示「在哪一步失败」
export const requirementWorkspaceStageLabels: Record<
  RequirementWorkspaceStage,
  string
> = {
  resolve: "解析目录",
  "create-directory": "创建目录",
  memory: "生成需求记忆",
  folders: "创建默认目录",
  index: "登记索引",
};
// 目录名清洗：去掉 Windows 保留字符与控制字符，压缩空白，去首尾点/空格
export function requirementDirectoryName(
  requirementNo: string,
  name: string,
): string {
  const clean = (value: string) =>
    value
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+|[.\s]+$/g, "");
  const no = clean(requirementNo) || "REQ";
  const title = clean(name).slice(0, 80);
  return title ? `${no} ${title}` : no;
}
// 系统级资源（文档 §12.3）：需求记忆文件与 images 目录不可通过普通操作删除/改名/移动
export function isProtectedArtifactPath(relativePath: string): boolean {
  return (
    relativePath === artifactMemoryName ||
    relativePath === requirementImagesFolder
  );
}
export interface RequirementWorkspaceState {
  requirementId: number;
  // 物理根目录名（需求编号 + 名称）与相对工作区根目录的路径
  directoryName: string;
  relativePath: string;
  status: RequirementWorkspaceStatus;
  failureStage: RequirementWorkspaceStage | null;
  failureReason: string | null;
  initializedAt: string | null;
  directoryExists: boolean;
  // 缺失的系统级资源与默认目录名（磁盘比对结果，供「修复默认结构」提示）
  missingResources: string[];
}
// 需求进度快照（只读组合，不新增数据表）：需求本体 + 工作区 + 阶段历史 + 问题/产出物统计
export interface RequirementProgress {
  requirement: Requirement;
  workspace: RequirementWorkspaceState;
  stageHistory: StageHistory[];
  issues: IssueStats;
  artifacts: ArtifactStats;
}
// 图片上传（文档 §12.4）：nodeId 为当前编辑的文档节点，用于按文档所在目录计算相对路径
export const artifactImageUploadSchema = z
  .object({
    nodeId: z.number().int().positive().nullable().default(null),
    mime: z.string().min(1, "缺少图片类型"),
    data: z.string().min(1, "缺少图片数据"),
    fileName: z.string().trim().max(200).optional(),
  })
  .strict();
export interface ArtifactImageUploadResult {
  node: ArtifactNode;
  // 相对当前文档所在目录的 Markdown 图片路径（如 ../images/x.png）
  relativePath: string;
  markdown: string;
}
// MCP 工具契约层（阶段 10）：契约只声明、不执行，网关见 apps/server mcp-gateway
export * from "./mcp-contract.js";
// 应用内更新契约：清单、检查结果、安装进度与运行时状态
export * from "./update-contract.js";
// 每日任务与工时记录契约
export * from "./daily-tasks.js";
export * from "./online-tools.js";
export * from "./meetings.js";
export * from "./notes.js";
