export type AcceptanceResultDraft = {
  result: "passed" | "failed";
  reason: string;
  issueId?: number | null;
};

export type ScopeChangeDraft = {
  type: "postpone" | "waive" | "";
  reason: string;
  followUpDeliveryId: number | null;
  followUpOwnerUserId: number | null;
  followUpDate: string | null;
};

export type ScopeChangeDisposition = ScopeChangeDraft & {
  type: Exclude<ScopeChangeDraft["type"], "">;
};

export function buildScopeChangeDrafts(
  existingRequirementIds: readonly number[],
  nextRequirementIds: readonly number[],
  drafts: Readonly<Record<number, ScopeChangeDraft | undefined>>,
): Array<ScopeChangeDisposition & { requirementId: number }> | null {
  const next = new Set(nextRequirementIds);
  const removed = existingRequirementIds.filter((id) => !next.has(id));
  const changes: Array<ScopeChangeDisposition & { requirementId: number }> = [];
  for (const requirementId of removed) {
    const draft = drafts[requirementId];
    if (
      !draft ||
      !draft.type ||
      !draft.reason.trim() ||
      (!draft.followUpDeliveryId &&
        !(draft.followUpOwnerUserId && draft.followUpDate))
    ) return null;
    changes.push({ ...draft, type: draft.type, requirementId, reason: draft.reason.trim() });
  }
  return changes;
}

export function isAcceptanceResultSetComplete(
  scopeItemIds: readonly number[],
  results: Readonly<Record<number, AcceptanceResultDraft | undefined>>,
): boolean {
  return scopeItemIds.every((scopeItemId) => {
    const entry = results[scopeItemId];
    if (!entry) return false;
    return entry.result === "passed" || entry.reason.trim().length > 0;
  });
}
