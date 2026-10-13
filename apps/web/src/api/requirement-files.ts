import type {
  FileCategory,
  RequirementFile,
  RequirementFileList,
  Stage,
} from "@superpm/shared";
import { request } from "./client";

export interface RequirementFileUpload {
  phase: Stage;
  category: FileCategory;
  name: string;
  mime: string;
  data: string;
  isFinal: boolean;
}
export const requirementFileApi = {
  list: (id: number, phase: Stage, all: boolean) =>
    request<RequirementFileList>(
      `/requirements/${id}/files?phase=${phase}&all=${all ? "true" : "false"}`,
    ),
  upload: (id: number, payload: RequirementFileUpload) =>
    request<RequirementFile>(`/requirements/${id}/files`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  content: (id: number, fileId: number) =>
    request<{ file: RequirementFile; content: string }>(
      `/requirements/${id}/files/${fileId}/content`,
    ),
  saveContent: (id: number, fileId: number, content: string) =>
    request<RequirementFile>(`/requirements/${id}/files/${fileId}/content`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  update: (
    id: number,
    fileId: number,
    patch: { name?: string; isFinal?: boolean },
  ) =>
    request<RequirementFile>(`/requirements/${id}/files/${fileId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  remove: (id: number, fileId: number) =>
    request<void>(`/requirements/${id}/files/${fileId}`, { method: "DELETE" }),
  rawUrl: (id: number, fileId: number) =>
    `/api/requirements/${id}/files/${fileId}/raw`,
};
