<template>
  <component
    :is="activeTheme"
    :key="dark ? 'dark' : 'light'"
    :loading="loading"
    :error="error"
    @submit="handleSubmit"
  />
  <!-- 浅色 / 深色切换：与主应用共用同一主题状态（localStorage superpm-theme） -->
  <button
    class="login-theme-toggle"
    type="button"
    :aria-label="dark ? '切换到浅色模式' : '切换到深色模式'"
    :title="dark ? '切换到浅色模式' : '切换到深色模式'"
    @click="toggleTheme"
  >
    <el-icon><Sunny v-if="dark" /><Moon v-else /></el-icon>
  </button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Moon, Sunny } from "@element-plus/icons-vue";
import { dark, toggleTheme } from "../../../theme";
import ClassicTheme from "./themes/ClassicTheme.vue";
import DarkTheme from "./themes/DarkTheme.vue";

defineOptions({ name: "XlyLogin" });

defineProps<{ loading?: boolean; error?: string }>();
const emit = defineEmits<{
  submit: [form: { username: string; password: string }];
}>();

// 浅色 → 经典蓝（ClassicTheme），深色 → 暗黑科技（DarkTheme）
const activeTheme = computed(() => (dark.value ? DarkTheme : ClassicTheme));

function handleSubmit(form: { username: string; password: string }) {
  emit("submit", form);
}
</script>

<style scoped lang="css">
/* 悬浮主题切换按钮：颜色全部取自 styles.css 语义化变量，随深浅色自动适配 */
.login-theme-toggle {
  position: fixed;
  top: 18px;
  right: 20px;
  z-index: 20;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--border-base);
  border-radius: 8px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.login-theme-toggle:hover {
  background: var(--bg-hover);
  color: var(--brand);
}
</style>
