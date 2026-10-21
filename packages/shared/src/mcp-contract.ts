import { z } from "zod";

/**
 * MCP 工具契约层（主开发文档阶段 10：MCP 接入准备与契约验证）。
 *
 * 本文件只声明“AI 可以通过 MCP 做什么”，不包含任何执行逻辑；执行统一收敛在
 * apps/server 的 mcp-gateway（网关把工具调用转发给真实业务服务，不做第二套业务逻辑）。
 *
 * 关键设计约束：
 * 1. MCP 层不暴露任意 SQL、绝对路径或文件系统工具——模型只能通过本契约声明的
 *    业务工具访问数据；文件读取只经 assetId 间接访问，路径解析、越权校验与
 *    软删除约束全部由业务服务完成。
 * 2. AI 提交 solution 不得隐式把问题置为 resolved：issue.update 的网关守卫强制
 *    “保存解决方案”与“状态变更”分两步显式调用（网关层实现，见 mcp-gateway.ts）。
 * 3. 入参 schema 显式镜像业务服务真实签名，而不直接复用本包 index.ts 中的业务
 *    schema——避免形成运行时循环依赖，同时把 MCP 视为独立的外部契约；服务签名
 *    变更时必须同步本文件（测试会校验契约与网关执行器一一对应）。
 * 4. 幂等约定：readonly 工具 idempotency="none"；mutating 工具
 *    idempotency="key-required"，调用时必须携带非空 idempotencyKey。
 */

/** 只读工具名（7 个）：只查询，不产生任何副作用 */
export const mcpReadonlyToolNames = [
  "requirement.list",
  "requirement.get",
  "asset.list",
  "asset.get",
  "issue.list",
  "issue.get",
  "issue.activities",
] as const;
/** 写工具名（7 个）：改变业务状态，必须携带幂等键 */
export const mcpMutatingToolNames = [
  "issue.create",
  "issue.update",
  "issue.comment",
  "issue.linkAsset",
  "issue.unlinkAsset",
  "asset.create",
  "asset.updateStatus",
] as const;

export type McpReadonlyToolName = (typeof mcpReadonlyToolNames)[number];
export type McpMutatingToolName = (typeof mcpMutatingToolNames)[number];
export type McpToolName = McpReadonlyToolName | McpMutatingToolName;
export type McpToolKind = "readonly" | "mutating";
/** readonly → "none"；mutating → "key-required"（网关强制幂等键） */
export type McpIdempotency = "none" | "key-required";

/**
 * MCP 层允许 surfaced 的 DomainError code 白名单。
 * 与业务服务实际抛出的 DomainError code 集合保持一致；白名单之外的错误
 * （如未捕获异常）不得直接透给模型，由未来的 MCP server 本体统一兜底。
 */
export const MCP_ERROR_CODES = [
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "FORBIDDEN",
  "CONFLICT",
  "INVALID_PATH",
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

/** 单个 MCP 工具的契约描述 */
export interface McpToolContract {
  name: McpToolName;
  /** 给模型看的能力说明（含关键业务规则提示） */
  description: string;
  kind: McpToolKind;
  /** 入参约束 schema（显式镜像业务服务真实签名） */
  input: z.ZodTypeAny;
  /** 该工具可能抛出的 DomainError code（必须是 MCP_ERROR_CODES 的子集） */
  allowedErrors: McpErrorCode[];
  idempotency: McpIdempotency;
}

// ---------------------------------------------------------------------------
// 入参 schema（与业务服务签名一一镜像）
// ---------------------------------------------------------------------------

const id = z.number().int().positive();
const mcpDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD");

/** 镜像 RequirementService.list / requirementListSchema */
export const mcpRequirementListInput = z
  .object({
    q: z.string().trim().max(200).default(""),
    type: z.enum(["feature", "improvement", "bug", "refactor", "other"]).optional(),
    priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    status: z
      .enum(["not_started", "in_progress", "blocked", "paused", "completed", "cancelled"])
      .optional(),
    currentStage: z.enum(["analysis", "design", "development", "testing"]).optional(),
    proposedAtFrom: mcpDate.optional(),
    proposedAtTo: mcpDate.optional(),
    startedAtFrom: mcpDate.optional(),
    startedAtTo: mcpDate.optional(),
    expectedAtFrom: mcpDate.optional(),
    expectedAtTo: mcpDate.optional(),
    completedAtFrom: mcpDate.optional(),
    completedAtTo: mcpDate.optional(),
    plannedReleaseAtFrom: mcpDate.optional(),
    plannedReleaseAtTo: mcpDate.optional(),
    releasedAtFrom: mcpDate.optional(),
    releasedAtTo: mcpDate.optional(),
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
export type McpRequirementListInput = z.output<typeof mcpRequirementListInput>;

/** 镜像 RequirementService.get */
export const mcpRequirementGetInput = z.object({ id }).strict();
export type McpRequirementGetInput = z.output<typeof mcpRequirementGetInput>;

/** 镜像 RequirementFileService.list(id, phase: Stage | "all", all) */
export const mcpAssetListInput = z
  .object({
    requirementId: id,
    phase: z.enum(["analysis", "design", "development", "testing", "all"]).default("all"),
    // true 时草稿与确认版全部返回；false 时仅确认版
    all: z.boolean().default(true),
  })
  .strict();
export type McpAssetListInput = z.output<typeof mcpAssetListInput>;

/** 镜像 RequirementFileService.content：文件读取只经 assetId 间接访问 */
export const mcpAssetGetInput = z
  .object({ requirementId: id, assetId: id })
  .strict();
export type McpAssetGetInput = z.output<typeof mcpAssetGetInput>;

/** 镜像 IssueService.list(requirementId, phase?, status?) */
export const mcpIssueListInput = z
  .object({
    requirementId: id,
    phase: z.enum(["design", "development", "testing"]).optional(),
    status: z.enum(["pending", "processing", "testing", "resolved"]).optional(),
  })
  .strict();
export type McpIssueListInput = z.output<typeof mcpIssueListInput>;

/** 镜像 IssueService.detail（含活动时间线） */
export const mcpIssueGetInput = z
  .object({ requirementId: id, issueId: id })
  .strict();
export type McpIssueGetInput = z.output<typeof mcpIssueGetInput>;

/** 镜像 IssueService.detail，仅返回活动时间线 */
export const mcpIssueActivitiesInput = mcpIssueGetInput;
export type McpIssueActivitiesInput = z.output<typeof mcpIssueActivitiesInput>;

/** 镜像 IssueService.create / issueCreateSchema（初始状态固定 pending） */
export const mcpIssueCreateInput = z
  .object({
    requirementId: id,
    phase: z.enum(["design", "development", "testing"]),
    title: z.string().trim().min(1, "请输入问题标题").max(200),
    description: z.string().max(200000).default(""),
    issueType: z.enum(["ui", "development", "defect", "change", "question"]).optional(),
  })
  .strict();
export type McpIssueCreateInput = z.output<typeof mcpIssueCreateInput>;

/**
 * 镜像 IssueService.update / issueUpdateSchema。
 * 网关守卫：不允许一次调用同时提交 solution 并把 status 置为 resolved。
 */
export const mcpIssueUpdateInput = z
  .object({
    requirementId: id,
    issueId: id,
    title: z.string().trim().min(1, "请输入问题标题").max(200).optional(),
    description: z.string().max(200000).optional(),
    issueType: z.enum(["ui", "development", "defect", "change", "question"]).nullable().optional(),
    status: z.enum(["pending", "processing", "testing", "resolved"]).optional(),
    solution: z.string().max(10000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.issueType !== undefined ||
      value.status !== undefined ||
      value.solution !== undefined,
    "请提交需要更新的字段",
  );
export type McpIssueUpdateInput = z.output<typeof mcpIssueUpdateInput>;

/** 镜像 IssueService.comment / issueCommentSchema */
export const mcpIssueCommentInput = z
  .object({
    requirementId: id,
    issueId: id,
    content: z.string().trim().min(1, "请输入处理说明").max(10000),
  })
  .strict();
export type McpIssueCommentInput = z.output<typeof mcpIssueCommentInput>;

/** 镜像 IssueService.linkAsset / issueAssetLinkSchema */
export const mcpIssueLinkAssetInput = z
  .object({
    requirementId: id,
    issueId: id,
    assetId: id,
    relationType: z.enum(["evidence", "solution_material", "reference", "other"]).default("reference"),
  })
  .strict();
export type McpIssueLinkAssetInput = z.output<typeof mcpIssueLinkAssetInput>;

/** 镜像 IssueService.unlinkAsset（不删除产出物本体） */
export const mcpIssueUnlinkAssetInput = z
  .object({ requirementId: id, issueId: id, assetId: id })
  .strict();
export type McpIssueUnlinkAssetInput = z.output<typeof mcpIssueUnlinkAssetInput>;

/**
 * 镜像 RequirementFileService.create / requirementFileCreateSchema。
 * file/link/text 三种形态互斥的交叉校验由业务服务负责，契约只约束字段本身。
 */
export const mcpAssetCreateInput = z
  .object({
    requirementId: id,
    phase: z.enum(["analysis", "design", "development", "testing"]),
    category: z.enum([
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
    ]),
    name: z.string().trim().min(1, "请输入文件名称").max(200),
    resourceType: z.enum(["file", "link", "text"]).default("file"),
    mime: z.string().trim().max(200).default("application/octet-stream"),
    // 文件形态：base64 编码内容（上限与业务服务一致）
    data: z.string().min(1, "文件内容不能为空").max(7 * 1024 * 1024).optional(),
    // 链接形态：仅允许 http(s)/ftp 地址（业务服务再做协议白名单校验）
    linkUrl: z.string().trim().max(2000).optional(),
    // 文本形态：轻量正文直接入库
    textContent: z.string().min(1, "文本内容不能为空").max(200000).optional(),
    isFinal: z.boolean().default(false),
  })
  .strict();
export type McpAssetCreateInput = z.output<typeof mcpAssetCreateInput>;

/**
 * 镜像 RequirementFileService.update / requirementFileUpdateSchema。
 * 有意收窄：不暴露 isFinal 兼容入参（与 status 等价），MCP 统一用 status。
 * missing 状态由系统检测产生，不开放手工设置。
 */
export const mcpAssetUpdateStatusInput = z
  .object({
    requirementId: id,
    assetId: id,
    name: z.string().trim().min(1, "请输入文件名称").max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    status: z.enum(["draft", "final", "archived"]).optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.description !== undefined || value.status !== undefined,
    "请提交需要更新的字段",
  );
export type McpAssetUpdateStatusInput = z.output<typeof mcpAssetUpdateStatusInput>;

// ---------------------------------------------------------------------------
// 契约清单
// ---------------------------------------------------------------------------

/** 14 个 MCP 工具的完整契约（只读 7 + 写 7），网关按此一一建立执行器 */
export const mcpToolContracts: McpToolContract[] = [
  {
    name: "requirement.list",
    description: "按筛选条件分页查询需求列表，树形返回（含子需求）。",
    kind: "readonly",
    input: mcpRequirementListInput,
    allowedErrors: ["VALIDATION_ERROR"],
    idempotency: "none",
  },
  {
    name: "requirement.get",
    description: "按 ID 查询单个需求详情。",
    kind: "readonly",
    input: mcpRequirementGetInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR"],
    idempotency: "none",
  },
  {
    name: "asset.list",
    description:
      "列出需求在指定阶段（或全部阶段）的产出物，按分类分组返回；all=false 时仅返回确认版。",
    kind: "readonly",
    input: mcpAssetListInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR"],
    idempotency: "none",
  },
  {
    name: "asset.get",
    description:
      "按 ID 读取单个产出物的元数据与正文（文本/本地文件；链接条目没有正文）。文件读取只允许经 assetId 间接访问。",
    kind: "readonly",
    input: mcpAssetGetInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR"],
    idempotency: "none",
  },
  {
    name: "issue.list",
    description: "查询某需求下的问题列表，可按阶段（design/development/testing）与状态过滤。",
    kind: "readonly",
    input: mcpIssueListInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR"],
    idempotency: "none",
  },
  {
    name: "issue.get",
    description: "按 ID 查询单个问题详情（含活动时间线）。",
    kind: "readonly",
    input: mcpIssueGetInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR"],
    idempotency: "none",
  },
  {
    name: "issue.activities",
    description: "仅读取问题的活动时间线（评论、方案、状态变更、系统记录），按时间正序。",
    kind: "readonly",
    input: mcpIssueActivitiesInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR"],
    idempotency: "none",
  },
  {
    name: "issue.create",
    description:
      "在需求的指定阶段创建问题；初始状态固定为 pending，并自动写入一条系统活动记录。",
    kind: "mutating",
    input: mcpIssueCreateInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR"],
    idempotency: "key-required",
  },
  {
    name: "issue.update",
    description:
      "更新问题的标题/描述/类型/状态/解决说明。注意：不允许一次调用同时提交 solution 并把状态置为 resolved——必须先单独保存 solution，再显式发起一次状态变更（AI 生成解决方案不会自动把问题置为已解决）。",
    kind: "mutating",
    input: mcpIssueUpdateInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR"],
    idempotency: "key-required",
  },
  {
    name: "issue.comment",
    description: "向问题追加一条处理说明评论（comment 活动）。",
    kind: "mutating",
    input: mcpIssueCommentInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR"],
    idempotency: "key-required",
  },
  {
    name: "issue.linkAsset",
    description:
      "将同需求下的产出物与问题建立关联（relationType：evidence/solution_material/reference/other）；重复关联会被拒绝。",
    kind: "mutating",
    input: mcpIssueLinkAssetInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR", "CONFLICT"],
    idempotency: "key-required",
  },
  {
    name: "issue.unlinkAsset",
    description: "取消问题与产出物的关联；只移除关联关系，不会删除产出物本体。",
    kind: "mutating",
    input: mcpIssueUnlinkAssetInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR"],
    idempotency: "key-required",
  },
  {
    name: "asset.create",
    description:
      "为需求创建产出物条目。file/link/text 三种形态互斥：文件需 base64 data，链接需 http(s)/ftp 地址，文本需 textContent；isFinal=true 时创建即为确认版。",
    kind: "mutating",
    input: mcpAssetCreateInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR", "INVALID_PATH"],
    idempotency: "key-required",
  },
  {
    name: "asset.updateStatus",
    description:
      "更新产出物的名称/描述/状态（draft/final/archived）。设为 final 会取消同分类同名条目原有的确认版标记；missing 由系统检测产生，不可手工设置。",
    kind: "mutating",
    input: mcpAssetUpdateStatusInput,
    allowedErrors: ["NOT_FOUND", "VALIDATION_ERROR"],
    idempotency: "key-required",
  },
];
