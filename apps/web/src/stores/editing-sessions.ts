export interface EditingSession {
  flush: () => Promise<boolean>;
  dispose?: () => void;
  invalidate?: () => void;
  projectId?: number | null;
}
const sessions = new Map<string, EditingSession>();
export function registerEditingSession(path: string, session: EditingSession) {
  sessions.set(path, session);
  return () => {
    if (sessions.get(path) === session) sessions.delete(path);
  };
}
/** Validate every target before any caller changes tab layout. */
export async function flushEditingSessions(paths = [...sessions.keys()]) {
  for (const path of paths) {
    const session = sessions.get(path);
    if (session && !(await session.flush())) return false;
  }
  return true;
}
export function disposeEditingSessions(paths: string[]) {
  for (const path of paths) {
    sessions.get(path)?.dispose?.();
    sessions.delete(path);
  }
}
export function invalidateProjectSessions(projectId: number) {
  for (const session of sessions.values())
    if (session.projectId === projectId) session.invalidate?.();
}
export function clearEditingSessions() {
  for (const session of sessions.values()) session.dispose?.();
  sessions.clear();
}
