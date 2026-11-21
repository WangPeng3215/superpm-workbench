import { describe, expect, it } from "vitest";
import {
  clearResourceDrafts,
  readResourceDraft,
  resourceDraftKey,
  writeResourceDraft,
} from "../src/features/requirements/resource-draft";

const scope = {
  accountId: 1,
  projectId: 7,
  requirementId: 5,
  kind: "artifact" as const,
};
const hash = "a".repeat(64);
const valid = (value: unknown): value is { html: string } =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { html?: unknown }).html === "string";
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
describe("需求资源会话草稿", () => {
  it("草稿按账号、项目、需求、资源种类及实体隔离", () => {
    const storage = memoryStorage();
    const key = resourceDraftKey(scope, 9);
    writeResourceDraft(storage, key, hash, { html: "<p>未保存</p>" });
    expect(readResourceDraft(storage, key, hash, valid)).toEqual({
      version: hash,
      values: { html: "<p>未保存</p>" },
      conflict: false,
    });
    for (const key of [
      resourceDraftKey({ ...scope, accountId: 2 }, 9),
      resourceDraftKey({ ...scope, projectId: 8 }, 9),
      resourceDraftKey({ ...scope, requirementId: 6 }, 9),
      resourceDraftKey({ ...scope, kind: "issue" }, 9),
      resourceDraftKey(scope, 10),
    ])
      expect(readResourceDraft(storage, key, hash, valid)).toBeNull();
  });
  it("重读已授权资源后比对基准版本，冲突仍保留本地输入", () => {
    const storage = memoryStorage();
    const key = resourceDraftKey({ ...scope, kind: "issue" }, 3);
    writeResourceDraft(storage, key, 2, { html: "本地问题正文" });
    expect(readResourceDraft(storage, key, 3, valid)).toEqual({
      version: 2,
      values: { html: "本地问题正文" },
      conflict: true,
    });
    expect(storage.getItem(key)).not.toBeNull();
  });
  it("损坏正文或错误版本类型不能替换服务端数据", () => {
    for (const raw of [
      "invalid",
      "{}",
      JSON.stringify({ version: 0, values: { html: "x" } }),
      JSON.stringify({ version: 2, values: { html: 3 } }),
      JSON.stringify({ version: hash, values: { html: "x" } }),
    ]) {
      expect(
        readResourceDraft({ getItem: () => raw }, "key", 2, valid),
      ).toBeNull();
    }
  });
  it("失权时清理该账号需求资源的草稿，保留其他账号与其他需求", () => {
    const storage = memoryStorage();
    const keys = [
      resourceDraftKey(scope, 9),
      resourceDraftKey({ ...scope, projectId: null }, 10),
      resourceDraftKey({ ...scope, accountId: 2 }, 9),
      resourceDraftKey({ ...scope, requirementId: 6 }, 9),
    ];
    for (const key of keys)
      writeResourceDraft(storage, key, hash, { html: "草稿" });
    clearResourceDrafts(storage, scope);
    expect(keys.map((key) => storage.getItem(key) !== null)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
  it("存储异常交给界面提示，不能声称可恢复", () => {
    expect(() =>
      writeResourceDraft(
        {
          setItem() {
            throw new Error("quota");
          },
        },
        "key",
        hash,
        { html: "草稿" },
      ),
    ).toThrow("quota");
  });
});
