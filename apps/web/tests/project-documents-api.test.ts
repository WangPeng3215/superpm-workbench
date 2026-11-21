import { afterEach, describe, expect, it, vi } from "vitest";
import { projectDocumentsApi } from "../src/api/project-documents";

afterEach(() => vi.unstubAllGlobals());

describe("项目资料 API", () => {
  it("读取项目资料与需求产物", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);

    await projectDocumentsApi.list(7, { kind: "note", q: "范围" });
    await projectDocumentsApi.artifacts(7);

    expect(fetch.mock.calls[0][0]).toBe(
      "/api/projects/7/documents?kind=note&q=%E8%8C%83%E5%9B%B4",
    );
    expect(fetch.mock.calls[1][0]).toBe("/api/projects/7/artifacts");
  });

  it("创建资料、按版本更新并确认复制会议", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 3, version: 2 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);

    await projectDocumentsApi.create(7, {
      kind: "note",
      title: "范围说明",
      content: "正文",
    });
    await projectDocumentsApi.update(7, 3, {
      expectedVersion: 1,
      title: "范围说明（更新）",
    });
    await projectDocumentsApi.copyMeeting(7, 11);

    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(fetch.mock.calls[0][1].body).toBe(
      JSON.stringify({ kind: "note", title: "范围说明", content: "正文" }),
    );
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "PATCH" });
    expect(fetch.mock.calls[1][1].body).toBe(
      JSON.stringify({ expectedVersion: 1, title: "范围说明（更新）" }),
    );
    expect(fetch.mock.calls[2][0]).toBe(
      "/api/projects/7/documents/copy-meeting",
    );
    expect(fetch.mock.calls[2][1].body).toBe(
      JSON.stringify({ meetingId: 11, confirmed: true }),
    );
  });

  it("删除资料携带对象版本", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await projectDocumentsApi.remove(7, 3, 2);

    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: 2 }),
    });
  });
});
