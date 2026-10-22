import type {
  Issue,
  IssueAssetListResult,
  IssueAssetRelation,
  IssueDetail,
  IssueListResult,
  IssueStage,
  IssueStatus,
  IssueType,
} from "@superpm/shared";
import { request } from "./client";

export interface IssueListParams {
  stage?: IssueStage;
  status?: IssueStatus;
  type?: IssueType;
  q?: string;
}
export interface IssueCreatePayload {
  stage?: IssueStage;
  title: string;
  description?: string;
  type?: IssueType | null;
}
export interface IssueUpdatePayload {
  title?: string;
  description?: string;
  stage?: IssueStage;
  type?: IssueType | null;
  status?: IssueStatus;
  solution?: string;
}
export const issueApi = {
  list: (id: number, params: IssueListParams = {}) => {
    const query = new URLSearchParams();
    if (params.stage) query.set("stage", params.stage);
    if (params.status) query.set("status", params.status);
    if (params.type) query.set("type", params.type);
    if (params.q?.trim()) query.set("q", params.q.trim());
    const suffix = query.toString();
    return request<IssueListResult>(
      `/requirements/${id}/issues${suffix ? `?${suffix}` : ""}`,
    );
  },
  detail: (id: number, issueId: number) =>
    request<IssueDetail>(`/requirements/${id}/issues/${issueId}`),
  create: (id: number, payload: IssueCreatePayload) =>
    request<Issue>(`/requirements/${id}/issues`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  update: (id: number, issueId: number, payload: IssueUpdatePayload) =>
    request<Issue>(`/requirements/${id}/issues/${issueId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  // 问题正文（md 文件）直读/直写
  getDescription: (id: number, issueId: number) =>
    request<{ content: string }>(
      `/requirements/${id}/issues/${issueId}/description`,
    ),
  saveDescription: (id: number, issueId: number, content: string) =>
    request<{ updatedAt: string }>(
      `/requirements/${id}/issues/${issueId}/description`,
      { method: "PUT", body: JSON.stringify({ content }) },
    ),
  comment: (id: number, issueId: number, content: string) =>
    request<IssueDetail>(
      `/requirements/${id}/issues/${issueId}/activities`,
      { method: "POST", body: JSON.stringify({ content }) },
    ),
  remove: (id: number, issueId: number) =>
    request<void>(`/requirements/${id}/issues/${issueId}`, {
      method: "DELETE",
    }),
  listAssets: (id: number, issueId: number) =>
    request<IssueAssetListResult>(
      `/requirements/${id}/issues/${issueId}/assets`,
    ),
  linkAsset: (
    id: number,
    issueId: number,
    assetId: number,
    relationType: IssueAssetRelation = "reference",
  ) =>
    request<void>(`/requirements/${id}/issues/${issueId}/assets`, {
      method: "POST",
      body: JSON.stringify({ assetId, relationType }),
    }),
  unlinkAsset: (id: number, issueId: number, assetId: number) =>
    request<void>(`/requirements/${id}/issues/${issueId}/assets/${assetId}`, {
      method: "DELETE",
    }),
};
