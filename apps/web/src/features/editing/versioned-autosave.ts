export type VersionedSaveState =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "blocked"
  | "error"
  | "conflict"
  | "unauthorized"
  | "forbidden";
export interface VersionedAutoSaveOptions<
  T extends { version: number },
  D extends object,
> {
  initial: T;
  snapshot: () => D | null;
  persist: (patch: Partial<D>, expectedVersion: number) => Promise<T>;
  apply?: (server: T, sent: D) => void;
  onStateChange?: (state: VersionedSaveState) => void;
  onError?: (error: unknown) => void;
  delay?: number;
}
/** Serial entity saves. A response acknowledges only its sent revision. */
export function createVersionedAutoSave<
  T extends { version: number },
  D extends object,
>(options: VersionedAutoSaveOptions<T, D>) {
  let base = { ...options.initial };
  let state: VersionedSaveState = "idle";
  let dirty = false,
    disposed = false,
    generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<boolean> | undefined;
  const frozen = () =>
    disposed || ["conflict", "unauthorized", "forbidden"].includes(state);
  const setState = (next: VersionedSaveState) => {
    state = next;
    options.onStateChange?.(next);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  async function perform() {
    const token = generation;
    while (dirty && !frozen()) {
      const snapshot = options.snapshot();
      if (!snapshot) {
        setState("blocked");
        return false;
      }
      const sent = { ...snapshot };
      const patch = Object.fromEntries(
        Object.entries(sent).filter(
          ([key, value]) => value !== (base as Record<string, unknown>)[key],
        ),
      ) as Partial<D>;
      dirty = false;
      if (!Object.keys(patch).length) {
        setState("saved");
        continue;
      }
      setState("saving");
      try {
        const result = await options.persist(patch, base.version);
        if (token !== generation || disposed) return false;
        base = { ...result };
        options.apply?.(result, sent);
        setState(dirty ? "pending" : "saved");
      } catch (error) {
        if (token !== generation || disposed) return false;
        dirty = true;
        const status = (error as { status?: number })?.status;
        setState(
          status === 409
            ? "conflict"
            : status === 401
              ? "unauthorized"
              : status === 403 || status === 404
                ? "forbidden"
                : "error",
        );
        options.onError?.(error);
        return false;
      }
    }
    return !dirty && !frozen();
  }
  function flush(): Promise<boolean> {
    cancel();
    if (frozen()) return Promise.resolve(false);
    if (active) return active;
    active = perform().finally(() => {
      active = undefined;
    });
    return active;
  }
  return {
    schedule() {
      if (frozen()) return;
      dirty = true;
      if (state !== "saving") setState("pending");
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, options.delay ?? 700);
    },
    flush,
    retry: flush,
    cancel,
    state: () => state,
    reset(server: T) {
      cancel();
      generation++;
      base = { ...server };
      dirty = false;
      setState("idle");
    },
    invalidate() {
      cancel();
      generation++;
      dirty = false;
      setState("forbidden");
    },
    dispose() {
      cancel();
      generation++;
      disposed = true;
    },
  };
}
