import { afterEach, describe, expect, it } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { projectRoot } from "../src/config/index.js";
import { AuthService } from "../src/services/auth.js";

const sourceMigrations = join(projectRoot, "apps/server/drizzle");
const timestamp = "2026-11-20T00:00:00.000Z";

function copyMigrationsThrough(target: string, version: number) {
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(sourceMigrations).filter(
    (name) =>
      name.endsWith(".sql") && Number(name.split("_")[0]) <= version,
  ))
    copyFileSync(join(sourceMigrations, file), join(target, file));
}

function seedDatabase(version: number) {
  const directory = mkdtempSync(join(tmpdir(), "superpm-project-migration-chain-"));
  const db = new Database(join(directory, "old.sqlite"));
  const oldMigrations = join(directory, "migrations");
  copyMigrationsThrough(oldMigrations, version);
  migrate(db, oldMigrations);
  new AuthService(db).ensureSeed();
  const owner = (
    db.prepare("SELECT id FROM users WHERE username='admin'").get() as {
      id: number;
    }
  ).id;
  return { directory, db, owner };
}

function createProjectFixture(db: Database.Database, owner: number) {
  const project = db
    .prepare(
      `INSERT INTO projects
        (project_no, name, owner_user_id, product_owner_user_id, created_by, created_at, updated_at)
       VALUES ('PRJ-MIGRATE-001', '迁移链项目', ?, ?, ?, ?, ?)`,
    )
    .run(owner, owner, owner, timestamp, timestamp);
  const projectId = Number(project.lastInsertRowid);
  const delivery = db
    .prepare(
      `INSERT INTO deliveries
        (project_id, name, is_default, created_by, created_at, updated_at)
       VALUES (?, '默认交付', 1, ?, ?, ?)`,
    )
    .run(projectId, owner, timestamp, timestamp);
  return { projectId, deliveryId: Number(delivery.lastInsertRowid) };
}

function createRequirement(db: Database.Database, owner: number, projectId?: number) {
  const columns = projectId == null
    ? "requirement_no,name,type,priority,description,status,current_stage,proposed_at,created_at,updated_at,user_id"
    : "requirement_no,name,type,priority,description,status,current_stage,proposed_at,created_at,updated_at,user_id,project_id";
  const values = projectId == null
    ? "'REQ-MIGRATE-001','迁移链需求','feature','medium','旧正文','draft','analysis','2026-11-20',?,?,?"
    : "'REQ-MIGRATE-001','迁移链需求','feature','medium','旧正文','draft','analysis','2026-11-20',?,?,?,?";
  const params = projectId == null
    ? [timestamp, timestamp, owner]
    : [timestamp, timestamp, owner, projectId];
  const row = db
    .prepare(`INSERT INTO requirements (${columns}) VALUES (${values})`)
    .run(...params);
  return Number(row.lastInsertRowid);
}

describe("项目管理 0022-0027 逐级旧库升级", () => {
  const temporaryDirectories: string[] = [];
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const directory of temporaryDirectories.splice(0))
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  for (const boundary of [21, 22, 23, 24, 25, 26]) {
    it(`从 ${boundary} 逐级升级到 0027 后保留业务数据且可重放`, () => {
      const fixture = seedDatabase(boundary);
      temporaryDirectories.push(fixture.directory);
      databases.push(fixture.db);
      const { db, owner } = fixture;
      const snapshots: Record<string, unknown> = {};

      if (boundary === 21) {
        const requirementId = createRequirement(db, owner);
        db.prepare(
          `INSERT INTO requirement_directories
            (requirement_id, directory_name, relative_path, status, initialized_at, created_at, updated_at, user_id)
           VALUES (?, 'REQ-MIGRATE-001 迁移链需求', 'requirements/REQ-MIGRATE-001 迁移链需求', 'completed', ?, ?, ?, ?)`,
        ).run(requirementId, timestamp, timestamp, timestamp, owner);
        snapshots.requirement = db
          .prepare("SELECT requirement_no, name, description, user_id FROM requirements WHERE id=?")
          .get(requirementId);
        snapshots.directory = db
          .prepare("SELECT directory_name, relative_path, user_id FROM requirement_directories WHERE requirement_id=?")
          .get(requirementId);
      } else {
        const { projectId, deliveryId } = createProjectFixture(db, owner);
        const requirementId = createRequirement(db, owner, projectId);
        snapshots.project = db
          .prepare("SELECT project_no, name, owner_user_id, product_owner_user_id FROM projects WHERE id=?")
          .get(projectId);
        snapshots.delivery = db
          .prepare("SELECT name, is_default, project_id FROM deliveries WHERE id=?")
          .get(deliveryId);
        snapshots.requirement = db
          .prepare("SELECT requirement_no, name, description, user_id, project_id FROM requirements WHERE id=?")
          .get(requirementId);

        if (boundary >= 23) {
          const task = db
            .prepare(
              `INSERT INTO project_tasks
                (project_id, requirement_id, title, type, assignee_user_id, confirmer_user_id, created_by, created_at, updated_at)
               VALUES (?, ?, '迁移任务', 'development', ?, ?, ?, ?, ?)`,
            )
            .run(projectId, requirementId, owner, owner, owner, timestamp, timestamp);
          const taskId = Number(task.lastInsertRowid);
          snapshots.task = db
            .prepare("SELECT title, project_id, requirement_id, assignee_user_id FROM project_tasks WHERE id=?")
            .get(taskId);
        }

        if (boundary >= 24) {
          const scope = db
            .prepare(
              `INSERT INTO delivery_scope_versions
                (delivery_id, scope_version, confirmed_by, confirmed_at)
               VALUES (?, 1, ?, ?)`,
            )
            .run(deliveryId, owner, timestamp);
          const scopeId = Number(scope.lastInsertRowid);
          db.prepare("UPDATE deliveries SET current_scope_version_id=? WHERE id=?").run(
            scopeId,
            deliveryId,
          );
          db.prepare(
            `INSERT INTO delivery_scope_items
              (scope_version_id, requirement_id, requirement_no, requirement_name, requirement_version)
             VALUES (?, ?, 'REQ-MIGRATE-001', '迁移链需求', 1)`,
          ).run(scopeId, requirementId);
          snapshots.scope = db
            .prepare("SELECT delivery_id, scope_version, confirmed_by FROM delivery_scope_versions WHERE id=?")
            .get(scopeId);
        }

        if (boundary >= 25) {
          const scopeId = (
            db.prepare("SELECT current_scope_version_id FROM deliveries WHERE id=?").get(
              deliveryId,
            ) as { current_scope_version_id: number }
          ).current_scope_version_id;
          const round = db
            .prepare(
              `INSERT INTO delivery_acceptance_rounds
                (delivery_id, scope_version_id, round_no, delivery_version, status, submitted_by, submitted_at)
               VALUES (?, ?, 1, 1, 'pending', ?, ?)`,
            )
            .run(deliveryId, scopeId, owner, timestamp);
          const roundId = Number(round.lastInsertRowid);
          db.prepare(
            `INSERT INTO delivery_acceptance_evidence
              (round_id, kind, source_kind, label, content, immutable, content_hash, snapshot_content, created_by, created_at)
             VALUES (?, 'text', 'manual', '验收说明', '旧验收证据', 1, 'hash-old', ?, ?, ?)`,
          ).run(roundId, Buffer.from("旧验收证据"), owner, timestamp);
          snapshots.acceptance = db
            .prepare("SELECT delivery_id, scope_version_id, round_no, status FROM delivery_acceptance_rounds WHERE id=?")
            .get(roundId);
        }

        if (boundary >= 26) {
          db.prepare(
            `INSERT INTO project_closures
              (project_id, action, from_status, to_status, reason, actor_user_id, actor_name_snapshot, created_at)
             VALUES (?, 'close', 'active', 'closed', '迁移前结项记录', ?, '管理员', ?)`,
          ).run(projectId, owner, timestamp);
          snapshots.closure = db
            .prepare("SELECT project_id, action, from_status, to_status, reason FROM project_closures WHERE project_id=?")
            .get(projectId);
        }
      }

      migrate(db);
      migrate(db);

      expect(
        db.prepare("SELECT version, COUNT(*) AS count FROM schema_migrations GROUP BY version HAVING COUNT(*) > 1").all(),
      ).toEqual([]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
        count: 27,
      });
      for (const [key, value] of Object.entries(snapshots)) {
        const table =
          key === "project"
            ? "projects"
            : key === "delivery"
              ? "deliveries"
              : key === "requirement"
                ? "requirements"
                : key === "directory"
                  ? "requirement_directories"
                  : key === "task"
                    ? "project_tasks"
                    : key === "scope"
                      ? "delivery_scope_versions"
                      : key === "acceptance"
                        ? "delivery_acceptance_rounds"
                        : "project_closures";
        // Different legacy tables use different primary-key names; each fixture
        // database contains one row for the table being checked.
        const row = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
        expect(row, key).toMatchObject(value as Record<string, unknown>);
      }
    });
  }
});
