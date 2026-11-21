import { describe, expect, it, vi } from "vitest";
import type { ProjectOverview } from "@superpm/shared";
import { projectApi } from "../src/api/projects";
import { useProjectOverview } from "../src/features/projects/useProjectOverview";

const emptyOverview = {
  project: { id: 12, name: "项目" },
  requirements: { total: 0, byStatus: {}, completed: 0, blocked: 0 },
  tasks: { total: 0, byStatus: {}, pending: 0, blocked: 0, overdue: 0 },
  deliveries: { total: 0, byStatus: {}, active: 0, awaitingAcceptance: 0 },
  risks: { blockedRequirements: [], blockedTasks: [], overdueTasks: [] },
  recentEvents: [],
} as unknown as ProjectOverview;

describe("useProjectOverview", () => {
  it("loads the empty overview for the current project id", async () => {
    const request = vi.spyOn(projectApi, "overview").mockResolvedValue(emptyOverview);
    const state = useProjectOverview(() => 12);

    await state.load();

    expect(request).toHaveBeenCalledWith(12);
    expect(state.overview.value).toEqual(emptyOverview);
    expect(state.loading.value).toBe(false);
    expect(state.error.value).toBe("");
    request.mockRestore();
  });

  it("exposes the loading state while the request is pending", async () => {
    let resolve!: (value: ProjectOverview) => void;
    vi.spyOn(projectApi, "overview").mockReturnValue(
      new Promise((done) => { resolve = done; }),
    );
    const state = useProjectOverview(() => 12);
    const pending = state.load();

    expect(state.loading.value).toBe(true);
    resolve(emptyOverview);
    await pending;
    expect(state.loading.value).toBe(false);
  });

  it("retains a readable error when loading fails", async () => {
    vi.spyOn(projectApi, "overview").mockRejectedValue(new Error("读取失败"));
    const state = useProjectOverview(() => 12);

    await state.load();

    expect(state.error.value).toBe("读取失败");
    expect(state.loading.value).toBe(false);
    expect(state.overview.value).toBeNull();
  });
});
