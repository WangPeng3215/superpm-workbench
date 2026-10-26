<script setup lang="ts">
import { nextTick, ref } from "vue";
import {
  noteColorLabels,
  noteColors,
  noteTypeLabels,
  noteTypes,
  type Note,
  type NoteColor,
  type NoteType,
} from "@superpm/shared";
import { errorMessage } from "../../api/client";
import { noteApi } from "../../api/notes";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  (event: "update:visible", value: boolean): void;
  (event: "created", note: Note): void;
}>();

const title = ref("");
const content = ref("");
const type = ref<NoteType>("inspiration");
const color = ref<NoteColor>("yellow");
const saving = ref(false);
const error = ref("");
const contentEl = ref<HTMLTextAreaElement>();

function close() {
  if (saving.value) return;
  emit("update:visible", false);
}

function reset() {
  title.value = "";
  content.value = "";
  type.value = "inspiration";
  color.value = "yellow";
  error.value = "";
}

function onClosed() {
  reset();
}

function onOpened() {
  void nextTick(() => contentEl.value?.focus());
}

async function submit() {
  if (saving.value) return;
  if (!title.value.trim() && !content.value.trim()) {
    error.value = "请输入便签标题或内容";
    void nextTick(() => contentEl.value?.focus());
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    const note = await noteApi.create({
      title: title.value,
      content: content.value,
      type: type.value,
      color: color.value,
    });
    emit("created", note);
    emit("update:visible", false);
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="props.visible"
    title="新建便签"
    width="480px"
    class="note-quick-dialog"
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    append-to-body
    @update:model-value="(value: boolean) => emit('update:visible', value)"
    @opened="onOpened"
    @closed="onClosed"
  >
    <div class="quick-field">
      <input
        v-model="title"
        class="quick-title"
        type="text"
        maxlength="120"
        placeholder="标题（可选）"
        aria-label="便签标题"
        :disabled="saving"
      />
      <textarea
        ref="contentEl"
        v-model="content"
        class="quick-content"
        rows="6"
        maxlength="20000"
        placeholder="记录灵感、待办或会议要点…"
        aria-label="便签内容"
        :disabled="saving"
        @keydown.meta.enter.prevent="submit"
        @keydown.ctrl.enter.prevent="submit"
      />
    </div>

    <div class="quick-options">
      <div class="option-group" role="group" aria-label="便签类型">
        <button
          v-for="value in noteTypes"
          :key="value"
          type="button"
          class="type-option"
          :class="{ active: type === value }"
          :aria-pressed="type === value"
          :disabled="saving"
          @click="type = value"
        >
          {{ noteTypeLabels[value] }}
        </button>
      </div>
      <div class="color-options" role="group" aria-label="便签颜色">
        <button
          v-for="value in noteColors"
          :key="value"
          type="button"
          class="quick-swatch"
          :class="[`color-${value}`, { active: color === value }]"
          :aria-label="noteColorLabels[value]"
          :title="noteColorLabels[value]"
          :disabled="saving"
          @click="color = value"
        />
      </div>
    </div>

    <p v-if="error" class="quick-error">{{ error }}</p>
    <p class="quick-hint">创建后可在「便签」中继续编辑与转任务</p>

    <template #footer>
      <el-button :disabled="saving" @click="close">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">
        创建便签
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.quick-field {
  overflow: hidden;
  border: 1px solid var(--border-base);
  border-radius: 10px;
  background: var(--bg-subtle);
}
.quick-title {
  width: 100%;
  padding: 11px 13px 6px;
  border: 0;
  background: transparent;
  color: var(--text-title);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  outline: none;
}
.quick-title::placeholder {
  color: var(--text-faint);
  font-weight: 500;
}
.quick-content {
  display: block;
  width: 100%;
  min-height: 132px;
  max-height: 260px;
  padding: 4px 13px 12px;
  border: 0;
  background: transparent;
  color: var(--text-body);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.7;
  outline: none;
  overflow-y: auto;
  resize: vertical;
}
.quick-content::placeholder {
  color: var(--text-faint);
}
.quick-field:focus-within {
  border-color: var(--border-brand);
  box-shadow: 0 0 0 2px var(--brand-ring);
}
.quick-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}
.option-group {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: var(--bg-subtle);
}
.type-option {
  padding: 4px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition:
    background 140ms var(--ease-standard),
    color 140ms var(--ease-standard);
}
.type-option.active {
  background: var(--bg-surface);
  color: var(--text-title);
  box-shadow: var(--shadow-sm);
  font-weight: 600;
}
.color-options {
  display: flex;
  gap: 7px;
}
.quick-swatch {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid rgb(0 0 0 / 12%);
  border-radius: 50%;
  background: #f5dd86;
  cursor: pointer;
  transition:
    transform 140ms var(--ease-standard),
    box-shadow 140ms var(--ease-standard);
}
.quick-swatch.color-yellow {
  background: #f5dd86;
}
.quick-swatch.color-pink {
  background: #f2b6c8;
}
.quick-swatch.color-blue {
  background: #b8cdf0;
}
.quick-swatch.color-green {
  background: #b7dfc6;
}
.quick-swatch.color-purple {
  background: #cfbdee;
}
.quick-swatch.color-slate {
  background: #cbd5e1;
}
.quick-swatch:hover:not(:disabled) {
  transform: scale(1.12);
}
.quick-swatch.active {
  box-shadow:
    0 0 0 2px var(--bg-surface),
    0 0 0 3.5px var(--brand);
}
.quick-error {
  margin: 9px 0 0;
  color: var(--danger-text);
  font-size: 11px;
}
.quick-hint {
  margin: 10px 0 0;
  color: var(--text-faint);
  font-size: 10px;
}
</style>
