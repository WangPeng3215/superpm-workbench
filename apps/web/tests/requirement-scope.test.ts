import { describe, expect, it } from "vitest";
import {
  scopedRequirementQuery,
  canManageRequirement,
  projectEditingCheck,
} from "../src/features/requirements/scope";
describe("固定项目作用域", () => {
  it("权限回查401和服务暂不可用只暂停保稿，明确只读或403/404才清稿", () => {
    for (const status of [0, 401, 503])
      expect(projectEditingCheck(undefined, { status })).toEqual({
        canEdit: false,
        discardDraft: false,
      });
    for (const status of [403, 404])
      expect(projectEditingCheck(undefined, { status })).toEqual({
        canEdit: false,
        discardDraft: true,
      });
    expect(projectEditingCheck(false)).toEqual({
      canEdit: false,
      discardDraft: true,
    });
    expect(projectEditingCheck(true)).toEqual({
      canEdit: true,
      discardDraft: false,
    });
  });
  it("项目编辑能力未确认时只读，私有需求保持原编辑行为", () => {
    expect(canManageRequirement(null, {})).toBe(true);
    expect(canManageRequirement(3, {})).toBe(false);
    expect(canManageRequirement(3, { 3: false })).toBe(false);
    expect(canManageRequirement(3, { 3: true })).toBe(true);
    expect(canManageRequirement(3, { 3: true }, true)).toBe(false);
  });
  it("固定 scope 优先于用户筛选，清空筛选也不能清除", () => {
    expect(
      scopedRequirementQuery({ q: "名称", projectId: 9, unassigned: true }, 3),
    ).toEqual({ q: "名称", projectId: 3 });
    expect(scopedRequirementQuery({}, 3)).toEqual({ projectId: 3 });
  });
});
