import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectApi, type ProjectEvent } from "../src/api/projects.js";
import { useProjectActivity } from "../src/features/projects/useProjectActivity.js";
import { projectEventLabel } from "../src/features/projects/project-panels.js";

function event(id: number): ProjectEvent {
  return {
    id,
    action: "project_created",
    actorNameSnapshot: "负责人",
    createdAt: "2026-11-20T10:00:00.000Z",
    payload: {},
  };
}

describe("useProjectActivity", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("loads cursor pages and deduplicates repeated events", async () => {
    const request = vi
      .spyOn(projectApi, "events")
      .mockResolvedValueOnce({
        items: [event(31), event(30)],
        hasMore: true,
        nextCursor: "30",
      })
      .mockResolvedValueOnce({
        items: [event(30), event(29)],
        hasMore: false,
        nextCursor: null,
      });
    const state = useProjectActivity(() => 12);

    await state.refresh();
    expect(state.items.value.map((item) => item.id)).toEqual([31, 30]);
    expect(state.hasMore.value).toBe(true);
    expect(state.nextCursor.value).toBe("30");

    await state.loadMore();

    expect(request).toHaveBeenNthCalledWith(1, 12);
    expect(request).toHaveBeenNthCalledWith(2, 12, "30");
    expect(state.items.value.map((item) => item.id)).toEqual([31, 30, 29]);
    expect(state.hasMore.value).toBe(false);
  });

  it("ignores a stale response after switching projects", async () => {
    let projectId = 1;
    let resolveOld!: (
      value: Awaited<ReturnType<typeof projectApi.events>>,
    ) => void;
    const request = vi.spyOn(projectApi, "events");
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    request.mockResolvedValueOnce({
      items: [event(22)],
      hasMore: false,
      nextCursor: null,
    });
    const state = useProjectActivity(() => projectId);

    const oldRequest = state.refresh();
    projectId = 2;
    await state.refresh();
    resolveOld({ items: [event(11)], hasMore: false, nextCursor: null });
    await oldRequest;

    expect(state.items.value.map((item) => item.id)).toEqual([22]);
    expect(state.loading.value).toBe(false);
  });
});

describe("projectEventLabel", () => {
  it("describes project document changes in the activity feed", () => {
    expect(projectEventLabel({ action: "project_document_created" })).toBe(
      "新增了项目资料",
    );
    expect(projectEventLabel({ action: "project_document_updated" })).toBe(
      "更新了项目资料",
    );
    expect(projectEventLabel({ action: "project_document_deleted" })).toBe(
      "删除了项目资料",
    );
    expect(projectEventLabel({ action: "project_meeting_copied" })).toBe(
      "复制了项目会议纪要",
    );
  });
});
