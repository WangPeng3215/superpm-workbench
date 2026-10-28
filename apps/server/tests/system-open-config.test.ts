import { describe, expect, it } from "vitest";
import { resolveAllowSystemOpen } from "../src/config/index";

describe("resolveAllowSystemOpen", () => {
  it("is enabled by default", () => {
    expect(resolveAllowSystemOpen(undefined)).toBe(true);
    expect(resolveAllowSystemOpen("")).toBe(true);
    expect(resolveAllowSystemOpen("1")).toBe(true);
  });

  it("can be turned off explicitly", () => {
    expect(resolveAllowSystemOpen("0")).toBe(false);
    expect(resolveAllowSystemOpen(" false ")).toBe(false);
    expect(resolveAllowSystemOpen("OFF")).toBe(false);
  });
});
