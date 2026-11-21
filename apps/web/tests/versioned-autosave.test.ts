import { afterEach, describe, expect, it, vi } from "vitest";
import { createVersionedAutoSave } from "../src/features/editing/versioned-autosave";

afterEach(() => vi.useRealTimers());
describe("版本自动保存", () => {
  it("串行保存新修订并保留请求期间的输入", async () => {
    let draft = { name: "初始" };
    const calls: unknown[] = [];
    let release!: (value: { name: string; version: number }) => void;
    const saver = createVersionedAutoSave({
      initial: { ...draft, version: 1 },
      snapshot: () => ({ ...draft }),
      persist: async (patch, expectedVersion) => {
        calls.push({ patch, expectedVersion });
        if (calls.length === 1)
          return new Promise<{ name: string; version: number }>((resolve) => {
            release = resolve;
          });
        return { name: String(patch.name), version: 3 };
      },
      apply: (server, sent) => {
        if (draft.name === sent.name) draft.name = server.name;
      },
    });
    draft.name = "第一次";
    saver.schedule();
    const saving = saver.flush();
    await Promise.resolve();
    draft.name = "第二次";
    saver.schedule();
    release({ name: "第一次", version: 2 });
    expect(await saving).toBe(true);
    expect(draft.name).toBe("第二次");
    expect(calls).toEqual([
      { patch: { name: "第一次" }, expectedVersion: 1 },
      { patch: { name: "第二次" }, expectedVersion: 2 },
    ]);
    saver.dispose();
  });
  it("409 暂停重试并保留草稿直到明确重载", async () => {
    let draft = { name: "本地草稿" };
    let attempts = 0;
    const saver = createVersionedAutoSave({
      initial: { name: "原始", version: 1 },
      snapshot: () => draft,
      persist: async () => {
        attempts++;
        throw { status: 409, details: { currentVersion: 2 } };
      },
    });
    saver.schedule();
    expect(await saver.flush()).toBe(false);
    expect(saver.state()).toBe("conflict");
    saver.schedule();
    expect(await saver.flush()).toBe(false);
    expect(attempts).toBe(1);
    expect(draft.name).toBe("本地草稿");
    saver.reset({ name: "服务器", version: 2 });
    expect(saver.state()).toBe("idle");
    saver.dispose();
  });
  it("权限失效后停止队列且忽略已在途响应", async () => {
    let release!: (value: { name: string; version: number }) => void;
    const apply = vi.fn();
    const saver = createVersionedAutoSave({
      initial: { name: "旧", version: 1 },
      snapshot: () => ({ name: "新" }),
      persist: () =>
        new Promise<{ name: string; version: number }>((resolve) => {
          release = resolve;
        }),
      apply,
    });
    saver.schedule();
    const saving = saver.flush();
    await Promise.resolve();
    saver.invalidate();
    release({ name: "新", version: 2 });
    await saving;
    expect(apply).not.toHaveBeenCalled();
    expect(saver.state()).toBe("forbidden");
  });
});
