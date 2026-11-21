import { requirementUpdateSchema, type Requirement } from "@superpm/shared";

const fields = [
  "name",
  "type",
  "priority",
  "status",
  "currentStage",
  "description",
  "descriptionHtml",
  "acceptanceCriteria",
  "assigneeUserId",
  "developerUserId",
  "proposedAt",
  "expectedAt",
  "startedAt",
  "completedAt",
  "plannedReleaseAt",
  "releasedAt",
] as const satisfies readonly (keyof Requirement)[];
export type RequirementDraft = Pick<Requirement, (typeof fields)[number]>;
export function requirementSnapshot(source: Requirement): RequirementDraft {
  return Object.fromEntries(
    fields.map((key) => [key, source[key]]),
  ) as RequirementDraft;
}
export function mergeRequirementDraft(
  server: Requirement,
  sent: RequirementDraft,
  current: RequirementDraft,
): RequirementDraft {
  const next = requirementSnapshot(server);
  for (const key of fields)
    if (current[key] !== sent[key])
      Object.assign(next, { [key]: current[key] });
  if (
    current.description !== sent.description ||
    current.descriptionHtml !== sent.descriptionHtml
  ) {
    next.description = current.description;
    next.descriptionHtml = current.descriptionHtml;
  }
  return next;
}
export const requirementDraftKey = (
  accountId: number,
  projectId: number | null,
  requirementId: number,
) =>
  `superpm.requirement-draft.v1.${accountId}.${projectId ?? "private"}.${requirementId}`;
export function readRequirementDraft(
  storage: Pick<Storage, "getItem">,
  key: string,
): { version: number; values: RequirementDraft; stageNote?: string } | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  let entry: { version?: unknown; values?: unknown; stageNote?: unknown };
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !entry ||
    !Number.isInteger(entry.version) ||
    Number(entry.version) < 1 ||
    !entry.values ||
    typeof entry.values !== "object" ||
    (entry.stageNote !== undefined &&
      (typeof entry.stageNote !== "string" || entry.stageNote.length > 2000))
  )
    return null;
  const values = entry.values as Record<string, unknown>;
  if (
    fields.some((key) => !(key in values)) ||
    typeof values.name !== "string" ||
    values.name.length > 200
  )
    return null;
  if (
    !requirementUpdateSchema.safeParse({ ...values, name: "恢复草稿" }).success
  )
    return null;
  return {
    version: Number(entry.version),
    values: values as RequirementDraft,
    ...(typeof entry.stageNote === "string" && entry.stageNote
      ? { stageNote: entry.stageNote }
      : {}),
  };
}
export function writeRequirementDraft(
  storage: Pick<Storage, "setItem">,
  key: string,
  version: number,
  values: RequirementDraft,
  stageNote = "",
) {
  storage.setItem(
    key,
    JSON.stringify({ version, values, ...(stageNote ? { stageNote } : {}) }),
  );
}
