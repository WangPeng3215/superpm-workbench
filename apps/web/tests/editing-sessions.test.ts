import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearEditingSessions,
  flushEditingSessions,
  registerEditingSession,
} from "../src/stores/editing-sessions";
afterEach(clearEditingSessions);
describe("编辑会话", () => {
  it("后台页签也会保存，失败时整批关闭停止", async () => {
    const dispose = vi.fn();
    const flush = vi.fn(async () => false);
    registerEditingSession("/projects/1", { flush: async () => true, dispose });
    registerEditingSession("/requirements/2", { flush, dispose });
    expect(await flushEditingSessions(["/projects/1", "/requirements/2"])).toBe(
      false,
    );
    expect(flush).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
  });
  it("卸载旧实例不会注销同路径的新实例", async () => {
    const unregister = registerEditingSession("/projects/1", {
      flush: async () => false,
    });
    const flush = vi.fn(async () => true);
    registerEditingSession("/projects/1", { flush });
    unregister();
    expect(await flushEditingSessions()).toBe(true);
    expect(flush).toHaveBeenCalledOnce();
  });
});
