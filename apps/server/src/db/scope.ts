import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";

/**
 * 用户数据隔离地基（开发文档 §3「单库 + user_id」）
 *
 * 设计要点：
 * 1. 作用域随请求流转：HTTP 入口在 onRequest 钩子里建立用户作用域，
 *    之后该请求链路上所有 Service 的同步 SQL 都归属同一用户。
 * 2. 隔离条件由数据库代理自动追加，而不是靠每个 Service 自觉拼 user_id：
 *    只要语句落在业务表上，要么被自动加上 `user_id = ?`，要么直接抛错。
 *    因此「漏改某个接口」不会变成越权，而是立刻报错。
 * 3. 系统作用域（迁移、种子、定时补偿、MCP、命令行）不做隔离，
 *    等价于本机系统身份；HTTP 请求永远不会落在这个作用域里。
 */

export interface UserScope {
  userId: number;
  /** 超管：可读全部用户数据（写仍然归属本人） */
  isAdmin: boolean;
}

/**
 * 需要按用户隔离的表。users / app_meta / schema_migrations 属于系统表，不在此列。
 * 新增业务表时必须同步加入本集合，否则新建的表不会被隔离。
 */
export const SCOPED_TABLES: ReadonlySet<string> = new Set([
  "requirements",
  "requirement_history",
  "requirement_audit",
  "requirement_workspaces",
  "requirement_files",
  "requirement_directories",
  "issues",
  "issue_activities",
  "issue_assets",
  "artifact_nodes",
  "artifact_links",
  "issue_artifact_links",
  "daily_tasks",
  "daily_time_entries",
  "daily_time_entry_audits",
  "meetings",
  "meeting_requirements",
  "notes",
  "optimization_points",
  "online_tools",
  "mcp_write_confirmations",
  "mcp_audit",
]);

/** 隔离语句无法自动改写时的错误：宁可整条语句失败，也不能放过潜在越权 */
export class ScopeError extends Error {
  readonly sql: string;
  constructor(message: string, sql: string) {
    super(message);
    this.name = "ScopeError";
    this.sql = sql;
  }
}

const storage = new AsyncLocalStorage<UserScope | null>();

/** 在指定用户作用域内执行（同步链路，用于请求入口） */
export function runAsUser<T>(scope: UserScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** 以系统身份执行：迁移、种子、定时补偿、MCP、命令行等本机可信路径 */
export function runAsSystem<T>(fn: () => T): T {
  return storage.run(null, fn);
}

/** 当前作用域；null 表示系统身份 */
export function currentUserScope(): UserScope | null {
  return storage.getStore() ?? null;
}

/** 把字符串字面量、引号标识符与注释抹成空格（等长替换，下标与原 SQL 对齐） */
export function maskLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      // SQLite 用连写两个引号表示转义，遇到引号先看下一个字符
      out += " ";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            out += "  ";
            i += 2;
            continue;
          }
          out += " ";
          i += 1;
          break;
        }
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    if (ch === "[") {
      out += " ";
      i += 1;
      while (i < sql.length && sql[i] !== "]") {
        out += " ";
        i += 1;
      }
      out += " ";
      i += 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += sql[i] === "*" ? "  " : "";
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 从 index 起跳过空白后的标识符（支持 schema.table、引号、方括号），返回名字末段 */
function readIdentifier(
  masked: string,
  index: number,
): { name: string; end: number } | null {
  let i = index;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  const start = i;
  while (i < masked.length && /[A-Za-z0-9_$]/.test(masked[i])) i += 1;
  if (i === start) return null;
  const name = masked.slice(start, i).toLowerCase();
  return { name, end: i };
}

/** 找到与 start（指向 "(" ）匹配的右括号下标；找不到返回 -1 */
function matchParen(masked: string, start: number): number {
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    if (masked[i] === "(") depth += 1;
    else if (masked[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 在 depth 0 上查找关键字，返回其起始下标；找不到返回 -1 */
export function findTopLevel(
  masked: string,
  keyword: string,
  from = 0,
): number {
  let depth = 0;
  // 逐字符推进，确保只匹配顶层（括号深度 0）的关键字
  for (let i = from; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(depth - 1, 0);
    else if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(masked.slice(i))?.[0] ?? "";
      if (word.toLowerCase() === keyword.toLowerCase()) return i;
      i += Math.max(word.length - 1, 0);
    }
  }
  return -1;
}

/** 语句尾部子句的起点：注入点必须落在这些关键字之前 */
const TAIL_KEYWORDS = ["group", "order", "limit", "union", "having", "window"];

function firstTailClause(masked: string, from: number): number {
  let best = -1;
  for (const keyword of TAIL_KEYWORDS) {
    const index = findTopLevel(masked, keyword, from);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  const semicolon = masked.indexOf(";", from);
  if (semicolon >= 0 && (best < 0 || semicolon < best)) best = semicolon;
  return best < 0 ? masked.length : best;
}

/** 注入点回退到前一个非空白字符之后，避免写出 "? and user_id = ?ORDER BY" */
function trimInsertPoint(masked: string, index: number): number {
  let i = index;
  while (i > 0 && /\s/.test(masked[i - 1])) i -= 1;
  return i;
}

function countPlaceholdersBefore(masked: string, index: number): number {
  let count = 0;
  for (let i = 0; i < index && i < masked.length; i += 1) {
    if (masked[i] === "?") count += 1;
  }
  return count;
}

function mentionsScopedTable(masked: string): string[] {
  const found: string[] = [];
  for (const table of SCOPED_TABLES) {
    if (new RegExp(`\\b${table}\\b`, "i").test(masked)) found.push(table);
  }
  return found;
}

export interface ScopeRewrite {
  sql: string;
  /** 作用域参数在调用方参数数组中的插入位置 */
  paramIndex: number;
}

/**
 * 手写 JOIN 语句时使用：返回需要拼进 SQL 的归属片段与参数。
 *
 * 多表联查无法安全地自动改写（别名、子查询、聚合都可能歧义），这类语句必须
 * 显式书写 user_id——本函数只是把「当前作用域取值」收敛到一处，避免各服务各写一份。
 * 约定用法：
 *   const owner = ownerFilterSql("n");
 *   db.prepare(`SELECT ... FROM notes n LEFT JOIN ... ON t.id=n.x AND t.user_id=n.user_id
 *               WHERE n.is_archived=? ${owner.sql} ORDER BY ...`).all(...[archived, ...owner.params])
 * 系统身份与超管返回空片段，保持全库可见。
 */
export function ownerFilterSql(alias: string): {
  sql: string;
  params: number[];
} {
  const scope = currentUserScope();
  if (!scope || scope.isAdmin) return { sql: "", params: [] };
  return { sql: ` AND ${alias}.user_id = ?`, params: [scope.userId] };
}

/**
 * 按作用域改写单条语句。
 * 返回 null 表示无需改写（非业务表、超管读、或语句已显式带 user_id）。
 * 无法安全改写时抛 ScopeError，绝不静默跳过。
 */
export function rewriteStatement(
  sql: string,
  scope: UserScope,
): ScopeRewrite | null {
  const masked = maskLiterals(sql);
  const trimmed = masked.trimStart();
  if (!trimmed) return null;
  const leading = /^[A-Za-z_]+/.exec(trimmed)?.[0]?.toLowerCase() ?? "";

  if (leading === "insert") return rewriteInsert(sql, masked, scope);
  if (leading === "update")
    return rewriteFiltered(sql, masked, scope, "update");
  if (leading === "delete")
    return rewriteFiltered(sql, masked, scope, "delete");
  if (leading === "select")
    return rewriteFiltered(sql, masked, scope, "select");
  return null;
}

function assertNoNamedParams(masked: string, sql: string) {
  if (/(^|[\s,(=])([:@$])[A-Za-z_]/.test(masked))
    throw new ScopeError("隔离语句不支持命名参数，请统一使用位置参数 ?", sql);
}

function rewriteInsert(
  sql: string,
  masked: string,
  scope: UserScope,
): ScopeRewrite | null {
  const match = /^\s*insert\s+(?:or\s+[a-z]+\s+)?into\s+/i.exec(masked);
  if (!match) return null;
  const table = readIdentifier(masked, match[0].length);
  if (!table || !SCOPED_TABLES.has(table.name)) return null;
  // 调用方已显式写入归属列时不再改写
  if (/\buser_id\b/i.test(masked)) return null;
  assertNoNamedParams(masked, sql);

  let i = table.end;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  if (masked[i] !== "(")
    throw new ScopeError(
      `新增 ${table.name} 记录必须显式列出列名，无法自动写入 user_id`,
      sql,
    );
  const columnsEnd = matchParen(masked, i);
  if (columnsEnd < 0)
    throw new ScopeError(`无法解析 ${table.name} 的列表`, sql);
  const valuesIndex = findTopLevel(masked, "values", columnsEnd + 1);
  if (valuesIndex < 0)
    throw new ScopeError(
      `新增 ${table.name} 记录只支持 VALUES 形式，无法自动写入 user_id`,
      sql,
    );
  let valuesStart = valuesIndex + "values".length;
  while (valuesStart < masked.length && /\s/.test(masked[valuesStart]))
    valuesStart += 1;
  if (masked[valuesStart] !== "(")
    throw new ScopeError(`无法解析 ${table.name} 的取值列表`, sql);
  const valuesEnd = matchParen(masked, valuesStart);
  if (valuesEnd < 0)
    throw new ScopeError(`无法解析 ${table.name} 的取值列表`, sql);

  // 先改取值列表再改列表，避免前一处插入影响后一处的下标
  let next = sql.slice(0, valuesEnd) + ", ?" + sql.slice(valuesEnd);
  next = next.slice(0, columnsEnd) + ", user_id" + next.slice(columnsEnd);
  return {
    sql: next,
    paramIndex: countPlaceholdersBefore(masked, valuesEnd),
  };
}

function rewriteFiltered(
  sql: string,
  masked: string,
  scope: UserScope,
  kind: "select" | "update" | "delete",
): ScopeRewrite | null {
  const mentioned = mentionsScopedTable(masked);
  if (!mentioned.length) return null;
  // 超管：读全库、可维护任意用户数据，因此不做任何归属过滤
  if (scope.isAdmin) return null;
  if (/\buser_id\b/i.test(masked)) return null;
  if (mentioned.length > 1)
    throw new ScopeError(
      `语句涉及多张业务表（${mentioned.join("、")}），隔离条件必须显式书写 user_id`,
      sql,
    );
  assertNoNamedParams(masked, sql);

  let table: { name: string; end: number } | null = null;
  if (kind === "select") {
    const fromIndex = findTopLevel(masked, "from");
    if (fromIndex < 0) return null;
    let i = fromIndex + "from".length;
    while (i < masked.length && /\s/.test(masked[i])) i += 1;
    if (masked[i] === "(")
      throw new ScopeError("不支持对子查询做自动隔离，请显式书写 user_id", sql);
    table = readIdentifier(masked, i);
  } else if (kind === "update") {
    const match = /^\s*update\s+(?:or\s+[a-z]+\s+)?/i.exec(masked);
    table = match ? readIdentifier(masked, match[0].length) : null;
  } else {
    const match = /^\s*delete\s+from\s+/i.exec(masked);
    table = match ? readIdentifier(masked, match[0].length) : null;
  }
  if (!table || !SCOPED_TABLES.has(table.name)) return null;
  if (mentioned[0] !== table.name)
    throw new ScopeError(
      `语句主表 ${table.name} 与业务表 ${mentioned[0]} 不一致，请显式书写 user_id`,
      sql,
    );

  const whereIndex = findTopLevel(masked, "where", table.end);
  const cutoff = trimInsertPoint(masked, firstTailClause(masked, table.end));
  if (whereIndex >= 0 && whereIndex < cutoff) {
    const next = sql.slice(0, cutoff) + " and user_id = ?" + sql.slice(cutoff);
    return { sql: next, paramIndex: countPlaceholdersBefore(masked, cutoff) };
  }
  const next = sql.slice(0, cutoff) + " where user_id = ?" + sql.slice(cutoff);
  return { sql: next, paramIndex: countPlaceholdersBefore(masked, cutoff) };
}

type Statement = Database.Statement;

function normalizeArgs(args: unknown[]): unknown[] {
  if (args.length === 1 && Array.isArray(args[0])) return [...args[0]];
  return args;
}

function withScopeParam(
  args: unknown[],
  paramIndex: number,
  value: unknown,
): unknown[] {
  const flat = normalizeArgs(args);
  const index = Math.min(Math.max(paramIndex, 0), flat.length);
  const next = [...flat];
  next.splice(index, 0, value);
  return next;
}

/** 用代理包住 Statement，把作用域参数插入到改写语句预留的位置 */
function wrapStatement(
  statement: Statement,
  rewrite: ScopeRewrite,
  value: unknown,
): Statement {
  const wrapper = new Proxy(statement, {
    get(target, property, receiver) {
      if (
        property === "run" ||
        property === "get" ||
        property === "all" ||
        property === "iterate"
      ) {
        const original = (target as unknown as Record<string, unknown>)[
          property
        ] as (...params: unknown[]) => unknown;
        return (...args: unknown[]) =>
          original.apply(
            target,
            withScopeParam(args, rewrite.paramIndex, value),
          );
      }
      if (
        property === "bind" ||
        property === "pluck" ||
        property === "raw" ||
        property === "expand" ||
        property === "safeIntegers"
      ) {
        const original = (target as unknown as Record<string, unknown>)[
          property
        ] as (...params: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const result = original.apply(target, args);
          // 链式方法返回语句自身，需要继续返回代理，保证作用域参数仍然被插入
          return result === target ? receiver : result;
        };
      }
      return Reflect.get(target, property, target);
    },
  });
  return wrapper;
}

/**
 * 包装数据库：所有 prepare 出来的语句在执行业务表时自动带用户隔离。
 * 未处于任何作用域（系统身份）时原样透传。
 */
export function createScopedDatabase(db: Database.Database): Database.Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const scope = currentUserScope();
          if (!scope) return target.prepare(sql);
          const rewrite = rewriteStatement(sql, scope);
          if (!rewrite) return target.prepare(sql);
          return wrapStatement(
            target.prepare(rewrite.sql),
            rewrite,
            scope.userId,
          );
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
