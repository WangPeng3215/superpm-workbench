import type Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import type {
  McpConfirmedWriteToolName,
  McpWritePrepareData,
  McpWriteToolName,
} from "@superpm/shared";
import { DomainError } from "./requirements.js";

export interface McpWriteServiceOptions {
  enabled?: boolean;
  /** 确认令牌有效期，默认 5 分钟 */
  confirmationTtlMs?: number;
  /** 测试可注入时钟，生产使用系统时间 */
  now?: () => Date;
}

export interface McpWriteTarget {
  /** 问题写入关联的需求；会议/便签为独立实体，记为 null */
  requirementId: number | null;
  targetType: string;
  targetId: string;
}

export interface McpWriteRequest {
  tool: McpWriteToolName;
  /** 已通过契约 schema 解析的完整 payload（含 requirementId/issueId，不含确认令牌） */
  payload: Record<string, unknown>;
  idempotencyKey: string;
  confirmationToken?: string;
  target: McpWriteTarget;
  actorName: string;
  /** 不含正文的短摘要，用于审计与 prepare 返回 */
  summary: string;
}

/** 受确认写入的请求：工具必须属于受确认清单 */
export type McpConfirmedWriteRequest = Omit<
  McpWriteRequest,
  "tool" | "confirmationToken"
> & { tool: McpConfirmedWriteToolName };

interface ConfirmationRow {
  id: number;
  tool: string;
  requirement_id: number;
  target_type: string;
  target_id: string;
  params_hash: string;
  expires_at: string;
  used_at: string | null;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const TOKEN_BYTES = 32;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 稳定的 JSON 序列化，保证同一参数在 prepare/execute 得到同一哈希 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function paramsHash(
  tool: McpWriteToolName,
  payload: Record<string, unknown>,
  idempotencyKey: string,
) {
  return sha256(stableStringify({ tool, payload, idempotencyKey }));
}

function isUniqueConstraint(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    (error instanceof Error && /UNIQUE constraint failed/i.test(error.message))
  );
}

/**
 * M3 受控写入守卫：开关、确认令牌、幂等键与审计。
 *
 * - 默认禁用；只有显式 SUPERPM_MCP_WRITE=1 时构造为 enabled。
 * - 令牌只存 SHA-256 哈希，绑定工具 + 解析后的 payload + idempotencyKey，单次使用。
 * - 成功写入的幂等键持久化在 mcp_audit；重复提交返回 CONFLICT，不产生第二条业务记录。
 * - 审计只记录参数哈希、目标与结果摘要，不记录正文、原始令牌或绝对路径。
 */
export class McpWriteService {
  private readonly enabled: boolean;
  private readonly confirmationTtlMs: number;
  private readonly now: () => Date;

  constructor(
    private db: Database.Database,
    options: McpWriteServiceOptions = {},
  ) {
    this.enabled = options.enabled === true;
    this.confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  get isEnabled() {
    return this.enabled;
  }

  prepare(request: McpConfirmedWriteRequest): McpWritePrepareData {
    this.ensureEnabled();
    if (
      this.db
        .prepare("SELECT 1 FROM mcp_audit WHERE idempotency_key=?")
        .get(request.idempotencyKey)
    )
      throw new DomainError(
        "CONFLICT",
        "该 idempotencyKey 已完成过一次写入，请更换后重新提交",
        409,
      );

    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + this.confirmationTtlMs,
    ).toISOString();
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const hash = paramsHash(
      request.tool,
      request.payload,
      request.idempotencyKey,
    );
    try {
      this.db.transaction(() => {
        const inserted = this.db
          .prepare(
            `INSERT INTO mcp_write_confirmations
              (token_hash, tool, requirement_id, target_type, target_id, params_hash, idempotency_key, expires_at, used_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            sha256(token),
            request.tool,
            // 确认表 requirement_id 为历史非空列：独立实体写入用哨兵 0，审计表仍记 NULL
            request.target.requirementId ?? 0,
            request.target.targetType,
            request.target.targetId,
            hash,
            request.idempotencyKey,
            expiresAt,
            nowIso,
          );
        this.writeAudit({
          ...request,
          paramsHash: hash,
          idempotencyKey: null,
          confirmationId: Number(inserted.lastInsertRowid),
          outcome: "prepared",
          createdAt: nowIso,
        });
      })();
    } catch (error) {
      if (isUniqueConstraint(error))
        throw new DomainError(
          "CONFLICT",
          "该 idempotencyKey 已用于其他写入请求，请更换后重新提交",
          409,
        );
      throw error;
    }
    return {
      tool: request.tool,
      confirmationToken: token,
      expiresAt,
      summary: request.summary,
    };
  }

  execute<T>(request: McpWriteRequest, run: () => T): T {
    this.ensureEnabled();
    const token = request.confirmationToken?.trim();
    if (!token)
      throw new DomainError(
        "FORBIDDEN",
        "写操作必须先调用 write.prepare 获取确认令牌",
        403,
      );

    const nowIso = this.now().toISOString();
    const row = this.db
      .prepare(
        `SELECT id, tool, requirement_id, target_type, target_id, params_hash, expires_at, used_at
           FROM mcp_write_confirmations WHERE token_hash=?`,
      )
      .get(sha256(token)) as ConfirmationRow | undefined;
    if (!row)
      throw new DomainError(
        "FORBIDDEN",
        "确认令牌无效，请重新调用 write.prepare",
        403,
      );
    if (row.used_at)
      throw new DomainError(
        "FORBIDDEN",
        "确认令牌已使用，请重新调用 write.prepare",
        403,
      );
    if (row.expires_at <= nowIso)
      throw new DomainError(
        "FORBIDDEN",
        "确认令牌已过期，请重新调用 write.prepare",
        403,
      );

    const hash = paramsHash(
      request.tool,
      request.payload,
      request.idempotencyKey,
    );
    if (
      row.tool !== request.tool ||
      row.params_hash !== hash ||
      row.requirement_id !== (request.target.requirementId ?? 0) ||
      row.target_type !== request.target.targetType ||
      row.target_id !== request.target.targetId
    )
      throw new DomainError(
        "FORBIDDEN",
        "确认令牌与当前操作参数不匹配，请重新调用 write.prepare",
        403,
      );

    const duplicate = this.db
      .prepare("SELECT 1 FROM mcp_audit WHERE idempotency_key=?")
      .get(request.idempotencyKey);
    if (duplicate)
      throw new DomainError(
        "CONFLICT",
        "该 idempotencyKey 已完成过一次写入，请勿重复提交",
        409,
      );

    const marked = this.db
      .prepare(
        "UPDATE mcp_write_confirmations SET used_at=? WHERE id=? AND used_at IS NULL",
      )
      .run(nowIso, row.id);
    if (marked.changes !== 1)
      throw new DomainError(
        "FORBIDDEN",
        "确认令牌已使用，请重新调用 write.prepare",
        403,
      );

    try {
      return this.db.transaction(() => {
        const result = run();
        this.writeAudit({
          ...request,
          paramsHash: hash,
          idempotencyKey: request.idempotencyKey,
          confirmationId: row.id,
          outcome: "success",
          createdAt: nowIso,
        });
        return result;
      })();
    } catch (error) {
      this.writeAudit({
        ...request,
        paramsHash: hash,
        idempotencyKey: null,
        confirmationId: row.id,
        outcome: "error",
        errorCode: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
        createdAt: nowIso,
      });
      throw error;
    }
  }

  /**
   * 低风险自动写入：不需要确认令牌，但仍强制写开关、幂等键、业务服务与审计。
   * 仅用于需求记忆与普通文本产出物；删除、跨项目与权限变更不得走此通道。
   */
  executeAuto<T>(
    request: Omit<McpWriteRequest, "confirmationToken">,
    run: () => T,
  ): T {
    this.ensureEnabled();
    const nowIso = this.now().toISOString();
    const duplicate = this.db
      .prepare("SELECT 1 FROM mcp_audit WHERE idempotency_key=?")
      .get(request.idempotencyKey);
    if (duplicate)
      throw new DomainError(
        "CONFLICT",
        "该 idempotencyKey 已完成过一次写入，请勿重复提交",
        409,
      );

    const hash = paramsHash(
      request.tool,
      request.payload,
      request.idempotencyKey,
    );
    try {
      return this.db.transaction(() => {
        const result = run();
        this.writeAudit({
          ...request,
          paramsHash: hash,
          idempotencyKey: request.idempotencyKey,
          confirmationId: null,
          outcome: "success",
          createdAt: nowIso,
        });
        return result;
      })();
    } catch (error) {
      this.writeAudit({
        ...request,
        paramsHash: hash,
        idempotencyKey: null,
        confirmationId: null,
        outcome: "error",
        errorCode: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
        createdAt: nowIso,
      });
      throw error;
    }
  }

  private ensureEnabled() {
    if (!this.enabled)
      throw new DomainError(
        "FORBIDDEN",
        "MCP 写入能力未启用：请显式设置 SUPERPM_MCP_WRITE=1 并重启服务",
        403,
      );
  }

  private writeAudit(input: {
    tool: McpWriteToolName;
    target: McpWriteTarget;
    paramsHash: string;
    idempotencyKey: string | null;
    confirmationId: number | null;
    actorName: string;
    outcome: "prepared" | "success" | "error";
    errorCode?: string;
    summary: string;
    createdAt: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO mcp_audit
          (tool, requirement_id, target_type, target_id, params_hash, idempotency_key, confirmation_id, actor_name, outcome, error_code, result_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tool,
        input.target.requirementId,
        input.target.targetType,
        input.target.targetId,
        input.paramsHash,
        input.idempotencyKey,
        input.confirmationId,
        input.actorName,
        input.outcome,
        input.errorCode ?? null,
        input.summary,
        input.createdAt,
      );
  }
}
