import { describe, expect, it } from "vitest";
import {
  requirementCreateSchema,
  requirementListSchema,
  requirementShareSchema,
  requirementUpdateSchema,
} from "../src/index";

const input = { name: "需求", proposedAt: "2026-11-19" };

describe("需求项目关联输入", () => {
  it("旧创建输入使用空项目、空负责人和空验收标准", () => {
    expect(requirementCreateSchema.parse(input)).toMatchObject({
      projectId: null,
      assigneeUserId: null,
      developerUserId: null,
      acceptanceCriteria: "",
    });
  });

  it("创建可关联项目并指定负责人和验收标准", () => {
    const projectFields = {
      projectId: 7,
      assigneeUserId: 8,
      developerUserId: 9,
      acceptanceCriteria: "主流程通过验收",
    };
    expect(
      requirementCreateSchema.parse({ ...input, ...projectFields }),
    ).toMatchObject(projectFields);
  });

  it("项目与负责人可以显式为空，非法标识不能写入", () => {
    for (const field of ["projectId", "assigneeUserId", "developerUserId"]) {
      expect(
        requirementCreateSchema.safeParse({ ...input, [field]: null }).success,
      ).toBe(true);
      for (const value of [0, -1, 1.5, "8"]) {
        expect(
          requirementCreateSchema.safeParse({ ...input, [field]: value })
            .success,
        ).toBe(false);
      }
    }
  });

  it("验收标准最多 50000 字", () => {
    expect(
      requirementCreateSchema.safeParse({
        ...input,
        acceptanceCriteria: "验".repeat(50000),
      }).success,
    ).toBe(true);
    expect(
      requirementCreateSchema.safeParse({
        ...input,
        acceptanceCriteria: "验".repeat(50001),
      }).success,
    ).toBe(false);
  });

  it("普通更新不能迁移或清除项目关联", () => {
    for (const projectId of [1, null]) {
      expect(requirementUpdateSchema.safeParse({ projectId }).success).toBe(
        false,
      );
      expect(
        requirementUpdateSchema.safeParse({
          name: "更新",
          projectId,
          expectedVersion: 1,
        }).success,
      ).toBe(false);
    }
  });

  it("旧私有更新可不传版本，传入版本时必须为正整数", () => {
    expect(requirementUpdateSchema.parse({ name: "更新" })).toEqual({
      name: "更新",
    });
    expect(
      requirementUpdateSchema.parse({ name: "更新", expectedVersion: 2 }),
    ).toEqual({ name: "更新", expectedVersion: 2 });
    for (const expectedVersion of [0, -1, 1.5, "2"]) {
      expect(
        requirementUpdateSchema.safeParse({ name: "更新", expectedVersion })
          .success,
      ).toBe(false);
    }
    expect(
      requirementUpdateSchema.safeParse({ expectedVersion: 1 }).success,
    ).toBe(false);
    expect(
      requirementUpdateSchema.safeParse({
        expectedVersion: 1,
        stageNote: "说明",
      }).success,
    ).toBe(false);
  });

  it("负责人和验收标准可单独编辑且不会补全其他字段", () => {
    expect(requirementUpdateSchema.parse({ assigneeUserId: null })).toEqual({
      assigneeUserId: null,
    });
    expect(requirementUpdateSchema.parse({ developerUserId: 9 })).toEqual({
      developerUserId: 9,
    });
    expect(requirementUpdateSchema.parse({ acceptanceCriteria: "" })).toEqual({
      acceptanceCriteria: "",
    });
  });
});

describe("需求列表项目筛选", () => {
  it("项目筛选解析数字查询值，拒绝非正整数", () => {
    expect(requirementListSchema.parse({ projectId: 8 }).projectId).toBe(8);
    expect(requirementListSchema.parse({ projectId: "8" }).projectId).toBe(8);
    for (const projectId of [0, -1, 1.5, "no"]) {
      expect(requirementListSchema.safeParse({ projectId }).success).toBe(
        false,
      );
    }
  });

  it("未关联筛选只解析明确的布尔值与布尔查询字符串", () => {
    for (const unassigned of [true, "true"]) {
      expect(requirementListSchema.parse({ unassigned }).unassigned).toBe(true);
    }
    for (const unassigned of [false, "false"]) {
      expect(requirementListSchema.parse({ unassigned }).unassigned).toBe(
        false,
      );
    }
    for (const unassigned of [1, 0, "1", "0", "yes", "", null]) {
      expect(requirementListSchema.safeParse({ unassigned }).success).toBe(
        false,
      );
    }
  });

  it("项目与未关联筛选不能同时提交", () => {
    for (const unassigned of [true, false, "true", "false"]) {
      expect(
        requirementListSchema.safeParse({ projectId: 8, unassigned }).success,
      ).toBe(false);
    }
  });
});

describe("需求共享确认", () => {
  const confirmation = {
    token: "preview-token",
    confirmed: true,
    expectedVersion: 1,
  };

  it("确认必须提供预览令牌、显式确认和需求基准版本", () => {
    expect(requirementShareSchema.parse(confirmation)).toEqual(confirmation);
    for (const value of [
      { confirmed: true, expectedVersion: 1 },
      { ...confirmation, token: "" },
      { token: "preview-token", expectedVersion: 1 },
      { ...confirmation, confirmed: false },
      { ...confirmation, confirmed: "true" },
      { token: "preview-token", confirmed: true },
      { ...confirmation, expectedVersion: 0 },
      { ...confirmation, expectedVersion: "1" },
    ]) {
      expect(requirementShareSchema.safeParse(value).success).toBe(false);
    }
  });

  it("共享时可重新选择负责人和清空开发负责人", () => {
    expect(
      requirementShareSchema.parse({
        ...confirmation,
        assigneeUserId: 8,
        developerUserId: null,
      }),
    ).toEqual({ ...confirmation, assigneeUserId: 8, developerUserId: null });
    expect(
      requirementShareSchema.safeParse({
        ...confirmation,
        assigneeUserId: null,
      }).success,
    ).toBe(false);
    expect(
      requirementShareSchema.safeParse({ ...confirmation, developerUserId: 0 })
        .success,
    ).toBe(false);
  });

  it("共享确认不能额外更换预览中已绑定的目标项目", () => {
    expect(
      requirementShareSchema.safeParse({ ...confirmation, projectId: 7 })
        .success,
    ).toBe(false);
  });
});
