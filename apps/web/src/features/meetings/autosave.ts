/**
 * 会议记录实时保存的调度器。
 *
 * 设计要点：
 * - 改动后延迟合并落盘，连续输入只发一次请求；
 * - 保存期间的再次改动会排队，落盘完成后立刻补一次，不会丢改动；
 * - `flush` 供离开页面/退出编辑时强制刷盘并等待结果；
 * - `snapshot` 返回 null 表示当前内容还不满足保存条件（例如标题为空），
 *   此时保留改动并进入 blocked 状态，等用户补全后再保存。
 *
 * 不依赖 DOM 与网络，便于单测。
 */
export type AutoSaveState =
  "idle" | "pending" | "saving" | "saved" | "blocked" | "error";

export interface AutoSaveOptions<T> {
  /** 读取待保存内容；null 表示暂不满足保存条件 */
  snapshot: () => T | null;
  /** 落盘；抛错视为失败，改动保留 */
  persist: (payload: T) => Promise<void>;
  /** 停止输入多久后落盘，默认 700ms */
  delay?: number;
  onStateChange?: (state: AutoSaveState) => void;
  onError?: (error: unknown) => void;
}

export interface AutoSave {
  /** 标记有改动，延迟落盘 */
  schedule: () => void;
  /** 立即落盘并等待结果；返回 false 表示仍有未保存内容 */
  flush: () => Promise<boolean>;
  /** 取消待执行的延迟任务，不改动状态 */
  cancel: () => void;
  /** 保存失败后手动重试 */
  retry: () => Promise<boolean>;
  state: () => AutoSaveState;
  dispose: () => void;
}

export const autoSaveDelay = 700;

export function createAutoSave<T>(options: AutoSaveOptions<T>): AutoSave {
  const delay = options.delay ?? autoSaveDelay;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<boolean> | null = null;
  let queued = false;
  let dirty = false;
  let disposed = false;
  let state: AutoSaveState = "idle";

  function clearTimer() {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function setState(next: AutoSaveState) {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  }

  async function perform(): Promise<boolean> {
    clearTimer();
    if (disposed) return true;
    const payload = options.snapshot();
    if (payload === null) {
      setState("blocked");
      return false;
    }
    dirty = false;
    setState("saving");
    try {
      await options.persist(payload);
      // 保存期间可能又有输入，此时保持待保存状态，由排队的那次继续落盘
      setState(dirty ? "pending" : "saved");
      return true;
    } catch (error) {
      dirty = true;
      setState("error");
      options.onError?.(error);
      return false;
    }
  }

  function run(): Promise<boolean> {
    if (active) {
      queued = true;
      return active;
    }
    active = perform().finally(() => {
      active = null;
      if (queued && !disposed) {
        queued = false;
        void run();
      }
    });
    return active;
  }

  function schedule() {
    if (disposed) return;
    dirty = true;
    setState("pending");
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
  }

  async function flush(): Promise<boolean> {
    if (disposed) return true;
    clearTimer();
    let ok = true;
    while (dirty || active || queued) {
      ok = await run();
      clearTimer();
      if (!ok) break;
    }
    return ok;
  }

  return {
    schedule,
    flush,
    retry: flush,
    cancel: clearTimer,
    state: () => state,
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
