import type { RequirementListQuery } from "@superpm/shared";
export function projectEditingCheck(
  capability: boolean | undefined,
  error?: { status?: number },
) {
  return {
    canEdit: capability === true && !error,
    discardDraft: error
      ? [403, 404].includes(error.status ?? 0)
      : capability === false,
  };
}
export function canManageRequirement(
  projectId: number | null,
  capabilities: Record<number, boolean>,
  fixedReadOnly = false,
) {
  return (
    !fixedReadOnly && (projectId === null || capabilities[projectId] === true)
  );
}
export function scopedRequirementQuery(
  query: RequirementListQuery,
  projectId?: number,
): RequirementListQuery {
  if (projectId === undefined) return { ...query };
  const { unassigned: _unassigned, ...filters } = query;
  return { ...filters, projectId };
}
