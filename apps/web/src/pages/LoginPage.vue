<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import XlyLogin from "../components/ease-ui/login/index.vue";
import { errorMessage } from "../api/client";
import { login } from "../api/auth";
import { setAuthUser } from "../stores/auth";

// 登录页：复用 ease-ui 登录视图（浅色 ClassicTheme / 深色 DarkTheme）
const route = useRoute();
const router = useRouter();
const loading = ref(false);
const errorMsg = ref("");

async function handleLogin(form: { username: string; password: string }) {
  errorMsg.value = "";
  loading.value = true;
  try {
    const user = await login(form.username, form.password);
    setAuthUser(user);
    // 只回跳站内路径，防止开放重定向
    const redirect =
      typeof route.query.redirect === "string" &&
      route.query.redirect.startsWith("/") &&
      !route.query.redirect.startsWith("//")
        ? route.query.redirect
        : "/requirements";
    await router.push(redirect);
  } catch (error) {
    errorMsg.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <XlyLogin :loading="loading" :error="errorMsg" @submit="handleLogin" />
</template>
