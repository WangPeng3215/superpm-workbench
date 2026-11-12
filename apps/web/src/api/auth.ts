import { request } from "./client";

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  /** 超管账号可见全部用户数据，前端据此展示提示 */
  isAdmin: boolean;
}
// 会话 Token 由服务端写入 httpOnly Cookie，前端无需感知其内容
export function login(username: string, password: string) {
  return request<AuthUser>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}
export function register(
  username: string,
  password: string,
  displayName?: string,
) {
  return request<AuthUser>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password, displayName }),
  });
}
// 登录页需要知道服务端是否开放自助注册（公网部署可关闭）
export function fetchAuthConfig() {
  return request<{ registrationEnabled: boolean }>("/auth/config");
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
