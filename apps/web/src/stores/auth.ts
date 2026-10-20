import { reactive } from "vue";
import { fetchMe, type AuthUser } from "../api/auth";

// 登录态缓存：Token 存于 httpOnly Cookie，前端只保存用户信息。
// ready 标记避免路由守卫重复请求 /auth/me。
export const authStore = reactive<{
  user: AuthUser | null;
  ready: boolean;
}>({ user: null, ready: false });

export async function ensureAuth(): Promise<AuthUser | null> {
  if (authStore.ready) return authStore.user;
  try {
    authStore.user = await fetchMe();
  } catch {
    authStore.user = null;
  }
  authStore.ready = true;
  return authStore.user;
}

export function setAuthUser(user: AuthUser) {
  authStore.user = user;
  authStore.ready = true;
}

export function clearAuthUser() {
  authStore.user = null;
  authStore.ready = true;
}
