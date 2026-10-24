<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ArrowDown,
  Bell,
  Close,
  Connection,
  Moon,
  Sunny,
} from "@element-plus/icons-vue";
import { authStore } from "../../stores/auth";
import {
  closeTab,
  syncRoute,
  tabsStore,
  type WorkTab,
} from "../../stores/tabs";
import { dark, toggleTheme } from "../../theme";

defineProps<{ connected: boolean }>();
const emit = defineEmits<{
  "change-password": [];
  logout: [];
}>();

const route = useRoute();
const router = useRouter();
const avatarChar = computed(
  () => (authStore.user?.displayName ?? "未").trim().charAt(0) || "未",
);

function pushTab(tab: WorkTab) {
  if (route.path !== tab.path) void router.push(tab.path);
}

async function onCloseTab(tab: WorkTab) {
  const target = closeTab(tab.key);
  if (!target) return;
  if (route.path === target) syncRoute(target);
  else await router.push(target);
}

function handleUserCommand(command: string | number | object) {
  if (command === "change-password") emit("change-password");
  else if (command === "logout") emit("logout");
}
</script>

<template>
  <header class="topbar">
    <nav
      v-if="tabsStore.tabs.length"
      class="topbar-tabs"
      aria-label="功能页签"
    >
      <button
        v-for="tab in tabsStore.tabs"
        :key="tab.key"
        type="button"
        class="topbar-tab"
        :class="{ active: tabsStore.activePath === tab.path }"
        :title="tab.label"
        @click="pushTab(tab)"
      >
        <span class="tab-label">{{ tab.label }}</span>
        <span
          class="tab-close"
          role="button"
          tabindex="0"
          aria-label="关闭页签"
          title="关闭页签"
          @click.stop="onCloseTab(tab)"
          @keydown.enter.stop="onCloseTab(tab)"
          @keydown.space.prevent.stop="onCloseTab(tab)"
        >
          <el-icon><Close /></el-icon>
        </span>
      </button>
    </nav>
    <div class="topbar-actions">
      <span class="service-status" :class="{ offline: !connected }">
        <el-icon><Connection /></el-icon>
        {{ connected ? "本地服务已连接" : "本地服务未连接" }}
      </span>
      <RouterLink
        to="/notifications"
        class="topbar-icon-button"
        aria-label="系统通知"
        title="系统通知"
      >
        <el-icon><Bell /></el-icon>
      </RouterLink>
      <button
        class="topbar-icon-button"
        type="button"
        :aria-label="dark ? '切换到浅色模式' : '切换到深色模式'"
        :title="dark ? '切换到浅色模式' : '切换到深色模式'"
        @click="toggleTheme"
      >
        <el-icon><Sunny v-if="dark" /><Moon v-else /></el-icon>
      </button>
      <el-dropdown
        class="user-menu"
        trigger="click"
        @command="handleUserCommand"
      >
        <button class="user-trigger" type="button" aria-label="账户菜单">
          <span class="user-avatar">{{ avatarChar }}</span>
          <strong>{{ authStore.user?.displayName ?? "未登录" }}</strong>
          <el-icon class="user-caret"><ArrowDown /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="change-password">
              修改密码
            </el-dropdown-item>
            <el-dropdown-item divided command="logout">
              退出登录
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </header>
</template>
