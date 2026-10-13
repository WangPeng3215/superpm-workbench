import type { Requirement } from "@superpm/shared";
import { dateFields, dateLabels } from "@superpm/shared";
export interface TableColumn {
  key: keyof Requirement;
  label: string;
  width: number;
  visible: boolean;
  fixed: "" | "left" | "right";
  kind: "text" | "select" | "date" | "rich" | "readonly";
}
export const columnDefaults = (): TableColumn[] => [
  {
    key: "requirementNo",
    label: "需求编号",
    width: 165,
    visible: true,
    fixed: "left",
    kind: "readonly",
  },
  {
    key: "name",
    label: "需求名称",
    width: 260,
    visible: true,
    fixed: "left",
    kind: "text",
  },
  {
    key: "type",
    label: "需求类型",
    width: 120,
    visible: true,
    fixed: "",
    kind: "select",
  },
  {
    key: "status",
    label: "状态",
    width: 120,
    visible: true,
    fixed: "",
    kind: "select",
  },
  {
    key: "priority",
    label: "优先级",
    width: 95,
    visible: true,
    fixed: "",
    kind: "select",
  },
  {
    key: "currentStage",
    label: "当前阶段",
    width: 125,
    visible: true,
    fixed: "",
    kind: "select",
  },
  {
    key: "description",
    label: "需求描述",
    width: 190,
    visible: true,
    fixed: "",
    kind: "rich",
  },
  ...dateFields.map((key) => ({
    key,
    label: dateLabels[key],
    width: 160,
    visible: true,
    fixed: "" as const,
    kind: "date" as const,
  })),
  {
    key: "updatedAt",
    label: "最近更新",
    width: 170,
    visible: false,
    fixed: "",
    kind: "readonly",
  },
];
export const columnStorageKey = "superpm.requirements.columns.v1";
export function restoreColumns(): TableColumn[] {
  const defaults = columnDefaults();
  try {
    const saved = JSON.parse(localStorage.getItem(columnStorageKey) ?? "null");
    if (!Array.isArray(saved)) return defaults;
    const result: TableColumn[] = [];
    for (const value of saved) {
      const original = defaults.find((column) => column.key === value.key);
      if (!original || result.some((column) => column.key === value.key))
        continue;
      result.push({
        ...original,
        visible:
          typeof value.visible === "boolean" ? value.visible : original.visible,
        fixed: ["left", "right", ""].includes(value.fixed)
          ? value.fixed
          : original.fixed,
      });
    }
    return [
      ...result,
      ...defaults.filter(
        (column) => !result.some((item) => item.key === column.key),
      ),
    ];
  } catch {
    return defaults;
  }
}
