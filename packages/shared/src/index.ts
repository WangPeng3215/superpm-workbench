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
export type RequirementFileCreate = z.input<typeof requirementFileCreateSchema>;
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
// 问题管理：Issue 仅存在于 UI 设计/开发跟进/需求测试三个阶段
export const issuePhases = ["design", "development", "testing"] as const;
export type IssuePhase = (typeof issuePhases)[number];
export const issueStatuses = ["open", "in_progress", "testing", "resolved"] as const;
export type IssueStatus = (typeof issueStatuses)[number];
export const issueStatusLabels: Record<IssueStatus, string> = {
  open: "待处理",
  in_progress: "处理中",
  testing: "测试中",
  resolved: "已解决",
};
export const issueTypes = ["ui", "development", "defect", "change", "question"] as const;
export type IssueType = (typeof issueTypes)[number];
export const issueTypeLabels: Record<IssueType, string> = {
  ui: "UI",
  development: "开发",
  defect: "缺陷",
  change: "变更",
  question: "疑问",
};
export const issueActivityTypes = ["comment", "solution", "status_change", "system"] as const;
export type IssueActivityType = (typeof issueActivityTypes)[number];
export const issueCreateSchema = z
  .object({
    phase: z.enum(issuePhases),
    title: z.string().trim().min(1, "请输入问题标题").max(200),
    description: z.string().max(10000).default(""),
    // 富文本正文：html 与纯文本双写同步（html 用于回显编辑器，text 用于导出/检索）
    descriptionHtml: z.string().max(200000).default(""),
    issueType: z.enum(issueTypes).optional(),
  })
  .strict();
export const issueUpdateSchema = z
  .object({
    title: z.string().trim().min(1, "请输入问题标题").max(200).optional(),
    description: z.string().max(10000).optional(),
    descriptionHtml: z.string().max(200000).optional(),
    issueType: z.enum(issueTypes).nullable().optional(),
    status: z.enum(issueStatuses).optional(),
    solution: z.string().max(10000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "请提交需要更新的字段");
export const issueCommentSchema = z
  .object({ content: z.string().trim().min(1, "请输入处理说明").max(10000) })
  .strict();
export type IssueCreate = z.input<typeof issueCreateSchema>;
export interface Issue {
  id: number;
  requirementId: number;
  phase: IssuePhase;
  issueKey: string | null;
  title: string;
  description: string;
  // 富文本正文（html），与 description 纯文本双写同步
  descriptionHtml: string;
  issueType: IssueType | null;
  status: IssueStatus;
  solution: string | null;
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
  if (files.length === 1) return { action: "open_single", assetId: files[0].id };
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
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;
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
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) return false;
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
    name: z.string().trim().min(1, "请输入链接名称").max(200, "名称最多 200 字"),
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
  .refine(
    (value) => Object.keys(value).length > 0,
    "请提交需要更新的字段",
  );
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
// MCP 工具契约层（阶段 10）：契约只声明、不执行，网关见 apps/server mcp-gateway
export * from "./mcp-contract.js";
