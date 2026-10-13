import type {
  Requirement,
  RequirementCreate,
  RequirementListQuery,
  RequirementListResult,
  RequirementRelations,
  RequirementUpdate,
  StageHistory,
  StageWorkspace,
} from "@superpm/shared";
import { request } from "./client";

export const requirementApi = {
  list(query: RequirementListQuery) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== "") search.set(key, String(value));
    return request<RequirementListResult>(`/requirements?${search}`);
  },
  get: (id: number) => request<Requirement>(`/requirements/${id}`),
  create: (data: RequirementCreate) =>
    request<Requirement>("/requirements", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: number, data: RequirementUpdate) =>
    request<Requirement>(`/requirements/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (id: number) =>
    request<void>(`/requirements/${id}`, { method: "DELETE" }),
  history: (id: number) =>
    request<StageHistory[]>(`/requirements/${id}/history`),
  relations: (id: number) =>
    request<RequirementRelations>(`/requirements/${id}/relations`),
  workspace: (id: number) =>
    request<StageWorkspace>(`/requirements/${id}/workspace`),
  saveWorkspace: (id: number, data: StageWorkspace) =>
    request<StageWorkspace>(`/requirements/${id}/workspace`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  uploadImage: (id: number, data: string, mime: string) =>
    request<{ url: string }>(`/requirements/${id}/images`, {
      method: "POST",
      body: JSON.stringify({ data, mime }),
    }),
};
