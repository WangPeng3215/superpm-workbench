import { describe, expect, it } from "vitest";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate";
import { projectRoot } from "../src/config";
import { AuthService } from "../src/services/auth";
describe("项目迁移保留旧需求及工作区映射", () => {
  it("0021旧库升级不猜归属、不建项目、保持编号与作者；重跑幂等且外键有效", () => {
    const dir = mkdtempSync(join(tmpdir(), "superpm-project-migrate-"));
    const db = new Database(join(dir, "old.sqlite"));
    try {
      const old = join(dir, "migrations");
      mkdirSync(old);
      const source = join(projectRoot, "apps/server/drizzle");
      for (const file of readdirSync(source).filter(
        (f) => f.endsWith(".sql") && Number(f.split("_")[0]) <= 21,
      ))
        copyFileSync(join(source, file), join(old, file));
      migrate(db, old);
      new AuthService(db).ensureSeed();
      const owner = (
        db.prepare("SELECT id FROM users WHERE username='admin'").get() as {
          id: number;
        }
      ).id;
      db.prepare(
        "INSERT INTO requirements(requirement_no,name,type,priority,description,status,current_stage,proposed_at,created_at,updated_at,user_id) VALUES ('REQ-0042','历史私人需求','feature','P2','正文','not_started','analysis','2026-01-01','old-created','old-updated',?)",
      ).run(owner);
      const before = db.prepare("SELECT * FROM requirements").get() as Record<
        string,
        unknown
      >;
      db.prepare(
        "INSERT INTO requirement_directories(requirement_id,directory_name,relative_path,status,initialized_at,created_at,updated_at,user_id) VALUES (?,'REQ-0042 历史私人需求','requirements/REQ-0042 历史私人需求','completed','old-init','old-created','old-updated',?)",
      ).run(before.id, owner);
      const mapping = db.prepare("SELECT * FROM requirement_directories").all();
      migrate(db);
      migrate(db);
      const after = db.prepare("SELECT * FROM requirements").get() as Record<
        string,
        unknown
      >;
      for (const [key, value] of Object.entries(before))
        expect(after[key], key).toEqual(value);
      expect(db.prepare("SELECT * FROM requirement_directories").all()).toEqual(
        mapping,
      );
      expect(after).toMatchObject({
        project_id: null,
        assignee_user_id: null,
        developer_user_id: null,
        acceptance_criteria: "",
        version: 1,
      });
      expect(
        (
          db.prepare("SELECT count(*) AS n FROM projects").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
      expect(
        (
          db.prepare("SELECT count(*) AS n FROM deliveries").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM requirements WHERE project_id=? AND deleted_at IS NULL",
        )
        .all(1);
      expect(JSON.stringify(plan)).toContain(
        "requirements_project_deleted_idx",
      );
      expect(
        (
          db
            .prepare(
              "SELECT count(*) AS n FROM schema_migrations WHERE version=22",
            )
            .get() as { n: number }
        ).n,
      ).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
