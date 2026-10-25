<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { InputInstance } from "element-plus";
import { ElMessage } from "element-plus";
import {
  AppstoreOutlined,
  CloseOutlined,
  RightOutlined,
  SearchOutlined,
} from "@ant-design/icons-vue";
import {
  isAllowedExternalUrl,
  onlineToolCategoryLabels,
  onlineToolHost,
  type OnlineTool,
} from "@superpm/shared";
import XlyEmpty from "../../components/ease-ui/xly-empty/index.vue";
import { decorative } from "../../components/decorativeIcon";
import { categoryTone, onlineToolIcon } from "./icons";
import {
  clampToolboxPosition,
  loadToolboxPosition,
  saveToolboxPosition,
  toolboxButtonSize,
  type ToolboxPoint,
} from "./position";
import { refreshToolbox, toolboxStore } from "./toolboxStore";

const SearchIcon = decorative(SearchOutlined);

const route = useRoute();
const router = useRouter();

const open = ref(false);
const keyword = ref("");
const position = ref<ToolboxPoint>(loadToolboxPosition());
const dragging = ref(false);
const panelStyle = ref<Record<string, string>>({});
const buttonRef = ref<HTMLButtonElement>();
const panelRef = ref<HTMLElement>();
const searchRef = ref<InputInstance>();

const favorites = computed(() =>
  toolboxStore.tools.filter((tool) => tool.enabled && tool.isFavorite),
);
const favoriteCount = computed(() => favorites.value.length);
const badgeLabel = computed(() =>
  favoriteCount.value > 99 ? "99+" : String(favoriteCount.value),
);
const filteredTools = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  if (!query) return favorites.value;
  return favorites.value.filter(
    (tool) =>
      tool.name.toLowerCase().includes(query) ||
      tool.description.toLowerCase().includes(query) ||
      onlineToolCategoryLabels[tool.category].includes(query) ||
      tool.category.includes(query),
  );
});
const showSkeleton = computed(
  () => toolboxStore.loading && favorites.value.length === 0,
);
const showLoadError = computed(
  () => Boolean(toolboxStore.error) && favorites.value.length === 0,
);
const showEmpty = computed(
  () =>
    !showSkeleton.value && !showLoadError.value && favoriteCount.value === 0,
);
const showNoMatch = computed(
  () =>
    !showSkeleton.value &&
    !showLoadError.value &&
    favoriteCount.value > 0 &&
    filteredTools.value.length === 0,
);

const fabStyle = computed(() => ({
  transform: `translate3d(${position.value.x}px, ${position.value.y}px, 0)`,
}));

function estimatePanelHeight() {
  const rows = Math.ceil(Math.max(filteredTools.value.length, 1) / 3);
  return Math.min(window.innerHeight - 24, 186 + rows * 78);
}

function updatePanelStyle() {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(348, viewportWidth - 24);
  const gap = 14;
  const margin = 12;
  const buttonCenterX = position.value.x + toolboxButtonSize / 2;
  const buttonCenterY = position.value.y + toolboxButtonSize / 2;
  const rightLeft = position.value.x + toolboxButtonSize + gap;
  const leftLeft = position.value.x - gap - width;
  let left: number;
  if (rightLeft + width <= viewportWidth - margin) left = rightLeft;
  else if (leftLeft >= margin) left = leftLeft;
  else
    left = Math.min(
      Math.max(margin, rightLeft),
      viewportWidth - margin - width,
    );
  const measured = panelRef.value?.offsetHeight || estimatePanelHeight();
  const height = Math.min(measured, viewportHeight - margin * 2);
  const top = Math.min(
    viewportHeight - margin - height,
    Math.max(margin, buttonCenterY - height / 2),
  );
  panelStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    width: `${width}px`,
    maxHeight: `${viewportHeight - margin * 2}px`,
    "--origin-x": `${Math.round(buttonCenterX - left)}px`,
    "--origin-y": `${Math.round(
      Math.min(Math.max(buttonCenterY - top, 18), height - 18),
    )}px`,
  };
}

let panelObserver: ResizeObserver | null = null;

function observePanel() {
  panelObserver?.disconnect();
  if (!panelRef.value) return;
  panelObserver = new ResizeObserver(() => updatePanelStyle());
  panelObserver.observe(panelRef.value);
}

async function togglePanel() {
  if (open.value) {
    closePanel(true);
    return;
  }
  open.value = true;
  void refreshToolbox();
  await nextTick();
  updatePanelStyle();
  observePanel();
  searchRef.value?.focus();
  document.addEventListener("pointerdown", onOutsidePointer, true);
}

function closePanel(restoreFocus = false) {
  if (!open.value) return;
  open.value = false;
  if (restoreFocus) buttonRef.value?.focus();
}

function onOutsidePointer(event: PointerEvent) {
  const target = event.target as Node | null;
  if (!target) return;
  if (panelRef.value?.contains(target) || buttonRef.value?.contains(target))
    return;
  open.value = false;
}

function onEscape(event: KeyboardEvent) {
  if (event.key === "Escape" && open.value) closePanel(true);
}

function openTool(tool: OnlineTool) {
  if (!isAllowedExternalUrl(tool.url)) {
    ElMessage.warning("该工具网址无效，请先在在线工具页修正");
    return;
  }
  const win = window.open(tool.url, "_blank");
  if (!win) {
    ElMessage.warning("浏览器拦截了新标签页，请允许弹出窗口后重试");
    return;
  }
  try {
    win.opener = null;
  } catch {
    // 页面已开始加载时浏览器可能拒绝改写 opener，忽略即可
  }
  closePanel();
}

function goManage() {
  open.value = false;
  void router.push("/online-tools");
}

// ===== 拖动 =====
let dragPointer: number | null = null;
let dragOrigin: {
  pointerX: number;
  pointerY: number;
  x: number;
  y: number;
} | null = null;
let moved = false;
let ignoreClick = false;

function startDragListeners() {
  window.addEventListener("pointermove", onFabPointerMove, true);
  window.addEventListener("pointerup", onFabPointerUp, true);
  window.addEventListener("pointercancel", onFabPointerUp, true);
}

function stopDragListeners() {
  window.removeEventListener("pointermove", onFabPointerMove, true);
  window.removeEventListener("pointerup", onFabPointerUp, true);
  window.removeEventListener("pointercancel", onFabPointerUp, true);
}

function onFabPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  dragPointer = event.pointerId;
  dragOrigin = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    x: position.value.x,
    y: position.value.y,
  };
  moved = false;
  startDragListeners();
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    // 指针捕获不可用时由 window 监听兜底，不影响拖动与位置保存
  }
}

function onFabPointerMove(event: PointerEvent) {
  if (dragPointer !== event.pointerId || !dragOrigin) return;
  const dx = event.clientX - dragOrigin.pointerX;
  const dy = event.clientY - dragOrigin.pointerY;
  if (!moved) {
    if (Math.hypot(dx, dy) < 5) return;
    moved = true;
    dragging.value = true;
    open.value = false;
  }
  event.preventDefault();
  position.value = clampToolboxPosition({
    x: dragOrigin.x + dx,
    y: dragOrigin.y + dy,
  });
}

function onFabPointerUp(event: PointerEvent) {
  if (dragPointer !== event.pointerId) return;
  stopDragListeners();
  const target = buttonRef.value;
  try {
    if (target?.hasPointerCapture(event.pointerId))
      target.releasePointerCapture(event.pointerId);
  } catch {
    // 捕获已随指针释放时忽略
  }
  const dragged = moved;
  dragPointer = null;
  dragOrigin = null;
  moved = false;
  if (!dragged) return;
  dragging.value = false;
  saveToolboxPosition(position.value);
  ignoreClick = true;
  window.setTimeout(() => {
    ignoreClick = false;
  }, 0);
}

function onFabClick() {
  if (ignoreClick) return;
  void togglePanel();
}

function onFabKeydown(event: KeyboardEvent) {
  if (!event.altKey) return;
  const step = event.shiftKey ? 40 : 12;
  const dx =
    event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
  const dy =
    event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
  if (!dx && !dy) return;
  event.preventDefault();
  position.value = clampToolboxPosition({
    x: position.value.x + dx,
    y: position.value.y + dy,
  });
  saveToolboxPosition(position.value);
  if (open.value) updatePanelStyle();
}

function onWindowResize() {
  const next = clampToolboxPosition(position.value);
  if (next.x !== position.value.x || next.y !== position.value.y)
    position.value = next;
  if (open.value) updatePanelStyle();
}

watch(
  () => route.fullPath,
  () => {
    if (open.value) open.value = false;
  },
);

onMounted(() => {
  window.addEventListener("resize", onWindowResize);
  document.addEventListener("keydown", onEscape);
  void refreshToolbox();
});

onUnmounted(() => {
  window.removeEventListener("resize", onWindowResize);
  document.removeEventListener("keydown", onEscape);
  document.removeEventListener("pointerdown", onOutsidePointer, true);
  stopDragListeners();
  panelObserver?.disconnect();
});
</script>

<template>
  <Teleport to="body">
    <button
      ref="buttonRef"
      type="button"
      class="toolbox-fab"
      :class="{ open, dragging }"
      :style="fabStyle"
      title="快捷工具（可直接拖动，Alt + 方向键微调位置）"
      aria-label="快捷工具箱"
      aria-haspopup="dialog"
      aria-controls="toolbox-panel"
      :aria-expanded="open"
      @pointerdown="onFabPointerDown"
      @click="onFabClick"
      @keydown="onFabKeydown"
    >
      <span class="fab-aura" aria-hidden="true" />
      <span class="fab-ring" aria-hidden="true" />
      <span class="fab-orbit" aria-hidden="true"> <i /><i /><i /> </span>
      <span class="fab-core" aria-hidden="true">
        <span class="fab-shine" />
        <el-icon class="fab-glyph glyph-tool" :size="23">
          <AppstoreOutlined />
        </el-icon>
        <el-icon class="fab-glyph glyph-close" :size="20">
          <CloseOutlined />
        </el-icon>
      </span>
      <span
        v-if="favoriteCount"
        :key="badgeLabel"
        class="fab-badge"
        aria-hidden="true"
      >
        {{ badgeLabel }}
      </span>
    </button>

    <Transition name="toolbox-pop">
      <section
        v-if="open"
        id="toolbox-panel"
        ref="panelRef"
        class="toolbox-panel"
        :style="panelStyle"
        role="dialog"
        aria-label="快捷工具"
      >
        <header class="panel-head">
          <div class="panel-title-row">
            <span class="panel-mark">
              <el-icon :size="17" aria-hidden="true"
                ><AppstoreOutlined
              /></el-icon>
            </span>
            <div class="panel-heading">
              <h2>快捷工具</h2>
              <p class="panel-sub">常用在线工具，一键打开</p>
            </div>
            <span v-if="favoriteCount" class="panel-count">
              {{ favoriteCount }}
            </span>
            <button
              type="button"
              class="panel-close"
              aria-label="关闭快捷工具"
              @click="closePanel(true)"
            >
              <el-icon :size="14" aria-hidden="true"><CloseOutlined /></el-icon>
            </button>
          </div>
          <el-input
            ref="searchRef"
            v-model="keyword"
            clearable
            class="panel-search"
            placeholder="搜索名称、简介或分类"
            aria-label="搜索快捷工具"
            :prefix-icon="SearchIcon"
          />
        </header>

        <div class="panel-scroll">
          <div v-if="showSkeleton" class="tool-skeleton" aria-label="正在加载">
            <span v-for="index in 6" :key="index" class="skeleton-tile" />
          </div>

          <div v-else-if="showLoadError" class="panel-state">
            <XlyEmpty
              type="network"
              size="small"
              description="快捷工具加载失败"
            >
              <el-button size="small" plain @click="refreshToolbox">
                重新加载
              </el-button>
            </XlyEmpty>
          </div>

          <div v-else-if="showEmpty" class="panel-state">
            <XlyEmpty type="list" size="small" description="还没有快捷工具">
              <el-button size="small" type="primary" plain @click="goManage">
                去添加
              </el-button>
            </XlyEmpty>
            <p class="panel-hint">
              在「在线工具」中开启快捷入口后，会出现在这里
            </p>
          </div>

          <div v-else-if="showNoMatch" class="panel-state">
            <XlyEmpty
              type="search"
              size="small"
              description="没有找到匹配的工具"
            >
              <el-button size="small" plain @click="keyword = ''">
                清除搜索
              </el-button>
            </XlyEmpty>
          </div>

          <template v-else>
            <div class="tool-grid">
              <button
                v-for="(tool, index) in filteredTools"
                :key="tool.id"
                type="button"
                class="tool-tile"
                :style="{ '--i': index }"
                :title="`${tool.name} · ${tool.url}`"
                @click="openTool(tool)"
              >
                <span class="tile-icon" :class="categoryTone[tool.category]">
                  <el-icon :size="18" aria-hidden="true">
                    <component :is="onlineToolIcon(tool.icon, tool.category)" />
                  </el-icon>
                </span>
                <span class="tile-name">{{ tool.name }}</span>
                <span class="tile-host">{{ onlineToolHost(tool.url) }}</span>
              </button>
            </div>
            <div v-if="toolboxStore.error" class="panel-note">
              <span>刷新失败，当前为上次结果</span>
              <button type="button" @click="refreshToolbox">重试</button>
            </div>
          </template>
        </div>

        <footer class="panel-foot">
          <button type="button" class="panel-manage" @click="goManage">
            <span>管理在线工具</span>
            <el-icon :size="12" aria-hidden="true"><RightOutlined /></el-icon>
          </button>
        </footer>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.toolbox-fab {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 942;
  width: 58px;
  height: 58px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  cursor: grab;
  touch-action: none;
  transition: transform 240ms var(--ease-standard);
  will-change: transform;
  -webkit-tap-highlight-color: transparent;
}
.toolbox-fab.dragging {
  cursor: grabbing;
  transition: none;
  z-index: 960;
}
.toolbox-fab:focus-visible {
  outline: none;
}
.fab-core {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background:
    radial-gradient(circle at 32% 22%, rgb(255 255 255 / 42%), transparent 44%),
    linear-gradient(135deg, #4d84ff 0%, #3370ff 46%, #6f5bff 100%);
  color: #fff;
  box-shadow:
    0 16px 32px -14px color-mix(in srgb, var(--brand) 78%, transparent),
    inset 0 1px 0 rgb(255 255 255 / 42%),
    inset 0 -8px 18px -12px rgb(12 24 60 / 55%);
  transition:
    transform 260ms cubic-bezier(0.2, 0.9, 0.3, 1.2),
    box-shadow 260ms var(--ease-standard);
}
.fab-core::after {
  content: "";
  position: absolute;
  inset: 3px;
  border: 1px solid rgb(255 255 255 / 18%);
  border-radius: 50%;
  pointer-events: none;
}
.toolbox-fab:hover .fab-core {
  transform: translateY(-2px) scale(1.05);
  box-shadow:
    0 22px 40px -16px color-mix(in srgb, var(--brand) 92%, transparent),
    inset 0 1px 0 rgb(255 255 255 / 52%),
    inset 0 -8px 18px -12px rgb(12 24 60 / 55%);
}
.toolbox-fab:active .fab-core {
  transform: scale(0.94);
  transition-duration: 120ms;
}
.toolbox-fab.dragging .fab-core {
  transform: scale(1.08) rotate(3deg);
  box-shadow:
    0 26px 48px -14px color-mix(in srgb, var(--brand) 85%, transparent),
    inset 0 1px 0 rgb(255 255 255 / 52%);
}
.toolbox-fab:focus-visible .fab-core {
  box-shadow:
    0 0 0 3px var(--bg-page),
    0 0 0 5px var(--brand-ring),
    0 16px 32px -14px color-mix(in srgb, var(--brand) 78%, transparent);
}
.fab-aura {
  position: absolute;
  inset: -15px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--brand) 48%, transparent),
    transparent 68%
  );
  filter: blur(11px);
  opacity: 0.6;
  pointer-events: none;
  animation: fab-breathe 4.6s ease-in-out infinite;
}
.fab-ring {
  position: absolute;
  inset: -7px;
  border: 1.5px dashed color-mix(in srgb, var(--brand) 58%, transparent);
  border-radius: 50%;
  opacity: 0.8;
  pointer-events: none;
  animation: fab-spin 16s linear infinite;
  transition: opacity 240ms var(--ease-standard);
}
.toolbox-fab:hover .fab-ring {
  opacity: 1;
  animation-duration: 5.5s;
}
.toolbox-fab.open .fab-ring {
  border-color: color-mix(in srgb, var(--brand) 34%, transparent);
  animation-duration: 9s;
}
.fab-orbit {
  position: absolute;
  inset: -9px;
  border-radius: 50%;
  pointer-events: none;
  animation: fab-spin 9s linear infinite reverse;
  transition: animation-duration 300ms;
}
.toolbox-fab.open .fab-orbit {
  animation-duration: 3.4s;
}
.fab-orbit i {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 7px 1px color-mix(in srgb, var(--brand) 70%, transparent);
}
.fab-orbit i:nth-child(1) {
  top: -1px;
  left: calc(50% - 2px);
}
.fab-orbit i:nth-child(2) {
  right: 3px;
  bottom: 9px;
  width: 3px;
  height: 3px;
  opacity: 0.75;
}
.fab-orbit i:nth-child(3) {
  bottom: 9px;
  left: 3px;
  width: 2.5px;
  height: 2.5px;
  opacity: 0.55;
}
.fab-shine {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: 50%;
}
.fab-shine::before {
  content: "";
  position: absolute;
  top: -45%;
  left: -90%;
  width: 65%;
  height: 190%;
  background: linear-gradient(
    90deg,
    transparent,
    rgb(255 255 255 / 38%),
    transparent
  );
  transform: rotate(20deg) translateX(0);
  transition: transform 620ms var(--ease-standard);
}
.toolbox-fab:hover .fab-shine::before {
  transform: rotate(20deg) translateX(340%);
}
.fab-glyph {
  position: absolute;
  transition:
    opacity 220ms var(--ease-standard),
    transform 320ms cubic-bezier(0.2, 0.9, 0.25, 1.1);
}
.glyph-close {
  opacity: 0;
  transform: rotate(-90deg) scale(0.5);
}
.toolbox-fab.open .glyph-tool {
  opacity: 0;
  transform: rotate(85deg) scale(0.55);
}
.toolbox-fab.open .glyph-close {
  opacity: 1;
  transform: rotate(0deg) scale(1);
}
.fab-badge {
  position: absolute;
  top: -4px;
  right: -3px;
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border: 2px solid var(--bg-page);
  border-radius: 999px;
  background: linear-gradient(135deg, #ff8a5b, #ff4d6d);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 5px 12px -4px rgb(255 77 109 / 65%);
  animation: badge-pop 280ms cubic-bezier(0.2, 0.9, 0.3, 1.3);
  pointer-events: none;
}

.toolbox-panel {
  position: fixed;
  z-index: 941;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--glass-border);
  border-radius: 18px;
  background: var(--glass-bg);
  box-shadow:
    0 32px 72px -30px rgb(16 24 40 / 42%),
    0 0 0 1px color-mix(in srgb, var(--brand) 9%, transparent),
    var(--shadow-md);
  backdrop-filter: blur(22px) saturate(1.25);
  transform-origin: var(--origin-x, 50%) var(--origin-y, 50%);
}
.panel-head {
  position: relative;
  flex: none;
  padding: 15px 14px 10px;
}
.panel-head::before {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(
    120% 130% at 0% 0%,
    color-mix(in srgb, var(--brand) 15%, transparent),
    transparent 62%
  );
  pointer-events: none;
}
.panel-title-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
}
.panel-mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  background: linear-gradient(135deg, var(--brand), #7b5ec4);
  color: #fff;
  box-shadow: 0 8px 18px -10px var(--brand);
}
.panel-heading {
  min-width: 0;
}
.panel-heading h2 {
  margin: 0;
  color: var(--text-heading);
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.2px;
  line-height: 1.3;
}
.panel-sub {
  margin: 2px 0 0;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.4;
}
.panel-count {
  margin-left: auto;
  padding: 1px 7px;
  border: 1px solid var(--border-brand);
  border-radius: 99px;
  background: var(--bg-brand-soft);
  color: var(--brand);
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.panel-close {
  display: grid;
  flex: none;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}
.panel-count + .panel-close {
  margin-left: 4px;
}
.panel-close:hover {
  background: var(--bg-hover);
  color: var(--text-title);
}
.panel-search {
  position: relative;
  margin-top: 11px;
}
.panel-search :deep(.el-input__wrapper) {
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
  box-shadow: 0 0 0 1px var(--border-base) inset;
}
.panel-search :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px var(--brand) inset;
}
.panel-scroll {
  flex: 1 1 auto;
  min-height: 0;
  padding: 2px 12px 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.panel-scroll::-webkit-scrollbar {
  width: 6px;
}
.panel-scroll::-webkit-scrollbar-thumb {
  border-radius: 99px;
  background: var(--border-strong);
}
.panel-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.tool-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.tool-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 10px 4px 8px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  font: inherit;
  cursor: pointer;
  animation: tile-in 320ms var(--ease-standard) both;
  animation-delay: calc(var(--i) * 28ms);
  transition:
    background var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    transform var(--duration-normal) var(--ease-standard);
}
.tool-tile:hover {
  border-color: var(--border-brand);
  background: color-mix(in srgb, var(--bg-surface) 78%, transparent);
  transform: translateY(-2px);
}
.tool-tile:active {
  transform: scale(0.96);
}
.tool-tile:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}
.tile-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  transition:
    transform 240ms cubic-bezier(0.2, 0.9, 0.3, 1.2),
    box-shadow var(--duration-normal) var(--ease-standard);
}
.tool-tile:hover .tile-icon {
  transform: translateY(-1px) rotate(-4deg) scale(1.06);
  box-shadow: 0 8px 16px -10px color-mix(in srgb, var(--brand) 55%, transparent);
}
.tile-icon.tone-blue {
  border-color: var(--tone-blue-bd);
  background: var(--tone-blue-bg);
  color: var(--tone-blue-fg);
}
.tile-icon.tone-purple {
  border-color: var(--tone-purple-bd);
  background: var(--tone-purple-bg);
  color: var(--tone-purple-fg);
}
.tile-icon.tone-teal {
  border-color: var(--tone-teal-bd);
  background: var(--tone-teal-bg);
  color: var(--tone-teal-fg);
}
.tile-icon.tone-amber {
  border-color: var(--tone-amber-bd);
  background: var(--tone-amber-bg);
  color: var(--tone-amber-fg);
}
.tile-icon.tone-slate {
  border-color: var(--tone-slate-bd);
  background: var(--tone-slate-bg);
  color: var(--tone-slate-fg);
}
.tile-name {
  width: 100%;
  overflow: hidden;
  color: var(--text-title);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tile-host {
  width: 100%;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 9px;
  line-height: 1.3;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-skeleton {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  padding: 2px 0;
}
.skeleton-tile {
  height: 73px;
  border-radius: 12px;
  background: linear-gradient(
    100deg,
    var(--bg-subtle) 28%,
    var(--bg-hover) 48%,
    var(--bg-subtle) 68%
  );
  background-size: 220% 100%;
  animation: skeleton-shimmer 1.5s linear infinite;
}
.panel-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 190px;
}
.panel-state :deep(.xly-empty) {
  padding: 14px 8px 0;
}
.panel-hint {
  margin: 0 12px 8px;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.6;
  text-align: center;
}
.panel-note {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--tone-amber-bg);
  color: var(--tone-amber-fg);
  font-size: 10px;
}
.panel-note button {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.panel-foot {
  flex: none;
  padding: 7px 10px;
  border-top: 1px solid var(--border-soft);
  background: color-mix(in srgb, var(--bg-surface) 48%, transparent);
}
.panel-manage {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}
.panel-manage:hover {
  background: var(--bg-brand-soft);
  color: var(--brand);
}
.panel-manage:focus-visible {
  outline-offset: 1px;
}

.toolbox-pop-enter-active {
  transition:
    opacity 220ms var(--ease-standard),
    transform 280ms cubic-bezier(0.2, 0.9, 0.25, 1.12);
}
.toolbox-pop-leave-active {
  transition:
    opacity 130ms var(--ease-standard),
    transform 130ms var(--ease-standard);
}
.toolbox-pop-enter-from {
  opacity: 0;
  transform: scale(0.88) translateY(8px);
}
.toolbox-pop-leave-to {
  opacity: 0;
  transform: scale(0.94) translateY(4px);
}

@keyframes fab-breathe {
  0%,
  100% {
    opacity: 0.42;
    transform: scale(0.94);
  }
  50% {
    opacity: 0.72;
    transform: scale(1.08);
  }
}
@keyframes fab-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes badge-pop {
  from {
    opacity: 0;
    transform: scale(0.4);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes tile-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
@keyframes skeleton-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -120% 0;
  }
}
</style>
