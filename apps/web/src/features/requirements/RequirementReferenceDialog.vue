<script setup lang="ts">
import { ref, watch } from "vue";
import { SearchOutlined } from "@ant-design/icons-vue";
import { errorMessage } from "../../api/client";
import { decorative } from "../../components/decorativeIcon";
import XlyEmpty from "../../components/ease-ui/xly-empty/index.vue";
import {
  searchRequirementOptions,
  type RequirementOption,
} from "./requirement-options";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  select: [option: RequirementOption];
}>();

const SearchIcon = decorative(SearchOutlined);
const keyword = ref("");
const options = ref<RequirementOption[]>([]);
const loading = ref(false);
const loadError = ref("");
const inputRef = ref<{ focus: () => void }>();
let requestSeq = 0;
let timer: number | undefined;

async function load(query = "") {
  const seq = ++requestSeq;
  loading.value = true;
  loadError.value = "";
  try {
    const items = await searchRequirementOptions(query);
    if (seq === requestSeq) options.value = items;
  } catch (error) {
    if (seq === requestSeq) loadError.value = errorMessage(error);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function search(query: string) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void load(query), 250);
}

function open() {
  keyword.value = "";
  options.value = [];
  void load();
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) open();
  },
);

function choose(option: RequirementOption) {
  emit("select", option);
  emit("update:modelValue", false);
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="插入需求引用"
    width="min(560px, 92vw)"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
    @opened="inputRef?.focus()"
  >
    <el-input
      ref="inputRef"
      v-model="keyword"
      clearable
      placeholder="搜索需求编号或名称"
      aria-label="搜索需求编号或名称"
      :prefix-icon="SearchIcon"
      @input="search"
    />
    <div v-loading="loading" class="reference-results">
      <el-alert
        v-if="loadError"
        :title="loadError"
        type="error"
        :closable="false"
        show-icon
      />
      <button
        v-for="option in options"
        :key="option.id"
        type="button"
        class="reference-option"
        @click="choose(option)"
      >
        <span class="reference-no">{{ option.requirementNo }}</span>
        <span class="reference-name">{{ option.name }}</span>
      </button>
      <XlyEmpty
        v-if="!loading && !loadError && !options.length"
        size="small"
        type="search"
        description="没有找到匹配的需求"
      />
    </div>
  </el-dialog>
</template>

<style scoped>
.reference-results {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 160px;
  max-height: 340px;
  margin-top: 12px;
  overflow: auto;
}
.reference-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard);
}
.reference-option:hover {
  border-color: var(--border-brand);
  background: var(--bg-brand-soft);
}
.reference-option:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}
.reference-no {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.reference-name {
  overflow: hidden;
  color: var(--text-title);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
