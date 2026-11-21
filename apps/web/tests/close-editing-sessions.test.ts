import { afterEach, describe, expect, it, vi } from "vitest";
import { closeEditingSessions } from "../src/features/editing/close-editing-sessions";
import {
  clearEditingSessions,
  registerEditingSession,
} from "../src/stores/editing-sessions";

afterEach(clearEditingSessions);
describe("关闭编辑页签", () => {
  it("后台页签保存失败时整批布局保持不变，任何会话都不销毁", async () => {
    const commit = vi.fn();
    const dispose = vi.fn();
    registerEditingSession("a", { flush: async () => true, dispose });
    registerEditingSession("b", { flush: async () => false, dispose });
    expect(await closeEditingSessions(["a", "b"], commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("等待全部保存后提交布局并销毁指定会话", async () => {
    const calls: string[] = [];
    registerEditingSession("a", {
      flush: async () => {
        calls.push("save");
        return true;
      },
      dispose: () => {
        calls.push("dispose");
      },
    });
    expect(
      await closeEditingSessions(["a"], async () => {
        calls.push("navigate");
      }),
    ).toBe(true);
    expect(calls).toEqual(["save", "navigate", "dispose"]);
  });

  it("导航被其他守卫取消时保留会话", async () => {
    const dispose = vi.fn();
    registerEditingSession("a", { flush: async () => true, dispose });
    expect(await closeEditingSessions(["a"], async () => false)).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
  });
});
