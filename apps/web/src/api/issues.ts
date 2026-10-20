import type {
  Issue,
  IssueAssetListResult,
  IssueAssetRelation,
  IssueDetail,
  IssueListResult,
  IssuePhase,
  IssueStatus,
} from "@superpm/shared";
import { request } from "./client";

export interface IssueCreatePayload {
  phase: IssuePhase;
  title: string;
  description?: string;
  descriptionHtml?: string;
  issueType?: string;
}
export interface IssueUpdatePayload {
  title?: string;
  description?: string;
  descriptionHtml?: string;
  issueType?: string | null;
  status?: IssueStatus;
  solution?: string;
}
export const issueApi = {
  list: (id: number, phase?: IssuePhase, status?: IssueStatus) => {
    const params = new URLSearchParams();
    if (phase) params.set("phase", phase);
    if (status) params.set("status", status);
    const query = params.toString();
    return request<IssueListResult>(
      `/requirements/${id}/issues${query ? `?${query}` : ""}`,
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
