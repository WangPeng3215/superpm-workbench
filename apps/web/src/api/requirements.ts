import type {
  Requirement,
  RequirementCreate,
  RequirementListQuery,
  RequirementListResult,
  RequirementUpdate,
  StageHistory,
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
};
