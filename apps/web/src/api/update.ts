import type { UpdateCheckResult, UpdateStatus } from "@superpm/shared";
import { request } from "./client";

export function fetchUpdateStatus() {
  return request<UpdateStatus>("/update/status");
}

export function checkUpdate() {
  return request<UpdateCheckResult>("/update/check", { method: "POST" });
}

export function installUpdate(version: string, force: boolean) {
  return request<{ accepted: true }>("/update/install", {
    method: "POST",
    body: JSON.stringify({ version, force }),
  });
}
