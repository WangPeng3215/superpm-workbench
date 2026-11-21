import { readFileSync } from "node:fs";
import { compileScript, parse } from "@vue/compiler-sfc";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import * as vue from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@superpm/shared";
import * as noteDraft from "../src/features/notes/note-draft";

const original: Note = {
  id: 71,
  title: "原始标题",
  content: "原始正文",
  type: "inspiration",
  color: "yellow",
  isPinned: false,
  isArchived: false,
  convertedTaskId: null,
  convertedTask: null,
  createdAt: "2026-11-21T02:00:00.000Z",
  updatedAt: "2026-11-21T02:00:00.000Z",
  archivedAt: null,
};

const renderer = vue.createRenderer<any, any>({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert: () => {},
  remove: () => {},
  setText: () => {},
  setElementText: () => {},
  parentNode: () => null,
  nextSibling: () => null,
  patchProp: () => {},
});
const disposers: Array<() => void> = [];
const update = vi.fn();
const list = vi.fn();
const warning = vi.fn();
const confirm = vi.fn();
const guards: Array<() => Promise<boolean>> = [];
const sessions = new Map<string, { flush: () => Promise<boolean> }>();

function mountSource(file: string, props: Record<string, unknown>) {
  const path = new URL("../src/" + file, import.meta.url);
  const { descriptor } = parse(readFileSync(path, "utf8"));
  const compiled = compileScript(descriptor, { id: file });
  const code = transpileModule(compiled.content, {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} as { default: any } };
  const require = (name: string): unknown => {
    if (name === "vue") return vue;
    if (name === "vue-router")
      return {
        useRouter: () => ({ push: vi.fn() }),
        useRoute: () => ({ path: "/notes" }),
        onBeforeRouteLeave: (guard: () => Promise<boolean>) =>
          guards.push(guard),
      };
    if (name === "element-plus")
      return {
        ElMessage: { error: warning, warning },
        ElMessageBox: { confirm },
      };
    if (name.endsWith("/api/notes")) return { noteApi: { update, list } };
    if (name.endsWith("/api/client"))
      return { errorMessage: (error: Error) => error.message };
    if (name.endsWith("/stores/auth"))
      return { authStore: { user: { id: 1 } } };
    if (name.endsWith("/note-draft")) return noteDraft;
    if (name.endsWith("/stores/editing-sessions"))
      return {
        registerEditingSession: (path: string, session: any) => {
          sessions.set(path, session);
          return () => sessions.delete(path);
        },
      };
    if (name === "@superpm/shared") return { noteTypes: [] };
    if (name.endsWith("/components/decorativeIcon"))
      return { decorative: () => ({}) };
    return {};
  };
  new Function("require", "module", "exports", code)(
    require,
    module,
    module.exports,
  );
  const component = module.exports.default;
  const setup = component.setup;
  let state: any;
  component.setup = (values: any, context: any) => {
    state = setup(values, context);
    return state;
  };
  component.render = () => null;
  const values = vue.shallowRef(props);
  const root = {};
  renderer.render(
    vue.h({ render: () => vue.h(component, values.value) }),
    root,
  );
  disposers.push(() => renderer.render(null, root));
  return {
    state,
    setProps: async (next: Record<string, unknown>) => {
      values.value = { ...values.value, ...next };
      await vue.nextTick();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  guards.length = 0;
  sessions.clear();
  update.mockReset();
  list.mockResolvedValue([]);
  warning.mockReset();
  confirm.mockReset();
  const stored = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    get length() {
      return stored.size;
    },
    key: (index: number) => [...stored.keys()][index] ?? null,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("便签编辑回归", () => {
  it("干净卡片同步刷新返回的新正文", async () => {
    const { state, setProps } = mountSource("features/notes/NoteCard.vue", {
      note: original,
      cardKey: "note-71",
    });
    await setProps({ note: { ...original, content: "外部更新的正文" } });
    expect(state.content.value).toBe("外部更新的正文");
  });

  it("只改标题时仅发送标题，保留服务端更新的正文", async () => {
    update.mockImplementation(async (_id, patch) => ({
      ...original,
      content: "外部更新的正文",
      ...patch,
    }));
    const { state } = mountSource("features/notes/NoteCard.vue", {
      note: original,
      cardKey: "note-71",
    });
    state.title.value = "本地新标题";
    state.onInput();
    expect(await state.flush()).toBe(true);
    expect(update).toHaveBeenCalledWith(71, { title: "本地新标题" });
    expect(state.content.value).toBe("外部更新的正文");
  });

  it("请求期间继续输入时旧保存响应不覆盖新输入", async () => {
    let release!: (note: Note) => void;
    update.mockImplementationOnce(
      () =>
        new Promise<Note>((resolve) => {
          release = resolve;
        }),
    );
    update.mockImplementation(async (_id, patch) => ({
      ...original,
      ...patch,
    }));
    const { state } = mountSource("features/notes/NoteCard.vue", {
      note: original,
      cardKey: "note-71",
    });
    state.content.value = "第一版";
    state.onInput();
    const flushing = state.flush();
    state.content.value = "第二版";
    state.onInput();
    release({ ...original, content: "第一版" });
    expect(await flushing).toBe(true);
    expect(state.content.value).toBe("第二版");
    expect(update).toHaveBeenLastCalledWith(71, { content: "第二版" });
  });

  it("刷新与本地同字段编辑冲突时保留草稿并阻止保存", async () => {
    update.mockImplementation(async (_id, patch) => ({
      ...original,
      ...patch,
    }));
    const { state, setProps } = mountSource("features/notes/NoteCard.vue", {
      note: original,
      cardKey: "note-71",
    });
    state.content.value = "本地草稿";
    state.onInput();
    await setProps({ note: { ...original, content: "外部新正文" } });
    expect(state.content.value).toBe("本地草稿");
    expect(await state.flush()).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("页面离开与关闭编辑会话都等待便签成功保存", async () => {
    const { state } = mountSource("pages/NotesPage.vue", {});
    await vue.nextTick();
    state.cardRefs.value = [{ flush: async () => false }];
    expect(guards).toHaveLength(1);
    expect(await guards[0]!()).toBe(false);
    expect(await sessions.get("/notes")?.flush()).toBe(false);
    state.cardRefs.value = [{ flush: async () => true }];
    expect(await guards[0]!()).toBe(true);
  });

  it("失败输入同步保留到会话草稿，重新挂载后恢复", async () => {
    update.mockRejectedValue(new Error("服务暂不可用"));
    const first = mountSource("features/notes/NoteCard.vue", {
      note: original,
      cardKey: "note-71",
    });
    first.state.content.value = "失败后仍须恢复的正文";
    first.state.onInput();
    expect(sessionStorage.length).toBe(1);
    expect(await first.state.flush()).toBe(false);
    const restored = mountSource("features/notes/NoteCard.vue", {
      note: original,
      cardKey: "note-71",
    });
    expect(restored.state.content.value).toBe("失败后仍须恢复的正文");
    expect(restored.state.dirty.value).toBe(true);
  });

  it("失败的新建便签会在页面重载时恢复", async () => {
    const note = { ...original, id: -71, title: "", content: "" };
    const { state } = mountSource("features/notes/NoteCard.vue", {
      note,
      cardKey: "draft-71",
    });
    state.content.value = "新建便签未保存的正文";
    state.onInput();
    const page = mountSource("pages/NotesPage.vue", {});
    await vue.nextTick();
    await vue.nextTick();
    expect(page.state.notes.value).toEqual([
      expect.objectContaining({ id: -71, content: "新建便签未保存的正文" }),
    ]);
  });

  it("外部返回已包含失败草稿时更新为已保存状态并清理会话草稿", async () => {
    update.mockRejectedValue(new Error("响应丢失"));
    const { state, setProps } = mountSource("features/notes/NoteCard.vue", {
      note: original,
      cardKey: "note-71",
    });
    state.content.value = "服务器实际已保存的内容";
    state.onInput();
    expect(await state.flush()).toBe(false);
    await setProps({
      note: { ...original, content: "服务器实际已保存的内容" },
    });
    expect(state.saveState.value).toBe("saved");
    expect(sessionStorage.length).toBe(0);
  });

  it("刷新期间修改标题可合并外部正文并仅保存标题", async () => {
    update.mockImplementation(async (_id, patch) => ({
      ...original,
      content: "外部正文",
      ...patch,
    }));
    const { state, setProps } = mountSource("features/notes/NoteCard.vue", {
      note: original,
      cardKey: "note-71",
    });
    state.title.value = "本地标题";
    state.onInput();
    await setProps({ note: { ...original, content: "外部正文" } });
    expect(state.title.value).toBe("本地标题");
    expect(state.content.value).toBe("外部正文");
    expect(await state.flush()).toBe(true);
    expect(update).toHaveBeenCalledWith(71, { title: "本地标题" });
    expect(sessionStorage.length).toBe(0);
  });

  it("恢复草稿时服务端同字段已更新则暂停保存并继续保留草稿", async () => {
    const first = mountSource("features/notes/NoteCard.vue", {
      note: original,
      cardKey: "note-71",
    });
    first.state.content.value = "刷新前的未保存草稿";
    first.state.onInput();
    const restored = mountSource("features/notes/NoteCard.vue", {
      note: { ...original, content: "外部在刷新前更新的正文" },
      cardKey: "note-71",
    });
    expect(restored.state.content.value).toBe("刷新前的未保存草稿");
    expect(restored.state.conflict.value).toBe(true);
    expect(await restored.state.flush()).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(1);
  });

  it("新建草稿按账号隔离并忽略损坏存储", () => {
    sessionStorage.setItem(
      noteDraft.noteDraftKey(1, -1),
      JSON.stringify({
        id: -1,
        createdAt: original.createdAt,
        base: noteDraft.noteValues(original),
        values: { ...noteDraft.noteValues(original), content: "账号一的草稿" },
      }),
    );
    sessionStorage.setItem(
      noteDraft.noteDraftKey(2, -2),
      JSON.stringify({
        id: -2,
        createdAt: original.createdAt,
        base: noteDraft.noteValues(original),
        values: { ...noteDraft.noteValues(original), content: "账号二的草稿" },
      }),
    );
    sessionStorage.setItem(noteDraft.noteDraftKey(1, -3), "损坏内容");
    expect(
      noteDraft
        .recoverNoteDrafts(sessionStorage, 1)
        .map((note) => note.content),
    ).toEqual(["账号一的草稿"]);
    expect(
      noteDraft
        .recoverNoteDrafts(sessionStorage, 2)
        .map((note) => note.content),
    ).toEqual(["账号二的草稿"]);
  });

  it("刷新请求先发后回时不会覆盖期间已成功保存的新正文", async () => {
    list.mockResolvedValueOnce([original]);
    const { state } = mountSource("pages/NotesPage.vue", {});
    await vue.nextTick();
    let release!: (items: Note[]) => void;
    list.mockImplementationOnce(
      () =>
        new Promise<Note[]>((resolve) => {
          release = resolve;
        }),
    );
    const loading = state.load();
    state.onSaved("note-71", {
      ...original,
      content: "刷新期间成功保存的新正文",
    });
    release([{ ...original, content: "刷新开始时的旧快照" }]);
    await loading;
    expect(state.notes.value[0].content).toBe("刷新期间成功保存的新正文");
    expect(state.loading.value).toBe(false);
  });

  it("刷新列表缺少正在编辑的便签时保留卡片和离开守卫", async () => {
    list.mockResolvedValueOnce([original]);
    const { state } = mountSource("pages/NotesPage.vue", {});
    await vue.nextTick();
    state.rememberCard("note-71", {
      flush: async () => false,
      hasUnsavedChanges: () => true,
    });
    expect([...state.cardsByKey.keys()]).toEqual(["note-71"]);
    expect(state.cardRefs.value).toHaveLength(1);
    list.mockResolvedValueOnce([]);
    await state.load();
    expect([...state.cardsByKey.keys()]).toEqual(["note-71"]);
    expect(state.notes.value).toEqual([
      expect.objectContaining({ id: 71, unavailable: true }),
    ]);
    expect(state.cardRefs.value).toHaveLength(1);
    expect(await guards[0]!()).toBe(false);
  });

  it("已不在服务器列表中的正ID草稿刷新后仍有保留入口", async () => {
    const { state } = mountSource("features/notes/NoteCard.vue", {
      note: original,
      cardKey: "note-71",
    });
    state.content.value = "已删除便签的本地草稿";
    state.onInput();
    const restored = mountSource("pages/NotesPage.vue", {});
    await vue.nextTick();
    expect(restored.state.notes.value).toEqual([
      expect.objectContaining({
        id: 71,
        content: "已删除便签的本地草稿",
        unavailable: true,
      }),
    ]);
  });

  it("不可用便签暂停PATCH，只有确认移除后清理草稿", async () => {
    const { state } = mountSource("features/notes/NoteCard.vue", {
      note: original,
      cardKey: "note-71",
      unavailable: true,
    });
    state.content.value = "不可用便签需要保留的草稿";
    state.onInput();
    expect(await state.flush()).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(1);
    confirm.mockRejectedValueOnce(new Error("取消移除"));
    await state.removeNote();
    expect(sessionStorage.length).toBe(1);
    expect(state.removed.value).toBe(false);
    confirm.mockResolvedValueOnce(undefined);
    await state.removeNote();
    expect(sessionStorage.length).toBe(0);
    expect(state.removed.value).toBe(true);
  });
});
