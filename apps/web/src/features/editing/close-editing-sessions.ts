import {
  disposeEditingSessions,
  flushEditingSessions,
} from "../../stores/editing-sessions";

/** Commit tab or account layout only after every affected editor has saved. */
export async function closeEditingSessions(
  paths: string[],
  commit: () => Promise<boolean | void> | boolean | void,
) {
  if (!(await flushEditingSessions(paths))) return false;
  if ((await commit()) === false) return false;
  disposeEditingSessions(paths);
  return true;
}
