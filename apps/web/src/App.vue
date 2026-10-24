<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { FormInstance, FormRules } from "element-plus";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  Grid,
  Calendar,
  Bell,
  Setting,
  Connection,
  ArrowDown,
  Close,
  Moon,
  Sunny,
} from "@element-plus/icons-vue";
import { request } from "./api/client";
import { changePassword, logout } from "./api/auth";
import { authStore, clearAuthUser } from "./stores/auth";
import {
  clearTabs,
  closeTab,
  syncRoute,
  tabsStore,
  type WorkTab,
} from "./stores/tabs";
import { dark, toggleTheme } from "./theme";

const route = useRoute();
const router = useRouter();
const connected = ref(false);
// 登录页是独立视图：脱离侧栏/顶栏布局直接渲染
const bareLayout = computed(() => Boolean(route.meta.public));
// 顶栏页签与路由联动：功能/详情路由进入后对应页签才出现并激活；
// 进入公开页（登录、退出登录跳转）时清空全部页签，之后进入功能按需重开
watch(
  () => route.path,
  (path) => {
    if (route.meta.public) clearTabs();
    else syncRoute(path);
  },
  { immediate: true },
);

// 点击页签跳转对应路由（当前页签重复点击不重复导航）
function pushTab(tab: WorkTab) {
  if (route.path !== tab.path) void router.push(tab.path);
}
// 关闭页签：若关闭的是激活页签，按右侧→左侧→需求列表规则回退路由；
// 目标与当前路由相同（关掉最后一个页签兜底回首页）时不再触发路由联动，手动补开首页页签
async function onCloseTab(tab: WorkTab) {
  const target = closeTab(tab.key);
  if (!target) return;
  if (route.path === target) syncRoute(target);
  else await router.push(target);
}
const navigation = [
  { path: "/requirements", label: "需求列表", icon: Grid },
  { path: "/tasks", label: "每日任务", icon: Calendar },
];
// 头像圆标取显示名首字
const avatarChar = computed(
  () => (authStore.user?.displayName ?? "未").trim().charAt(0) || "未",
);
onMounted(async () => {
  try {
    await request("/health");
    connected.value = true;
  } catch {
    connected.value = false;
  }
});

// ===== 右上角用户菜单：修改密码 / 退出登录 =====
function handleUserCommand(command: string | number | object) {
  if (command === "change-password") openPasswordDialog();
  else if (command === "logout") confirmLogout();
}

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
    <aside class="sidebar">
      <RouterLink to="/requirements" class="brand" aria-label="superPM 首页"
        ><img class="brand-logo" src="/logo-mark.png" alt="superPM" /><span
          >superPM<small>workbench</small></span
        ></RouterLink
      >
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
      </div>
    </aside>
    <div class="main-layout">
      <header class="topbar">
        <!-- 功能页签栏（替代原面包屑）：页签在功能被打开后出现、均可关闭，需求详情按访问动态开签 -->
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
              aria-label="关闭页签"
              title="关闭页签"
              @click.stop="onCloseTab(tab)"
            >
              <el-icon><Close /></el-icon>
            </span>
          </button>
        </nav>
        <div class="topbar-actions">
          <span class="service-status" :class="{ offline: !connected }"
            ><el-icon><Connection /></el-icon
            >{{ connected ? "本地服务已连接" : "本地服务未连接" }}</span
          >
          <RouterLink
            to="/notifications"
            class="topbar-icon-button"
            aria-label="系统通知"
            title="系统通知"
            ><el-icon><Bell /></el-icon
          ></RouterLink>
          <button
            class="topbar-icon-button"
            type="button"
            :aria-label="dark ? '切换到浅色模式' : '切换到深色模式'"
            :title="dark ? '切换到浅色模式' : '切换到深色模式'"
            @click="toggleTheme"
          >
            <el-icon><Sunny v-if="dark" /><Moon v-else /></el-icon>
          </button>
          <!-- 右上角用户区：头像 + 名称 + 修改密码/退出登录 -->
          <el-dropdown
            class="user-menu"
            trigger="click"
            @command="handleUserCommand"
          >
            <button class="user-trigger" type="button">
              <span class="user-avatar">{{ avatarChar }}</span>
              <strong>{{ authStore.user?.displayName ?? "未登录" }}</strong>
              <el-icon class="user-caret"><ArrowDown /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="change-password"
                  >修改密码</el-dropdown-item
                >
                <el-dropdown-item divided command="logout"
                  >退出登录</el-dropdown-item
                >
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>
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
