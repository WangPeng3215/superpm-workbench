import { describe, expect, it } from "vitest";
import { stageTransitionNeedsNote } from "../src/features/requirements/stage-transition";

describe("需求阶段原因", () => {
  it("仅跳过或退回阶段需要原因，原阶段和顺序前进不需要", () => {
    expect(stageTransitionNeedsNote("analysis", "analysis")).toBe(false);
    expect(stageTransitionNeedsNote("analysis", "development")).toBe(true);
    expect(stageTransitionNeedsNote("development", "analysis")).toBe(true);
    expect(stageTransitionNeedsNote("analysis", "design")).toBe(false);
    expect(stageTransitionNeedsNote("design", "development")).toBe(false);
  });
});
