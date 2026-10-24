import type {
  DailyTask,
  DailyTaskActiveState,
  DailyTaskCalendar,
  DailyTaskCreate,
  DailyTaskDay,
  DailyTaskSummaryText,
  DailyTaskUpdate,
  DailyTimeEntry,
} from "@superpm/shared";
import { request } from "./client";

function dayQuery(date?: string) {
  return date ? `?date=${encodeURIComponent(date)}` : "";
}

export const dailyTaskApi = {
  day: (date?: string) =>
    request<DailyTaskDay>(`/daily-tasks${dayQuery(date)}`),
  calendar: (month: string) =>
    request<DailyTaskCalendar>(
      `/daily-tasks/calendar?month=${encodeURIComponent(month)}`,
    ),
  active: () => request<DailyTaskActiveState>("/daily-tasks/active"),
  summary: (date: string) =>
    request<DailyTaskSummaryText>(
      `/daily-tasks/summary-text?date=${encodeURIComponent(date)}`,
    ),
  create: (data: DailyTaskCreate) =>
    request<DailyTask>("/daily-tasks", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: number, data: DailyTaskUpdate) =>
    request<DailyTask>(`/daily-tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (id: number) =>
    request<{ archived: boolean }>(`/daily-tasks/${id}`, {
      method: "DELETE",
    }),
  reorder: (date: string, ids: number[]) =>
    request<{ ok: true }>("/daily-tasks/order", {
      method: "PATCH",
      body: JSON.stringify({ date, ids }),
    }),
  entries: (id: number) =>
    request<DailyTimeEntry[]>(`/daily-tasks/${id}/time-entries`),
  start: (id: number) =>
    request<DailyTaskActiveState>(`/daily-tasks/${id}/start`, {
      method: "POST",
    }),
  stop: (id: number) =>
    request<DailyTaskActiveState>(`/daily-tasks/${id}/stop`, {
      method: "POST",
    }),
  updateEntry: (
    id: number,
    data: { startedAt: string; endedAt: string; reason: string },
  ) =>
    request<{ entry: DailyTimeEntry; day: DailyTaskDay }>(
      `/daily-time-entries/${id}`,
      { method: "PATCH", body: JSON.stringify(data) },
    ),
};
