import type { DailyTask } from "@superpm/shared";
import { ApiError, request } from "./client";
import { authStore } from "../stores/auth";

export type ProjectTaskStatus =
  | "pending"
  | "in_progress"
  | "pending_confirmation"
  | "completed"
  | "blocked"
  | "cancelled";
export type ProjectTaskType =
  "design" | "development" | "testing" | "deployment" | "other";
export type ProjectTaskAction =
  | "start"
  | "block"
  | "resume"
  | "submit"
  | "approve"
  | "return"
  | "cancel"
  | "reopen";
export type ProjectTaskHistoryAction = ProjectTaskAction | "created" | "edit";
export type TaskEvidence =
  | { kind: "external_link"; url: string; label?: string }
  | { kind: "artifact_node" | "requirement_file"; id: number };
export type TaskEvidenceReference = TaskEvidence & { displayName?: string };

export interface ProjectTaskCapabilities {
  canEdit: boolean;
  canPlan: boolean;
  actions: ProjectTaskAction[];
}
export interface ProjectTask {
  id: number;
  projectId: number;
  requirementId: number | null;
  title: string;
  description: string;
  type: ProjectTaskType;
  assigneeUserId: number;
  confirmerUserId: number;
  dueDate: string | null;
  status: ProjectTaskStatus;
  previousStatus: string | null;
  version: number;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  capabilities: ProjectTaskCapabilities;
}
export interface ProjectTaskSubmission {
  id: number;
  submittedBy: number;
  summary: string;
  evidence: TaskEvidenceReference[];
  createdAt: string;
  review: {
    id: number;
    reviewerUserId: number;
    result: "approved" | "returned";
    reason: string | null;
    createdAt: string;
  } | null;
}
export interface ProjectTaskDetail extends ProjectTask {
  submissions: ProjectTaskSubmission[];
  actions: {
    id: number;
    action: ProjectTaskHistoryAction;
    actorUserId: number;
    reason: string | null;
    changes?: Record<string, { before: unknown; after: unknown }>;
    createdAt: string;
  }[];
}
export interface ProjectTaskListQuery {
  requirementId?: number;
  assigneeUserId?: number;
  confirmerUserId?: number;
  status?: ProjectTaskStatus;
  page?: number;
  pageSize?: number;
}
export interface ProjectTaskInput {
  title: string;
  type: ProjectTaskType;
  assigneeUserId: number;
  confirmerUserId: number;
  requirementId?: number | null;
  description?: string;
  dueDate?: string | null;
}
export interface TaskRequirementOption {
  id: number;
  requirementNo: string;
  name: string;
  canCreate: boolean;
}

const pendingCommands = new Map<string, string>();
function queryString(query: object) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
}
async function command<T>(path: string, data: unknown): Promise<T> {
  const body = JSON.stringify(data);
  const signature =
    String(authStore.user?.id ?? "") + "\n" + path + "\n" + body;
  const key = pendingCommands.get(signature) ?? crypto.randomUUID();
  pendingCommands.set(signature, key);
  try {
    const result = await request<T>(path, {
      method: "POST",
      body,
      headers: { "Idempotency-Key": key },
    });
    pendingCommands.delete(signature);
    return result;
  } catch (error) {
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

export const projectTaskApi = {
  list: (projectId: number, query: ProjectTaskListQuery = {}) =>
    request<{ items: ProjectTask[]; total: number; canCreate: boolean }>(
      "/projects/" + projectId + "/tasks?" + queryString(query),
    ),
  get: (taskId: number) =>
    request<ProjectTaskDetail>("/project-tasks/" + taskId),
  create: (projectId: number, input: ProjectTaskInput) =>
    command<ProjectTaskDetail>("/projects/" + projectId + "/tasks", input),
  update: (
    taskId: number,
    input: Partial<ProjectTaskInput> & { expectedVersion: number },
  ) =>
    request<ProjectTaskDetail>("/project-tasks/" + taskId, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  action: (
    taskId: number,
    input: {
      action: ProjectTaskAction;
      expectedVersion: number;
      reason?: string;
      summary?: string;
      evidence?: TaskEvidence[];
    },
  ) =>
    command<ProjectTaskDetail>("/project-tasks/" + taskId + "/actions", input),
  plan: (
    taskId: number,
    input: {
      date: string;
      expectedVersion: number;
      plannedStartAt?: string | null;
      plannedEndAt?: string | null;
      estimatedMinutes?: number;
    },
  ) =>
    command<DailyTask>("/project-tasks/" + taskId + "/daily-plans", {
      ...input,
    }),
  requirements: (projectId: number, q = "", includeId?: number) =>
    request<{ items: TaskRequirementOption[] }>(
      "/projects/" +
        projectId +
        "/task-requirements?" +
        queryString({ q, includeId }),
    ),
};
