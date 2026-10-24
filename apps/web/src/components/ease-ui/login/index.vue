<template>
  <component
    :is="activeTheme"
    :key="dark ? 'dark' : 'light'"
    :loading="loading"
    :error="error"
    @submit="handleSubmit"
  />
  <!-- 浅色 / 深色切换：与主应用共用同一主题状态（localStorage superpm-theme） -->
  <ThemeSwitch class="login-theme-toggle" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import ThemeSwitch from "../../ThemeSwitch.vue";
import { dark } from "../../../theme";
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
/* 悬浮定位；开关样式见 components/ThemeSwitch.vue */
.login-theme-toggle {
  position: fixed;
  top: 18px;
  right: 20px;
  z-index: 20;
}
</style>
