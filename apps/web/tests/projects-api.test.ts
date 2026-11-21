import { afterEach, describe, expect, it, vi } from "vitest";
import { projectApi } from "../src/api/projects";
import { request } from "../src/api/client";
import { requirementApi } from "../src/api/requirements";
afterEach(() => vi.unstubAllGlobals());
describe("项目 API", () => {
  it("项目需求删除携带行对象版本", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await requirementApi.remove(9, 4);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: 4 }),
    });
  });
  it("候选使用有界查询，移除请求保留对象版本", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    await projectApi.memberCandidates(3, "小明");
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/projects/3/member-candidates?q=%E5%B0%8F%E6%98%8E",
    );
    await projectApi.removeMember(3, 4, 7);
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: 7 }),
    });
    const taskTransfers = [
      { taskId: 11, expectedVersion: 2, assigneeUserId: 5, confirmerUserId: 8 },
    ];
    await projectApi.removeMember(3, 4, 8, taskTransfers);
    expect(fetch.mock.calls[2][1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: 8, taskTransfers }),
    });
  });
  it("错误保留版本冲突及责任移交详情", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "VERSION_CONFLICT",
              message: "已被修改",
              details: { currentVersion: 8 },
            },
          }),
          { status: 409 },
        ),
    );
    await expect(request("/projects/3")).rejects.toMatchObject({
      status: 409,
      details: { currentVersion: 8 },
    });
  });
  it("不确定失败重试保留业务命令键，成功后重新操作使用新键", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("连接中断"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "服务暂不可用" } }), {
          status: 503,
        }),
      )
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ project: { id: 5 } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    const input = { name: "创建重试项目" };
    await expect(projectApi.create(input)).rejects.toMatchObject({ status: 0 });
    await expect(projectApi.create(input)).rejects.toMatchObject({
      status: 503,
    });
    await projectApi.create(input);
    await projectApi.create(input);
    const keys = fetch.mock.calls.map(
      (call) => call[1].headers["Idempotency-Key"],
    );
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[0].length).toBeGreaterThan(10);
    expect(keys.slice(0, 3)).toEqual([keys[0], keys[0], keys[0]]);
    expect(keys[3]).not.toBe(keys[0]);
  });
  it("确定校验失败结束命令键，成员变更带键而普通字段PATCH不带键", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "版本冲突" } }), {
          status: 409,
        }),
      )
      .mockImplementation(
        async () => new Response(JSON.stringify({}), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    const input = {
      userId: 4,
      roles: ["contributor"] as ["contributor"],
      expectedVersion: 7,
    };
    await expect(projectApi.addMember(6, input)).rejects.toMatchObject({
      status: 409,
    });
    await projectApi.addMember(6, input);
    await projectApi.update(6, { name: "普通编辑", expectedVersion: 7 });
    expect(fetch.mock.calls[0][1].headers["Idempotency-Key"]).toEqual(
      expect.any(String),
    );
    expect(fetch.mock.calls[1][1].headers["Idempotency-Key"]).not.toBe(
      fetch.mock.calls[0][1].headers["Idempotency-Key"],
    );
    expect(fetch.mock.calls[2][1].headers["Idempotency-Key"]).toBeUndefined();
  });
});
