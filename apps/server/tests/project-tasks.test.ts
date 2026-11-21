import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate";
import { runAsUser } from "../src/db/scope";
import { ProjectTaskService } from "../src/services/project-tasks";
import { ProjectService } from "../src/services/projects";

describe("project task service", () => {
  let db: Database.Database;
  let tasks: ProjectTaskService;
  let projectId: number;
  const owner = 1;
  const assignee = 2;
  const confirmer = 3;
  const viewer = 4;
  const stranger = 5;
  const admin = 6;
  const as = <T>(userId: number, fn: () => T): T =>
    runAsUser({ userId, isAdmin: false }, fn);

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    const user = db.prepare(
      "INSERT INTO users(username,display_name,password_hash,password_salt,created_at,updated_at) VALUES(?,?,'x','x','now','now')",
    );
    for (let id = owner; id <= admin; id++)
      user.run("actor" + id, "Actor " + id);
    const projects = new ProjectService(db);
    tasks = new ProjectTaskService(db);
    projectId = as(
      owner,
      () => projects.create({ name: "Task project" }, "project").project.id,
    );
    for (const [userId, role] of [
      [assignee, "contributor"],
      [confirmer, "contributor"],
      [viewer, "viewer"],
    ]) {
      db.prepare(
        "INSERT INTO project_members(project_id,user_id,joined_at) VALUES (?,?,'now')",
      ).run(projectId, userId);
      db.prepare(
        "INSERT INTO project_member_roles(project_id,user_id,role) VALUES (?,?,?)",
      ).run(projectId, userId, role);
    }
  });
  afterEach(() => db.close());

  const createInput = {
    type: "development",
    title: "Implement workflow",
    assigneeUserId: assignee,
    confirmerUserId: confirmer,
  };

  it("requires active project roles and returns scoped task capabilities", () => {
    const task = as(owner, () => tasks.create(projectId, createInput));
    expect(task).toMatchObject({
      status: "pending",
      previousStatus: null,
      version: 1,
      createdBy: owner,
    });
    expect(task.actions).toMatchObject([
      {
        action: "created",
        actorUserId: owner,
        actorNameSnapshot: "Actor 1",
        changes: {
          title: { after: "Implement workflow" },
          assigneeUserId: { after: assignee },
        },
      },
    ]);
    expect(
      as(assignee, () => tasks.list(projectId, { assigneeUserId: assignee }))
        .items[0].capabilities,
    ).toMatchObject({
      canEdit: true,
      canPlan: true,
      actions: expect.arrayContaining(["start", "block"]),
    });
    expect(as(viewer, () => tasks.get(task.id)).capabilities).toEqual({
      canEdit: false,
      canPlan: false,
      actions: [],
    });
    expect(() => as(stranger, () => tasks.get(task.id))).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(() =>
      as(viewer, () => tasks.create(projectId, createInput)),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() =>
      runAsUser({ userId: admin, isAdmin: true }, () =>
        tasks.create(projectId, createInput),
      ),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("revokes task write capabilities when an assignee is demoted to viewer", () => {
    const task = as(owner, () => tasks.create(projectId, createInput));
    db.prepare(
      "DELETE FROM project_member_roles WHERE project_id=? AND user_id=?",
    ).run(projectId, assignee);
    db.prepare(
      "INSERT INTO project_member_roles(project_id,user_id,role) VALUES (?,?,'viewer')",
    ).run(projectId, assignee);

    const viewerTask = as(assignee, () => tasks.get(task.id));
    expect(viewerTask.capabilities).toEqual({
      canEdit: false,
      canPlan: false,
      actions: [],
    });
    expect(() =>
      as(assignee, () =>
        tasks.update(task.id, { title: "viewer edit", expectedVersion: 1 }),
      ),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
    expect(() =>
      as(assignee, () =>
        tasks.action(task.id, { action: "start", expectedVersion: 1 }),
      ),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
    expect(() =>
      as(assignee, () => tasks.assertDailyPlanAccess(task.id)),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
  });

  it("runs a versioned append-only submit, return, resubmit and approve flow", () => {
    const task = as(owner, () => tasks.create(projectId, createInput));
    const act = (
      userId: number,
      action: string,
      expectedVersion: number,
      fields: object = {},
    ) =>
      as(userId, () =>
        tasks.action(task.id, { action, expectedVersion, ...fields }),
      );
    expect(
      act(assignee, "block", 1, { reason: "Waiting for access" }),
    ).toMatchObject({
      status: "blocked",
      previousStatus: "pending",
      version: 2,
    });
    expect(act(assignee, "resume", 2)).toMatchObject({
      status: "pending",
      previousStatus: null,
      version: 3,
    });
    expect(act(assignee, "start", 3).status).toBe("in_progress");
    expect(() => act(assignee, "submit", 4)).toThrow();
    expect(act(assignee, "submit", 4, { summary: "Initial" }).status).toBe(
      "pending_confirmation",
    );
    expect(() => act(owner, "approve", 5)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(
      act(confirmer, "return", 5, { reason: "Add test evidence" }).status,
    ).toBe("in_progress");
    expect(act(assignee, "submit", 6, { summary: "Revised" }).status).toBe(
      "pending_confirmation",
    );
    expect(act(confirmer, "approve", 7).status).toBe("completed");
    const reopened = act(owner, "reopen", 8, {
      reason: "Requirements changed",
    });
    expect(reopened).toMatchObject({ status: "in_progress", version: 9 });
    expect(reopened.submissions).toMatchObject([
      {
        summary: "Initial",
        review: {
          result: "returned",
          reason: "Add test evidence",
          reviewerUserId: confirmer,
        },
      },
      {
        summary: "Revised",
        review: { result: "approved", reviewerUserId: confirmer },
      },
    ]);
    expect(
      reopened.actions.map((item: { action: string }) => item.action),
    ).toEqual([
      "created",
      "block",
      "resume",
      "start",
      "submit",
      "return",
      "submit",
      "approve",
      "reopen",
    ]);
  });

  it("rejects stale ordinary edits and replays an idempotent command only while authorized", () => {
    const task = as(owner, () =>
      tasks.create(projectId, createInput, "create-task"),
    );
    expect(
      as(owner, () => tasks.create(projectId, createInput, "create-task")).id,
    ).toBe(task.id);
    expect(() =>
      as(owner, () => tasks.update(task.id, { title: "No version" })),
    ).toThrow(expect.objectContaining({ status: 428 }));
    const renamed = as(owner, () =>
      tasks.update(task.id, { title: "New title", expectedVersion: 1 }),
    );
    expect(renamed).toMatchObject({ title: "New title", version: 2 });
    expect(renamed.actions).toMatchObject([
      { action: "created", actorNameSnapshot: "Actor 1" },
      {
        action: "edit",
        actorNameSnapshot: "Actor 1",
        changes: {
          title: { before: "Implement workflow", after: "New title" },
        },
      },
    ]);
    expect(() =>
      as(owner, () =>
        tasks.update(task.id, { title: "Stale title", expectedVersion: 1 }),
      ),
    ).toThrow(
      expect.objectContaining({
        status: 409,
        details: { current: expect.objectContaining({ title: "New title" }) },
      }),
    );
    const command = { action: "start", expectedVersion: 2 };
    expect(
      as(assignee, () => tasks.action(task.id, command, "start-task")).status,
    ).toBe("in_progress");
    expect(
      as(assignee, () => tasks.action(task.id, command, "start-task")).version,
    ).toBe(3);
    expect(() =>
      as(assignee, () =>
        tasks.action(
          task.id,
          { ...command, expectedVersion: 99 },
          "start-task",
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    db.prepare(
      "UPDATE project_members SET status='removed' WHERE project_id=? AND user_id=?",
    ).run(projectId, assignee);
    expect(() =>
      as(assignee, () => tasks.action(task.id, command, "start-task")),
    ).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("only accepts evidence from the linked requirement or safe external URLs", () => {
    const insertRequirement = (name: string) =>
      Number(
        db
          .prepare(
            "INSERT INTO requirements(requirement_no,name,type,priority,description,status,current_stage,proposed_at,created_at,updated_at,user_id,project_id) VALUES(?,?,'feature','P2','','not_started','analysis','2026-11-20','now','now',?,?)",
          )
          .run(name, name, owner, projectId).lastInsertRowid,
      );
    const requirementId = insertRequirement("REQ-0001");
    const otherRequirement = insertRequirement("REQ-0002");
    const insertFile = (id: number) =>
      Number(
        db
          .prepare(
            "INSERT INTO artifact_nodes(requirement_id,node_type,name,relative_path,indexed_at,status,created_at,updated_at) VALUES(?,'file','proof.md','proof.md','now','normal','now','now')",
          )
          .run(id).lastInsertRowid,
      );
    const evidenceId = insertFile(requirementId);
    const foreignEvidenceId = insertFile(otherRequirement);
    const task = as(owner, () =>
      tasks.create(projectId, { ...createInput, requirementId }),
    );
    as(assignee, () =>
      tasks.action(task.id, { action: "start", expectedVersion: 1 }),
    );
    expect(() =>
      as(assignee, () =>
        tasks.action(task.id, {
          action: "submit",
          expectedVersion: 2,
          evidence: [{ kind: "artifact_node", id: foreignEvidenceId }],
        }),
      ),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(() =>
      as(assignee, () =>
        tasks.action(task.id, {
          action: "submit",
          expectedVersion: 2,
          evidence: [{ kind: "external_link", url: "javascript:alert(1)" }],
        }),
      ),
    ).toThrow();
    const submitted = as(assignee, () =>
      tasks.action(task.id, {
        action: "submit",
        expectedVersion: 2,
        evidence: [{ kind: "artifact_node", id: evidenceId }],
      }),
    );
    expect(submitted.submissions[0].evidence).toMatchObject([
      { kind: "artifact_node", id: evidenceId },
    ]);
  });

  it("keeps the linked requirement fixed after the first submission", () => {
    const insertRequirement = (name: string) =>
      Number(
        db
          .prepare(
            "INSERT INTO requirements(requirement_no,name,type,priority,description,status,current_stage,proposed_at,created_at,updated_at,user_id,project_id) VALUES(?,?,'feature','P2','','not_started','analysis','2026-11-20','now','now',?,?)",
          )
          .run(name, name, owner, projectId).lastInsertRowid,
      );
    const firstRequirement = insertRequirement("REQ-0001");
    const secondRequirement = insertRequirement("REQ-0002");
    const task = as(owner, () =>
      tasks.create(projectId, {
        ...createInput,
        requirementId: firstRequirement,
      }),
    );
    as(assignee, () =>
      tasks.action(task.id, { action: "start", expectedVersion: 1 }),
    );
    as(assignee, () =>
      tasks.action(task.id, {
        action: "submit",
        expectedVersion: 2,
        summary: "Submitted against original requirement",
      }),
    );

    expect(() =>
      as(owner, () =>
        tasks.update(task.id, {
          requirementId: secondRequirement,
          expectedVersion: 3,
        }),
      ),
    ).toThrow(
      expect.objectContaining({ code: "INVALID_TRANSITION", status: 409 }),
    );
  });
});
