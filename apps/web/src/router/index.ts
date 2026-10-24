import { createRouter, createWebHistory } from "vue-router";
import { ensureAuth } from "../stores/auth";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/requirements" },
    {
      path: "/login",
      component: () => import("../pages/LoginPage.vue"),
      meta: { title: "登录", public: true },
    },
    {
      path: "/requirements",
      component: () => import("../pages/RequirementsPage.vue"),
      meta: { title: "需求工作台" },
    },
    {
      path: "/requirements/:id",
      component: () => import("../pages/RequirementDetailPage.vue"),
      meta: { title: "需求详情" },
    },
    {
      path: "/tasks",
      component: () => import("../pages/DailyTasksPage.vue"),
      meta: { title: "每日任务", module: "tasks" },
    },
    {
      path: "/notifications",
      component: () => import("../pages/PlannedPage.vue"),
      meta: { title: "系统通知", module: "notifications" },
    },
    {
      path: "/settings",
      component: () => import("../pages/SettingsPage.vue"),
      meta: { title: "系统设置" },
    },
    { path: "/:pathMatch(.*)*", redirect: "/requirements" },
  ],
});

// 全局守卫：登录页外的所有路由都需要有效会话，未登录跳登录页并记住原路径
router.beforeEach(async (to) => {
  const user = await ensureAuth();
  if (to.meta.public) {
    if (user) return { path: "/requirements" };
    return true;
  }
  if (!user) return { path: "/login", query: { redirect: to.fullPath } };
  return true;
});
