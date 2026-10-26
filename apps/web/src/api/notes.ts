import type {
  Note,
  NoteConvertResult,
  NoteCreate,
  NoteUpdate,
} from "@superpm/shared";
import { request } from "./client";

export const noteApi = {
  list: (archived = false) =>
    request<Note[]>(`/notes${archived ? "?archived=true" : ""}`),
  create: (data: NoteCreate) =>
    request<Note>("/notes", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: number, data: NoteUpdate) =>
    request<Note>(`/notes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (id: number) => request<void>(`/notes/${id}`, { method: "DELETE" }),
  convert: (id: number) =>
    request<NoteConvertResult>(`/notes/${id}/convert`, { method: "POST" }),
};
