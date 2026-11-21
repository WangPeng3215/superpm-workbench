import { describe, expect, it } from "vitest";
import {
  buildScopeChangeDrafts,
  isAcceptanceResultSetComplete,
  type ScopeChangeDraft,
} from "../src/features/projects/project-delivery-acceptance";

describe("isAcceptanceResultSetComplete", () => {
  it("requires a result for every scoped requirement", () => {
    expect(
      isAcceptanceResultSetComplete(
        [1, 2],
        { 1: { result: "passed", reason: "" } },
      ),
    ).toBe(false);
  });

  it("requires a reason for each failed requirement", () => {
    expect(
      isAcceptanceResultSetComplete(
        [1, 2],
        {
          1: { result: "passed", reason: "" },
          2: { result: "failed", reason: "   " },
        },
      ),
    ).toBe(false);
  });

  it("allows submission when all results and failure reasons are complete", () => {
    expect(
      isAcceptanceResultSetComplete(
        [1, 2],
        {
          1: { result: "passed", reason: "" },
          2: { result: "failed", reason: "复现失败" },
        },
      ),
    ).toBe(true);
  });
});

describe("buildScopeChangeDrafts", () => {
  it("requires an explicit disposition, reason, and follow-up for each removed requirement", () => {
    const draft: ScopeChangeDraft = {
      type: "postpone",
      reason: "依赖客户数据",
      followUpDeliveryId: 9,
      followUpOwnerUserId: null,
      followUpDate: null,
    };

    expect(buildScopeChangeDrafts([1, 2], [1], { 2: draft })).toEqual([
      { requirementId: 2, ...draft },
    ]);
    expect(buildScopeChangeDrafts([1, 2], [1], {})).toBeNull();
    expect(
      buildScopeChangeDrafts([1, 2], [1], {
        2: { ...draft, followUpDeliveryId: null, followUpOwnerUserId: 7, followUpDate: null },
      }),
    ).toBeNull();
  });

  it("does not classify a removal as waived unless waiver is selected explicitly", () => {
    const result = buildScopeChangeDrafts(
      [4],
      [],
      {
        4: {
          type: "waive",
          reason: "双方同意不纳入本次交付",
          followUpDeliveryId: null,
          followUpOwnerUserId: 3,
          followUpDate: "2026-12-01",
        },
      },
    );
    expect(result?.[0]).toMatchObject({ type: "waive", followUpOwnerUserId: 3, followUpDate: "2026-12-01" });
  });
});
