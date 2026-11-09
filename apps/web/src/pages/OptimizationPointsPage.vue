<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons-vue";
import {
  optimizationPointStatusLabels,
  optimizationPointStatuses,
  type OptimizationPointStatus,
  type OptimizationPointSummary,
} from "@superpm/shared";
import { optimizationPointApi } from "../api/optimization-points";
import { errorMessage } from "../api/client";
import { decorative } from "../components/decorativeIcon";
import XlyEmpty from "../components/ease-ui/xly-empty/index.vue";
import {
  formatPointDate,
  optimizationStatusTone,
} from "../features/optimization-points/format";

const SearchIcon = decorative(SearchOutlined);
const PlusIcon = decorative(PlusOutlined);
const ReloadIcon = decorative(ReloadOutlined);

const router = useRouter();
const points = ref<OptimizationPointSummary[]>([]);
const loading = ref(false);
const loadError = ref("");
const keyword = ref("");
const status = ref<OptimizationPointStatus | "">("");
const deletingId = ref<number | null>(null);
let requestSeq = 0;
let searchTimer: number | undefined;

const hasFilters = computed(
  () => Boolean(keyword.value.trim()) || Boolean(status.value),
);
const countLabel = computed(() =>
  hasFilters.value
    ? `${points.value.length} 条匹配`
    : `${points.value.length} 个优化点`,
);

async function load() {
  const seq = ++requestSeq;
  loading.value = true;
  loadError.value = "";
  try {
    const items = await optimizationPointApi.list({
      q: keyword.value.trim() || undefined,
      status: status.value || undefined,
    });
    if (seq === requestSeq) points.value = items;
  } catch (error) {
    if (seq === requestSeq) loadError.value = errorMessage(error);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function search() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void load(), 300);
}

function clearFilters() {
  keyword.value = "";
  status.value = "";
  void load();
}

function openDetail(row: OptimizationPointSummary) {
  void router.push(`/optimization-points/${row.id}`);
}

function openRequirement(row: OptimizationPointSummary) {
  if (!row.requirement?.exists) return;
  void router.push(`/requirements/${row.requirement.id}`);
}

/** 已转换且关联有效时不再提供转换入口；关联需求被删除后允许重新转换 */
function canConvert(row: OptimizationPointSummary): boolean {
  return !(row.status === "converted" && Boolean(row.requirement?.exists));
}

/**
 * 转换要确认需求名称并预览正文，弹窗只在详情页维护一份：
 * 列表点转换即带着 ?convert=1 跳到详情，由详情页打开弹窗。
 */
function openConvert(row: OptimizationPointSummary) {
  void router.push(`/optimization-points/${row.id}?convert=1`);
}

async function removePoint(row: OptimizationPointSummary) {
  if (deletingId.value !== null) return;
  try {
    await ElMessageBox.confirm(
      "删除后该优化点记录将不可恢复；已转换生成的正式需求不受影响。",
      "删除优化点",
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
  deletingId.value = row.id;
  try {
    await optimizationPointApi.remove(row.id);
    ElMessage.success("优化点已删除");
    await load();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    deletingId.value = null;
  }
}

// ===== 新增优化点：跳独立新建页（与会议记录一致，不再用弹窗）=====
function goCreate() {
  void router.push("/optimization-points/new");
}

// 详情页保存/转换后回到列表时刷新
onMounted(load);
</script>

<template>
  <div class="points-toolbar">
    <el-input
      v-model="keyword"
      clearable
      class="search-input"
      placeholder="搜索优化点名称"
      aria-label="搜索优化点名称"
      :prefix-icon="SearchIcon"
      @input="search"
      @keyup.enter="load"
    />
    <el-select
      v-model="status"
      clearable
      class="status-filter"
      placeholder="全部状态"
      aria-label="按状态筛选"
      @change="load"
    >
      <el-option
        v-for="value in optimizationPointStatuses"
        :key="value"
        :label="optimizationPointStatusLabels[value]"
        :value="value"
      >
        <el-tag
          size="small"
          class="enum-tag"
          :class="optimizationStatusTone[value]"
        >
          {{ optimizationPointStatusLabels[value] }}
        </el-tag>
      </el-option>
    </el-select>
    <span class="point-count">{{ countLabel }}</span>
    <span class="toolbar-spacer" />
    <el-button text :icon="ReloadIcon" :loading="loading" @click="load">
      刷新
    </el-button>
    <el-button type="primary" :icon="PlusIcon" @click="goCreate">
      新增优化点
    </el-button>
  </div>

  <section class="surface points-surface">
    <div v-if="loadError" class="load-error">
      <el-alert :title="loadError" type="error" :closable="false" show-icon />
      <el-button size="small" @click="load">重新加载</el-button>
    </div>
    <el-table
      v-loading="loading"
      :data="points"
      row-key="id"
      class="editable-table point-table"
      @row-dblclick="openDetail"
    >
      <el-table-column label="优化点" min-width="320">
        <template #default="{ row }">
          <div class="point-cell">
            <button
              type="button"
              class="point-name"
              :title="row.name"
              @click="openDetail(row)"
            >
              {{ row.name }}
            </button>
            <p
              class="point-summary"
              :class="{ empty: !row.summary }"
              :title="row.summary"
            >
              {{ row.summary || "暂无问题描述" }}
            </p>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="所属模块" width="140">
        <template #default="{ row }">
          <span v-if="row.module" class="module-text" :title="row.module">
            {{ row.module }}
          </span>
          <span v-else class="muted-placeholder">未填写</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="122">
        <template #default="{ row }">
          <el-tag
            size="small"
            class="enum-tag"
            :class="
              optimizationStatusTone[row.status as OptimizationPointStatus]
            "
          >
            {{
              optimizationPointStatusLabels[
                row.status as OptimizationPointStatus
              ]
            }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="发现时间" width="110">
        <template #default="{ row }">
          <span class="date-text">{{ formatPointDate(row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="更新时间" width="110">
        <template #default="{ row }">
          <span class="date-text">{{ formatPointDate(row.updatedAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="关联正式需求" width="170">
        <template #default="{ row }">
          <button
            v-if="row.requirement?.exists"
            type="button"
            class="requirement-link"
            :title="`${row.requirement.requirementNo} ${row.requirement.name}`"
            @click="openRequirement(row)"
          >
            <span class="link-no">{{ row.requirement.requirementNo }}</span>
            <span class="link-name">{{ row.requirement.name }}</span>
          </button>
          <span v-else-if="row.status === 'converted'" class="stale-link">
            关联需求已删除
          </span>
          <span v-else class="muted-placeholder">未转换</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="208" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button
              link
              type="primary"
              size="small"
              @click="openDetail(row)"
            >
              编辑
            </el-button>
            <el-button
              v-if="canConvert(row)"
              link
              type="primary"
              size="small"
              @click="openConvert(row)"
            >
              转为正式需求
            </el-button>
            <el-button
              link
              type="danger"
              size="small"
              :loading="deletingId === row.id"
              @click="removePoint(row)"
            >
              删除
            </el-button>
          </div>
        </template>
      </el-table-column>
      <template #empty>
        <XlyEmpty
          v-if="hasFilters"
          size="small"
          type="search"
          description="没有找到匹配的优化点"
        >
          <el-button plain @click="clearFilters">清除筛选</el-button>
        </XlyEmpty>
        <XlyEmpty
          v-else
          size="small"
          type="list"
          description="还没有记录优化点"
        >
          <el-button type="primary" plain :icon="PlusIcon" @click="goCreate">
            记录第一个优化点
          </el-button>
        </XlyEmpty>
      </template>
    </el-table>
  </section>
</template>

<style scoped>
.points-toolbar {
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
  flex: 0 1 280px;
  min-width: 180px;
}
.status-filter {
  flex: 0 0 150px;
}
.point-count {
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.toolbar-spacer {
  flex: 1;
}
.points-surface {
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
.point-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.point-name {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-title);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.point-name:hover {
  color: var(--brand);
}
.point-summary {
  margin: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.6;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.point-summary.empty,
.muted-placeholder {
  color: var(--text-faint);
  font-size: 11px;
}
.module-text {
  display: block;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.date-text {
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.requirement-link {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  text-align: left;
}
.link-no {
  color: var(--brand);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.link-name {
  max-width: 100%;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.requirement-link:hover .link-name {
  color: var(--brand);
}
.stale-link {
  color: var(--warning-text);
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
  .points-toolbar {
    flex-wrap: wrap;
  }
  .search-input {
    flex: 1 1 100%;
  }
  .status-filter {
    flex: 1 1 150px;
  }
}
</style>
