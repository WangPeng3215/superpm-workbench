import type Database from "better-sqlite3";
import {
  optimizationPointConvertSchema,
  optimizationPointCreateSchema,
  optimizationPointListSchema,
  optimizationPointUpdateSchema,
  type OptimizationPoint,
  type OptimizationPointConversion,
  type OptimizationPointRequirementRef,
  type OptimizationPointStatus,
  type OptimizationPointSummary,
  type RequirementOptimizationPointRef,
} from "@superpm/shared";
import { DomainError, type RequirementService } from "./requirements.js";

interface OptimizationPointRow {
  id: number;
  name: string;
  module: string;
  description: string;
  description_html: string;
  remark: string;
  status: OptimizationPointStatus;
  requirement_id: number | null;
  created_at: string;
  updated_at: string;
  requirement_no: string | null;
  requirement_name: string | null;
  requirement_deleted_at: string | null;
}

// 关联需求用 LEFT JOIN 取回编号/名称：需求软删除后仍能识别「关联已失效」
const selectColumns = `p.id, p.name, p.module, p.description, p.description_html,
  p.remark, p.status, p.requirement_id, p.created_at, p.updated_at,
  r.requirement_no, r.name AS requirement_name, r.deleted_at AS requirement_deleted_at`;
const fromClause =
  "FROM optimization_points p LEFT JOIN requirements r ON r.id = p.requirement_id";

// 可更新字段：契约字段名 → 数据库列名
const mutableFields = [
  ["name", "name"],
  ["module", "module"],
  ["description", "description"],
  ["descriptionHtml", "description_html"],
  ["remark", "remark"],
  ["status", "status"],
] as const;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

// 列表摘要：正文是编辑器输出的纯文本投影，压缩空白后截断
function textSummary(text: string, maxLength = 100): string {
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain;
}

function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 优化点管理。
 *
 * 与正式需求是两个独立实体：本服务只维护优化点自身状态。
 * 转换时复用 RequirementService.createWithWorkspace——需求编号生成、记录入库、
 * 物理目录初始化都走既有那一套规则，不复制第二份建需逻辑。
 */
export class OptimizationPointService {
  constructor(
    private readonly db: Database.Database,
    private readonly requirements: RequirementService,
  ) {}

  /** 列表：关键词只匹配名称，按更新时间倒序（列表页与状态筛选共用） */
  list(input: unknown): OptimizationPointSummary[] {
    const query = optimizationPointListSchema.parse(input);
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.q) {
      clauses.push("p.name LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(query.q)}%`);
    }
    if (query.status) {
      clauses.push("p.status = ?");
      params.push(query.status);
    }
    const rows = this.db
      .prepare(
        `SELECT ${selectColumns} ${fromClause}
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY p.updated_at DESC, p.id DESC`,
      )
      .all(...params) as OptimizationPointRow[];
    return rows.map((row) => this.summary(row));
  }

  get(id: number): OptimizationPoint {
    const row = this.row(id);
    return {
      ...this.summary(row),
      description: row.description,
      descriptionHtml: row.description_html,
      remark: row.remark,
    };
  }

  create(input: unknown): OptimizationPoint {
    const parsed = optimizationPointCreateSchema.parse(input);
    const timestamp = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO optimization_points
          (name, module, description, description_html, remark, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        parsed.name,
        parsed.module,
        parsed.description,
        parsed.descriptionHtml,
        parsed.remark,
        timestamp,
        timestamp,
      );
    return this.get(Number(result.lastInsertRowid));
  }

  update(id: number, input: unknown): OptimizationPoint {
    const parsed = optimizationPointUpdateSchema.parse(input);
    return this.transaction(() => {
      const existing = this.row(id);
      if (parsed.status !== undefined)
        this.assertStatusChange(existing, parsed.status);
      const assignments: string[] = [];
      const values: (string | number)[] = [];
      for (const [field, column] of mutableFields) {
        const value = parsed[field];
        if (value === undefined) continue;
        assignments.push(`${column} = ?`);
        values.push(value);
      }
      assignments.push("updated_at = ?");
      values.push(new Date().toISOString());
      this.db
        .prepare(
          `UPDATE optimization_points SET ${assignments.join(", ")} WHERE id = ?`,
        )
        .run(...values, id);
      return this.get(id);
    });
  }

  remove(id: number): void {
    this.row(id);
    this.db.prepare("DELETE FROM optimization_points WHERE id = ?").run(id);
  }

  /**
   * 转为正式需求。
   *
   * 一致性设计：建需与回写关联放在同一个数据库事务里——任一步失败都整体回滚，
   * 不会出现「优化点显示已转换、但正式需求不存在」或反过来的孤立需求。
   * 目录初始化由 createWithWorkspace 内部的既有补偿机制处理：失败只把
   * requirement_directories 记为 failed 并记录阶段，不抛出、不回滚已建需求，
   * 用户可在需求详情「修复默认结构」重试；此时结果里的 workspaceReady 为 false。
   */
  convert(id: number, input: unknown): OptimizationPointConversion {
    const parsed = optimizationPointConvertSchema.parse(input ?? {});
    const point = this.get(id);
    // 关联有效时阻止重复转换；关联已失效（需求被删除）时允许重新转换
    if (point.requirement?.exists)
      throw new DomainError(
        "CONFLICT",
        `该优化点已转为正式需求 ${point.requirement.requirementNo}，不能重复转换`,
        409,
      );
    const created = this.transaction(() => {
      const result = this.requirements.createWithWorkspace({
        name: parsed.name ?? point.name,
        type: "improvement",
        priority: "P2",
        status: "not_started",
        currentStage: "analysis",
        // 正文整段作为需求详情继承：Markdown 与富文本都带上，需求详情打开即是同样内容
        description: parsed.description ?? point.description,
        descriptionHtml: parsed.descriptionHtml ?? point.descriptionHtml,
        proposedAt: today(),
      });
      this.db
        .prepare(
          "UPDATE optimization_points SET requirement_id = ?, status = 'converted', updated_at = ? WHERE id = ?",
        )
        .run(result.requirement.id, new Date().toISOString(), id);
      return result;
    });
    return {
      point: this.get(id),
      requirement: {
        id: created.requirement.id,
        requirementNo: created.requirement.requirementNo,
        name: created.requirement.name,
        workspaceReady: created.workspaceReady,
      },
    };
  }

  /** 正式需求详情反查：该需求来自哪些优化点（一对一关联，正常为一个） */
  byRequirement(requirementId: number): RequirementOptimizationPointRef[] {
    return this.db
      .prepare(
        `SELECT id, name, module, status FROM optimization_points
         WHERE requirement_id = ? ORDER BY id ASC`,
      )
      .all(requirementId) as RequirementOptimizationPointRef[];
  }

  private row(id: number): OptimizationPointRow {
    const row = this.db
      .prepare(`SELECT ${selectColumns} ${fromClause} WHERE p.id = ?`)
      .get(id) as OptimizationPointRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "优化点不存在", 404);
    return row;
  }

  private summary(row: OptimizationPointRow): OptimizationPointSummary {
    return {
      id: row.id,
      name: row.name,
      module: row.module,
      status: row.status,
      requirement: this.requirementRef(row),
      summary: textSummary(row.description),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private requirementRef(
    row: OptimizationPointRow,
  ): OptimizationPointRequirementRef | null {
    if (row.requirement_id === null || !row.requirement_no) return null;
    return {
      id: row.requirement_id,
      requirementNo: row.requirement_no,
      name: row.requirement_name ?? "",
      // 需求软删除时 RequirementService.remove 已清空关联；此处兜底识别历史数据
      exists: !row.requirement_deleted_at,
    };
  }

  /**
   * 状态流转规则（不记录历史，只校验本次变更）：
   * - converted 只能由「转为正式需求」产生，不允许手工设置；
   * - 已转换且关联有效时不允许改状态；关联失效（需求被删除）时允许改回其他状态；
   * - 其余四个状态之间可自由调整（含暂缓/不采纳重新回到评估中）。
   */
  private assertStatusChange(
    existing: OptimizationPointRow,
    next: OptimizationPointStatus,
  ) {
    if (next === existing.status) return;
    if (next === "converted")
      throw new DomainError(
        "VALIDATION_ERROR",
        "「已转正式需求」只能通过转为正式需求操作产生",
      );
    if (existing.status === "converted" && existing.requirement_id !== null)
      throw new DomainError(
        "CONFLICT",
        "已转为正式需求的优化点不能直接修改状态",
        409,
      );
  }

  private transaction<T>(fn: () => T) {
    return this.db.transaction(fn).immediate();
  }
}
