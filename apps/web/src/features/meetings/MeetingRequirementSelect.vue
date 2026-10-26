<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { SearchOutlined } from "@ant-design/icons-vue";
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
}>();

const SearchIcon = decorative(SearchOutlined);
const options = ref<RequirementOption[]>([]);
const results = ref<RequirementOption[]>([]);
const loading = ref(false);
let requestSeq = 0;
let timer: number | undefined;

function selectedOptions(): RequirementOption[] {
  return props.modelValue.map((item) => ({
    id: item.id,
    requirementNo: item.requirementNo,
    name: item.name,
    depth: 0,
    label: `${item.requirementNo} · ${item.name}`,
  }));
}

// 已选项永远保留在候选里，继续搜索不会让已选标签丢失
function mergeOptions(items: RequirementOption[]) {
  const merged = selectedOptions();
  for (const item of items)
    if (!merged.some((existing) => existing.id === item.id)) merged.push(item);
  options.value = merged;
}

async function load(query: string) {
  const seq = ++requestSeq;
  loading.value = true;
  try {
    const items = await searchRequirementOptions(query);
    if (seq !== requestSeq) return;
    results.value = items;
    mergeOptions(items);
  } catch {
    // 搜索失败时保留现有选项，避免已选需求被清空
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function search(query: string) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void load(query), 250);
}

function onVisibleChange(open: boolean) {
  if (open && !results.value.length) void load("");
}

watch(
  () => props.modelValue,
  () => mergeOptions(results.value),
  { deep: true },
);

const selectedIds = computed({
  get: () => props.modelValue.map((item) => item.id),
  set: (value: number[]) => {
    const lookup = new Map(options.value.map((item) => [item.id, item]));
    const next = value
      .map((id) => {
        const known = props.modelValue.find((item) => item.id === id);
        if (known) return known;
        const option = lookup.get(id);
        return option
          ? {
              id: option.id,
              requirementNo: option.requirementNo,
              name: option.name,
            }
          : null;
      })
      .filter((item): item is MeetingRequirementRef => item !== null);
    emit("update:modelValue", next);
  },
});

onMounted(() => {
  mergeOptions([]);
  void load("");
});
</script>

<template>
  <el-select
    v-model="selectedIds"
    multiple
    filterable
    remote
    clearable
    collapse-tags
    collapse-tags-tooltip
    :max-collapse-tags="3"
    :remote-method="search"
    :loading="loading"
    :disabled="disabled"
    placeholder="搜索需求编号或名称，可多选"
    aria-label="关联需求"
    style="width: 100%"
    @visible-change="onVisibleChange"
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
    >
      <div class="requirement-option">
        <span class="requirement-no">{{ option.requirementNo }}</span>
        <span class="requirement-name">{{ option.name }}</span>
      </div>
    </el-option>
  </el-select>
</template>

<style scoped>
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
</style>
