import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { Note, NoteConvertResult } from "@superpm/shared";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { DailyTaskService } from "../src/services/daily-tasks.js";
import { NoteService } from "../src/services/notes.js";
import { authedInject } from "./auth-helper.js";

const fixedNow = () => new Date("2026-10-26T02:00:00.000Z");

describe("note service", () => {
  let directory: string;
  let db: Database.Database;
  let dailyTasks: DailyTaskService;
  let service: NoteService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "superpm-notes-"));
    db = new Database(join(directory, "test.sqlite"));
    migrate(db);
    dailyTasks = new DailyTaskService(db, { now: fixedNow });
    service = new NoteService(db, dailyTasks, { now: fixedNow });
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function create(overrides: Record<string, unknown> = {}) {
    return service.create({
      title: "周会灵感",
      content: "把每日任务和工作小结串起来",
      type: "inspiration",
      ...overrides,
    });
  }

  it("creates notes with defaults and lists pinned notes first", () => {
    const first = create();
    expect(first).toMatchObject({
      title: "周会灵感",
      color: "yellow",
      isPinned: false,
      isArchived: false,
      convertedTaskId: null,
      convertedTask: null,
    });
    const second = create({ title: "", content: "" });
    expect(second.title).toBe("");
    service.update(first.id, { isPinned: true });
    expect(service.list({}).map((note) => note.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(service.list({ archived: true })).toEqual([]);
  });

  it("updates content, type, color and keeps pin and archive independent", () => {
    const note = create();
    const updated = service.update(note.id, {
      content: "新的正文",
      type: "work_memo",
      color: "blue",
    });
    expect(updated).toMatchObject({
      content: "新的正文",
      type: "work_memo",
      color: "blue",
      isPinned: false,
      isArchived: false,
    });
    const archived = service.update(note.id, {
      isPinned: true,
      isArchived: true,
    });
    expect(archived.isArchived).toBe(true);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.isPinned).toBe(true);
    expect(service.list({})).toEqual([]);
    expect(service.list({ archived: true }).map((item) => item.id)).toEqual([
      note.id,
    ]);
    const restored = service.update(note.id, { isArchived: false });
    expect(restored.isArchived).toBe(false);
    expect(restored.archivedAt).toBeNull();
    expect(service.list({ archived: true })).toEqual([]);
  });

  it("removes notes and reports missing ids", () => {
    const note = create();
    service.remove(note.id);
    expect(service.list({})).toEqual([]);
    expect(() => service.get(note.id)).toThrowError("便签不存在");
    expect(() => service.remove(note.id)).toThrowError("便签不存在");
  });

  it("converts to a daily task and is idempotent while the task exists", () => {
    const note = create({
      title: "  整理会议结论  ",
      content: "同步到每日任务",
    });
    const first = service.convert(note.id);
    expect(first.created).toBe(true);
    expect(first.task).toMatchObject({
      title: "整理会议结论",
      planDate: "2026-10-26",
    });
    expect(first.note.convertedTask).toMatchObject({
      id: first.task.id,
      title: "整理会议结论",
      planDate: "2026-10-26",
      exists: true,
    });
    const tasks = dailyTasks.day("2026-10-26").tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "整理会议结论",
      description: "同步到每日任务",
      estimatedMinutes: 30,
    });

    const second = service.convert(note.id);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(dailyTasks.day("2026-10-26").tasks).toHaveLength(1);
  });

  it("falls back to the first content line and truncates long descriptions", () => {
    const note = create({
      title: "   ",
      content: `\n\n第一行内容\n${"长".repeat(5000)}`,
    });
    const result = service.convert(note.id);
    expect(result.task.title).toBe("第一行内容");
    const task = dailyTasks.day(result.task.planDate).tasks[0];
    expect(task.description).toHaveLength(4000);
    const empty = create({ title: "", content: "" });
    expect(service.convert(empty.id).task.title).toBe("便签任务");
  });

  it("allows reconverting after the target task is deleted", () => {
    const note = create();
    const first = service.convert(note.id);
    dailyTasks.remove(first.task.id);
    expect(service.get(note.id).convertedTaskId).toBeNull();
    const again = service.convert(note.id);
    expect(again.created).toBe(true);
    expect(again.task.id).not.toBe(first.task.id);
    expect(dailyTasks.day("2026-10-26").tasks).toHaveLength(1);
  });

  it("does not mark the note converted when task creation fails", () => {
    const failing = {
      create: () => {
        throw new Error("任务创建失败");
      },
    } as unknown as DailyTaskService;
    const failingService = new NoteService(db, failing, { now: fixedNow });
    const note = failingService.create({ title: "失败用例" });
    expect(() => failingService.convert(note.id)).toThrowError("任务创建失败");
    expect(failingService.get(note.id).convertedTaskId).toBeNull();
  });
});

describe("notes HTTP API", () => {
  let app: FastifyInstance;
  let directory: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-notes-api-"));
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      workspacePath: join(directory, "workspace"),
      logger: false,
      serveWeb: false,
    });
    await authedInject(app);
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires a session", async () => {
    const bare = await createApp({
      databasePath: join(directory, "bare.sqlite"),
      workspacePath: join(directory, "bare-workspace"),
      logger: false,
      serveWeb: false,
    });
    try {
      expect((await bare.inject("/api/notes")).statusCode).toBe(401);
      expect(
        (
          await bare.inject({
            method: "POST",
            url: "/api/notes",
            payload: { content: "未登录" },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await bare.close();
    }
  });

  it("supports CRUD, archive filtering and conversion", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/notes",
      payload: {
        title: "E2E 便签",
        content: "正文内容",
        type: "work_memo",
        color: "pink",
      },
    });
    expect(created.statusCode).toBe(201);
    const note = created.json<Note>();
    expect(note).toMatchObject({
      title: "E2E 便签",
      type: "work_memo",
      color: "pink",
    });

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      payload: { content: "更新正文", isPinned: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<Note>()).toMatchObject({
      content: "更新正文",
      isPinned: true,
    });

    const converted = await app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/convert`,
    });
    expect(converted.statusCode).toBe(200);
    const result = converted.json<NoteConvertResult>();
    expect(result.created).toBe(true);
    expect(result.note.convertedTask?.id).toBe(result.task.id);

    const again = await app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/convert`,
    });
    expect(again.json<NoteConvertResult>().created).toBe(false);
    expect(again.json<NoteConvertResult>().task.id).toBe(result.task.id);

    const archived = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      payload: { isArchived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect((await app.inject("/api/notes")).json<Note[]>()).toEqual([]);
    expect(
      (await app.inject("/api/notes?archived=true")).json<Note[]>(),
    ).toHaveLength(1);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/notes/${note.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await app.inject("/api/notes?archived=true")).json<Note[]>(),
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/notes/${note.id}`,
          payload: { title: "不存在" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("validates empty updates and invalid enum values", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/notes",
      payload: { title: "校验" },
    });
    const note = created.json<Note>();
    const empty = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/notes",
      payload: { color: "neon" },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
