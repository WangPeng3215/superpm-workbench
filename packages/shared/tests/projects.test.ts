import { describe, expect, it } from "vitest";
import {
  projectArchiveSchema,
  projectCreateSchema,
  projectLeadsUpdateSchema,
  projectLifecycleSchema,
  projectListSchema,
  projectMemberWriteSchema,
  projectRoles,
  projectStatuses,
  projectUpdateSchema,
} from "../src/projects";

describe("项目基础输入", () => {
  it("创建仅需手填名称，其他普通字段有默认值", () => {
    expect(projectCreateSchema.parse({ name: "  客户工单系统一期  " })).toEqual(
      {
        name: "客户工单系统一期",
        goal: "",
        scopeSummary: "",
        customerName: "",
        customerContact: "",
        plannedStartDate: null,
        targetDeliveryDate: null,
      },
    );
  });

  it.each(["", "   ", "项".repeat(201)])("拒绝非法项目名", (name) => {
    expect(projectCreateSchema.safeParse({ name }).success).toBe(false);
  });

  it("拒绝创建时自报身份、状态、版本或编号", () => {
    for (const field of [
      "createdBy",
      "ownerUserId",
      "status",
      "version",
      "projectNo",
    ]) {
      expect(
        projectCreateSchema.safeParse({ name: "项目", [field]: 1 }).success,
      ).toBe(false);
    }
  });

  it("校验真实日期与同时给出的计划区间", () => {
    expect(
      projectCreateSchema.safeParse({
        name: "项目",
        targetDeliveryDate: "2026-02-29",
      }).success,
    ).toBe(false);
    expect(
      projectCreateSchema.safeParse({
        name: "项目",
        plannedStartDate: "2026-12-10",
        targetDeliveryDate: "2026-12-01",
      }).success,
    ).toBe(false);
    expect(
      projectCreateSchema.safeParse({
        name: "项目",
        plannedStartDate: "2026-12-01",
        targetDeliveryDate: "2026-12-01",
      }).success,
    ).toBe(true);
  });

  it("普通更新携带基准版本且只保留实际传入字段", () => {
    expect(
      projectUpdateSchema.parse({ name: "新名称", expectedVersion: 3 }),
    ).toEqual({ name: "新名称", expectedVersion: 3 });
    expect(projectUpdateSchema.safeParse({ name: "新名称" }).success).toBe(
      false,
    );
    expect(projectUpdateSchema.safeParse({ expectedVersion: 3 }).success).toBe(
      false,
    );
    expect(
      projectUpdateSchema.safeParse({ name: "新名称", expectedVersion: 0 })
        .success,
    ).toBe(false);
    expect(
      projectUpdateSchema.safeParse({ status: "closed", expectedVersion: 3 })
        .success,
    ).toBe(false);
  });

  it("日期可显式清空；部分日期的全量比较由服务端合并后完成", () => {
    expect(
      projectUpdateSchema.parse({
        targetDeliveryDate: null,
        expectedVersion: 1,
      }),
    ).toEqual({ targetDeliveryDate: null, expectedVersion: 1 });
    expect(
      projectUpdateSchema.parse({
        targetDeliveryDate: "2026-12-18",
        expectedVersion: 1,
      }),
    ).toEqual({ targetDeliveryDate: "2026-12-18", expectedVersion: 1 });
  });
});

describe("项目成员与独立业务动作", () => {
  it("角色支持兼任，但不能空、重复或写未知角色", () => {
    expect(
      projectMemberWriteSchema.parse({
        userId: 8,
        roles: ["owner", "product_owner"],
        expectedVersion: 1,
      }).roles,
    ).toEqual(["owner", "product_owner"]);
    for (const roles of [[], ["owner", "owner"], ["administrator"]]) {
      expect(
        projectMemberWriteSchema.safeParse({
          userId: 8,
          roles,
          expectedVersion: 1,
        }).success,
      ).toBe(false);
    }
    expect(
      projectMemberWriteSchema.safeParse({
        userId: 0,
        roles: ["viewer"],
        expectedVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("任务责任移交要求任务和版本，并至少指定执行人或确认人", () => {
    const input = {
      userId: 8,
      roles: ["viewer"],
      expectedVersion: 3,
      taskTransfers: [{ taskId: 12, expectedVersion: 4, assigneeUserId: 9 }],
    };
    expect(projectMemberWriteSchema.parse(input)).toEqual(input);
    expect(
      projectMemberWriteSchema.safeParse({
        ...input,
        taskTransfers: [{ taskId: 12, expectedVersion: 4 }],
      }).success,
    ).toBe(false);
    expect(
      projectMemberWriteSchema.safeParse({
        ...input,
        taskTransfers: [{ taskId: 12, assigneeUserId: 9 }],
      }).success,
    ).toBe(false);
  });

  it("主负责人更换与普通项目编辑分开", () => {
    expect(
      projectLeadsUpdateSchema.parse({
        ownerUserId: 8,
        productOwnerUserId: 9,
        expectedVersion: 2,
      }),
    ).toEqual({ ownerUserId: 8, productOwnerUserId: 9, expectedVersion: 2 });
    expect(
      projectUpdateSchema.safeParse({ ownerUserId: 8, expectedVersion: 2 })
        .success,
    ).toBe(false);
  });

  it.each(["pause", "resume", "cancel", "close", "reopen"])(
    "动作 %s 必须给出原因或结论",
    (action) => {
      expect(
        projectLifecycleSchema.safeParse({ action, expectedVersion: 2 })
          .success,
      ).toBe(false);
      expect(
        projectLifecycleSchema.safeParse({
          action,
          expectedVersion: 2,
          reason: "记录动作依据",
        }).success,
      ).toBe(true);
    },
  );

  it("开始和提交验收不强制重复填写原因，但仍需要版本", () => {
    expect(
      projectLifecycleSchema.parse({ action: "start", expectedVersion: 1 })
        .reason,
    ).toBe("");
    expect(
      projectLifecycleSchema.safeParse({
        action: "submit_acceptance",
        expectedVersion: 1,
      }).success,
    ).toBe(true);
    expect(projectLifecycleSchema.safeParse({ action: "start" }).success).toBe(
      false,
    );
  });

  it("归档是独立布尔动作，拒绝真值字符串", () => {
    expect(
      projectArchiveSchema.parse({ archived: true, expectedVersion: 1 }),
    ).toEqual({ archived: true, expectedVersion: 1 });
    expect(
      projectArchiveSchema.safeParse({ archived: "false", expectedVersion: 1 })
        .success,
    ).toBe(false);
  });
});

describe("项目列表与固定枚举", () => {
  it("分页查询具有稳定默认值", () => {
    expect(projectListSchema.parse({})).toEqual({
      q: "",
      view: "all",
      page: 1,
      pageSize: 20,
      sortBy: "updatedAt",
      sortOrder: "desc",
    });
    expect(
      projectListSchema.parse({ page: "2", pageSize: "50", view: "owned" })
        .page,
    ).toBe(2);
    expect(projectListSchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(projectListSchema.safeParse({ view: "everyone" }).success).toBe(
      false,
    );
  });

  it("固定业务代码，避免前后端自行发明枚举", () => {
    expect(projectRoles).toEqual([
      "owner",
      "product_owner",
      "contributor",
      "viewer",
    ]);
    expect(projectStatuses).toEqual([
      "planning",
      "active",
      "awaiting_acceptance",
      "closed",
      "paused",
      "cancelled",
    ]);
  });
});
