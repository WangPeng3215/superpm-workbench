import type {
  ProjectArchiveInput,
  ProjectCreate,
  ProjectDetail,
  ProjectOverview,
  ProjectLeadsUpdate,
  ProjectLifecycleInput,
  ProjectListQuery,
  ProjectListResult,
  ProjectMemberWrite,
  ProjectTaskResponsibilityTransfer,
  ProjectUpdate,
} from "@superpm/shared";
import { ApiError, request } from "./client";
import { authStore } from "../stores/auth";
export interface ProjectMemberCandidate {
  id: number;
  username: string;
  displayName: string;
}
export interface ProjectSharePreview {
  rootRequirementId: number;
  projectId: number;
  token: string;
  requirements: {
    id: number;
    requirementNo: string;
    name: string;
    version: number;
  }[];
  issueCount: number;
  artifactCount: number;
  expiresAt: string;
}
export interface ProjectEvent {
  id: number;
  action: string;
  actorNameSnapshot?: string;
  actorName?: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}
function queryString(query: object) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") search.set(key, String(value));
  return search.toString();
}
const write = <T>(path: string, method: string, data: unknown) =>
  request<T>(path, { method, body: JSON.stringify(data) });
const pendingCommands = new Map<string, string>();
async function command<T>(
  path: string,
  method: string,
  data: unknown,
): Promise<T> {
  const body = JSON.stringify(data);
  const signature = JSON.stringify([
    authStore.user?.id ?? null,
    path,
    method,
    body,
  ]);
  const key = pendingCommands.get(signature) ?? crypto.randomUUID();
  pendingCommands.set(signature, key);
  try {
    const result = await request<T>(path, {
      method,
      body,
      headers: { "Idempotency-Key": key },
    });
    pendingCommands.delete(signature);
    return result;
  } catch (error) {
    // A network error, timeout or 5xx may happen after the transaction committed.
    // Retrying the same operation must replay its response rather than execute twice.
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    )
      pendingCommands.delete(signature);
    throw error;
  }
}
export const projectApi = {
  list: (query: ProjectListQuery = {}) =>
    request<ProjectListResult>(`/projects?${queryString(query)}`),
  get: (id: number) => request<ProjectDetail>(`/projects/${id}`),
  overview: (id: number) =>
    request<ProjectOverview>("/projects/" + id + "/overview"),
  create: (data: ProjectCreate) =>
    command<ProjectDetail>("/projects", "POST", data),
  update: (id: number, data: ProjectUpdate) =>
    write<ProjectDetail>(`/projects/${id}`, "PATCH", data),
  memberCandidates: (id: number, q: string) =>
    request<{ items: ProjectMemberCandidate[] }>(
      `/projects/${id}/member-candidates?${queryString({ q })}`,
    ),
  addMember: (id: number, data: ProjectMemberWrite) =>
    command<ProjectDetail>(`/projects/${id}/members`, "POST", data),
  updateMember: (id: number, userId: number, data: ProjectMemberWrite) =>
    command<ProjectDetail>(`/projects/${id}/members/${userId}`, "PATCH", data),
  removeMember: (
    id: number,
    userId: number,
    expectedVersion: number,
    taskTransfers?: ProjectTaskResponsibilityTransfer[],
  ) =>
    command<ProjectDetail>(`/projects/${id}/members/${userId}`, "DELETE", {
      expectedVersion,
      ...(taskTransfers?.length ? { taskTransfers } : {}),
    }),
  updateLeads: (id: number, data: ProjectLeadsUpdate) =>
    command<ProjectDetail>(`/projects/${id}/leads`, "PATCH", data),
  lifecycle: (id: number, data: ProjectLifecycleInput) =>
    command<ProjectDetail>(`/projects/${id}/lifecycle`, "POST", data),
  archive: (id: number, data: ProjectArchiveInput) =>
    command<ProjectDetail>(`/projects/${id}/archive`, "PATCH", data),
  sharePreview: (id: number, rootRequirementId: number) =>
    write<ProjectSharePreview>(
      `/projects/${id}/requirements/share-preview`,
      "POST",
      { rootRequirementId },
    ),
  share: (
    id: number,
    data: {
      token: string;
      confirmed: true;
      expectedVersion: number;
      assigneeUserId?: number;
      developerUserId?: number;
    },
  ) =>
    command<ProjectDetail>(`/projects/${id}/requirements/share`, "POST", data),
  events: (id: number, cursor?: string) =>
    request<{
      items: ProjectEvent[];
      hasMore: boolean;
      nextCursor: string | null;
    }>(`/projects/${id}/events?${queryString({ cursor })}`),
};
