<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import XlyLogin from "../components/ease-ui/login/index.vue";
import { errorMessage } from "../api/client";
import { fetchAuthConfig, login, register } from "../api/auth";
import { setAuthUser } from "../stores/auth";

// 登录页：复用 ease-ui 登录视图（浅色 ClassicTheme / 深色 DarkTheme）；
// 注册与登录共用同一套视觉，切换时清空错误提示，避免串场的红色文案。
const route = useRoute();
const router = useRouter();
const loading = ref(false);
const errorMsg = ref("");
const mode = ref<"login" | "register">("login");
// 服务端关闭自助注册时隐藏注册入口；查询失败按「不开放」处理，避免出现点了就报错的按钮
const allowRegister = ref(false);

onMounted(async () => {
  try {
    allowRegister.value = (await fetchAuthConfig()).registrationEnabled;
  } catch {
    allowRegister.value = false;
  }
});

async function handleSubmit(form: { username: string; password: string }) {
  errorMsg.value = "";
  loading.value = true;
  try {
    const user =
      mode.value === "register"
        ? await register(form.username, form.password)
        : await login(form.username, form.password);
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

function handleSwitchMode(next: "login" | "register") {
  mode.value = next;
  errorMsg.value = "";
}
</script>

<template>
  <XlyLogin
    :loading="loading"
    :error="errorMsg"
    :mode="mode"
    :allow-register="allowRegister"
    @submit="handleSubmit"
    @switch-mode="handleSwitchMode"
  />
</template>
