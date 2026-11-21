import {
  requirementCreateSchema,
  stages,
  type RequirementCreateParsed,
  type Stage,
} from "@superpm/shared";
export interface TableDraft {
  requirementId: number | null;
  version: number | null;
  values: RequirementCreateParsed;
  stageNote?: string;
}
export const tableDraftKey = (accountId: number, projectId?: number) =>
  `superpm.requirement-table-draft.v1.${accountId}.${projectId ?? "global"}`;
export function readTableDraft(
  raw: string | null,
  projectId?: number,
): TableDraft | null {
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw);
    if (
      !entry ||
      !entry.values ||
      typeof entry.values.name !== "string" ||
      entry.values.name.length > 200
    )
      return null;
    if (
      entry.requirementId !== null &&
      (!Number.isInteger(entry.requirementId) ||
        entry.requirementId < 1 ||
        !Number.isInteger(entry.version) ||
        entry.version < 1)
    )
      return null;
    if (entry.requirementId === null && entry.version !== null) return null;
    if (projectId !== undefined && entry.values.projectId !== projectId)
      return null;
    if (
      entry.stageNote !== undefined &&
      (typeof entry.stageNote !== "string" || entry.stageNote.length > 2000)
    )
      return null;
    const parsed = requirementCreateSchema.safeParse({
      ...entry.values,
      name: "恢复草稿",
    });
    return parsed.success
      ? {
          requirementId: entry.requirementId,
          version: entry.version,
          values: { ...parsed.data, name: entry.values.name },
          ...(entry.stageNote ? { stageNote: entry.stageNote } : {}),
        }
      : null;
  } catch {
    return null;
  }
}
export const stageReasonRequired = (from: Stage, to: Stage) =>
  from !== to && stages.indexOf(to) !== stages.indexOf(from) + 1;
