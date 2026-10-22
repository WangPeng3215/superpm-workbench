import { z } from "zod";
import {
  MCP_ERROR_CODES,
  MCP_UNTRUSTED_CONTENT_NOTICE,
  mcpToolContracts,
  mcpWritePayloadSchemas,
  mcpWritePrepareInput,
  mcpWriteToolNames,
  type Issue,
  type McpArtifactDirectoryData,
  type McpArtifactGetInput,
  type McpArtifactListInput,
  type McpErrorCode,
  type McpIssueActivitiesInput,
  type McpIssueCommentInput,
  type McpIssueGetInput,
  type McpIssueLinkAssetInput,
  type McpIssueLinkWriteData,
  type McpIssueListInput,
  type McpIssueSummary,
  type McpIssueUnlinkAssetInput,
  type McpIssueUnlinkWriteData,
  type McpIssueUpdateInput,
  type McpIssueWriteData,
  type McpReadResult,
  type McpRequirementGetInput,
  type McpRequirementListInput,
  type McpRequirementMemoryGetInput,
  type McpRequirementProgressGetInput,
  type McpRequirementSummary,
  type McpToolKind,
  type McpToolName,
  type McpWritePrepareData,
  type Requirement,
} from "@superpm/shared";
import { DomainError, RequirementService } from "./requirements.js";
import { IssueService, type IssueActor } from "./issues.js";
import { ArtifactService } from "./artifacts.js";
import { RequirementProgressService } from "./requirement-progress.js";
import { McpWriteService, type McpWriteTarget } from "./mcp-writes.js";

/**
 * MCP 服务网关（M3：受控写入）：契约层的唯一执行入口。
 *
 * 安全边界（显式声明）：
 * - 只读工具不写数据库、不写工作区：不补目录映射、不初始化工作区、不刷新索引。
 * - 写工具默认不可见、不可调用；必须显式启用写能力，并先通过 write.prepare 获取
 *   一次性确认令牌。令牌绑定工具、解析后的参数与幂等键，过期或复用均被拒绝。
 * - 不做第二套业务逻辑：执行器只做“契约校验 + 转发 + 投影/截断 + 写入守卫”，
 *   读写的权威实现都在业务服务；所有工具都以需求为作用域，跨需求访问返回 NOT_FOUND。
 * - 不暴露 SQL、绝对路径、文件写入或删除工具；文本内容按 maxChars 截断，二进制不返回内容。
 * - DomainError / ZodError 统一转换为结构化结果；非预期异常原样上抛，由 MCP server 本体
 *   统一兜底（不得直接把堆栈或绝对路径透给模型）。
 */

export interface McpGatewayDeps {
  requirements: RequirementService;
  issues: IssueService;
  artifacts: ArtifactService;
  progress: RequirementProgressService;
  writes: McpWriteService;
}

export interface McpToolCallOptions {
  /** MCP 客户端名称（不含版本），写入时标记为 AI 操作者 */
  actorName?: string;
}

export interface McpToolExecutor {
  readonly name: McpToolName;
  readonly kind: McpToolKind;
  execute(input: unknown, options?: McpToolCallOptions): McpReadResult<unknown>;
}

export type McpCallResult =
  | { ok: true; data: McpReadResult<unknown> }
  | {
      ok: false;
      error: { code: McpErrorCode | "INTERNAL_ERROR"; message: string };
    };

export interface McpGateway {
  /** 工具执行器映射：与 mcpToolContracts 中已启用的工具一一对应 */
  readonly tools: ReadonlyMap<McpToolName, McpToolExecutor>;
  readonly writeEnabled: boolean;
  /** 推荐调用入口：未知工具 / 入参非法 / 业务失败均返回结构化结果而非抛出 */
  call(
    name: string,
    input?: unknown,
    options?: McpToolCallOptions,
  ): McpCallResult;
}

/** 各工具入参的解析后类型（与契约 schema 的 z.output 一一对应） */
interface McpToolInputs {
  "requirement.list": McpRequirementListInput;
  "requirement.get": McpRequirementGetInput;
  "requirement.memory.get": McpRequirementMemoryGetInput;
  "requirement.progress.get": McpRequirementProgressGetInput;
  "issue.list": McpIssueListInput;
  "issue.get": McpIssueGetInput;
  "issue.activities": McpIssueActivitiesInput;
  "artifact.list": McpArtifactListInput;
  "artifact.get": McpArtifactGetInput;
  "issue.update": McpIssueUpdateInput;
  "issue.comment": McpIssueCommentInput;
  "issue.linkAsset": McpIssueLinkAssetInput;
  "issue.unlinkAsset": McpIssueUnlinkAssetInput;
}

const ISSUE_PREVIEW_CHARS = 200;
const AI_ACTOR_PREFIX = "mcp:";

function toRequirementSummary(
  item: Requirement,
  children: Requirement[] = [],
): McpRequirementSummary {
  return {
    id: item.id,
    requirementNo: item.requirementNo,
    name: item.name,
    type: item.type,
    priority: item.priority,
    status: item.status,
    currentStage: item.currentStage,
    parentId: item.parentId,
    proposedAt: item.proposedAt,
    expectedAt: item.expectedAt,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    plannedReleaseAt: item.plannedReleaseAt,
    releasedAt: item.releasedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    children: children.map((child) => toRequirementSummary(child)),
  };
}

function toIssueSummary(issue: Issue): McpIssueSummary {
  return {
    id: issue.id,
    requirementId: issue.requirementId,
    stage: issue.stage,
    issueKey: issue.issueKey,
    title: issue.title,
    type: issue.type,
    status: issue.status,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    resolvedAt: issue.resolvedAt,
    descriptionPreview: issue.description.slice(0, ISSUE_PREVIEW_CHARS),
    descriptionLength: issue.description.length,
    hasSolution: issue.solution.trim().length > 0,
  };
}

function clip(
  value: string,
  maxChars: number,
  field: string,
  truncatedFields: string[],
): string {
  if (value.length <= maxChars) return value;
  truncatedFields.push(field);
  return value.slice(0, maxChars);
}

function issueTarget(requirementId: number, issueId: number): McpWriteTarget {
  return {
    requirementId,
    targetType: "issue",
    targetId: String(issueId),
  };
}

function actorFor(options?: McpToolCallOptions): IssueActor {
  const name = options?.actorName?.trim();
  return {
    actorType: "ai",
    actorName: name ? `${AI_ACTOR_PREFIX}${name}`.slice(0, 120) : "mcp:unknown",
  };
}

function payloadTarget(payload: Record<string, unknown>): McpWriteTarget {
  return issueTarget(Number(payload.requirementId), Number(payload.issueId));
}

function writeSummary(
  tool: (typeof mcpWriteToolNames)[number],
  payload: Record<string, unknown>,
) {
  const issueId = Number(payload.issueId);
  switch (tool) {
    case "issue.update": {
      const fields = [
        "title",
        "description",
        "stage",
        "type",
        "status",
        "solution",
      ].filter((key) => payload[key] !== undefined);
      return `更新问题 #${issueId}（${fields.join("、")}）`;
    }
    case "issue.comment":
      return `为问题 #${issueId} 追加处理说明`;
    case "issue.linkAsset":
      return `关联产出物 #${Number(payload.assetId)} 到问题 #${issueId}`;
    case "issue.unlinkAsset":
      return `取消问题 #${issueId} 与产出物 #${Number(payload.assetId)} 的关联`;
  }
}

function latestActivityId(
  detail: { activities: { id: number; createdAt: string }[] },
  updatedAt: string,
) {
  const last = detail.activities[detail.activities.length - 1];
  return last && last.createdAt === updatedAt ? last.id : null;
}

/**
 * 构建 MCP 工具执行器映射。
 * 只读工具始终注册；写工具仅在写入开关开启时注册。写工具统一经过
 * McpWriteService 的确认令牌、幂等键与审计守卫。
 */
export function buildMcpTools(deps: McpGatewayDeps): McpGateway {
  const writes = deps.writes;
  const handlers: {
    [K in McpToolName]: (
      input: McpToolInputs[K],
      options: McpToolCallOptions,
    ) => unknown;
  } = {
    "requirement.list": (input) => {
      const result = deps.requirements.list(input);
      return {
        ...result,
        items: result.items.map((item) =>
          toRequirementSummary(item, item.children),
        ),
      };
    },
    "requirement.get": (input) => {
      const requirement = deps.requirements.get(input.id);
      const relations = deps.requirements.relations(input.id);
      const truncatedFields: string[] = [];
      return {
        requirement: {
          ...toRequirementSummary(requirement),
          description: clip(
            requirement.description,
            input.maxChars,
            "description",
            truncatedFields,
          ),
          descriptionHtml: clip(
            requirement.descriptionHtml,
            input.maxChars,
            "descriptionHtml",
            truncatedFields,
          ),
        },
        relations: {
          parent: relations.parent
            ? toRequirementSummary(relations.parent)
            : null,
          children: relations.children.map((child) =>
            toRequirementSummary(child),
          ),
        },
        maxChars: input.maxChars,
        truncated: truncatedFields.length > 0,
        truncatedFields,
      };
    },
    "requirement.memory.get": (input) =>
      deps.artifacts.readMemory(input.requirementId, input.maxChars),
    "requirement.progress.get": (input) => {
      const progress = deps.progress.get(input.requirementId);
      return {
        ...progress,
        requirement: toRequirementSummary(progress.requirement),
      };
    },
    "issue.list": (input) => {
      const result = deps.issues.list(input.requirementId, {
        stage: input.stage,
        status: input.status,
        type: input.type,
        q: input.q,
        limit: input.limit,
        offset: input.offset,
      });
      return {
        items: result.items.map(toIssueSummary),
        total: result.total,
        statusCounts: result.statusCounts,
        limit: result.limit ?? input.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      };
    },
    "issue.get": (input) => {
      const detail = deps.issues.detail(input.requirementId, input.issueId);
      const { activities: rawActivities, ...issue } = detail;
      const truncatedFields: string[] = [];
      const activities = rawActivities.map((activity, index) => ({
        ...activity,
        content: clip(
          activity.content,
          input.maxChars,
          `activities[${index}].content`,
          truncatedFields,
        ),
      }));
      return {
        issue: {
          ...issue,
          description: clip(
            detail.description,
            input.maxChars,
            "description",
            truncatedFields,
          ),
          solution: clip(
            detail.solution,
            input.maxChars,
            "solution",
            truncatedFields,
          ),
        },
        activities,
        maxChars: input.maxChars,
        truncated: truncatedFields.length > 0,
        truncatedFields,
      };
    },
    "issue.activities": (input) => {
      const detail = deps.issues.detail(input.requirementId, input.issueId);
      const truncatedFields: string[] = [];
      const items = detail.activities.map((activity, index) => ({
        ...activity,
        content: clip(
          activity.content,
          input.maxChars,
          `activities[${index}].content`,
          truncatedFields,
        ),
      }));
      return {
        items,
        maxChars: input.maxChars,
        truncated: truncatedFields.length > 0,
        truncatedFields,
      };
    },
    "artifact.list": (input) => {
      const directory = deps.artifacts.listNodes(
        input.requirementId,
        input.parentId,
        input.q,
        { sync: false, limit: input.limit },
      );
      return {
        ...directory,
        total: directory.total ?? {
          folders: directory.folders.length,
          files: directory.files.length,
          links: directory.links.length,
        },
        truncated: directory.truncated ?? false,
        limit: input.limit,
      } satisfies McpArtifactDirectoryData;
    },
    "artifact.get": (input) =>
      deps.artifacts.readArtifact(
        input.requirementId,
        input.nodeId,
        input.maxChars,
      ),
    "issue.update": (input, options) => {
      const { confirmationToken, idempotencyKey, ...payload } = input;
      const { requirementId, issueId, ...patch } = payload;
      const target = issueTarget(requirementId, issueId);
      const summary = writeSummary("issue.update", payload);
      const issue = writes.execute(
        {
          tool: "issue.update",
          payload,
          idempotencyKey,
          confirmationToken,
          target,
          actorName: actorFor(options).actorName,
          summary,
        },
        () =>
          deps.issues.update(requirementId, issueId, patch, actorFor(options)),
      );
      return {
        issue: toIssueSummary(issue),
        changedFields: Object.keys(patch),
        activityId:
          patch.solution !== undefined || patch.status !== undefined
            ? latestActivityId(
                deps.issues.detail(requirementId, issueId),
                issue.updatedAt,
              )
            : null,
      } satisfies McpIssueWriteData;
    },
    "issue.comment": (input, options) => {
      const { confirmationToken, idempotencyKey, ...payload } = input;
      const { requirementId, issueId, content } = payload;
      const target = issueTarget(requirementId, issueId);
      const summary = writeSummary("issue.comment", payload);
      const detail = writes.execute(
        {
          tool: "issue.comment",
          payload,
          idempotencyKey,
          confirmationToken,
          target,
          actorName: actorFor(options).actorName,
          summary,
        },
        () =>
          deps.issues.comment(
            requirementId,
            issueId,
            { content },
            actorFor(options),
          ),
      );
      return {
        issue: toIssueSummary(detail),
        changedFields: ["comment"],
        activityId: latestActivityId(detail, detail.updatedAt),
      } satisfies McpIssueWriteData;
    },
    "issue.linkAsset": (input, options) => {
      const { confirmationToken, idempotencyKey, ...payload } = input;
      const { requirementId, issueId, assetId, relationType } = payload;
      const target = issueTarget(requirementId, issueId);
      const summary = writeSummary("issue.linkAsset", payload);
      writes.execute(
        {
          tool: "issue.linkAsset",
          payload,
          idempotencyKey,
          confirmationToken,
          target,
          actorName: actorFor(options).actorName,
          summary,
        },
        () =>
          deps.issues.linkAsset(requirementId, issueId, {
            assetId,
            relationType,
          }),
      );
      return {
        issueId,
        assetId,
        relationType,
        linked: true,
      } satisfies McpIssueLinkWriteData;
    },
    "issue.unlinkAsset": (input, options) => {
      const { confirmationToken, idempotencyKey, ...payload } = input;
      const { requirementId, issueId, assetId } = payload;
      const target = issueTarget(requirementId, issueId);
      const summary = writeSummary("issue.unlinkAsset", payload);
      writes.execute(
        {
          tool: "issue.unlinkAsset",
          payload,
          idempotencyKey,
          confirmationToken,
          target,
          actorName: actorFor(options).actorName,
          summary,
        },
        () => deps.issues.unlinkAsset(requirementId, issueId, assetId),
      );
      return {
        issueId,
        assetId,
        unlinked: true,
      } satisfies McpIssueUnlinkWriteData;
    },
  };

  const prepare = (
    rawInput: unknown,
    options?: McpToolCallOptions,
  ): McpReadResult<McpWritePrepareData> => {
    const input = mcpWritePrepareInput.parse(rawInput);
    const payload = mcpWritePayloadSchemas[input.tool].parse(
      input.input,
    ) as Record<string, unknown>;
    const prepared = writes.prepare({
      tool: input.tool,
      payload,
      idempotencyKey: input.idempotencyKey,
      target: payloadTarget(payload),
      actorName: actorFor(options).actorName,
      summary: writeSummary(input.tool, payload),
    });
    return {
      notice: MCP_UNTRUSTED_CONTENT_NOTICE,
      data: prepared,
    };
  };

  const tools = new Map<McpToolName, McpToolExecutor>();
  for (const contract of mcpToolContracts) {
    if (contract.kind === "mutating" && !writes.isEnabled) continue;
    // 执行器只会收到本契约 schema 的解析结果，这里收窄为统一入参签名
    const handler = handlers[contract.name] as (
      input: unknown,
      options: McpToolCallOptions,
    ) => unknown;
    tools.set(contract.name, {
      name: contract.name,
      kind: contract.kind,
      execute: (input, options = {}) => ({
        notice: MCP_UNTRUSTED_CONTENT_NOTICE,
        data: handler(contract.input.parse(input), options),
      }),
    });
  }

  const fail = (
    code: McpErrorCode | "INTERNAL_ERROR",
    message: string,
  ): McpCallResult => ({ ok: false, error: { code, message } });
  return {
    tools,
    writeEnabled: writes.isEnabled,
    call: (name, input, options) => {
      try {
        if (name === "write.prepare") {
          if (!writes.isEnabled)
            throw new DomainError(
              "FORBIDDEN",
              "MCP 写入能力未启用：请显式设置 SUPERPM_MCP_WRITE=1 并重启服务",
              403,
            );
          return { ok: true, data: prepare(input, options) };
        }
        const tool = tools.get(name as McpToolName);
        if (!tool) {
          const contract = mcpToolContracts.find((item) => item.name === name);
          if (contract?.kind === "mutating")
            throw new DomainError(
              "FORBIDDEN",
              "MCP 写入能力未启用：请显式设置 SUPERPM_MCP_WRITE=1 并重启服务",
              403,
            );
          throw new DomainError("NOT_FOUND", `未知的 MCP 工具：${name}`, 404);
        }
        return { ok: true, data: tool.execute(input, options) };
      } catch (error) {
        if (error instanceof z.ZodError) {
          const issues = error.issues
            .map(
              (issue) => `${issue.path.join(".") || "input"}: ${issue.message}`,
            )
            .join("；");
          return fail(
            "VALIDATION_ERROR",
            `工具 ${name} 入参校验失败：${issues}`,
          );
        }
        if (error instanceof DomainError) {
          if ((MCP_ERROR_CODES as readonly string[]).includes(error.code))
            return fail(error.code as McpErrorCode, error.message);
          // 白名单以外的业务错误不透传原文，避免泄露路径或内部实现细节
          return fail("INTERNAL_ERROR", "工具执行失败");
        }
        throw error;
      }
    },
  };
}
