import { describe, expect, it } from "vitest";
import {
  acceptanceResultsSchema,
  acceptanceSubmissionSchema,
} from "../src/deliveries.js";

describe("delivery acceptance contracts", () => {
  it("normalizes evidence labels and accepts immutable text plus external HTTP URLs", () => {
    const parsed = acceptanceSubmissionSchema.parse({
      expectedVersion: 2,
      scopeVersionId: 8,
      deliveryNotes: " Release notes ",
      evidence: [
        { kind: "text", label: " Notes ", content: "Build 1" },
        { kind: "url", label: " Demo ", url: "https://example.com/demo" },
      ],
    });
    expect(parsed.deliveryNotes).toBe("Release notes");
    expect(parsed.evidence.map((item) => item.label)).toEqual(["Notes", "Demo"]);
  });

  it("rejects empty evidence and non-HTTP external URLs", () => {
    expect(() =>
      acceptanceSubmissionSchema.parse({
        expectedVersion: 2,
        scopeVersionId: 8,
        evidence: [],
      }),
    ).toThrow();
    expect(() =>
      acceptanceSubmissionSchema.parse({
        expectedVersion: 2,
        scopeVersionId: 8,
        evidence: [{ kind: "url", label: "Local", url: "file:///tmp/demo" }],
      }),
    ).toThrow();
  });

  it("requires unique, complete-ready result items and a reason for failures", () => {
    expect(
      acceptanceResultsSchema.safeParse({
        expectedVersion: 3,
        scopeVersionId: 8,
        results: [
          { scopeItemId: 4, result: "passed" },
          { scopeItemId: 4, result: "passed" },
        ],
      }).success,
    ).toBe(false);
    expect(
      acceptanceResultsSchema.safeParse({
        expectedVersion: 3,
        scopeVersionId: 8,
        results: [{ scopeItemId: 4, result: "failed" }],
      }).success,
    ).toBe(false);
    expect(
      acceptanceResultsSchema.safeParse({
        expectedVersion: 3,
        scopeVersionId: 8,
        results: [
          { scopeItemId: 4, result: "passed" },
          { scopeItemId: 5, result: "failed", reason: "仍不满足" },
        ],
      }).success,
    ).toBe(true);
  });
});
