<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, EditPen, Upload } from "@element-plus/icons-vue";
import { marked } from "marked";
import type {
  FileCategory,
  RequirementFile,
  RequirementFileList,
} from "@superpm/shared";
import { requirementFileApi } from "../../api/requirement-files";
import { errorMessage } from "../../api/client";
import InlineRichTextEditor from "./InlineRichTextEditor.vue";

const props = defineProps<{ requirementId: number }>();
const all = ref(false);
const list = ref<RequirementFileList>();
const loading = ref(false);
const opening = ref(false);
const uploading = ref(false);
const activeCategory = ref<string>("record");
const recordHtml = ref("");
const savedHtml = ref("");
const recordText = ref("");
const recordFile = ref<RequirementFile>();
const autoState = ref<"saved" | "pending" | "saving" | "failed">("saved");
const input = ref<HTMLInputElement>();
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
const groups = computed(() => list.value?.groups ?? []);
const hiddenCount = computed(() =>
  groups.value.reduce(
    (total, group) => total + (group.total - group.files.length),
    0,
  ),
);
const htmlSourcePattern =
  /^\s*<(?:!doctype|h[1-6]|p|ul|ol|li|div|table|pre|blockquote|img)\b/i;
const imageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const isImage = (file: RequirementFile) =>
  imageExtensions.includes(file.name.split(".").pop()?.toLowerCase() ?? "");
const isMarkdown = (file: RequirementFile) =>
  /\.(md|markdown)$/i.test(file.fileName);
async function loadFiles() {
  const revision = ++filesRevision;
  const requirementId = props.requirementId;
  loading.value = true;
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
    if (revision === filesRevision) loading.value = false;
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
watch(all, loadFiles);
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
      for (const group of groups.value) {
        const listedFile = group.files.find((item) => item.id === file.id);
        if (listedFile) listedFile.updatedAt = updated.updatedAt;
      }
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
defineExpose({ flush });
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
async function upload(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  uploading.value = true;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error("文件不能超过 5 MB");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const created = await requirementFileApi.upload(props.requirementId, {
      phase: "analysis",
      category: activeCategory.value as FileCategory,
      name: file.name,
      mime: file.type || "application/octet-stream",
      data,
      isFinal: false,
    });
    // 先关闭「恢复默认文件」，否则列表刷新会把默认记录抢占进编辑器
    restoreDefault = false;
    await loadFiles();
    if (disposed) return;
    if (isMarkdown(created)) await loadEditor(created);
    ElMessage.success(
      isMarkdown(created) ? "文件已上传，已在左侧编辑器中打开" : "文件已上传",
    );
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    uploading.value = false;
    if (input.value) input.value.value = "";
  }
}
async function toggleFinal(file: RequirementFile) {
  try {
    const updated = await requirementFileApi.update(
      file.requirementId,
      file.id,
      {
        isFinal: !file.isFinal,
      },
    );
    if (recordFile.value?.id === file.id)
      recordFile.value.isFinal = updated.isFinal;
    await loadFiles();
    ElMessage.success(file.isFinal ? "已取消确认版本" : "已标记为确认版本");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
async function rename(file: RequirementFile) {
  let value: string;
  try {
    const result = await ElMessageBox.prompt("输入新的文件名称", "重命名文件", {
      inputValue: file.name,
      confirmButtonText: "保存",
      cancelButtonText: "取消",
      inputValidator: (text: string) => Boolean(text.trim()) || "名称不能为空",
    });
    value = result.value.trim();
  } catch {
    return;
  }
  try {
    const updated = await requirementFileApi.update(
      file.requirementId,
      file.id,
      {
        name: value,
      },
    );
    if (recordFile.value?.id === file.id) recordFile.value.name = updated.name;
    await loadFiles();
    ElMessage.success("文件已重命名");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
async function removeFile(file: RequirementFile) {
  if (opening.value) return;
  try {
    await ElMessageBox.confirm(`确定删除「${file.name}」吗？`, "删除文件", {
      confirmButtonText: "确认删除",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  if (disposed || opening.value) return;
  opening.value = true;
  let removedCurrent = false;
  let refreshed = false;
  try {
    if (file.id === recordFile.value?.id && !(await flushEditor())) return;
    await requirementFileApi.remove(file.requirementId, file.id);
    if (disposed) return;
    removedCurrent = recordFile.value?.id === file.id;
    if (removedCurrent) {
      clearEditor();
      restoreDefault = true;
    }
    for (const group of groups.value) {
      const remaining = group.files.filter((item) => item.id !== file.id);
      group.total -= group.files.length - remaining.length;
      group.files = remaining;
    }
    if (list.value?.editorFile?.id === file.id) list.value.editorFile = null;
    refreshed = await loadFiles();
    ElMessage.success("文件已删除");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    opening.value = false;
  }
  if (removedCurrent && refreshed) await loadEditor();
}
</script>
<template>
  <div class="analysis-page" v-loading="loading">
    <section class="md-panel" v-loading="opening" :inert="opening">
      <header class="panel-head">
        <h3>需求分析记录</h3>
        <span v-if="recordFile" class="current-file"
          >当前文件：{{ recordFile.name }}</span
        >
      </header>
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
        请选择文件，或
        <el-button link type="primary" @click="load">重新加载文件</el-button>
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
    <section class="files-panel">
      <header class="panel-head">
        <h3>分析产物文件夹</h3>
        <div class="files-actions">
          <span class="switch-label">展示全部文件</span>
          <el-switch v-model="all" :disabled="opening" />
          <el-button
            size="small"
            :icon="Upload"
            :loading="uploading"
            :disabled="opening"
            @click="input?.click()"
            >上传文件</el-button
          >
          <input ref="input" hidden type="file" @change="upload" />
        </div>
      </header>
      <p v-if="!all && hiddenCount" class="files-hint">
        已隐藏
        {{ hiddenCount }}
        个非确认版本文件，打开「展示全部文件」可查看草稿与历史版本。
      </p>
      <el-tabs v-model="activeCategory">
        <el-tab-pane
          v-for="group in groups"
          :key="group.category"
          :name="group.category"
        >
          <template #label>
            {{ group.label }}
            <span class="tab-count">{{ group.files.length }}</span>
          </template>
          <p v-if="!group.files.length" class="muted">
            该分类下暂无{{
              all ? "" : "确认版本"
            }}文件，可上传文件后标记为确认版本。
          </p>
          <div v-else class="file-list">
            <div
              v-for="file in group.files"
              :key="file.id"
              class="file-row"
              :class="{ 'is-selected': recordFile?.id === file.id }"
            >
              <img
                v-if="isImage(file)"
                class="file-thumb"
                :src="requirementFileApi.rawUrl(requirementId, file.id)"
                :alt="file.name"
              />
              <div class="file-main">
                <button
                  v-if="isMarkdown(file)"
                  type="button"
                  class="file-name file-open"
                  :aria-pressed="recordFile?.id === file.id"
                  :disabled="opening"
                  title="在左侧编辑器中打开"
                  @click="loadEditor(file)"
                >
                  {{ file.name }}
                </button>
                <strong v-else class="file-name">{{ file.name }}</strong>
                <span class="file-meta"
                  >更新于
                  {{ new Date(file.updatedAt).toLocaleString("zh-CN") }}</span
                >
              </div>
              <el-tag
                v-if="file.isFinal"
                size="small"
                type="success"
                effect="plain"
                >确认版本</el-tag
              >
              <el-tag v-else size="small" type="info" effect="plain"
                >草稿 / 历史</el-tag
              >
              <div class="file-actions">
                <a
                  v-if="!isMarkdown(file)"
                  class="file-link"
                  :href="requirementFileApi.rawUrl(requirementId, file.id)"
                  target="_blank"
                  rel="noreferrer"
                  >预览</a
                >
                <el-button
                  link
                  type="primary"
                  size="small"
                  :disabled="opening"
                  @click="toggleFinal(file)"
                  >{{ file.isFinal ? "取消确认" : "标记确认" }}</el-button
                >
                <el-button
                  link
                  type="primary"
                  size="small"
                  :icon="EditPen"
                  :disabled="opening"
                  @click="rename(file)"
                  >重命名</el-button
                >
                <el-button
                  link
                  type="danger"
                  size="small"
                  :icon="Delete"
                  :disabled="opening"
                  @click="removeFile(file)"
                  >删除</el-button
                >
              </div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </section>
  </div>
</template>
<style scoped>
.analysis-page {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.md-panel,
.files-panel {
  border: 1px solid var(--border-base);
  border-radius: 8px;
  padding: 16px 18px;
  background: var(--bg-surface);
}
.md-panel {
  display: flex;
  flex-direction: column;
}
.md-panel .panel-head {
  flex: none;
}
.md-panel .md-footer {
  flex: none;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.panel-head h3 {
  margin: 0;
  font-size: 14px;
  color: var(--text-title);
}
.current-file {
  max-width: 100%;
  overflow-wrap: anywhere;
  font-size: 12px;
  color: var(--text-muted);
}
.files-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.switch-label {
  font-size: 12px;
  color: var(--text-muted);
}
.md-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-faint);
}
.files-hint {
  font-size: 12px;
  color: var(--tone-amber-fg);
  background: var(--tone-amber-bg);
  border: 1px solid var(--tone-amber-bd);
  border-radius: 6px;
  padding: 8px 12px;
  margin: 0 0 12px;
  line-height: 1.7;
}
.tab-count {
  margin-left: 4px;
  font-size: 11px;
  color: var(--text-faint);
}
.file-list {
  display: grid;
  gap: 8px;
}
.file-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  background: var(--bg-subtle);
}
.file-row.is-selected {
  border-color: var(--border-brand);
  background: var(--bg-selected);
}
.file-thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid var(--border-base);
  flex: none;
}
.file-main {
  display: grid;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.file-name {
  font-size: 13px;
  color: var(--text-title);
  overflow-wrap: anywhere;
}
.file-open {
  justify-self: start;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-weight: 600;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}
.file-open:hover,
.file-open[aria-pressed="true"] {
  color: var(--brand);
}
.file-open:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 3px;
  border-radius: 2px;
}
.file-open:disabled {
  cursor: wait;
  opacity: 0.6;
}
.file-meta {
  font-size: 11px;
  color: var(--text-faint);
}
.file-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.file-link {
  font-size: 12px;
  color: var(--brand);
  text-decoration: none;
  padding: 0 6px;
}
.file-link:hover {
  text-decoration: underline;
}
@media (max-width: 1100px) {
  .analysis-page {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
