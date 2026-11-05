import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoSaveDelay,
  createAutoSave,
  type AutoSaveState,
} from "../src/features/meetings/autosave";

interface Draft {
  text: string;
}

function setup(initial: string) {
  const states: AutoSaveState[] = [];
  let draft = initial;
  const persist = vi.fn(async (_payload: Draft) => {});
  const saver = createAutoSave<Draft>({
    snapshot: () => (draft.trim() ? { text: draft } : null),
    persist,
    onStateChange: (state) => states.push(state),
  });
  return {
    saver,
    persist,
    states,
    setDraft: (value: string) => {
      draft = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("会议记录实时保存", () => {
  it("连续输入只落盘一次，并带上最后一次内容", async () => {
    const { saver, persist, setDraft } = setup("会议");
    setDraft("会议记");
    saver.schedule();
    await vi.advanceTimersByTimeAsync(300);
    setDraft("会议记录");
    saver.schedule();
    await vi.advanceTimersByTimeAsync(autoSaveDelay - 1);
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toEqual({ text: "会议记录" });
  });

  it("状态按 pending → saving → saved 流转", async () => {
    const { saver, states } = setup("会议");
    saver.schedule();
    expect(saver.state()).toBe("pending");
    await vi.advanceTimersByTimeAsync(autoSaveDelay);
    expect(states).toEqual(["pending", "saving", "saved"]);
    expect(saver.state()).toBe("saved");
  });

  it("必填项缺失时不发请求，补全后可继续保存", async () => {
    const { saver, persist, setDraft } = setup("");
    saver.schedule();
    await vi.advanceTimersByTimeAsync(autoSaveDelay);
    expect(persist).not.toHaveBeenCalled();
    expect(saver.state()).toBe("blocked");
    expect(await saver.flush()).toBe(false);
    setDraft("补全标题");
    expect(await saver.flush()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(saver.state()).toBe("saved");
  });

  it("落盘失败保留改动，重试成功后转为已保存", async () => {
    const { saver, persist } = setup("会议");
    persist.mockRejectedValueOnce(new Error("网络异常"));
    saver.schedule();
    await vi.advanceTimersByTimeAsync(autoSaveDelay);
    expect(saver.state()).toBe("error");
    expect(await saver.retry()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(saver.state()).toBe("saved");
  });

  it("flush 立即落盘，不会重复提交", async () => {
    const { saver, persist } = setup("会议");
    saver.schedule();
    expect(await saver.flush()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(autoSaveDelay);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("保存期间的新改动在完成后继续落盘", async () => {
    const { saver, persist, setDraft } = setup("会议");
    let release: (() => void) | undefined;
    persist.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    saver.schedule();
    await vi.advanceTimersByTimeAsync(autoSaveDelay);
    expect(saver.state()).toBe("saving");
    setDraft("会议补充结论");
    saver.schedule();
    release?.();
    await vi.advanceTimersByTimeAsync(autoSaveDelay);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1][0]).toEqual({ text: "会议补充结论" });
    expect(saver.state()).toBe("saved");
  });

  it("dispose 后不再落盘", async () => {
    const { saver, persist } = setup("会议");
    saver.schedule();
    saver.dispose();
    await vi.advanceTimersByTimeAsync(autoSaveDelay * 2);
    expect(persist).not.toHaveBeenCalled();
  });
});
