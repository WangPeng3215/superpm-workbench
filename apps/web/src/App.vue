<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  Grid,
  Calendar,
  Bell,
  Setting,
  Connection,
  ArrowRight,
  Moon,
  Sunny,
} from "@element-plus/icons-vue";
import { request } from "./api/client";

const THEME_KEY = "superpm-theme";
const route = useRoute();
const connected = ref(false);
const title = computed(() => String(route.meta.title ?? "需求工作台"));
const navigation = [
  { path: "/requirements", label: "需求工作台", icon: Grid },
  { path: "/tasks", label: "每日任务历史", icon: Calendar },
  { path: "/notifications", label: "系统通知", icon: Bell },
];
// 记住过的偏好优先，首次访问跟随系统
const stored = localStorage.getItem(THEME_KEY);
const dark = ref(
  stored === null
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : stored === "dark",
);
watch(
  dark,
  (value) => {
    document.documentElement.classList.toggle("dark", value);
  },
  { immediate: true },
);
function toggleTheme() {
  dark.value = !dark.value;
  localStorage.setItem(THEME_KEY, dark.value ? "dark" : "light");
}
onMounted(async () => {
  try {
    await request("/health");
    connected.value = true;
  } catch {
    connected.value = false;
  }
});
</script>

<template>
  <div class="app-layout">
    <aside class="sidebar">
      <RouterLink to="/requirements" class="brand" aria-label="superPM 首页"
        ><img class="brand-logo" src="/logo-mark.png" alt="superPM" /><span
          >superPM<small>workbench</small></span
        ></RouterLink
      >
      <div class="workspace-label">个人工作空间</div>
      <nav class="navigation" aria-label="主导航">
        <RouterLink
          v-for="item in navigation"
          :key="item.path"
          :to="item.path"
          class="nav-item"
          ><el-icon><component :is="item.icon" /></el-icon
          ><span>{{ item.label }}</span></RouterLink
        >
      </nav>
      <div class="sidebar-bottom">
        <RouterLink to="/settings" class="nav-item"
          ><el-icon><Setting /></el-icon><span>系统设置</span></RouterLink
        >
        <div class="local-profile">
          <span class="avatar">我</span>
          <div><strong>本地用户</strong><small>数据保存在这台电脑</small></div>
        </div>
      </div>
    </aside>
    <div class="main-layout">
      <header class="topbar">
        <div class="breadcrumb">
          工作空间<el-icon><ArrowRight /></el-icon><span>{{ title }}</span>
        </div>
        <div class="topbar-actions">
          <button
            class="theme-toggle"
            type="button"
            :aria-label="dark ? '切换到浅色模式' : '切换到深色模式'"
            :title="dark ? '切换到浅色模式' : '切换到深色模式'"
            @click="toggleTheme"
          >
            <el-icon><Sunny v-if="dark" /><Moon v-else /></el-icon>
          </button>
          <span class="service-status" :class="{ offline: !connected }"
            ><el-icon><Connection /></el-icon
            >{{ connected ? "本地服务已连接" : "本地服务未连接" }}</span
          >
        </div>
      </header>
      <main class="page-content"><RouterView /></main>
    </div>
  </div>
</template>
