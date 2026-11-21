import { describe, expect, it } from "vitest";
import {
  projectEventLabel,
  projectEventTarget,
  projectActionTarget,
  projectRiskItems,
} from "../src/features/projects/project-panels.js";
import type { ProjectEvent } from "../src/api/projects.js";
import type { ProjectOverview } from "@superpm/shared";

describe("project panel view helpers", () => {
  it("creates safe navigation targets only from recognized numeric event ids", () => {
    expect(
      projectEventTarget({
        id: 1,
        action: "requirement_updated",
        createdAt: "2026-11-20T10:00:00.000Z",
        payload: { requirementId: 52 },
      }),
    ).toEqual({ type: "requirement", id: 52 });
    expect(
      projectEventTarget({
        id: 2,
        action: "delivery_scope_confirmed",
        createdAt: "2026-11-20T10:00:00.000Z",
        payload: { deliveryId: 7, scopeVersion: 3 },
      }),
    ).toEqual({ type: "delivery", id: 7 });
    expect(
      projectEventTarget({
        id: 3,
        action: "project_created",
        createdAt: "2026-11-20T10:00:00.000Z",
        payload: { id: 7 },
      }),
    ).toBeNull();
    expect(
      projectEventTarget({
        id: 4,
        action: "requirement_updated",
        createdAt: "2026-11-20T10:00:00.000Z",
        payload: { requirementId: "52" },
      }),
    ).toBeNull();
  });

  it("uses readable event labels and preserves unknown action names", () => {
    expect(
      projectEventLabel({
        id: 1,
        action: "project_created",
        createdAt: "2026-11-20T10:00:00.000Z",
      }),
    ).toBe("创建了项目");
    expect(
      projectEventLabel({
        id: 2,
        action: "new_action",
        createdAt: "2026-11-20T10:00:00.000Z",
      }),
    ).toBe("项目发生更新");
  });

  it("deduplicates risk sources and provides destinations from actual overview ids", () => {
    const overview = {
      risks: {
        blockedRequirements: [3],
        blockedTasks: [9],
        overdueTasks: [9, 11],
      },
    } as ProjectOverview;

    expect(projectRiskItems(overview)).toEqual([
      {
        key: "requirement:3",
        title: "阻塞需求 #3",
        target: { type: "requirement", id: 3 },
      },
      {
        key: "task:9",
        title: "阻塞且逾期任务 #9",
        target: { type: "task", id: 9 },
      },
      {
        key: "task:11",
        title: "逾期任务 #11",
        target: { type: "task", id: 11 },
      },
    ]);
  });

  it("navigates delivery acceptance risks to the delivery panel", () => {
    const overview = {
      risks: {
        blockedRequirements: [],
        blockedTasks: [],
        overdueTasks: [],
        failedDeliveries: [12],
        overdueDeliveries: [14],
      },
    } as ProjectOverview;

    expect(projectRiskItems(overview)).toEqual([
      {
        key: "delivery:failed:12",
        title: "验收未通过交付 #12",
        target: { type: "delivery", id: 12 },
      },
      {
        key: "delivery:overdue:14",
        title: "逾期未验收交付 #14",
        target: { type: "delivery", id: 14 },
      },
    ]);
  });

  it("maps personal actions to their project panels", () => {
    expect(projectActionTarget({ id: 8, kind: "task" })).toEqual({
      type: "task",
      id: 8,
    });
    expect(projectActionTarget({ id: 4, kind: "delivery" })).toEqual({
      type: "delivery",
      id: 4,
    });
  });
});
