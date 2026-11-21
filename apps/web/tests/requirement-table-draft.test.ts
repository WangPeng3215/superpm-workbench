import { describe, expect, it } from "vitest";
import { requirementCreateSchema } from "@superpm/shared";
import {
  readTableDraft,
  stageReasonRequired,
  tableDraftKey,
} from "../src/features/requirements/table-draft";
describe("需求表格会话草稿", () => {
  it("按账号与固定项目隔离，保留空名称、新建状态、版本与阶段原因", () => {
    const values = {
      ...requirementCreateSchema.parse({
        name: "原名",
        proposedAt: "2026-11-20",
        projectId: 4,
      }),
      name: "",
    };
    const entry = {
      requirementId: 3,
      version: 2,
      values,
      stageNote: "验证后调整",
    };
    expect(readTableDraft(JSON.stringify(entry), 4)).toEqual(entry);
    expect(readTableDraft(JSON.stringify(entry), 5)).toBeNull();
    expect(tableDraftKey(1, 4)).not.toBe(tableDraftKey(2, 4));
    expect(tableDraftKey(1, 4)).not.toBe(tableDraftKey(1));
    expect(
      readTableDraft(
        JSON.stringify({ ...entry, requirementId: null, version: null }),
        4,
      )?.requirementId,
    ).toBeNull();
    expect(
      readTableDraft(JSON.stringify({ ...entry, version: 0 }), 4),
    ).toBeNull();
  });
  it("仅跳阶段与回退要求原因，相邻推进不要求", () => {
    expect(stageReasonRequired("analysis", "design")).toBe(false);
    expect(stageReasonRequired("analysis", "analysis")).toBe(false);
    expect(stageReasonRequired("analysis", "development")).toBe(true);
    expect(stageReasonRequired("development", "analysis")).toBe(true);
  });
});
