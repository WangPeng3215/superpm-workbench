import type {
  OnlineTool,
  OnlineToolCreate,
  OnlineToolUpdate,
} from "@superpm/shared";
import { request } from "./client";

export const onlineToolApi = {
  list: () => request<OnlineTool[]>("/online-tools"),
  favorites: () => request<OnlineTool[]>("/online-tools/favorites"),
  create: (data: OnlineToolCreate) =>
    request<OnlineTool>("/online-tools", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: number, data: OnlineToolUpdate) =>
    request<OnlineTool>(`/online-tools/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (id: number) =>
    request<void>(`/online-tools/${id}`, { method: "DELETE" }),
  reorder: (ids: number[]) =>
    request<{ ok: true }>("/online-tools/order", {
      method: "PATCH",
      body: JSON.stringify({ ids }),
    }),
};
