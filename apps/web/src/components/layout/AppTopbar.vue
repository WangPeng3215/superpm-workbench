<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  BellOutlined,
  CloseOutlined,
  CloudServerOutlined,
  DownOutlined,
  LeftOutlined,
  MoreOutlined,
  RightOutlined,
  PushpinFilled,
  PushpinOutlined,
} from "@ant-design/icons-vue";
import { authStore } from "../../stores/auth";
import ThemeSwitch from "../ThemeSwitch.vue";
import {
  closeTab,
  closeOtherTabsWithPolicy,
  clearTabs,
  siblingTabPath,
  syncRoute,
  tabsStore,
  togglePinned,
  reorderTab,
  type WorkTab,
} from "../../stores/tabs";

defineProps<{ connected: boolean }>();
const emit = defineEmits<{
  "change-password": [];
  logout: [];
}>();

const route = useRoute();
const router = useRouter();
const tabsViewport = ref<HTMLElement>();
const overflowTabs = ref(false);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);
let resizeObserver: ResizeObserver | undefined;
const avatarChar = computed(
  () => (authStore.user?.displayName ?? "未").trim().charAt(0) || "未",
);

function pushTab(tab: WorkTab) {
  if (route.path !== tab.path) void router.push(tab.path);
}

function pinLabel(tab: WorkTab) {
  return (tab.pinned ? "取消固定 " : "固定 ") + tab.label;
}

function updateScrollState() {
  const el = tabsViewport.value;
  if (!el) return;
  overflowTabs.value = el.scrollWidth > el.clientWidth + 1;
  canScrollLeft.value = el.scrollLeft > 1;
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

function scrollTabs(direction: -1 | 1) {
  const el = tabsViewport.value;
  el?.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "instant" });
}

async function closeOtherTabs(keepPinned: boolean) {
  closeOtherTabsWithPolicy(tabsStore.activePath || route.path, keepPinned);
  await nextTick();
  updateScrollState();
}

let draggedKey = "";
function onDragStart(event: DragEvent, tab: WorkTab) {
  draggedKey = tab.key;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tab.key);
  }
}
function onDrop(event: DragEvent, tab: WorkTab) {
  event.preventDefault();
  const sourceKey = event.dataTransfer?.getData("text/plain") || draggedKey;
  if (sourceKey) reorderTab(sourceKey, tab.key);
  draggedKey = "";
}

async function closeAllTabs() {
  const target = "/requirements";
  if (route.path !== target) {
    const failure = await router.push(target);
    if (failure) return;
  }
  clearTabs();
  syncRoute(target);
  await nextTick();
  updateScrollState();
}

function handleTabCommand(command: string | number | object) {
  if (command === "close-other-all") void closeOtherTabs(false);
  else if (command === "close-other-pinned") void closeOtherTabs(true);
  else if (command === "close-all") void closeAllTabs();
}

// 先完成导航再移除激活页签：未保存确认被取消时，页签必须保留在原页面
async function onCloseTab(tab: WorkTab) {
  const active = tabsStore.activePath === tab.key || route.path === tab.key;
  if (!active) {
    closeTab(tab.key);
    return;
  }
  const target = siblingTabPath(tab.key) ?? "/requirements";
  if (route.path !== target) {
    const failure = await router.push(target);
    if (failure) return;
  }
  const fallback = closeTab(tab.key);
  if (fallback && route.path === fallback) syncRoute(fallback);
}

function handleUserCommand(command: string | number | object) {
  if (command === "change-password") emit("change-password");
  else if (command === "logout") emit("logout");
}

watch(
  () => [tabsStore.tabs.length, tabsStore.activePath, route.path],
  async () => {
    await nextTick();
    updateScrollState();
    const active =
      tabsViewport.value?.querySelector<HTMLElement>(".topbar-tab.active");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateScrollState();
  },
);
onMounted(() => {
  resizeObserver = new ResizeObserver(updateScrollState);
  if (tabsViewport.value) resizeObserver.observe(tabsViewport.value);
  window.addEventListener("resize", updateScrollState);
  updateScrollState();
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener("resize", updateScrollState);
});
</script>

<template>
  <header class="topbar">
    <div class="topbar-tab-strip">
      <button
        v-if="overflowTabs"
        class="tab-scroll-button"
        type="button"
        aria-label="向左滚动页签"
        :disabled="!canScrollLeft"
        @click="scrollTabs(-1)"
      >
        <el-icon><LeftOutlined /></el-icon>
      </button>
      <nav
        v-if="tabsStore.tabs.length"
        ref="tabsViewport"
        class="topbar-tabs"
        aria-label="功能页签"
        @scroll="updateScrollState"
      >
        <button
          v-for="tab in tabsStore.tabs"
          :key="tab.key"
          type="button"
          class="topbar-tab"
          :class="{ active: tabsStore.activePath === tab.path }"
          :title="tab.label"
          :draggable="true"
          @click="pushTab(tab)"
          @dragstart="onDragStart($event, tab)"
          @dragover.prevent
          @drop="onDrop($event, tab)"
          @dragend="draggedKey = ''"
        >
          <span class="tab-label">{{ tab.label }}</span>
          <button
            class="tab-pin"
            type="button"
            :aria-label="pinLabel(tab)"
            :title="tab.pinned ? '取消固定' : '固定在最左侧'"
            @click.stop="togglePinned(tab.key)"
          >
            <el-icon aria-hidden="true">
              <PushpinFilled v-if="tab.pinned" />
              <PushpinOutlined v-else />
            </el-icon>
          </button>
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
            <el-icon aria-hidden="true"><CloseOutlined /></el-icon>
          </span>
        </button>
      </nav>
      <button
        v-if="overflowTabs"
        class="tab-scroll-button"
        type="button"
        aria-label="向右滚动页签"
        :disabled="!canScrollRight"
        @click="scrollTabs(1)"
      >
        <el-icon><RightOutlined /></el-icon>
      </button>
      <el-dropdown trigger="click" @command="handleTabCommand">
        <button
          class="tab-more-button"
          type="button"
          aria-label="页签操作"
          title="页签操作"
        >
          <el-icon><MoreOutlined /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              command="close-other-all"
              :disabled="tabsStore.tabs.length <= 1"
            >
              关闭其他（全部）
            </el-dropdown-item>
            <el-dropdown-item
              command="close-other-pinned"
              :disabled="tabsStore.tabs.length <= 1"
            >
              关闭其他（保留固定页签）
            </el-dropdown-item>
            <el-dropdown-item command="close-all"
              >关闭所有标签页</el-dropdown-item
            >
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <div class="topbar-actions">
      <span class="service-status" :class="{ offline: !connected }">
        <el-icon aria-hidden="true"><CloudServerOutlined /></el-icon>
        {{ connected ? "本地服务已连接" : "本地服务未连接" }}
      </span>
      <RouterLink
        to="/notifications"
        class="topbar-icon-button"
        aria-label="系统通知"
        title="系统通知"
      >
        <el-icon aria-hidden="true"><BellOutlined /></el-icon>
      </RouterLink>
      <ThemeSwitch />
      <el-dropdown
        class="user-menu"
        trigger="click"
        @command="handleUserCommand"
      >
        <button class="user-trigger" type="button" aria-label="账户菜单">
          <span class="user-avatar">{{ avatarChar }}</span>
          <strong>{{ authStore.user?.displayName ?? "未登录" }}</strong>
          <!-- 超管标识：能看到全部用户数据，需要明确的视觉提示 -->
          <span v-if="authStore.user?.isAdmin" class="user-badge">超管</span>
          <el-icon aria-hidden="true" class="user-caret"
            ><DownOutlined
          /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-if="authStore.user" disabled>
              当前账号：{{ authStore.user.username }}
            </el-dropdown-item>
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
