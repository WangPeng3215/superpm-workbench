<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { CloseOutlined, SearchOutlined } from "@ant-design/icons-vue";
import type { MeetingRequirementRef } from "@superpm/shared";
import { decorative } from "../../components/decorativeIcon";
import {
  searchRequirementOptions,
  type RequirementOption,
} from "../requirements/requirement-options";

const props = defineProps<{
  modelValue: MeetingRequirementRef[];
  disabled?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: MeetingRequirementRef[]];
  "open-requirement": [id: number];
}>();

const SearchIcon = decorative(SearchOutlined);
const options = ref<RequirementOption[]>([]);
const loading = ref(false);
const pickedId = ref<number>();
let requestSeq = 0;
let timer: number | undefined;

const selectedIds = computed(
  () => new Set(props.modelValue.map((item) => item.id)),
);

async function load(query: string) {
  const seq = ++requestSeq;
  loading.value = true;
  try {
    const items = await searchRequirementOptions(query);
    if (seq !== requestSeq) return;
    options.value = items;
  } catch {
    // 搜索失败时保留现有选项，避免列表闪空
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function search(query: string) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void load(query), 250);
}

function onVisibleChange(open: boolean) {
  if (open) void load("");
}

// 搜索框只负责检索：选中即加入下方列表并清空，不在框内保留标签
function addRequirement(id?: number) {
  const option =
    id === undefined ? undefined : options.value.find((item) => item.id === id);
  if (option && !selectedIds.value.has(option.id)) {
    emit("update:modelValue", [
      ...props.modelValue,
      {
        id: option.id,
        requirementNo: option.requirementNo,
        name: option.name,
      },
    ]);
  }
  pickedId.value = undefined;
}

function removeRequirement(id: number) {
  emit(
    "update:modelValue",
    props.modelValue.filter((item) => item.id !== id),
  );
}

onMounted(() => void load(""));
</script>

<template>
  <div class="requirement-picker">
    <el-select
      v-model="pickedId"
      filterable
      remote
      :remote-method="search"
      :loading="loading"
      :disabled="disabled"
      placeholder="搜索需求编号或名称，点击结果添加"
      aria-label="搜索需求"
      style="width: 100%"
      @visible-change="onVisibleChange"
      @change="addRequirement"
    >
      <template #prefix>
        <el-icon class="select-search" aria-hidden="true">
          <component :is="SearchIcon" />
        </el-icon>
      </template>
      <el-option
        v-for="option in options"
        :key="option.id"
        :label="option.label"
        :value="option.id"
        :disabled="selectedIds.has(option.id)"
      >
        <div class="requirement-option">
          <span class="requirement-no">{{ option.requirementNo }}</span>
          <span class="requirement-name">{{ option.name }}</span>
          <span v-if="selectedIds.has(option.id)" class="requirement-added">
            已添加
          </span>
        </div>
      </el-option>
      <template #empty>
        <p class="requirements-empty">没有匹配的需求</p>
      </template>
    </el-select>

    <div v-if="modelValue.length" class="selected-list">
      <div
        v-for="item in modelValue"
        :key="item.id"
        class="selected-row"
        :title="`${item.requirementNo} ${item.name}`"
      >
        <button
          type="button"
          class="selected-open"
          :aria-label="`打开需求 ${item.requirementNo}`"
          @click="emit('open-requirement', item.id)"
        >
          <span class="selected-no">{{ item.requirementNo }}</span>
          <span class="selected-name">{{ item.name }}</span>
        </button>
        <button
          type="button"
          class="selected-remove"
          :disabled="disabled"
          :aria-label="`移除关联 ${item.requirementNo}`"
          title="移除关联"
          @click="removeRequirement(item.id)"
        >
          <el-icon aria-hidden="true"><CloseOutlined /></el-icon>
        </button>
      </div>
    </div>
    <p v-else class="selected-empty">尚未关联需求。</p>
  </div>
</template>

<style scoped>
.requirement-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.select-search {
  color: var(--text-faint);
}
.requirement-option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.requirement-no {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.requirement-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.requirement-added {
  flex: none;
  margin-left: auto;
  color: var(--text-faint);
  font-size: 10px;
}
.requirements-empty {
  margin: 0;
  padding: 8px 0;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}
.selected-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.selected-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-regular);
  font-size: 12px;
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard);
}
.selected-row:hover {
  border-color: var(--border-brand);
  background: var(--bg-brand-soft);
}
.selected-open {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.selected-open:hover .selected-name {
  color: var(--brand);
}
.selected-no {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.selected-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selected-remove {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}
.selected-remove:hover:not(:disabled) {
  background: var(--tone-red-bg);
  color: var(--tone-red-fg);
}
.selected-remove:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.selected-empty {
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
}
</style>
