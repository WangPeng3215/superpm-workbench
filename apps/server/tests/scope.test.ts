import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  createScopedDatabase,
  rewriteStatement,
  runAsUser,
  ScopeError,
  type UserScope,
} from "../src/db/scope";

const user: UserScope = { userId: 7, isAdmin: false };
const admin: UserScope = { userId: 1, isAdmin: true };

function rewrite(sql: string, scope: UserScope = user) {
  return rewriteStatement(sql, scope);
}

describe("隔离语句改写", () => {
  it("查询自动追加 user_id 条件", () => {
    const result = rewrite(
      "SELECT * FROM artifact_nodes WHERE requirement_id=?",
    );
    expect(result?.sql).toBe(
      "SELECT * FROM artifact_nodes WHERE requirement_id=? and user_id = ?",
    );
    expect(result?.paramIndex).toBe(1);
  });

  it("没有 WHERE 的查询插入独立条件", () => {
    const result = rewrite("SELECT * FROM artifact_nodes");
    expect(result?.sql).toBe("SELECT * FROM artifact_nodes where user_id = ?");
    expect(result?.paramIndex).toBe(0);
  });

  it("排序与分页保持在注入点之后", () => {
    const result = rewrite(
      "SELECT * FROM daily_tasks WHERE plan_date=? ORDER BY sort_order LIMIT ?",
    );
    expect(result?.sql).toBe(
      "SELECT * FROM daily_tasks WHERE plan_date=? and user_id = ? ORDER BY sort_order LIMIT ?",
    );
    // 作用域参数插在 plan_date 之后、LIMIT 参数之前
    expect(result?.paramIndex).toBe(1);
  });

  it("更新时间语句不会漏掉归属条件", () => {
    const result = rewrite("UPDATE requirements SET name=? WHERE id=?");
    expect(result?.sql).toBe(
      "UPDATE requirements SET name=? WHERE id=? and user_id = ?",
    );
    expect(result?.paramIndex).toBe(2);
  });

  it("删除语句同样带归属条件", () => {
    const result = rewrite("DELETE FROM artifact_links WHERE id=?");
    expect(result?.sql).toBe(
      "DELETE FROM artifact_links WHERE id=? and user_id = ?",
    );
  });

  it("动态 IN 列表按占位符数量定位参数", () => {
    const result = rewrite(
      "DELETE FROM artifact_nodes WHERE id IN (?,?,?) AND requirement_id=?",
    );
    expect(result?.paramIndex).toBe(4);
    expect(result?.sql.endsWith("and user_id = ?")).toBe(true);
  });

  it("新增语句同时补列与补值", () => {
    const result = rewrite(
      "INSERT INTO notes(title, content, created_at) VALUES (?, ?, ?)",
    );
    expect(result?.sql).toBe(
      "INSERT INTO notes(title, content, created_at, user_id) VALUES (?, ?, ?, ?)",
    );
    expect(result?.paramIndex).toBe(3);
  });

  it("值列表里带函数调用也能定位插入点", () => {
    const result = rewrite(
      "INSERT INTO artifact_nodes(name, indexed_at) VALUES (lower(?), ?)",
    );
    expect(result?.sql).toBe(
      "INSERT INTO artifact_nodes(name, indexed_at, user_id) VALUES (lower(?), ?, ?)",
    );
    expect(result?.paramIndex).toBe(2);
  });

  it("系统表与常量查询原样返回", () => {
    expect(rewrite("SELECT 1")).toBeNull();
    expect(rewrite("SELECT * FROM users WHERE username=?")).toBeNull();
    expect(rewrite("SELECT value FROM app_meta WHERE key=?")).toBeNull();
    expect(rewrite("PRAGMA foreign_keys = ON")).toBeNull();
  });

  it("已显式书写 user_id 的语句不再改写", () => {
    expect(
      rewrite(
        "SELECT n.*, t.title FROM notes n LEFT JOIN daily_tasks t ON t.id=n.id AND t.user_id=? WHERE n.user_id=?",
      ),
    ).toBeNull();
  });

  it("超管不做过滤，但新增仍写入自己的归属", () => {
    expect(rewrite("SELECT * FROM requirements", admin)).toBeNull();
    expect(rewrite("DELETE FROM notes WHERE id=?", admin)).toBeNull();
    const inserted = rewrite("INSERT INTO notes(title) VALUES (?)", admin);
    expect(inserted?.sql).toContain("user_id");
  });

  it("多表联查与子查询要求显式声明，绝不静默放过", () => {
    expect(() =>
      rewrite(
        "SELECT * FROM issues i JOIN requirements r ON r.id=i.requirement_id",
      ),
    ).toThrow(ScopeError);
    expect(() => rewrite("SELECT * FROM (SELECT * FROM notes) n")).toThrow(
      ScopeError,
    );
    expect(() => rewrite("INSERT INTO notes SELECT * FROM notes")).toThrow(
      ScopeError,
    );
  });
});

describe("隔离数据库代理", () => {
  function createDatabase() {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        user_id INTEGER NOT NULL DEFAULT 0
      );
    `);
    return createScopedDatabase(db);
  }

  it("不同用户互不可见、互不可改", () => {
    const db = createDatabase();
    const id = runAsUser({ userId: 1, isAdmin: false }, () =>
      Number(
        db.prepare("INSERT INTO notes(title) VALUES (?)").run("甲的便签")
          .lastInsertRowid,
      ),
    );
    runAsUser({ userId: 2, isAdmin: false }, () => {
      expect(db.prepare("SELECT * FROM notes").all()).toHaveLength(0);
      expect(
        db.prepare("SELECT * FROM notes WHERE id=?").get(id),
      ).toBeUndefined();
      const changes = db
        .prepare("UPDATE notes SET title=? WHERE id=?")
        .run("被改掉", id).changes;
      expect(changes).toBe(0);
      const deleted = db
        .prepare("DELETE FROM notes WHERE id=?")
        .run(id).changes;
      expect(deleted).toBe(0);
    });
    // 甲的数据仍然完好
    runAsUser({ userId: 1, isAdmin: false }, () => {
      const row = db.prepare("SELECT title FROM notes WHERE id=?").get(id) as {
        title: string;
      };
      expect(row.title).toBe("甲的便签");
    });
  });

  it("数组式传参同样插入作用域参数", () => {
    const db = createDatabase();
    runAsUser({ userId: 3, isAdmin: false }, () => {
      db.prepare("INSERT INTO notes(title) VALUES (?)").run(["三条"]);
      const rows = db
        .prepare("SELECT title FROM notes WHERE title=?")
        .all(["三条"]);
      expect(rows).toHaveLength(1);
    });
    runAsUser({ userId: 4, isAdmin: false }, () => {
      expect(
        db.prepare("SELECT title FROM notes WHERE title=?").all(["三条"]),
      ).toHaveLength(0);
    });
  });

  it("超管可见全部用户数据", () => {
    const db = createDatabase();
    runAsUser({ userId: 1, isAdmin: false }, () =>
      db.prepare("INSERT INTO notes(title) VALUES (?)").run("甲"),
    );
    runAsUser({ userId: 2, isAdmin: false }, () =>
      db.prepare("INSERT INTO notes(title) VALUES (?)").run("乙"),
    );
    runAsUser({ userId: 99, isAdmin: true }, () => {
      expect(db.prepare("SELECT title FROM notes").all()).toHaveLength(2);
    });
  });
});
