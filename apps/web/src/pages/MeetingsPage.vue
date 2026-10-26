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
  meetingTypeLabels,
  meetingTypes,
  type MeetingSummary,
  type MeetingType,
} from "@superpm/shared";
import { meetingApi } from "../api/meetings";
import { errorMessage } from "../api/client";
import { decorative } from "../components/decorativeIcon";
import XlyEmpty from "../components/ease-ui/xly-empty/index.vue";
import { meetingTimeParts, meetingTypeTone } from "../features/meetings/format";

const SearchIcon = decorative(SearchOutlined);
const PlusIcon = decorative(PlusOutlined);
const ReloadIcon = decorative(ReloadOutlined);

const router = useRouter();
const meetings = ref<MeetingSummary[]>([]);
const loading = ref(false);
const loadError = ref("");
const keyword = ref("");
const type = ref<MeetingType | "">("");
const deletingId = ref<number | null>(null);
let requestSeq = 0;
let searchTimer: number | undefined;

const hasFilters = computed(
  () => Boolean(keyword.value.trim()) || Boolean(type.value),
);

async function load() {
  const seq = ++requestSeq;
  loading.value = true;
  loadError.value = "";
  try {
    const items = await meetingApi.list({
      q: keyword.value.trim() || undefined,
      type: type.value || undefined,
    });
    if (seq === requestSeq) meetings.value = items;
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
  type.value = "";
  void load();
}

function openCreate() {
  void router.push("/meetings/new");
}

function openDetail(row: MeetingSummary) {
  void router.push(`/meetings/${row.id}`);
}

function openEdit(row: MeetingSummary) {
  void router.push(`/meetings/${row.id}?edit=1`);
}

async function removeMeeting(row: MeetingSummary) {
  if (deletingId.value !== null) return;
  try {
    await ElMessageBox.confirm(
      "删除后，会议记录及其与需求的关联将一并移除。此操作不可撤销。",
      "删除会议记录",
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
    await meetingApi.remove(row.id);
    ElMessage.success("会议记录已删除");
    await load();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    deletingId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="meetings-toolbar">
    <el-input
      v-model="keyword"
      clearable
      class="search-input"
      placeholder="搜索会议标题"
      aria-label="搜索会议标题"
      :prefix-icon="SearchIcon"
      @input="search"
      @keyup.enter="load"
    />
    <el-select
      v-model="type"
      clearable
      class="type-filter"
      placeholder="全部类型"
      aria-label="按会议类型筛选"
      @change="load"
    >
      <el-option
        v-for="value in meetingTypes"
        :key="value"
        :label="meetingTypeLabels[value]"
        :value="value"
      >
        <el-tag size="small" class="enum-tag" :class="meetingTypeTone[value]">
          {{ meetingTypeLabels[value] }}
        </el-tag>
      </el-option>
    </el-select>
    <span class="meeting-count">
      {{
        hasFilters ? `${meetings.length} 场匹配` : `${meetings.length} 场会议`
      }}
    </span>
    <span class="toolbar-spacer" />
    <el-button text :icon="ReloadIcon" :loading="loading" @click="load">
      刷新
    </el-button>
    <el-button type="primary" :icon="PlusIcon" @click="openCreate">
      新建会议
    </el-button>
  </div>

  <section class="surface meetings-surface">
    <div v-if="loadError" class="load-error">
      <el-alert :title="loadError" type="error" :closable="false" show-icon />
      <el-button size="small" @click="load">重新加载</el-button>
    </div>
    <el-table
      v-loading="loading"
      :data="meetings"
      row-key="id"
      class="editable-table meeting-table"
      @row-dblclick="openDetail"
    >
      <el-table-column label="会议" min-width="320">
        <template #default="{ row }">
          <div class="meeting-cell">
            <button
              type="button"
              class="meeting-title"
              :title="row.title"
              @click="openDetail(row)"
            >
              {{ row.title }}
            </button>
            <p
              class="meeting-summary"
              :class="{ empty: !row.summary }"
              :title="row.summary"
            >
              {{ row.summary || "暂无内容摘要" }}
            </p>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="126">
        <template #default="{ row }">
          <el-tag
            size="small"
            class="enum-tag"
            :class="meetingTypeTone[row.type as MeetingType]"
          >
            {{ meetingTypeLabels[row.type as MeetingType] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="会议时间" width="150">
        <template #default="{ row }">
          <div class="time-cell">
            <span>{{ meetingTimeParts(row.meetingTime).date }}</span>
            <span class="time-detail">
              {{ meetingTimeParts(row.meetingTime).weekday }}
              {{ meetingTimeParts(row.meetingTime).time }}
            </span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="关联需求" width="118" align="center">
        <template #default="{ row }">
          <el-popover
            v-if="row.requirements.length"
            placement="top"
            :width="320"
            trigger="hover"
          >
            <template #reference>
              <button type="button" class="requirement-count">
                {{ row.requirementCount }} 个
              </button>
            </template>
            <ul class="requirement-popover">
              <li v-for="item in row.requirements" :key="item.id">
                <span class="popover-no">{{ item.requirementNo }}</span>
                <span class="popover-name">{{ item.name }}</span>
              </li>
            </ul>
          </el-popover>
          <span v-else class="no-requirement">未关联</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="154" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button
              link
              type="primary"
              size="small"
              @click="openDetail(row)"
            >
              查看
            </el-button>
            <el-button link type="primary" size="small" @click="openEdit(row)">
              编辑
            </el-button>
            <el-button
              link
              type="danger"
              size="small"
              :loading="deletingId === row.id"
              @click="removeMeeting(row)"
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
          description="没有找到匹配的会议记录"
        >
          <el-button plain @click="clearFilters">清除筛选</el-button>
        </XlyEmpty>
        <XlyEmpty v-else size="small" type="list" description="还没有会议记录">
          <el-button type="primary" plain :icon="PlusIcon" @click="openCreate">
            创建第一场会议
          </el-button>
        </XlyEmpty>
      </template>
    </el-table>
  </section>
</template>

<style scoped>
.meetings-toolbar {
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
.type-filter {
  flex: 0 0 148px;
}
.meeting-count {
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.toolbar-spacer {
  flex: 1;
}
.meetings-surface {
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
.meeting-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.meeting-title {
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
.meeting-title:hover {
  color: var(--brand);
}
.meeting-summary {
  margin: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.6;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meeting-summary.empty {
  color: var(--text-faint);
}
.time-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.time-detail {
  color: var(--text-muted);
  font-size: 11px;
}
.requirement-count {
  padding: 2px 9px;
  border: 1px solid var(--border-brand);
  border-radius: 99px;
  background: var(--bg-brand-soft);
  color: var(--brand);
  font-size: 11px;
  cursor: pointer;
}
.requirement-count:hover {
  border-color: var(--brand);
}
.no-requirement {
  color: var(--text-faint);
  font-size: 11px;
}
.requirement-popover {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}
.requirement-popover li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}
.popover-no {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.popover-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  .meetings-toolbar {
    flex-wrap: wrap;
  }
  .search-input {
    flex: 1 1 100%;
  }
  .type-filter {
    flex: 1 1 148px;
  }
}
</style>
