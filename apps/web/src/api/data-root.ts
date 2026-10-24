import type {
  HomeCleanupRequest,
  HomeCleanupResult,
  HomeMoveRequest,
  HomeMoveStartResult,
  HomeMoveView,
  HomeValidationResult,
} from "@superpm/shared/data-root-contract";
import { request } from "./client";

export function fetchHomeMove() {
  return request<HomeMoveView>("/system/home/move");
}

export function openHomeDirectory() {
  return request<void>("/system/home/open", { method: "POST" });
}

export function pickHomeDirectory() {
  return request<{ path: string | null }>("/system/home/pick", {
    method: "POST",
  });
}

export function validateHomeParent(parent: string) {
  return request<HomeValidationResult>("/system/home/validate", {
    method: "POST",
    body: JSON.stringify({ parent }),
  });
}

export function startHomeMove(payload: HomeMoveRequest) {
  return request<HomeMoveStartResult>("/system/home/move", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function cleanupHomeData(payload: HomeCleanupRequest) {
  return request<HomeCleanupResult>("/system/home/cleanup", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
