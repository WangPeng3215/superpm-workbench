<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  DownOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  UpOutlined,
} from "@ant-design/icons-vue";
import {
  onlineToolCategories,
  onlineToolCategoryLabels,
  onlineToolHost,
  type OnlineTool,
  type OnlineToolCategory,
  type OnlineToolUpdate,
} from "@superpm/shared";
import { onlineToolApi } from "../api/online-tools";
import { errorMessage } from "../api/client";
import XlyEmpty from "../components/ease-ui/xly-empty/index.vue";
import { decorative } from "../components/decorativeIcon";
import OnlineToolForm from "../features/online-tools/OnlineToolForm.vue";
import { categoryTone, onlineToolIcon } from "../features/online-tools/icons";
import { refreshToolbox } from "../features/online-tools/toolboxStore";
import type { OnlineToolPayload } from "../features/online-tools/types";

const SearchIcon = decorative(SearchOutlined);
const PlusIcon = decorative(PlusOutlined);
const ReloadIcon = decorative(ReloadOutlined);

const tools = ref<OnlineTool[]>([]);
const loading = ref(false);
const loadError = ref("");
const keyword = ref("");
const category = ref<OnlineToolCategory | "">("");
const busyId = ref<number | null>(null);

const formOpen = ref(false);
const editingTool = ref<OnlineTool | null>(null);
const saving = ref(false);
const formError = ref("");

const favorites = computed(() => tools.value.filter((tool) => tool.isFavorite));
const favoriteIds = computed(() => favorites.value.map((tool) => tool.id));
const favoriteIndex = computed(
  () => new Map(favoriteIds.value.map((id, index) => [id, index])),
);
const hasFilters = computed(
  () => Boolean(keyword.value.trim()) || Boolean(category.value),
);
const filteredTools = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  return tools.value.filter((tool) => {
    if (category.value && tool.category !== category.value) return false;
    return !query || tool.name.toLowerCase().includes(query);
  });
});

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    tools.value = await onlineToolApi.list();
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

async function reloadAfterChange() {
  await load();
  void refreshToolbox();
}

function clearFilters() {
  keyword.value = "";
  category.value = "";
}

function openCreate() {
  editingTool.value = null;
  formError.value = "";
  formOpen.value = true;
}

function openEdit(tool: OnlineTool) {
  editingTool.value = tool;
  formError.value = "";
  formOpen.value = true;
}

function nextFavoriteSortOrder() {
  return (
    favorites.value.reduce((max, tool) => Math.max(max, tool.sortOrder), -1) + 1
  );
}

async function submit(payload: OnlineToolPayload) {
  saving.value = true;
  formError.value = "";
  const editing = editingTool.value;
  try {
    if (editing) await onlineToolApi.update(editing.id, payload);
    else await onlineToolApi.create(payload);
    ElMessage.success(editing ? "在线工具已更新" : "在线工具已添加");
    formOpen.value = false;
    await reloadAfterChange();
  } catch (error) {
    formError.value = errorMessage(error);
  } finally {
    saving.value = false;
  }
}

function rowClassName({ row }: { row: OnlineTool }) {
  return row.enabled ? "" : "tool-row-disabled";
}

async function patchTool(
  tool: OnlineTool,
  changes: OnlineToolUpdate,
  message: string,
) {
  if (busyId.value !== null) return;
  busyId.value = tool.id;
  try {
    await onlineToolApi.update(tool.id, changes);
    ElMessage.success(message);
    await reloadAfterChange();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busyId.value = null;
  }
}

function toggleEnabled(tool: OnlineTool, value: boolean) {
  void patchTool(tool, { enabled: value }, value ? "工具已启用" : "工具已停用");
}

function toggleFavorite(tool: OnlineTool, value: boolean) {
  if (value) {
    void patchTool(
      tool,
      { isFavorite: true, sortOrder: nextFavoriteSortOrder() },
      "已加入快捷工具箱",
    );
  } else {
    void patchTool(tool, { isFavorite: false }, "已移出快捷工具箱");
  }
}

async function moveFavorite(tool: OnlineTool, delta: number) {
  if (busyId.value !== null) return;
  const ids = [...favoriteIds.value];
  const from = ids.indexOf(tool.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  busyId.value = tool.id;
  try {
    await onlineToolApi.reorder(ids);
    await reloadAfterChange();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busyId.value = null;
  }
}

async function removeTool(tool: OnlineTool) {
  try {
    await ElMessageBox.confirm(
      "删除后，该工具将从快捷工具箱中移除。此操作不可撤销。",
      "删除在线工具",
      {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        confirmButtonClass: "el-button--danger",
      },
    );
  } catch {
    return;
  }
  try {
    await onlineToolApi.remove(tool.id);
    ElMessage.success("在线工具已删除");
    await reloadAfterChange();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

onMounted(load);
</script>

<template>
  <div class="tools-toolbar">
    <el-input
      v-model="keyword"
      clearable
      class="search-input"
      placeholder="搜索工具名称"
      aria-label="搜索工具名称"
      :prefix-icon="SearchIcon"
    />
    <el-select
      v-model="category"
      clearable
      class="category-filter"
      placeholder="全部分类"
      aria-label="按分类筛选"
    >
      <el-option
        v-for="value in onlineToolCategories"
        :key="value"
        :label="onlineToolCategoryLabels[value]"
        :value="value"
      />
    </el-select>
    <span class="tool-count">
      {{ filteredTools.length }} / {{ tools.length }} 项
    </span>
    <span class="toolbar-spacer" />
    <el-button text :icon="ReloadIcon" :loading="loading" @click="load">
      刷新
    </el-button>
    <el-button type="primary" :icon="PlusIcon" @click="openCreate">
      添加工具
    </el-button>
  </div>

  <section class="surface tools-surface">
    <div v-if="loadError" class="load-error">
      <el-alert :title="loadError" type="error" :closable="false" show-icon />
      <el-button size="small" @click="load">重新加载</el-button>
    </div>
    <el-table
      v-loading="loading"
      :data="filteredTools"
      row-key="id"
      class="editable-table tool-table"
      :row-class-name="rowClassName"
    >
      <el-table-column label="工具" min-width="300">
        <template #default="{ row }">
          <div class="tool-cell">
            <span
              class="tool-avatar"
              :class="categoryTone[row.category as OnlineToolCategory]"
            >
              <el-icon :size="18" aria-hidden="true">
                <component
                  :is="
                    onlineToolIcon(row.icon as OnlineTool['icon'], row.category)
                  "
                />
              </el-icon>
            </span>
            <div class="tool-info">
              <div class="tool-name">
                <span class="tool-title" :title="row.name">{{ row.name }}</span>
                <span v-if="row.isFavorite && row.enabled" class="quick-badge">
                  快捷
                </span>
                <span v-if="!row.enabled" class="off-badge">已停用</span>
              </div>
              <div class="tool-meta" :title="row.url">
                {{ onlineToolHost(row.url)
                }}<template v-if="row.description">
                  · {{ row.description }}</template
                >
              </div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="分类" width="104">
        <template #default="{ row }">
          <el-tag
            size="small"
            class="enum-tag"
            :class="categoryTone[row.category as OnlineToolCategory]"
          >
            {{ onlineToolCategoryLabels[row.category as OnlineToolCategory] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="快捷入口" width="100" align="center">
        <template #default="{ row }">
          <el-switch
            :model-value="row.isFavorite"
            :disabled="busyId !== null"
            :aria-label="
              row.isFavorite
                ? `从快捷工具箱移除 ${row.name}`
                : `加入快捷工具箱 ${row.name}`
            "
            @change="
              (value: string | number | boolean) =>
                toggleFavorite(row, Boolean(value))
            "
          />
        </template>
      </el-table-column>
      <el-table-column label="状态" width="88" align="center">
        <template #default="{ row }">
          <el-switch
            :model-value="row.enabled"
            :disabled="busyId !== null"
            :aria-label="row.enabled ? `停用 ${row.name}` : `启用 ${row.name}`"
            @change="
              (value: string | number | boolean) =>
                toggleEnabled(row, Boolean(value))
            "
          />
        </template>
      </el-table-column>
      <el-table-column label="排序" width="96" align="center">
        <template #default="{ row }">
          <div v-if="row.isFavorite" class="order-cell">
            <button
              type="button"
              class="order-btn"
              title="上移"
              :aria-label="`上移 ${row.name}`"
              :disabled="busyId !== null || favoriteIndex.get(row.id) === 0"
              @click="moveFavorite(row, -1)"
            >
              <el-icon aria-hidden="true"><UpOutlined /></el-icon>
            </button>
            <button
              type="button"
              class="order-btn"
              title="下移"
              :aria-label="`下移 ${row.name}`"
              :disabled="
                busyId !== null ||
                favoriteIndex.get(row.id) === favorites.length - 1
              "
              @click="moveFavorite(row, 1)"
            >
              <el-icon aria-hidden="true"><DownOutlined /></el-icon>
            </button>
          </div>
          <span v-else class="order-dash">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="126" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button link type="primary" size="small" @click="openEdit(row)">
              编辑
            </el-button>
            <el-button link type="danger" size="small" @click="removeTool(row)">
              删除
            </el-button>
          </div>
        </template>
      </el-table-column>
      <template #empty>
        <XlyEmpty
          size="small"
          :type="hasFilters ? 'search' : 'list'"
          :description="
            hasFilters ? '没有找到匹配的在线工具' : '还没有在线工具'
          "
        >
          <el-button v-if="hasFilters" plain @click="clearFilters">
            清除筛选
          </el-button>
          <el-button
            v-else
            type="primary"
            plain
            :icon="PlusIcon"
            @click="openCreate"
          >
            添加第一个工具
          </el-button>
        </XlyEmpty>
      </template>
    </el-table>
  </section>

  <OnlineToolForm
    v-model:visible="formOpen"
    :tool="editingTool"
    :saving="saving"
    :error="formError"
    @submit="submit"
  />
</template>

<style scoped>
.tools-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-base);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
}
.search-input {
  flex: 0 1 260px;
  min-width: 170px;
}
.category-filter {
  flex: 0 0 132px;
}
.tool-count {
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.toolbar-spacer {
  flex: 1;
}
.tools-surface {
  overflow: hidden;
}
.load-error {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 12px 0;
}
.load-error :deep(.el-alert) {
  flex: 1;
}
.tool-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.tool-avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
.tool-avatar.tone-blue {
  border-color: var(--tone-blue-bd);
  background: var(--tone-blue-bg);
  color: var(--tone-blue-fg);
}
.tool-avatar.tone-purple {
  border-color: var(--tone-purple-bd);
  background: var(--tone-purple-bg);
  color: var(--tone-purple-fg);
}
.tool-avatar.tone-teal {
  border-color: var(--tone-teal-bd);
  background: var(--tone-teal-bg);
  color: var(--tone-teal-fg);
}
.tool-avatar.tone-amber {
  border-color: var(--tone-amber-bd);
  background: var(--tone-amber-bg);
  color: var(--tone-amber-fg);
}
.tool-avatar.tone-slate {
  border-color: var(--tone-slate-bd);
  background: var(--tone-slate-bg);
  color: var(--tone-slate-fg);
}
.tool-info {
  min-width: 0;
}
.tool-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.tool-title {
  overflow: hidden;
  color: var(--text-title);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.quick-badge,
.off-badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 99px;
  font-size: 9px;
  font-weight: 600;
  line-height: 1.5;
}
.quick-badge {
  background: var(--tone-teal-bg);
  color: var(--tone-teal-fg);
}
.off-badge {
  background: var(--tone-slate-bg);
  color: var(--tone-slate-fg);
}
.tool-meta {
  overflow: hidden;
  margin-top: 2px;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-table :deep(.tool-row-disabled) .tool-avatar,
.tool-table :deep(.tool-row-disabled) .tool-title {
  opacity: 0.55;
}
.order-cell {
  display: inline-flex;
  gap: 2px;
}
.order-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}
.order-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-title);
}
.order-btn:disabled {
  color: var(--text-faint);
  cursor: not-allowed;
  opacity: 0.45;
}
.order-btn:focus-visible {
  outline-offset: 1px;
}
.order-dash {
  color: var(--text-faint);
  font-size: 11px;
}
.row-actions {
  display: flex;
  gap: 2px;
}
.row-actions :deep(.el-button) {
  margin: 0;
  padding: 0 4px;
}
@media (max-width: 720px) {
  .tools-toolbar {
    flex-wrap: wrap;
  }
  .search-input {
    flex: 1 1 100%;
  }
  .category-filter {
    flex: 1 1 132px;
  }
}
</style>
