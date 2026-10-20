import type {
  ArtifactDirectory,
  ArtifactLink,
  ArtifactNode,
  ArtifactNodeDetails,
  ArtifactRefreshResult,
} from "@superpm/shared";
import { request } from "./client";

// 需求知识库 API（artifact_nodes / artifact_links；文档管理 tab 专用）
export const artifactApi = {
  list: (requirementId: number, parentId: number | null, q = "") => {
    const params = new URLSearchParams();
    if (parentId) params.set("parentId", String(parentId));
    if (q) params.set("q", q);
    const query = params.toString();
    return request<ArtifactDirectory>(
      `/requirements/${requirementId}/artifacts${query ? `?${query}` : ""}`,
    );
  },
  createFolder: (requirementId: number, parentId: number | null, name: string) =>
    request<ArtifactNode>(`/requirements/${requirementId}/artifacts/folders`, {
      method: "POST",
      body: JSON.stringify({ parentId, name }),
    }),
  createFile: (
    requirementId: number,
    parentId: number | null,
    name: string,
    initialContent?: string,
  ) =>
    request<ArtifactNode>(`/requirements/${requirementId}/artifacts/files`, {
      method: "POST",
      body: JSON.stringify(
        initialContent === undefined ? { parentId, name } : { parentId, name, initialContent },
      ),
    }),
  refresh: (requirementId: number, relativePath?: string) =>
    request<ArtifactRefreshResult>(
      `/requirements/${requirementId}/artifacts/refresh`,
      {
        method: "POST",
        body: JSON.stringify(relativePath ? { relativePath } : {}),
      },
    ),
  node: (nodeId: number) =>
    request<ArtifactNodeDetails>(`/artifacts/nodes/${nodeId}`),
  rename: (nodeId: number, name: string) =>
    request<ArtifactNode>(`/artifacts/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  move: (nodeId: number, targetParentId: number | null) =>
    request<ArtifactNode>(`/artifacts/nodes/${nodeId}/move`, {
      method: "POST",
      body: JSON.stringify({ targetParentId }),
    }),
  remove: (nodeId: number, recursive: boolean) =>
    request<void>(
      `/artifacts/nodes/${nodeId}${recursive ? "?recursive=1" : ""}`,
      { method: "DELETE" },
    ),
  content: (nodeId: number) =>
    request<{ node: ArtifactNode; content: string }>(
      `/artifacts/nodes/${nodeId}/content`,
    ),
  saveContent: (nodeId: number, content: string, force = false) =>
    request<ArtifactNode>(`/artifacts/nodes/${nodeId}/content`, {
      method: "PUT",
      body: JSON.stringify({ content, force }),
    }),
  rawUrl: (nodeId: number, download = false) =>
    `/api/artifacts/nodes/${nodeId}/raw${download ? "?download=1" : ""}`,
  openLocally: (nodeId: number) =>
    request<void>(`/artifacts/nodes/${nodeId}/open`, { method: "POST" }),
  createLink: (
    requirementId: number,
    payload: {
      folderNodeId: number | null;
      name: string;
      url: string;
      description?: string;
    },
  ) =>
    request<ArtifactLink>(`/requirements/${requirementId}/artifacts/links`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateLink: (
    linkId: number,
    patch: {
      folderNodeId?: number | null;
      name?: string;
      url?: string;
      description?: string | null;
    },
  ) =>
    request<ArtifactLink>(`/artifacts/links/${linkId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  removeLink: (linkId: number) =>
    request<void>(`/artifacts/links/${linkId}`, { method: "DELETE" }),
  memory: (requirementId: number) =>
    request<ArtifactNode>(`/requirements/${requirementId}/memory`),
};
