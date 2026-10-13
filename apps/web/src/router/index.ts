import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/requirements" },
    {
      path: "/requirements",
      component: () => import("../pages/RequirementsPage.vue"),
      meta: { title: "需求工作台" },
    },
    {
      path: "/tasks",
      component: () => import("../pages/PlannedPage.vue"),
      meta: { title: "每日任务历史", module: "tasks" },
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
