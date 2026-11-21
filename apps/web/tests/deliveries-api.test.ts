import { afterEach, expect, it, vi } from "vitest";
import { deliveryApi } from "../src/api/deliveries";

afterEach(() => vi.unstubAllGlobals());

it("uses the delivery scope endpoints and retries uncertain commands with one key", async () => {
  const fetch = vi
    .fn<(path: string, init?: RequestInit) => Promise<Response>>()
    .mockRejectedValueOnce(new Error("connection interrupted"))
    .mockImplementation(async () => Response.json({ id: 7 }));
  vi.stubGlobal("fetch", fetch);
  await expect(
    deliveryApi.confirmScope(7, { expectedVersion: 1, requirementIds: [3] }),
  ).rejects.toMatchObject({ status: 0 });
  await deliveryApi.confirmScope(7, { expectedVersion: 1, requirementIds: [3] });
  const [first, retry] = fetch.mock.calls;
  expect(first[0]).toBe("/api/deliveries/7/scope-confirmations");
  expect(retry).toEqual(first);
  expect(first[1]?.headers).toMatchObject({
    "Idempotency-Key": expect.any(String),
  });
});

it("loads acceptance history and uses versioned idempotent acceptance commands", async () => {
  const fetch = vi
    .fn<(path: string, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async () => Response.json({ id: 7 }));
  vi.stubGlobal("fetch", fetch);

  await deliveryApi.acceptanceRounds(7);
  await deliveryApi.submitAcceptance(7, {
    expectedVersion: 3,
    scopeVersionId: 9,
    evidence: [{ kind: "text", label: "发布说明", content: "v1" }],
  });
  await deliveryApi.recordAcceptanceResults(11, {
    expectedVersion: 4,
    scopeVersionId: 9,
    results: [{ scopeItemId: 12, result: "passed" }],
  });

  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    "/api/deliveries/7/acceptance-rounds",
    "/api/deliveries/7/acceptance-rounds",
    "/api/acceptance-rounds/11/results",
  ]);
  for (const [, init] of fetch.mock.calls.slice(1)) {
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Idempotency-Key": expect.any(String) });
  }
});

it("uses both delivery and blocker ids when resolving a blocker", async () => {
  const fetch = vi
    .fn<(path: string, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async () => Response.json({ id: 9 }));
  vi.stubGlobal("fetch", fetch);

  await deliveryApi.resolveBlockingIssue(7, 9, { expectedVersion: 3 });

  expect(fetch.mock.calls[0][0]).toBe("/api/deliveries/7/blocking-issues/9");
  expect(fetch.mock.calls[0][1]?.method).toBe("PATCH");
  expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
    "Idempotency-Key": expect.any(String),
  });
});
