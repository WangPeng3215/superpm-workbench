# superPM 项目管理 S0.1：共享项目契约 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立独立、可测试的项目与成员共享契约，作为后续前后端的共同输入输出边界，本步骤不启用数据共享。

**Architecture:** 新增纯 TypeScript/Zod 模块，从 shared 根入口导出。把已有日期校验等价移到无上层依赖的 dates.ts，让项目模块直接复用，避免 projects.ts 反向导入 index.ts 产生循环初始化。

**Tech Stack:** TypeScript、Zod 3、Vitest；不新增依赖。

**开发总纲：** [项目管理 V1 开发文档](2026-11-19-project-management-v1-development.md)。

---

## 范围与执行规则

- 当前状态：**S0.1 实现与回归已完成，S0/S1 整体验证已通过**；最终结果见[验证记录](../../reviews/2026-11-20-project-management-s1-validation.md)。本文保留最初代码基线，实际契约后续在 S1 中扩展，以源码为准。
- 当时 S0.1 的步骤边界仅为 shared 源码与单测；后续 S0/S1 已另行修改数据库、HTTP、权限与页面，不能将此边界描述为当前合并后的总 diff。版本号和真实 workspace 仍未改变。
- 这里定义输入形状和类型，不在前端用角色数组代替后端鉴权。成员是否有效、负责人对应角色、最后 owner 保护、状态前置条件，留在 S1 的事务内实现。
- 每次先执行相应失败测试，再写最小实现，验证通过后勾选；不跳过红灯结果。
- 禁止在本步骤顺带修已有业务问题。发现基线失败记录实际输出，进入 S0.2/S0.3 对应工作项。
- 本次没有提交/推送/发布指令，完成后保留可审阅 diff，不自动提交。

## 文件清单

| 操作 | 路径                                            | 职责                                    |
| ---- | ----------------------------------------------- | --------------------------------------- |
| 新建 | `packages/shared/src/dates.ts`                  | 等价复用现有严格业务日校验              |
| 修改 | `packages/shared/src/index.ts`                  | 导入/重导出 dateSchema；重导出 projects |
| 新建 | `packages/shared/src/projects.ts`               | 本计划完整项目契约                      |
| 新建 | `packages/shared/tests/dates.test.ts`           | 日期行为与原公共入口兼容                |
| 新建 | `packages/shared/tests/projects.test.ts`        | 输入约束、版本和角色契约                |
| 新建 | `packages/shared/tests/projects-public.test.ts` | 公共导出契约                            |

不修改 `packages/shared/package.json` 的 exports；统一从已有 `@superpm/shared` 根入口使用，不创建未声明的包子路径。

## Task 1：先锁定日期兼容行为

**Files:** Create `packages/shared/tests/dates.test.ts`。

- [x] **Step 1：写入日期兼容测试。**

```typescript
import { describe, expect, it } from "vitest";
import { dateSchema } from "../src/dates";
import { dateSchema as publicDateSchema } from "../src/index";

describe("共享业务日期", () => {
  it("接受真实日期和闰日", () => {
    expect(dateSchema.parse("2026-11-19")).toBe("2026-11-19");
    expect(dateSchema.parse("2024-02-29")).toBe("2024-02-29");
  });

  it.each([
    "2026-02-29",
    "2026-13-01",
    "2026-11-31",
    "2026-1-1",
    " 2026-11-19",
    "",
  ])("拒绝无效日期 %s", (value) =>
    expect(dateSchema.safeParse(value).success).toBe(false),
  );

  it("原公共 dateSchema 导出保持同一校验器", () => {
    expect(publicDateSchema).toBe(dateSchema);
  });
});
```

- [ ] **Step 2：历史红灯验证（未保留可独立核验的首次执行日志，不由当前绿灯反推）。**

```powershell
npx vitest run packages/shared/tests/dates.test.ts
```

预期：因 `../src/dates` 不存在而失败；若其他错误先发生，先记录并核实测试环境，不把任意失败算作有效红灯。

## Task 2：等价提取已有日期校验

**Files:** Create `packages/shared/src/dates.ts`；Modify `packages/shared/src/index.ts`。

- [x] **Step 1：创建 dates.ts，使用原有实现。**

```typescript
import { z } from "zod";

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(value + "T00:00:00Z");
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "无效日期");
```

- [x] **Step 2：局部调整 index.ts。**

在顶部 `import { z } from "zod";` 之后增加：

```typescript
import { dateSchema } from "./dates.js";
export { dateSchema } from "./dates.js";
```

删除原有 `export const dateSchema = z.string()...` 整个声明块，保留并继续使用后面的 `const nullableDate = dateSchema.nullable();`。不修改其他日期字段、需求 schema 或提示文案。提取后的算法与原算法相同，字符串拼接只是避免反向依赖，不改变日期语义。

- [x] **Step 3：验证绿灯及需求契约回归。**

```powershell
npx vitest run packages/shared/tests/dates.test.ts apps/server/tests/requirements.test.ts
npm run typecheck -w @superpm/shared
```

预期：全部通过，原 dateSchema 公共导出保留；不应因为本步骤改变旧需求的日期校验结果。

## Task 3：先定义项目契约的失败用例

**Files:** Create `packages/shared/tests/projects.test.ts`。

- [x] **Step 1：写入完整测试。**

```typescript
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
```

- [ ] **Step 2：历史红灯验证（未保留可独立核验的首次执行日志，不由当前绿灯反推）。**

```powershell
npx vitest run packages/shared/tests/projects.test.ts
```

预期：projects 模块不存在，测试无法导入。测试明确区分字段校验与服务端权限规则，不拿纯 schema 通过代替权限完成。

## Task 4：实现完整项目契约模块

**Files:** Create `packages/shared/src/projects.ts`。

- [x] **Step 1：写入项目契约模块（后续 S1 有扩展）。**

```typescript
import { z } from "zod";
import { dateSchema } from "./dates.js";

export const projectStatuses = [
  "planning",
  "active",
  "awaiting_acceptance",
  "closed",
  "paused",
  "cancelled",
] as const;
export type ProjectStatus = (typeof projectStatuses)[number];
export const projectStatusLabels: Record<ProjectStatus, string> = {
  planning: "筹备中",
  active: "进行中",
  awaiting_acceptance: "待验收",
  closed: "已结项",
  paused: "已暂停",
  cancelled: "已取消",
};

export const projectRoles = [
  "owner",
  "product_owner",
  "contributor",
  "viewer",
] as const;
export type ProjectRole = (typeof projectRoles)[number];
export const projectRoleLabels: Record<ProjectRole, string> = {
  owner: "项目负责人",
  product_owner: "产品负责人",
  contributor: "执行成员",
  viewer: "只读成员",
};

export const projectVersionSchema = z.number().int().positive();
const projectFieldsSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "请输入项目名称")
      .max(200, "项目名称最多 200 字"),
    goal: z.string().max(5000).default(""),
    scopeSummary: z.string().max(5000).default(""),
    customerName: z.string().trim().max(200).default(""),
    customerContact: z.string().trim().max(2000).default(""),
    plannedStartDate: dateSchema.nullable().default(null),
    targetDeliveryDate: dateSchema.nullable().default(null),
  })
  .strict();

function checkDateOrder(
  value: {
    plannedStartDate?: string | null;
    targetDeliveryDate?: string | null;
  },
  context: z.RefinementCtx,
) {
  if (
    value.plannedStartDate &&
    value.targetDeliveryDate &&
    value.targetDeliveryDate < value.plannedStartDate
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetDeliveryDate"],
      message: "目标交付日不能早于计划开始日",
    });
  }
}

export const projectCreateSchema =
  projectFieldsSchema.superRefine(checkDateOrder);
export const projectUpdateSchema = projectFieldsSchema
  .partial()
  .extend({
    expectedVersion: projectVersionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    checkDateOrder(value, context);
    if (!Object.keys(value).some((key) => key !== "expectedVersion")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "请提交需要更新的字段",
      });
    }
  });
export type ProjectCreate = z.input<typeof projectCreateSchema>;
export type ProjectCreateParsed = z.output<typeof projectCreateSchema>;
export type ProjectUpdate = z.input<typeof projectUpdateSchema>;

const memberRolesSchema = z
  .array(z.enum(projectRoles))
  .min(1)
  .max(4)
  .refine((roles) => new Set(roles).size === roles.length, "角色不能重复");
export const projectMemberWriteSchema = z
  .object({
    userId: z.number().int().positive(),
    roles: memberRolesSchema,
    expectedVersion: projectVersionSchema,
  })
  .strict();
export type ProjectMemberWrite = z.input<typeof projectMemberWriteSchema>;

export const projectLeadsUpdateSchema = z
  .object({
    ownerUserId: z.number().int().positive(),
    productOwnerUserId: z.number().int().positive(),
    expectedVersion: projectVersionSchema,
  })
  .strict();
export type ProjectLeadsUpdate = z.input<typeof projectLeadsUpdateSchema>;

export const projectLifecycleActions = [
  "start",
  "pause",
  "resume",
  "cancel",
  "submit_acceptance",
  "close",
  "reopen",
] as const;
export type ProjectLifecycleAction = (typeof projectLifecycleActions)[number];
const actionsRequiringReason: ReadonlySet<ProjectLifecycleAction> = new Set([
  "pause",
  "resume",
  "cancel",
  "close",
  "reopen",
]);
export const projectLifecycleSchema = z
  .object({
    action: z.enum(projectLifecycleActions),
    expectedVersion: projectVersionSchema,
    reason: z.string().trim().max(2000).default(""),
  })
  .strict()
  .superRefine((value, context) => {
    if (actionsRequiringReason.has(value.action) && !value.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "请填写操作原因或结论",
      });
    }
  });
export type ProjectLifecycleInput = z.input<typeof projectLifecycleSchema>;

export const projectArchiveSchema = z
  .object({
    archived: z.boolean(),
    expectedVersion: projectVersionSchema,
  })
  .strict();
export type ProjectArchiveInput = z.input<typeof projectArchiveSchema>;

export const projectListSchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    view: z.enum(["all", "owned", "participating", "archived"]).default("all"),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z
      .enum([
        "projectNo",
        "name",
        "targetDeliveryDate",
        "createdAt",
        "updatedAt",
      ])
      .default("updatedAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();
export type ProjectListQuery = z.input<typeof projectListSchema>;
export type ProjectListParsed = z.output<typeof projectListSchema>;

export interface Project extends ProjectCreateParsed {
  id: number;
  projectNo: string;
  ownerUserId: number;
  productOwnerUserId: number;
  status: ProjectStatus;
  previousStatus: ProjectStatus | null;
  version: number;
  archivedAt: string | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  projectId: number;
  userId: number;
  username: string;
  displayName: string;
  roles: ProjectRole[];
  status: "active" | "removed";
  accountStatus: "active" | "disabled";
  joinedAt: string;
  removedAt: string | null;
}

export interface ProjectCapabilities {
  canEditProject: boolean;
  canManageMembers: boolean;
  canManageRequirements: boolean;
  canManageProjectTasks: boolean;
  canPrepareDelivery: boolean;
  canConfirmScope: boolean;
  canCloseProject: boolean;
}

export interface ProjectDetail {
  project: Project;
  members: ProjectMember[];
  capabilities: ProjectCapabilities;
}

export interface ProjectListResult {
  items: Project[];
  total: number;
  page: number;
  pageSize: number;
}
```

注意：项目 PATCH 的区间校验只能比较本次同时给出的日期。服务层必须把 patch 与库中当前项目合并后再执行 projectCreateSchema 校验，防止只改交付日时绕过计划区间约束。Project.previousStatus 是暂停/恢复的持久状态，不由客户端输入。

本步骤未导出验收/任务等未实现能力。ProjectCapabilities 只是服务端计算结果的响应类型，不接受客户端写入。任务确认与交付验收是对象级能力，在相应阶段另定义，不能据 canPrepareDelivery 推断可代他人验收。

- [x] **Step 2：执行绿灯验证。**

```powershell
npx vitest run packages/shared/tests/dates.test.ts packages/shared/tests/projects.test.ts
npm run typecheck -w @superpm/shared
```

预期：所有上述用例通过，项目模块不依赖数据库、环境变量、Vue 或 index.ts。

## Task 5：公开导出并验证兼容性

**Files:** Create `packages/shared/tests/projects-public.test.ts`；Modify `packages/shared/src/index.ts`。

- [x] **Step 1：添加公共入口测试（当前回归通过，首次红灯未保留独立日志）。**

```typescript
import { expect, it } from "vitest";
import * as shared from "../src/index";
import { projectCreateSchema } from "../src/projects";

it("项目契约可从 shared 根入口读取且不替换旧日期和需求入口", () => {
  expect(shared).toHaveProperty("projectCreateSchema");
  expect(Reflect.get(shared, "projectCreateSchema")).toBe(projectCreateSchema);
  expect(
    shared.requirementCreateSchema.parse({
      name: "旧需求",
      proposedAt: "2026-11-19",
    }).name,
  ).toBe("旧需求");
  expect(shared.dateSchema.parse("2026-11-19")).toBe("2026-11-19");
});
```

执行：

```powershell
npx vitest run packages/shared/tests/projects-public.test.ts
```

预期：因根入口尚未导出 projectCreateSchema 而失败。

- [x] **Step 2：在 index.ts 末尾添加唯一导出语句。**

```typescript
export * from "./projects.js";
```

- [x] **Step 3：执行相关回归与全工作区类型检查。**

```powershell
npx vitest run packages/shared/tests apps/server/tests/requirements.test.ts
npm run typecheck
npx prettier --check packages/shared/src/dates.ts packages/shared/src/projects.ts packages/shared/src/index.ts packages/shared/tests/dates.test.ts packages/shared/tests/projects.test.ts packages/shared/tests/projects-public.test.ts
```

如新文件仅有排版问题，使用 prettier --write 精确指向上述本次文件后重跑；不运行仓库级 format 写操作。预期：相关测试、全工作区类型检查和格式检查通过。

## Task 6：完成证据与进入下一批

- [x] 核对 shared 源码与测试落点；S0/S1 合并后的改动范围、空白检查及真实数据边界统一记录在最终验证文档，不再把 S0.1 的局部范围当作本轮总范围。
- [x] 记录实际测试与类型检查结果；未核验的首次红灯明确保留上述说明，不伪填通过。开发总纲阶段状态已在最终回归后同步。
- [x] 只读复核类型名称、strict 边界、日期等价性和公开入口循环依赖。

实施调整：S0.2 未另建小计划，实际直接按开发总纲 S0.2 执行 SQL 边界修复和固定时钟测试。其红绿复现与限制见 Bug 表 BUG-003/012 及最终验证记录；共享入口在后续 S1 才接入。

## 本步骤验收

完成后能够从 `@superpm/shared` 使用明确的项目创建/编辑/成员/生命周期/列表契约；名称为唯一手填创建字段，角色可兼任，共享写入契约要求版本，业务身份/状态不可塞进普通 PATCH。现有需求与日期公共入口保持兼容。本步骤不代表项目页面、权限、数据库或交付功能已实现。
