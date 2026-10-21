import type {
  AssetResourceType,
  AssetStatus,
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
  resourceType?: "file";
  isFinal: boolean;
}
export interface RequirementFileLinkCreate {
  phase: Stage;
  category: FileCategory;
  name: string;
  resourceType: "link";
  linkUrl: string;
  isFinal: boolean;
}
export interface RequirementFileTextCreate {
  phase: Stage;
  category: FileCategory;
  name: string;
  resourceType: "text";
  textContent: string;
  isFinal: boolean;
}
export type RequirementFileCreate =
  | RequirementFileUpload
  | RequirementFileLinkCreate
  | RequirementFileTextCreate;
export const requirementFileApi = {
  list: (id: number, phase: Stage | "all", all: boolean) =>
    request<RequirementFileList>(
      `/requirements/${id}/files?phase=${phase}&all=${all ? "true" : "false"}`,
    ),
  create: (id: number, payload: RequirementFileCreate) =>
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
    patch: { name?: string; isFinal?: boolean; status?: AssetStatus; description?: string },
  ) =>
    request<RequirementFile>(`/requirements/${id}/files/${fileId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  remove: (id: number, fileId: number) =>
    request<void>(`/requirements/${id}/files/${fileId}`, { method: "DELETE" }),
  // 本地默认程序打开（补充文档 5.4）：服务器模式返回 403，前端回退为下载
  openLocally: (id: number, fileId: number) =>
    request<void>(`/requirements/${id}/files/${fileId}/open`, {
      method: "POST",
    }),
  rawUrl: (id: number, fileId: number) =>
    `/api/requirements/${id}/files/${fileId}/raw`,
};
