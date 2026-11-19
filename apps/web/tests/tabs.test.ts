import { afterEach, describe, expect, it, vi } from "vitest";
import { authStore } from "../src/stores/auth";
import {
  clearTabs,
  restoreTabs,
  setTabLabel,
  syncRoute,
  tabsStore,
} from "../src/stores/tabs";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
}

const storage = new MemoryStorage();

afterEach(() => {
  storage.clear();
  vi.unstubAllGlobals();
  tabsStore.tabs = [];
  tabsStore.activePath = "";
  authStore.user = null;
  authStore.ready = true;
});

describe("页签布局持久化", () => {
  it("按账号隔离布局并持久化详情页签文案", () => {
    vi.stubGlobal("localStorage", storage);
    authStore.user = {
      id: 11,
      username: "alice",
      displayName: "Alice",
      isAdmin: false,
    };
    syncRoute("/requirements/42");
    setTabLabel("/requirements/42", "REQ-0042 · Alice 的需求");
    clearTabs(true);

    authStore.user = {
      id: 12,
      username: "bob",
      displayName: "Bob",
      isAdmin: false,
    };
    restoreTabs();
    expect(tabsStore.tabs).toEqual([]);

    authStore.user = {
      id: 11,
      username: "alice",
      displayName: "Alice",
      isAdmin: false,
    };
    restoreTabs();
    expect(tabsStore.tabs).toHaveLength(1);
    expect(tabsStore.tabs[0].label).toBe("REQ-0042 · Alice 的需求");
  });
});
