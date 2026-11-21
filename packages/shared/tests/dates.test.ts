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
