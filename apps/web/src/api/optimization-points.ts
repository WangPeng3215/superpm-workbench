import type {
  OptimizationPoint,
  OptimizationPointConversion,
  OptimizationPointConvert,
  OptimizationPointCreate,
  OptimizationPointListQuery,
  OptimizationPointSummary,
  OptimizationPointUpdate,
} from "@superpm/shared";
import { request } from "./client";

export const optimizationPointApi = {
  list(query: OptimizationPointListQuery = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== "") search.set(key, String(value));
    return request<OptimizationPointSummary[]>(
      `/optimization-points?${search}`,
    );
  },
  get: (id: number) => request<OptimizationPoint>(`/optimization-points/${id}`),
  create: (data: OptimizationPointCreate) =>
    request<OptimizationPoint>("/optimization-points", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: number, data: OptimizationPointUpdate) =>
    request<OptimizationPoint>(`/optimization-points/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (id: number) =>
    request<void>(`/optimization-points/${id}`, { method: "DELETE" }),
  convert: (id: number, data: OptimizationPointConvert = {}) =>
    request<OptimizationPointConversion>(`/optimization-points/${id}/convert`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
};
