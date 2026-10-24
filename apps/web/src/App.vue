<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { FormInstance, FormRules } from "element-plus";
import { ElMessage, ElMessageBox } from "element-plus";
import { Calendar, Grid } from "@element-plus/icons-vue";
import { request } from "./api/client";
import { changePassword, logout } from "./api/auth";
import { clearAuthUser } from "./stores/auth";
import { clearTabs, syncRoute } from "./stores/tabs";
import AppSidebar from "./components/layout/AppSidebar.vue";
import AppTopbar from "./components/layout/AppTopbar.vue";

const route = useRoute();
const router = useRouter();
const connected = ref(false);
const bareLayout = computed(() => Boolean(route.meta.public));
watch(
  () => route.path,
  (path) => {
    if (route.meta.public) clearTabs();
    else syncRoute(path);
  },
  { immediate: true },
);

const navigation = [
  { path: "/requirements", label: "需求列表", icon: Grid },
  { path: "/tasks", label: "每日任务", icon: Calendar },
];
onMounted(async () => {
  try {
    await request("/health");
    connected.value = true;
  } catch {
    connected.value = false;
  }
});

async function confirmLogout() {
  try {
    await ElMessageBox.confirm("确定要退出当前账号吗？", "退出登录", {
      type: "warning",
      confirmButtonText: "退出",
      cancelButtonText: "取消",
    });
  } catch {
    return; // 用户取消
  }
  try {
    await logout();
  } catch {
    // 会话已失效等情况也继续清理本地状态
  }
  clearAuthUser();
  await router.push("/login");
}

// ===== 修改密码弹窗 =====
const pwdDialogVisible = ref(false);
const pwdSubmitting = ref(false);
const pwdFormRef = ref<FormInstance>();
const pwdForm = ref({ oldPassword: "", newPassword: "", confirmPassword: "" });
const pwdRules: FormRules = {
  oldPassword: [{ required: true, message: "请输入原密码", trigger: "blur" }],
  newPassword: [
    { required: true, message: "请输入新密码", trigger: "blur" },
    { min: 6, max: 100, message: "新密码长度需在 6 到 100 位之间", trigger: "blur" },
  ],
  confirmPassword: [
    { required: true, message: "请再次输入新密码", trigger: "blur" },
    {
      validator: (_rule, value, callback) => {
        if (value !== pwdForm.value.newPassword)
          callback(new Error("两次输入的密码不一致"));
        else callback();
      },
      trigger: "blur",
    },
  ],
};

function openPasswordDialog() {
  pwdForm.value = { oldPassword: "", newPassword: "", confirmPassword: "" };
  pwdDialogVisible.value = true;
}

async function submitChangePassword() {
  const valid = await pwdFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  pwdSubmitting.value = true;
  try {
    await changePassword(pwdForm.value.oldPassword, pwdForm.value.newPassword);
    pwdDialogVisible.value = false;
    ElMessage.success("密码已修改，下次登录请使用新密码");
  } finally {
    pwdSubmitting.value = false;
  }
}
</script>

<template>
  <!-- 登录页等公开路由：脱离主布局 -->
  <RouterView v-if="bareLayout" />
  <div v-else class="app-layout">
    <AppSidebar :items="navigation" />
    <div class="main-layout">
      <AppTopbar
        :connected="connected"
        @change-password="openPasswordDialog"
        @logout="confirmLogout"
      />
      <main class="page-content"><RouterView /></main>
    </div>
  </div>
  <!-- 修改密码弹窗 -->
  <el-dialog
    v-model="pwdDialogVisible"
    title="修改密码"
    width="420px"
    :close-on-click-modal="false"
  >
    <el-form
      ref="pwdFormRef"
      :model="pwdForm"
      :rules="pwdRules"
      label-width="96px"
      @submit.prevent="submitChangePassword"
    >
      <el-form-item label="原密码" prop="oldPassword">
        <el-input
          v-model="pwdForm.oldPassword"
          type="password"
          show-password
          placeholder="请输入原密码"
          autocomplete="current-password"
        />
      </el-form-item>
      <el-form-item label="新密码" prop="newPassword">
        <el-input
          v-model="pwdForm.newPassword"
          type="password"
          show-password
          placeholder="至少 6 位"
          autocomplete="new-password"
        />
      </el-form-item>
      <el-form-item label="确认新密码" prop="confirmPassword">
        <el-input
          v-model="pwdForm.confirmPassword"
          type="password"
          show-password
          placeholder="再次输入新密码"
          autocomplete="new-password"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="pwdDialogVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="pwdSubmitting"
        @click="submitChangePassword"
        >确认修改</el-button
      >
    </template>
  </el-dialog>
</template>
