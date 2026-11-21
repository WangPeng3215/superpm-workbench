import { request } from "./client";

export interface ProjectWorklogItem {
  projectTaskId: number;
  title: string;
  assigneeUserId: number;
  assigneeName: string;
  workerUserId: number;
  workerName: string;
  totalSeconds: number;
}

export const projectWorklogApi = {
  list: (projectId: number) =>
    request<{ totalSeconds: number; items: ProjectWorklogItem[] }>(
      "/projects/" + projectId + "/worklog",
    ),
};

export function formatWorklogDuration(seconds: number) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return remainder + " 分钟";
  return remainder ? hours + " 小时 " + remainder + " 分钟" : hours + " 小时";
}
