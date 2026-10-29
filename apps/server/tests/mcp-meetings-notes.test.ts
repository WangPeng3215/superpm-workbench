import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  McpArtifactDirectoryData,
  McpIssueListData,
  McpMeetingListData,
  McpMeetingWriteData,
  McpNoteConvertData,
  McpNoteListData,
  McpNoteWriteData,
  McpReadResult,
  McpRequirementListData,
  McpWritePrepareData,
  Meeting,
  Note,
  Requirement,
} from "@superpm/shared";
import { migrate } from "../src/db/migrate.js";
import { createMcpServer } from "../src/mcp/server.js";
import { ArtifactService } from "../src/services/artifacts.js";
import { DailyTaskService } from "../src/services/daily-tasks.js";
import { IssueService } from "../src/services/issues.js";
import { buildMcpTools, type McpGateway } from "../src/services/mcp-gateway.js";
import { McpWriteService } from "../src/services/mcp-writes.js";
import { MeetingService } from "../src/services/meetings.js";
import { NoteService } from "../src/services/notes.js";
import { RequirementDirectoryResolver } from "../src/services/requirement-directory.js";
import { RequirementProgressService } from "../src/services/requirement-progress.js";
import { RequirementService } from "../src/services/requirements.js";

const fixedNow = new Date("2026-10-26T08:00:00.000Z");
const richHtml =
  '<p data-color="blue">登录优化</p><p><strong>结论</strong>：<span style="color: #e11d48">下周上线</span></p>';

interface CallError {
  error: { code: string; message: string };
}

interface AuditRow {
  tool: string;
  requirement_id: number | null;
  target_type: string | null;
  outcome: string;
  result_summary: string | null;
}

describe("MCP 会议与便签能力", () => {
  let directory: string;
  let db: Database.Database;
  let requirements: RequirementService;
  let directories: RequirementDirectoryResolver;
  let artifacts: ArtifactService;
  let issues: IssueService;
  let progress: RequirementProgressService;
  let dailyTasks: DailyTaskService;
  let notes: NoteService;
  let meetings: MeetingService;
  let gateway: McpGateway;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let close: () => Promise<void>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "superpm-mcp-meeting-note-"));
    const workspace = join(directory, "workspace");
    mkdirSync(workspace, { recursive: true });
    db = new Database(join(directory, "test.sqlite"));
    migrate(db);
    requirements = new RequirementService(db);
    directories = new RequirementDirectoryResolver(db, workspace);
    artifacts = new ArtifactService(db, workspace, requirements, directories);
    issues = new IssueService(db, requirements, workspace, directories);
    progress = new RequirementProgressService(
      requirements,
      issues,
      artifacts,
      directories,
    );
    dailyTasks = new DailyTaskService(db, { now: () => fixedNow });
    notes = new NoteService(db, dailyTasks, { now: () => fixedNow });
    meetings = new MeetingService(db);
    gateway = buildMcpTools({
      requirements,
      issues,
      artifacts,
      progress,
      meetings,
      notes,
      writes: new McpWriteService(db, {
        enabled: true,
        now: () => fixedNow,
      }),
    });
    server = createMcpServer({
      version: "0.9.0",
      getSystemInfo: () => ({
        name: "superpm",
        version: "0.9.0",
        schemaVersion: 17,
        transport: "stdio",
        capabilities: { readonly: true, write: true },
      }),
      gateway,
      logError: () => {},
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: "vitest", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const call = (name: string, input: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: input });

  const dataOf = async <T>(
    name: string,
    input: Record<string, unknown> = {},
  ): Promise<T> => {
    const result = await call(name, input);
    if (result.isError)
      throw new Error(`工具 ${name} 失败：${JSON.stringify(result.content)}`);
    return (result.structuredContent as unknown as McpReadResult<T>).data;
  };

  const errorOf = async (
    name: string,
    input: Record<string, unknown> = {},
  ): Promise<CallError> => {
    const result = await call(name, input);
    expect(result.isError, `${name} 本应失败`).toBe(true);
    const content = result.content as { type: string; text: string }[];
    try {
      return JSON.parse(content[0].text) as CallError;
    } catch {
      // MCP SDK 对 inputSchema 的前置校验返回协议级错误文本，统一视为参数校验失败
      return { error: { code: "VALIDATION_ERROR", message: content[0].text } };
    }
  };

  const prepare = (
    tool: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ) =>
    dataOf<McpWritePrepareData>("write.prepare", {
      tool,
      input,
      idempotencyKey,
    });

  const perform = async <T>(
    tool: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<T> => {
    const prepared = await prepare(tool, input, idempotencyKey);
    return dataOf<T>(tool, {
      ...input,
      confirmationToken: prepared.confirmationToken,
      idempotencyKey,
    });
  };

  const performRaw = async (
    tool: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ) => {
    const prepared = await prepare(tool, input, idempotencyKey);
    return call(tool, {
      ...input,
      confirmationToken: prepared.confirmationToken,
      idempotencyKey,
    });
  };

  const createRequirement = (name = "关联需求") =>
    requirements.create({
      name,
      proposedAt: "2026-10-15",
    }) as Requirement;

  const seedMeetings = () => {
    const requirement = createRequirement("会议关联需求");
    const weekly = meetings.create({
      title: "周例会",
      type: "weekly",
      meetingTime: "2026-10-01T02:00:00.000Z",
      requirementIds: [requirement.id],
      contentHtml: richHtml,
    }) as Meeting;
    const requirementMeeting = meetings.create({
      title: "需求沟通会",
      type: "requirement",
      meetingTime: "2026-10-15T02:00:00.000Z",
      contentHtml: "<p>讨论支付流程</p>",
    }) as Meeting;
    const training = meetings.create({
      title: "新人培训",
      type: "training",
      meetingTime: "2026-10-20T02:00:00.000Z",
      contentHtml: "<p>介绍工作台</p>",
    }) as Meeting;
    return { requirement, weekly, requirementMeeting, training };
  };

  const seedNotes = () => {
    const pinned = notes.create({
      title: "灵感A",
      content: "第一条灵感内容",
      isPinned: true,
    }) as Note;
    const longContent = "长".repeat(150);
    const memo = notes.create({
      title: "工作备忘",
      content: longContent,
      type: "work_memo",
    }) as Note;
    const archived = notes.create({
      title: "旧想法",
      content: "归档内容 关键词收藏",
    }) as Note;
    notes.update(archived.id, { isArchived: true });
    return { pinned, memo, archived, longContent };
  };

  it("客户端发现 32 个工具，会议/便签删除标记为破坏性操作", async () => {
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(32);
    const names = listed.tools.map((tool) => tool.name);
    for (const name of [
      "meeting.list",
      "meeting.get",
      "meeting.search",
      "meeting.create",
      "meeting.update",
      "meeting.delete",
      "note.list",
      "note.get",
      "note.search",
      "note.create",
      "note.update",
      "note.archive",
      "note.delete",
      "note.convertToTask",
    ])
      expect(names).toContain(name);
    expect(
      listed.tools.find((tool) => tool.name === "meeting.delete")?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(
      listed.tools.find((tool) => tool.name === "note.delete")?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(
      listed.tools.find((tool) => tool.name === "note.archive")?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("会议列表分页与筛选返回摘要，详情返回完整富文本正文", async () => {
    const { requirement, weekly } = seedMeetings();

    const firstPage = await dataOf<McpMeetingListData>("meeting.list", {
      pageSize: 2,
    });
    expect(firstPage.total).toBe(3);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.items[0].title).toBe("新人培训");
    expect(firstPage.items.every((item) => !("contentHtml" in item))).toBe(
      true,
    );

    const secondPage = await dataOf<McpMeetingListData>("meeting.list", {
      page: 2,
      pageSize: 2,
    });
    expect(secondPage.items.map((item) => item.title)).toEqual(["周例会"]);
    expect(secondPage.hasMore).toBe(false);

    const byType = await dataOf<McpMeetingListData>("meeting.list", {
      type: "training",
    });
    expect(byType.items.map((item) => item.title)).toEqual(["新人培训"]);

    const byTitle = await dataOf<McpMeetingListData>("meeting.list", {
      q: "需求沟通",
    });
    expect(byTitle.total).toBe(1);

    const search = await dataOf<McpMeetingListData>("meeting.search", {
      q: "支付流程",
    });
    expect(search.total).toBe(1);
    expect(search.items[0].title).toBe("需求沟通会");
    expect(search.items[0].summary).toContain("支付流程");

    const range = await dataOf<McpMeetingListData>("meeting.list", {
      startTime: "2026-10-10T00:00:00.000Z",
      endTime: "2026-10-16T00:00:00.000Z",
    });
    expect(range.items.map((item) => item.title)).toEqual(["需求沟通会"]);

    const detail = await dataOf<{ meeting: Meeting }>("meeting.get", {
      id: weekly.id,
    });
    expect(detail.meeting.contentHtml).toBe(richHtml);
    expect(detail.meeting.requirements).toEqual([
      {
        id: requirement.id,
        requirementNo: requirement.requirementNo,
        name: requirement.name,
      },
    ]);

    const serialized = JSON.stringify(firstPage);
    expect(serialized).not.toContain("<p");
    expect(serialized).not.toContain(directory);
  });

  it("会议只读错误：无效 ID、非法分页与倒置时间范围", async () => {
    seedMeetings();
    expect((await errorOf("meeting.get", { id: 9999 })).error.code).toBe(
      "NOT_FOUND",
    );
    expect((await errorOf("meeting.list", { page: 0 })).error.code).toBe(
      "VALIDATION_ERROR",
    );
    expect((await errorOf("meeting.list", { pageSize: 101 })).error.code).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      (
        await errorOf("meeting.search", {
          q: "支付",
          startTime: "2026-10-20T00:00:00.000Z",
          endTime: "2026-10-10T00:00:00.000Z",
        })
      ).error.code,
    ).toBe("VALIDATION_ERROR");
    expect((await errorOf("meeting.search", { q: "   " })).error.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("便签列表默认排除归档且不返回正文，归档筛选与全文检索可显式指定", async () => {
    const { pinned, memo, archived, longContent } = seedNotes();

    const active = await dataOf<McpNoteListData>("note.list");
    expect(active.total).toBe(2);
    expect(active.items.map((item) => item.id)).toEqual([pinned.id, memo.id]);
    expect(active.items[1].preview).toHaveLength(121);
    expect(active.items[1].preview.endsWith("…")).toBe(true);
    expect(active.items[1].contentLength).toBe(longContent.length);
    expect(active.items.every((item) => !("content" in item))).toBe(true);

    const archivedOnly = await dataOf<McpNoteListData>("note.list", {
      isArchived: true,
    });
    expect(archivedOnly.items.map((item) => item.id)).toEqual([archived.id]);

    const all = await dataOf<McpNoteListData>("note.list", {
      isArchived: "all",
      pageSize: 1,
      page: 3,
    });
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(1);

    const byTitle = await dataOf<McpNoteListData>("note.search", { q: "备忘" });
    expect(byTitle.total).toBe(1);
    expect(byTitle.items[0].id).toBe(memo.id);

    const archivedKeyword = await dataOf<McpNoteListData>("note.search", {
      q: "关键词收藏",
    });
    expect(archivedKeyword.total).toBe(0);
    const archivedSearch = await dataOf<McpNoteListData>("note.search", {
      q: "关键词收藏",
      isArchived: "all",
    });
    expect(archivedSearch.items.map((item) => item.id)).toEqual([archived.id]);

    const detail = await dataOf<{ note: Note }>("note.get", { id: memo.id });
    expect(detail.note.content).toBe(longContent);

    expect((await errorOf("note.get", { id: 9999 })).error.code).toBe(
      "NOT_FOUND",
    );
    expect((await errorOf("note.list", { isArchived: "yes" })).error.code).toBe(
      "VALIDATION_ERROR",
    );
    expect((await errorOf("note.list", { pageSize: 0 })).error.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("会议写入：创建保留 HTML 与需求关联，部分更新不清空未提交字段，删除级联关联", async () => {
    const requirement = createRequirement("会议写入需求");
    const extra = createRequirement("另一个需求");
    const created = await perform<McpMeetingWriteData>(
      "meeting.create",
      {
        title: "  上线评审  ",
        type: "group",
        meetingTime: "2026-11-01T02:30:45.000+08:00",
        requirementIds: [requirement.id, requirement.id],
        contentHtml: richHtml,
      },
      "idem-meeting-create-01",
    );
    expect(created.meeting.title).toBe("上线评审");
    expect(created.meeting.contentHtml).toBe(richHtml);
    expect(created.meeting.meetingTime).toBe("2026-10-31T18:30:00.000Z");
    expect(created.meeting.requirementCount).toBe(1);
    expect(created.changedFields).toContain("contentHtml");

    const stored = db
      .prepare(
        "SELECT title, content_html, meeting_time FROM meetings WHERE id=?",
      )
      .get(created.meeting.id);
    expect(stored).toEqual({
      title: "上线评审",
      content_html: richHtml,
      meeting_time: "2026-10-31T18:30:00.000Z",
    });

    const updated = await perform<McpMeetingWriteData>(
      "meeting.update",
      { meetingId: created.meeting.id, title: "上线评审（改）" },
      "idem-meeting-update-01",
    );
    expect(updated.changedFields).toEqual(["title"]);
    expect(updated.meeting).toMatchObject({
      title: "上线评审（改）",
      type: "group",
      meetingTime: "2026-10-31T18:30:00.000Z",
      contentHtml: richHtml,
      requirementCount: 1,
    });

    const replaced = await perform<McpMeetingWriteData>(
      "meeting.update",
      {
        meetingId: created.meeting.id,
        requirementIds: [extra.id],
      },
      "idem-meeting-update-02",
    );
    expect(replaced.meeting.requirements.map((item) => item.id)).toEqual([
      extra.id,
    ]);

    const clearedContent = await perform<McpMeetingWriteData>(
      "meeting.update",
      { meetingId: created.meeting.id, contentHtml: "" },
      "idem-meeting-update-03",
    );
    expect(clearedContent.changedFields).toEqual(["contentHtml"]);
    expect(clearedContent.meeting).toMatchObject({
      title: "上线评审（改）",
      contentHtml: "",
      requirementCount: 1,
    });

    const cleared = await perform<McpMeetingWriteData>(
      "meeting.update",
      { meetingId: created.meeting.id, requirementIds: [] },
      "idem-meeting-update-04",
    );
    expect(cleared.meeting.requirementCount).toBe(0);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM meeting_requirements WHERE meeting_id=?",
        )
        .get(created.meeting.id),
    ).toEqual({ count: 0 });

    const conflict = await errorOf("write.prepare", {
      tool: "meeting.create",
      input: {
        title: "重复提交",
        type: "weekly",
        meetingTime: "2026-11-02T02:00:00.000Z",
      },
      idempotencyKey: "idem-meeting-create-01",
    });
    expect(conflict.error.code).toBe("CONFLICT");

    const deleted = await perform<{ meetingId: number; deleted: true }>(
      "meeting.delete",
      { meetingId: created.meeting.id },
      "idem-meeting-delete-01",
    );
    expect(deleted).toEqual({ meetingId: created.meeting.id, deleted: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM meetings").get()).toEqual({
      count: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM meeting_requirements").get(),
    ).toEqual({ count: 0 });
    expect(
      (await errorOf("meeting.get", { id: created.meeting.id })).error.code,
    ).toBe("NOT_FOUND");
  });

  it("会议写入业务校验：无效需求、缺失确认令牌与无效 ID", async () => {
    const requirement = createRequirement();
    const invalidRequirement = await performRaw(
      "meeting.create",
      {
        title: "无效关联",
        type: "weekly",
        meetingTime: "2026-11-03T02:00:00.000Z",
        requirementIds: [9999],
      },
      "idem-meeting-create-02",
    );
    expect(invalidRequirement.isError).toBe(true);
    const invalidBody = JSON.parse(
      (invalidRequirement.content as { text: string }[])[0].text,
    ) as CallError;
    expect(invalidBody.error.code).toBe("VALIDATION_ERROR");
    expect(db.prepare("SELECT COUNT(*) AS count FROM meetings").get()).toEqual({
      count: 0,
    });

    const missingToken = await errorOf("meeting.delete", {
      meetingId: 1,
      idempotencyKey: "idem-meeting-delete-02",
    });
    expect(missingToken.error.code).toBe("FORBIDDEN");

    const notFound = await performRaw(
      "meeting.delete",
      { meetingId: 9999 },
      "idem-meeting-delete-03",
    );
    expect(notFound.isError).toBe(true);
    expect(requirement.id).toBeGreaterThan(0);
  });

  it("便签写入：创建/部分更新保持正文完整，归档可恢复且更新接口拒绝归档字段", async () => {
    const created = await perform<McpNoteWriteData>(
      "note.create",
      {
        title: "写作灵感",
        content: "保留换行\n第二行",
        type: "work_memo",
        color: "blue",
        isPinned: true,
      },
      "idem-note-create-01",
    );
    expect(created.note).toMatchObject({
      title: "写作灵感",
      content: "保留换行\n第二行",
      type: "work_memo",
      color: "blue",
      isPinned: true,
      isArchived: false,
    });

    const updated = await perform<McpNoteWriteData>(
      "note.update",
      { noteId: created.note.id, content: "新的正文内容" },
      "idem-note-update-01",
    );
    expect(updated.changedFields).toEqual(["content"]);
    expect(updated.note).toMatchObject({
      title: "写作灵感",
      content: "新的正文内容",
      type: "work_memo",
      color: "blue",
      isPinned: true,
    });

    const clearedContent = await perform<McpNoteWriteData>(
      "note.update",
      { noteId: created.note.id, content: "" },
      "idem-note-update-03",
    );
    expect(clearedContent.changedFields).toEqual(["content"]);
    expect(clearedContent.note).toMatchObject({
      title: "写作灵感",
      content: "",
      type: "work_memo",
      color: "blue",
      isPinned: true,
    });

    const archivePayload = await call("write.prepare", {
      tool: "note.update",
      input: { noteId: created.note.id, isArchived: true },
      idempotencyKey: "idem-note-update-02",
    });
    expect(archivePayload.isError).toBe(true);

    const archived = await perform<{ note: Note; archived: boolean }>(
      "note.archive",
      { noteId: created.note.id, archived: true },
      "idem-note-archive-01",
    );
    expect(archived.archived).toBe(true);
    expect(archived.note.isArchived).toBe(true);
    expect(archived.note.archivedAt).not.toBeNull();
    expect(
      (await dataOf<McpNoteListData>("note.list")).items.map((item) => item.id),
    ).not.toContain(created.note.id);

    const restored = await perform<{ note: Note; archived: boolean }>(
      "note.archive",
      { noteId: created.note.id, archived: false },
      "idem-note-archive-02",
    );
    expect(restored.note.isArchived).toBe(false);
    expect(restored.note.archivedAt).toBeNull();
    expect(
      (await dataOf<McpNoteListData>("note.list")).items.map((item) => item.id),
    ).toContain(created.note.id);
  });

  it("便签转任务复用现有逻辑，重复转换不重复建任务，失败不标记便签", async () => {
    const note = await perform<McpNoteWriteData>(
      "note.create",
      {
        title: "整理会议结论",
        content: "同步到每日任务",
      },
      "idem-note-create-02",
    );

    const first = await perform<McpNoteConvertData>(
      "note.convertToTask",
      { noteId: note.note.id },
      "idem-note-convert-01",
    );
    expect(first.created).toBe(true);
    expect(first.task).toMatchObject({
      title: "整理会议结论",
      planDate: "2026-10-26",
    });
    expect(first.note.convertedTask).toMatchObject({
      id: first.task.id,
      exists: true,
    });
    expect(
      db
        .prepare(
          "SELECT title, description, plan_date, estimated_minutes FROM daily_tasks WHERE id=?",
        )
        .get(first.task.id),
    ).toEqual({
      title: "整理会议结论",
      description: "同步到每日任务",
      plan_date: "2026-10-26",
      estimated_minutes: 30,
    });

    const second = await perform<McpNoteConvertData>(
      "note.convertToTask",
      { noteId: note.note.id },
      "idem-note-convert-02",
    );
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM daily_tasks").get(),
    ).toEqual({ count: 1 });

    const failing = await perform<McpNoteWriteData>(
      "note.create",
      { title: "失败便签", content: "不应被标记" },
      "idem-note-create-03",
    );
    db.exec(
      "CREATE TRIGGER block_task_insert BEFORE INSERT ON daily_tasks BEGIN SELECT RAISE(ABORT, 'task insert blocked'); END",
    );
    const failed = await performRaw(
      "note.convertToTask",
      { noteId: failing.note.id },
      "idem-note-convert-03",
    );
    expect(failed.isError).toBe(true);
    expect(
      (
        db
          .prepare("SELECT converted_task_id FROM notes WHERE id=?")
          .get(failing.note.id) as { converted_task_id: number | null }
      ).converted_task_id,
    ).toBeNull();
    db.exec("DROP TRIGGER block_task_insert");

    const retried = await perform<McpNoteConvertData>(
      "note.convertToTask",
      { noteId: failing.note.id },
      "idem-note-convert-04",
    );
    expect(retried.created).toBe(true);

    const noteRow = await perform<{ noteId: number; deleted: true }>(
      "note.delete",
      { noteId: note.note.id },
      "idem-note-delete-01",
    );
    expect(noteRow.deleted).toBe(true);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM notes WHERE id=?")
        .get(note.note.id),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM daily_tasks WHERE id=?")
        .get(first.task.id),
    ).toEqual({ count: 1 });

    const invalid = await performRaw(
      "note.update",
      { noteId: 9999, content: "无效" },
      "idem-note-update-04",
    );
    expect(invalid.isError).toBe(true);
    const invalidError = JSON.parse(
      (invalid.content as { text: string }[])[0].text,
    ) as CallError;
    expect(invalidError.error.code).toBe("NOT_FOUND");
  });

  it("会议/便签写入审计不归属需求，摘要不含正文", async () => {
    const requirement = createRequirement();
    const meeting = await perform<McpMeetingWriteData>(
      "meeting.create",
      {
        title: "审计会议",
        type: "weekly",
        meetingTime: "2026-11-05T02:00:00.000Z",
        requirementIds: [requirement.id],
        contentHtml: "<p>审计机密正文</p>",
      },
      "idem-audit-meeting-01",
    );
    const note = await perform<McpNoteWriteData>(
      "note.create",
      { title: "审计便签", content: "审计机密便签正文" },
      "idem-audit-note-01",
    );
    await perform<{ note: Note; archived: boolean }>(
      "note.archive",
      { noteId: note.note.id, archived: true },
      "idem-audit-note-02",
    );
    await perform<McpMeetingWriteData>(
      "meeting.update",
      { meetingId: meeting.meeting.id, title: "审计会议（改）" },
      "idem-audit-meeting-02",
    );
    await perform<{ meetingId: number; deleted: true }>(
      "meeting.delete",
      { meetingId: meeting.meeting.id },
      "idem-audit-meeting-03",
    );

    const rows = db
      .prepare(
        "SELECT tool, requirement_id, target_type, outcome, result_summary FROM mcp_audit WHERE tool LIKE 'meeting.%' OR tool LIKE 'note.%' ORDER BY id",
      )
      .all() as AuditRow[];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      expect(row.requirement_id).toBeNull();
      expect(["meeting", "note"]).toContain(row.target_type);
      expect(row.result_summary ?? "").not.toContain("机密");
    }
    expect(rows.filter((row) => row.outcome === "success")).toHaveLength(5);

    const confirmationOwners = (
      db
        .prepare(
          "SELECT DISTINCT requirement_id FROM mcp_write_confirmations WHERE tool LIKE 'meeting.%' OR tool LIKE 'note.%'",
        )
        .all() as { requirement_id: number }[]
    ).map((row) => row.requirement_id);
    expect(confirmationOwners).toEqual([0]);
  });

  it("既有需求/文档/问题只读工具在扩展后仍正常返回", async () => {
    const requirement = createRequirement("回归需求");
    directories.initialize(requirement.id);
    issues.create(requirement.id, { title: "回归问题" });

    const requirementsData = await dataOf<McpRequirementListData>(
      "requirement.list",
      { q: "回归需求" },
    );
    expect(requirementsData.total).toBe(1);
    expect(requirementsData.items[0].id).toBe(requirement.id);

    const artifactData = await dataOf<McpArtifactDirectoryData>(
      "artifact.list",
      { requirementId: requirement.id },
    );
    expect(artifactData).toMatchObject({ limit: 200, truncated: false });
    expect(
      artifactData.total.folders +
        artifactData.total.files +
        artifactData.total.links,
    ).toBe(
      artifactData.folders.length +
        artifactData.files.length +
        artifactData.links.length,
    );

    const issueData = await dataOf<McpIssueListData>("issue.list", {
      requirementId: requirement.id,
    });
    expect(issueData.total).toBe(1);
    expect(issueData.items[0].title).toBe("回归问题");
  });
});
