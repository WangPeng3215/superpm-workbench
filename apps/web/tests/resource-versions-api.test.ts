import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactApi } from "../src/api/artifacts";
import { issueApi } from "../src/api/issues";

afterEach(() => vi.unstubAllGlobals());
describe("共享子资源版本请求", () => {
  it("默认评论键在连接中断和503后复用，成功后的新评论使用新键", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("连接中断"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "暂不可用" } }), {
          status: 503,
        }),
      )
      .mockImplementation(
        async () => new Response(JSON.stringify({}), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(issueApi.comment(2, 7, "失败重试讨论")).rejects.toMatchObject({
      status: 0,
    });
    await expect(issueApi.comment(2, 7, "失败重试讨论")).rejects.toMatchObject({
      status: 503,
    });
    await issueApi.comment(2, 7, "失败重试讨论");
    await issueApi.comment(2, 7, "失败重试讨论");
    const keys = fetch.mock.calls.map(
      (call) => call[1].headers["Idempotency-Key"],
    );
    expect(keys.slice(0, 3)).toEqual([keys[0], keys[0], keys[0]]);
    expect(keys[3]).not.toBe(keys[0]);
  });
  it("追加讨论传送可复用的幂等键", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    await issueApi.comment(2, 7, "讨论", "command-id");
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      "Idempotency-Key": "command-id",
    });
  });
  it("正文写入传送SHA-256基准，元数据修改传送整数基准", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const hash = "a".repeat(64);
    await artifactApi.saveContent(5, "正文", false, hash);
    await artifactApi.rename(5, "新名", 3);
    await artifactApi.move(5, null, 3);
    await artifactApi.setNodeFinal(5, true, 3);
    expect(
      fetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
    ).toEqual([
      { content: "正文", force: false, expectedVersion: hash },
      { name: "新名", expectedVersion: 3 },
      { targetParentId: null, expectedVersion: 3 },
      { isFinal: true, expectedVersion: 3 },
    ]);
  });

  it("节点和链接删除的查询中保留对象版本", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await artifactApi.remove(5, true, 4);
    await artifactApi.removeLink(6, 2);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/artifacts/nodes/5?recursive=1&expectedVersion=4",
      "/api/artifacts/links/6?expectedVersion=2",
    ]);
  });

  it("问题专用正文与删除使用各自的版本类型", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const hash = "b".repeat(64);
    await issueApi.saveDescription(2, 7, "正文", hash);
    await issueApi.remove(2, 7, 3);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      content: "正文",
      expectedVersion: hash,
    });
    expect(fetch.mock.calls[1][0]).toBe(
      "/api/requirements/2/issues/7?expectedVersion=3",
    );
  });
});
