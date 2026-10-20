import { request } from "./client";

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
}
// 会话 Token 由服务端写入 httpOnly Cookie，前端无需感知其内容
export function login(username: string, password: string) {
  return request<AuthUser>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}
export function fetchMe() {
  return request<AuthUser>("/auth/me");
}
export function changePassword(oldPassword: string, newPassword: string) {
  return request<{ ok: boolean }>("/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ oldPassword, newPassword }),
  });
}
export function logout() {
  return request<{ ok: boolean }>("/auth/logout", { method: "POST" });
}
