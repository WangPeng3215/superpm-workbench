export interface ResourceDraftScope {
  accountId: number;
  projectId: number | null;
  requirementId: number;
  kind: "artifact" | "issue";
}
type DraftVersion = number | string;
const PREFIX = "superpm.resource-draft.v1.";
export const resourceDraftKey = (scope: ResourceDraftScope, entityId: number) =>
  `${PREFIX}${scope.accountId}.${scope.projectId ?? "private"}.${scope.requirementId}.${scope.kind}.${entityId}`;

/** Call only after the resource GET has authorized the current account. */
export function readResourceDraft<T>(
  storage: Pick<Storage, "getItem">,
  key: string,
  serverVersion: DraftVersion,
  validate: (value: unknown) => value is T,
): { version: DraftVersion; values: T; conflict: boolean } | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  let stored: { version?: unknown; values?: unknown };
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !stored ||
    typeof stored.version !== typeof serverVersion ||
    !validate(stored.values)
  )
    return null;
  const version = stored.version;
  if (typeof version !== "number" && typeof version !== "string") return null;
  if (
    typeof version === "number"
      ? !Number.isInteger(version) || version < 1
      : typeof version !== "string" || !/^[0-9a-f]{64}$/.test(version)
  )
    return null;
  return {
    version,
    values: stored.values,
    conflict: version !== serverVersion,
  };
}
export function writeResourceDraft<T>(
  storage: Pick<Storage, "setItem">,
  key: string,
  version: DraftVersion,
  values: T,
) {
  storage.setItem(key, JSON.stringify({ version, values }));
}
/** Remove obsolete private/shared keys too, without crossing account or requirement. */
export function clearResourceDrafts(
  storage: Pick<Storage, "length" | "key" | "removeItem">,
  scope: ResourceDraftScope,
) {
  const prefix = `${PREFIX}${scope.accountId}.`;
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const [, requirementId, kind] = key.slice(prefix.length).split(".");
    if (requirementId === String(scope.requirementId) && kind === scope.kind)
      storage.removeItem(key);
  }
}
