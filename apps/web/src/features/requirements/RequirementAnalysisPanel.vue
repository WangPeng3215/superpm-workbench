<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { marked } from "marked";
import {
  type RequirementFile,
  type RequirementFileList,
} from "@superpm/shared";
import { requirementFileApi } from "../../api/requirement-files";
import { errorMessage } from "../../api/client";
import InlineRichTextEditor from "./InlineRichTextEditor.vue";

const props = defineProps<{ requirementId: number }>();
const all = ref(false);
const list = ref<RequirementFileList>();
const opening = ref(false);
const recordHtml = ref("");
const savedHtml = ref("");
const recordText = ref("");
const recordFile = ref<RequirementFile>();
const autoState = ref<"saved" | "pending" | "saving" | "failed">("saved");
const recordEditor = ref<InstanceType<typeof InlineRichTextEditor>>();
let disposed = false;
let restoreDefault = false;
let filesRevision = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveTask: Promise<boolean> | undefined;
const autoLabel = computed(() => {
  if (opening.value) return "正在同步文件…";
  if (autoState.value === "pending") return "有未保存的修改";
  if (autoState.value === "saving") return "保存中…";
  if (autoState.value === "failed") return "保存失败，请重试";
  return "已自动保存到本地文件";
});
const htmlSourcePattern =
  /^\s*<(?:!doctype|h[1-6]|p|ul|ol|li|div|table|pre|blockquote|img)\b/i;
const isMarkdown = (file: RequirementFile) =>
  /\.(md|markdown)$/i.test(file.fileName);
async function loadFiles() {
  const revision = ++filesRevision;
  const requirementId = props.requirementId;
  try {
    const result = await requirementFileApi.list(
      requirementId,
      "analysis",
      all.value,
    );
    if (disposed || revision !== filesRevision) return false;
    list.value = result;
    if (restoreDefault && !opening.value) await loadEditor(result.editorFile);
    return true;
  } catch (error) {
    if (!disposed && revision === filesRevision)
      ElMessage.error(errorMessage(error));
    return false;
  } finally {
    if (revision !== filesRevision) return false;
    return true;
  }
}
function toEditorHtml(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (htmlSourcePattern.test(trimmed)) return trimmed;
  return String(marked.parse(content, { async: false }));
}
function clearSaveTimer() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
}
function clearEditor() {
  clearSaveTimer();
  recordFile.value = undefined;
  recordHtml.value = "";
  savedHtml.value = "";
  recordText.value = "";
  autoState.value = "saved";
}
async function loadEditor(file = list.value?.editorFile) {
  if (disposed || opening.value) return;
  if (!file) {
    clearEditor();
    return;
  }
  if (!isMarkdown(file) || file.id === recordFile.value?.id) return;
  opening.value = true;
  try {
    if (!(await flushEditor()) || disposed) return;
    const result = await requirementFileApi.content(
      file.requirementId,
      file.id,
    );
    if (disposed || file.requirementId !== props.requirementId) return;
    if (!(await flushEditor()) || disposed) return;
    const html = toEditorHtml(result.content);
    recordHtml.value = html;
    savedHtml.value = html;
    recordText.value =
      new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
    autoState.value = "saved";
    recordFile.value = result.file;
    restoreDefault = false;
  } catch (error) {
    if (!disposed) ElMessage.error(errorMessage(error));
  } finally {
    opening.value = false;
  }
}
async function load() {
  if (await loadFiles()) await loadEditor();
}
watch(() => props.requirementId, load, { immediate: true });
watch(recordHtml, (value) => {
  clearSaveTimer();
  if (value === savedHtml.value) {
    if (autoState.value !== "saving") autoState.value = "saved";
    return;
  }
  autoState.value = "pending";
  saveTimer = setTimeout(() => void saveRecord(), 800);
});
async function persistRecord() {
  while (recordFile.value && recordHtml.value !== savedHtml.value) {
    const file = recordFile.value;
    const payload = recordHtml.value;
    autoState.value = "saving";
    try {
      const updated = await requirementFileApi.saveContent(
        file.requirementId,
        file.id,
        payload,
      );
      savedHtml.value = payload;
      recordFile.value.updatedAt = updated.updatedAt;
      autoState.value = payload === recordHtml.value ? "saved" : "pending";
    } catch (error) {
      autoState.value = "failed";
      if (!disposed) ElMessage.error(errorMessage(error));
      return false;
    }
  }
  return true;
}
function saveRecord() {
  clearSaveTimer();
  if (!saveTask) {
    saveTask = persistRecord().finally(() => {
      saveTask = undefined;
    });
  }
  return saveTask;
}
async function flushEditor() {
  await recordEditor.value?.waitForUpload();
  return saveRecord();
}
async function flush() {
  if (opening.value) return false;
  opening.value = true;
  try {
    return await flushEditor();
  } finally {
    opening.value = false;
  }
}
defineExpose({ flush, loadEditor, reloadIfCurrent });
// 右栏删除当前打开文档后回退到默认分析记录（恢复原 restoreDefault 接线）
async function reloadIfCurrent(fileId: number) {
  if (recordFile.value?.id !== fileId) return;
  restoreDefault = true;
  try {
    await load();
  } finally {
    restoreDefault = false;
  }
}
function onRecordHtml(html: string) {
  recordHtml.value = html;
}
function onRecordText(text: string) {
  recordText.value = text;
}
onBeforeUnmount(() => {
  disposed = true;
  filesRevision += 1;
  void saveRecord();
});
</script>
<template>
  <div class="analysis-page" v-loading="opening">
    <section class="md-panel">
      <InlineRichTextEditor
        v-if="recordFile"
        ref="recordEditor"
        :key="recordFile.id"
        :html="recordHtml"
        :requirement-id="requirementId"
        label="需求分析记录内容"
        fill-height
        @update:html="onRecordHtml"
        @update:text="onRecordText"
      />
      <p v-else class="muted">
        从右侧产物区选择文档，或
        <el-button link type="primary" @click="load">重新加载</el-button>
      </p>
      <div class="md-footer">
        <span>{{ recordText.length }} 字符 · {{ autoLabel }}</span>
        <el-button
          v-if="autoState === 'failed'"
          link
          type="primary"
          size="small"
          @click="saveRecord"
          >重试保存</el-button
        >
      </div>
    </section>
  </div>
</template>
<style scoped>
.analysis-page {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.md-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  border: 1px solid var(--border-base);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--bg-surface);
}
.md-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-faint);
  flex: none;
}
</style>
