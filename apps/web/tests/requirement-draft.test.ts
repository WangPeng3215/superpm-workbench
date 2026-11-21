import { describe, expect, it } from "vitest";
import { requirementCreateSchema, type Requirement } from "@superpm/shared";
import {
  mergeRequirementDraft,
  readRequirementDraft,
  requirementDraftKey,
  requirementSnapshot,
  writeRequirementDraft,
} from "../src/features/requirements/requirement-draft";

const detail = {
  ...requirementCreateSchema.parse({ name: "原名", proposedAt: "2026-11-19" }),
  id: 5,
  requirementNo: "REQ-5",
  version: 2,
  pinned: false,
  createdAt: "",
  updatedAt: "",
  deletedAt: null,
} satisfies Requirement;

describe("需求详情草稿", () => {
  it("项目责任移交与验收标准进入同一版本草稿，保存期间的新输入仍保留", () => {
    const projectDetail = {
      ...detail,
      projectId: 7,
      assigneeUserId: 3,
      developerUserId: 4,
      acceptanceCriteria: "原验收标准",
    };
    const sent = requirementSnapshot(projectDetail);
    expect(sent).toMatchObject({
      assigneeUserId: 3,
      developerUserId: 4,
      acceptanceCriteria: "原验收标准",
    });
    const current = {
      ...sent,
      assigneeUserId: 5,
      developerUserId: null,
      acceptanceCriteria: "新的验收标准",
    };
    expect(mergeRequirementDraft(projectDetail, sent, current)).toMatchObject({
      assigneeUserId: 5,
      developerUserId: null,
      acceptanceCriteria: "新的验收标准",
    });
  });

  it("响应只回填提交后未改字段，正文和HTML保持同一修订", () => {
    const sent = requirementSnapshot(detail);
    const current = { ...sent, name: "新输入", description: "输入中" };
    const result = mergeRequirementDraft(
      {
        ...detail,
        name: "服务器名",
        description: "旧正文",
        descriptionHtml: "<p>旧正文</p>",
      },
      sent,
      current,
    );
    expect(result.name).toBe("新输入");
    expect(result.description).toBe("输入中");
    expect(result.descriptionHtml).toBe(sent.descriptionHtml);
  });

  it("刷新草稿按账号、项目和实体隔离并保留基准版本", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const key = requirementDraftKey(1, 7, 5);
    const draft = { ...requirementSnapshot(detail), name: "" };
    writeRequirementDraft(storage, key, 2, draft);
    expect(readRequirementDraft(storage, key)).toEqual({
      version: 2,
      values: draft,
    });
    expect(
      readRequirementDraft(storage, requirementDraftKey(2, 7, 5)),
    ).toBeNull();
    expect(
      readRequirementDraft(storage, requirementDraftKey(1, 8, 5)),
    ).toBeNull();
    expect(
      readRequirementDraft(storage, requirementDraftKey(1, 7, 6)),
    ).toBeNull();
    expect(requirementDraftKey(1, null, 5)).not.toBe(key);
  });

  it("损坏或非完整草稿不能覆盖服务端读到的内容", () => {
    for (const raw of [
      "not-json",
      "{}",
      JSON.stringify({ version: 0, values: requirementSnapshot(detail) }),
      JSON.stringify({ version: 1, values: { name: "坏数据" } }),
    ]) {
      expect(readRequirementDraft({ getItem: () => raw }, "key")).toBeNull();
    }
  });

  it("刷新时保留跳过或退回阶段的原因，非法原因不会恢复", () => {
    let raw = "";
    const storage = {
      getItem: () => raw,
      setItem: (_key: string, value: string) => {
        raw = value;
      },
    };
    const draft = {
      ...requirementSnapshot(detail),
      currentStage: "development" as const,
    };
    writeRequirementDraft(storage, "key", 2, draft, "产品确认跳过设计");
    expect(readRequirementDraft(storage, "key")).toEqual({
      version: 2,
      values: draft,
      stageNote: "产品确认跳过设计",
    });
    raw = JSON.stringify({ version: 2, values: draft, stageNote: 123 });
    expect(readRequirementDraft(storage, "key")).toBeNull();
  });

  it("存储失败会抛给界面提示，不能虚报草稿已保存", () => {
    expect(() =>
      writeRequirementDraft(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        "key",
        2,
        requirementSnapshot(detail),
      ),
    ).toThrow("quota");
  });
});
