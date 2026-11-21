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
