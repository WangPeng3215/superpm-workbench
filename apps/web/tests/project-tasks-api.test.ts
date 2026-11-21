import { afterEach, expect, it, vi } from "vitest";
import { projectTaskApi } from "../src/api/project-tasks";

afterEach(() => vi.unstubAllGlobals());

it("keeps requirement scope in the confirmation queue", async () => {
  const fetch = vi.fn(async (_path: string) => Response.json({ items: [] }));
  vi.stubGlobal("fetch", fetch);
  await projectTaskApi.list(3, {
    requirementId: 7,
    status: "pending_confirmation",
    confirmerUserId: 5,
    page: 2,
    pageSize: 20,
  });
  const url = new URL(fetch.mock.calls[0][0], "http://localhost");
  expect(url.pathname).toBe("/api/projects/3/tasks");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    requirementId: "7",
    status: "pending_confirmation",
    confirmerUserId: "5",
    page: "2",
    pageSize: "20",
  });
});

it("retries an uncertain submission with the same command key and version", async () => {
  const fetch = vi
    .fn<(path: string, init: RequestInit) => Promise<Response>>()
    .mockRejectedValueOnce(new Error("connection interrupted"))
    .mockImplementation(async () => Response.json({}));
  vi.stubGlobal("fetch", fetch);
  const data = {
    action: "submit" as const,
    expectedVersion: 4,
    summary: "已实现",
    evidence: [{ kind: "external_link" as const, url: "https://example.com" }],
  };
  await expect(projectTaskApi.action(3, data)).rejects.toMatchObject({
    status: 0,
  });
  await projectTaskApi.action(3, data);
  await projectTaskApi.plan(3, {
    date: "2026-11-20",
    expectedVersion: 5,
    plannedStartAt: "09:00",
    plannedEndAt: "10:00",
    estimatedMinutes: 60,
  });
  const [first, retry, plan] = fetch.mock.calls;
  expect(first[0]).toBe("/api/project-tasks/3/actions");
  expect(JSON.parse(String(retry[1].body))).toEqual(data);
  expect(first[1].headers).toMatchObject({
    "Idempotency-Key": expect.any(String),
  });
  expect(retry).toEqual(first);
  expect(plan[0]).toBe("/api/project-tasks/3/daily-plans");
  expect(JSON.parse(String(plan[1].body))).toEqual({
    date: "2026-11-20",
    expectedVersion: 5,
    plannedStartAt: "09:00",
    plannedEndAt: "10:00",
    estimatedMinutes: 60,
  });
});
