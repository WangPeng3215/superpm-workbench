import { request } from "./client";

export type ProjectDocumentKind = "note" | "decision" | "meeting" | "link";

export interface ProjectDocument {
  id: number;
  projectId: number;
  kind: ProjectDocumentKind;
  title: string;
  content: string;
  url: string | null;
  meetingTime: string | null;
  version: number;
  createdBy: number;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDocumentCreate {
  kind: ProjectDocumentKind;
  title: string;
  content?: string;
  url?: string;
  meetingTime?: string;
}

export interface ProjectDocumentUpdate {
  title?: string;
  content?: string;
  url?: string;
  meetingTime?: string | null;
  expectedVersion: number;
}

export interface ProjectArtifact {
  id: number;
  kind: "file" | "link";
  requirementId: number;
  requirementNo: string;
  requirementName: string;
  name: string;
  relativePath?: string;
  url?: string;
  description?: string | null;
  version?: number;
  status?: string;
  isFinal?: boolean;
  updatedAt?: string;
}

function queryString(query: Record<string, unknown>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const result = search.toString();
  return result ? "?" + result : "";
}

export const projectDocumentKindLabels: Record<ProjectDocumentKind, string> = {
  note: "项目笔记",
  decision: "决策记录",
  meeting: "项目纪要",
  link: "外部链接",
};

export const projectDocumentsApi = {
  list: (
    projectId: number,
    query: { kind?: ProjectDocumentKind; q?: string } = {},
  ) =>
    request<{ items: ProjectDocument[] }>(
      "/projects/" + projectId + "/documents" + queryString(query),
    ),
  get: (projectId: number, documentId: number) =>
    request<ProjectDocument>(
      "/projects/" + projectId + "/documents/" + documentId,
    ),
  create: (projectId: number, data: ProjectDocumentCreate) =>
    request<ProjectDocument>("/projects/" + projectId + "/documents", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (
    projectId: number,
    documentId: number,
    data: ProjectDocumentUpdate,
  ) =>
    request<ProjectDocument>(
      "/projects/" + projectId + "/documents/" + documentId,
      { method: "PATCH", body: JSON.stringify(data) },
    ),
  remove: (projectId: number, documentId: number, expectedVersion: number) =>
    request<void>("/projects/" + projectId + "/documents/" + documentId, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion }),
    }),
  copyMeeting: (projectId: number, meetingId: number) =>
    request<ProjectDocument>(
      "/projects/" + projectId + "/documents/copy-meeting",
      {
        method: "POST",
        body: JSON.stringify({ meetingId, confirmed: true }),
      },
    ),
  artifacts: (projectId: number) =>
    request<{ items: ProjectArtifact[] }>(
      "/projects/" + projectId + "/artifacts",
    ),
};
