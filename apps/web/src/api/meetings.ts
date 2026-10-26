import type {
  Meeting,
  MeetingCreate,
  MeetingListQuery,
  MeetingSummary,
  MeetingUpdate,
} from "@superpm/shared";
import { request } from "./client";

export const meetingApi = {
  list(query: MeetingListQuery = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== "") search.set(key, String(value));
    return request<MeetingSummary[]>(`/meetings?${search}`);
  },
  get: (id: number) => request<Meeting>(`/meetings/${id}`),
  create: (data: MeetingCreate) =>
    request<Meeting>("/meetings", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: number, data: MeetingUpdate) =>
    request<Meeting>(`/meetings/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (id: number) =>
    request<void>(`/meetings/${id}`, { method: "DELETE" }),
};
