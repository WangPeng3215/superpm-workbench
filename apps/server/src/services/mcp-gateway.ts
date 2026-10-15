import { z } from "zod";
import {
  mcpToolContracts,
  type McpAssetCreateInput,
  type McpAssetGetInput,
  type McpAssetListInput,
  type McpAssetUpdateStatusInput,
  type McpIssueActivitiesInput,
  type McpIssueCommentInput,
  type McpIssueCreateInput,
  type McpIssueGetInput,
  type McpIssueLinkAssetInput,
  type McpIssueListInput,
  type McpIssueUnlinkAssetInput,
  type McpIssueUpdateInput,
  type McpRequirementGetInput,
  type McpRequirementListInput,
  type McpToolKind,
  type McpToolName,
} from "@superpm/shared";
import { DomainError, RequirementService } from "./requirements.js";
import { RequirementFileService } from "./requirement-files.js";
import { IssueService } from "./issues.js";

/**
 * MCP 服务网关（主开发文档阶段 10）：契约层的唯一执行入口。
 *
 * 安全边界（显式声明）：
 * - 网关不提供任何接受 SQL 字符串、绝对路径或文件系统路径参数的工具；
 *   所有数据访问都经由业务服务完成，文件读取只经 assetId 间接访问，
 *   路径解析、越权校验、软删除与协议白名单全部收敛在业务服务内部。
 * - 不做第二套业务逻辑：执行器只做“契约校验 + 转发”，读写的权威实现都在
 *   RequirementService / RequirementFileService / IssueService。
 * - DomainError / ZodError 统一转换为 { error: { code, message } } 结构化返回，
 *   供模型理解失败原因并自行恢复；非预期异常原样上抛，由未来的 MCP server
 *   本体统一兜底（不得直接把堆栈透给模型）。
 */

export interface McpGatewayDeps {
  requirements: RequirementService;
  files: RequirementFileService;
  issues: IssueService;
}

export interface McpToolExecuteOptions {
  /** mutating 工具必填：幂等键，同键重复调用只执行首次 */
  idempotencyKey?: string;
}

export interface McpToolExecutor {
  readonly name: McpToolName;
  readonly kind: McpToolKind;
  execute(input: unknown, options?: McpToolExecuteOptions): unknown;
}

export interface McpGateway {
  /** 工具执行器映射：与 mcpToolContracts 一一对应（契约多少个，执行器就多少个） */
  readonly tools: ReadonlyMap<McpToolName, McpToolExecutor>;
  /**
   * 推荐调用入口：未知工具 / 入参非法 / 业务失败均返回结构化错误而非抛出。
   * readonly 工具忽略 options；mutating 工具必须携带 options.idempotencyKey。
   */
  call(name: string, input?: unknown, options?: McpToolExecuteOptions): unknown;
}

/**
 * 幂等包装：mutating 工具必须携带非空 idempotencyKey，网关内存 store 以
 * `${toolName}:${idempotencyKey}` 为键；命中直接返回首次结果，不重复执行。
 * 只有成功结果会入缓存（失败调用不占用幂等键，可用同键重试）。
 *
 * 局限说明：store 为进程内 Map，无 TTL、无持久化、不跨进程共享；服务重启后
 * 同幂等键会重新执行。TTL 与持久化留给 MCP server 本体阶段实现。
 */
export function withIdempotency(
  store: Map<string, unknown>,
  toolName: McpToolName,
  execute: (input: unknown) => unknown,
) {
  return (input: unknown, options?: McpToolExecuteOptions): unknown => {
    const key = options?.idempotencyKey;
    if (typeof key !== "string" || key.trim() === "")
      throw new DomainError(
        "VALIDATION_ERROR",
        "写操作必须携带非空幂等键 idempotencyKey",
      );
    const storeKey = `${toolName}:${key}`;
    if (store.has(storeKey)) return store.get(storeKey);
    const result = execute(input);
    store.set(storeKey, result);
    return result;
  };
}

/** 各工具入参的解析后类型（与契约 schema 的 z.output 一一对应） */
interface McpToolInputs {
  "requirement.list": McpRequirementListInput;
  "requirement.get": McpRequirementGetInput;
  "asset.list": McpAssetListInput;
  "asset.get": McpAssetGetInput;
  "issue.list": McpIssueListInput;
  "issue.get": McpIssueGetInput;
  "issue.activities": McpIssueActivitiesInput;
  "issue.create": McpIssueCreateInput;
  "issue.update": McpIssueUpdateInput;
  "issue.comment": McpIssueCommentInput;
  "issue.linkAsset": McpIssueLinkAssetInput;
  "issue.unlinkAsset": McpIssueUnlinkAssetInput;
  "asset.create": McpAssetCreateInput;
  "asset.updateStatus": McpAssetUpdateStatusInput;
}

/**
 * 构建 MCP 工具执行器映射。
 * 遍历 mcpToolContracts 建立执行器：readonly 直接转发；mutating 先包一层幂等。
 * 入参在执行器内部按契约 schema 校验后再转发给业务服务。
 */
export function buildMcpTools(deps: McpGatewayDeps): McpGateway {
  const idempotencyStore = new Map<string, unknown>();
  // 入参已经过契约 schema 校验（含默认值填充），这里只做解构转发
  const handlers: { [K in McpToolName]: (input: McpToolInputs[K]) => unknown } = {
    "requirement.list": (input) => deps.requirements.list(input),
    "requirement.get": (input) => deps.requirements.get(input.id),
    "asset.list": (input) => deps.files.list(input.requirementId, input.phase, input.all),
    "asset.get": (input) => deps.files.content(input.requirementId, input.assetId),
    "issue.list": (input) => deps.issues.list(input.requirementId, input.phase, input.status),
    "issue.get": (input) => deps.issues.detail(input.requirementId, input.issueId),
    "issue.activities": (input) => ({
      items: deps.issues.detail(input.requirementId, input.issueId).activities,
    }),
    "issue.create": (input) => {
      const { requirementId, ...payload } = input;
      return deps.issues.create(requirementId, payload);
    },
    "issue.update": (input) => {
      const { requirementId, issueId, ...patch } = input;
      // solution 守卫：AI 提交 solution 不得隐式把问题置为已解决——
      // “保存解决方案”与“状态变更”必须分两步显式调用
      if (patch.solution !== undefined && patch.status === "resolved")
        throw new DomainError(
          "VALIDATION_ERROR",
          "不允许一次调用同时提交 solution 并将状态置为 resolved：请先单独保存解决方案，再显式发起一次状态变更",
        );
      return deps.issues.update(requirementId, issueId, patch);
    },
    "issue.comment": (input) => {
      const { requirementId, issueId, ...payload } = input;
      return deps.issues.comment(requirementId, issueId, payload);
    },
    "issue.linkAsset": (input) => {
      const { requirementId, issueId, ...payload } = input;
      return deps.issues.linkAsset(requirementId, issueId, payload);
    },
    "issue.unlinkAsset": (input) =>
      deps.issues.unlinkAsset(input.requirementId, input.issueId, input.assetId),
    "asset.create": (input) => {
      const { requirementId, ...payload } = input;
      return deps.files.create(requirementId, payload);
    },
    "asset.updateStatus": (input) => {
      const { requirementId, assetId, ...patch } = input;
      return deps.files.update(requirementId, assetId, patch);
    },
  };
  const tools = new Map<McpToolName, McpToolExecutor>();
  for (const contract of mcpToolContracts) {
    // 执行器只会收到本契约 schema 的解析结果，这里收窄为统一入参签名
    const handler = handlers[contract.name] as (input: unknown) => unknown;
    const run = (input: unknown) => handler(contract.input.parse(input));
    tools.set(contract.name, {
      name: contract.name,
      kind: contract.kind,
      execute:
        contract.kind === "mutating"
          ? withIdempotency(idempotencyStore, contract.name, run)
          : (input) => run(input),
    });
  }
  return {
    tools,
    call: (name, input, options) => {
      try {
        const tool = tools.get(name as McpToolName);
        if (!tool) throw new DomainError("NOT_FOUND", `未知的 MCP 工具：${name}`, 404);
        return tool.execute(input, options);
      } catch (error) {
        if (error instanceof z.ZodError) {
          const issues = error.issues
            .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
            .join("；");
          return {
            error: { code: "VALIDATION_ERROR", message: `工具 ${name} 入参校验失败：${issues}` },
          };
        }
        if (error instanceof DomainError)
          return { error: { code: error.code, message: error.message } };
        throw error;
      }
    },
  };
}
