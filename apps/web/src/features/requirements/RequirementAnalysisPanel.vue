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
const uploading = ref(false);
const activeCategory = ref<string>("record");
const recordHtml = ref("");
const savedHtml = ref("");
const recordText = ref("");
const recordFileId = ref<number>();
const autoState = ref<"saved" | "pending" | "saving" | "failed">("saved");
const input = ref<HTMLInputElement>();
const autoLabel = computed(() => {
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
const imageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const isImage = (file: RequirementFile) =>
  imageExtensions.includes(file.name.split(".").pop()?.toLowerCase() ?? "");
async function loadFiles() {
  loading.value = true;
  try {
    list.value = await requirementFileApi.list(
      props.requirementId,
      "analysis",
      all.value,
    );
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}
function toEditorHtml(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<")) return trimmed;
  return String(marked.parse(content, { async: false }));
}
async function loadEditor() {
  const file = list.value?.editorFile;
  if (!file) {
    recordFileId.value = undefined;
    recordHtml.value = "";
    savedHtml.value = "";
    recordText.value = "";
    return;
  }
  try {
    const result = await requirementFileApi.content(
      props.requirementId,
      file.id,
    );
    const html = toEditorHtml(result.content);
    recordHtml.value = html;
    savedHtml.value = html;
    recordText.value = "";
    autoState.value = "saved";
    recordFileId.value = file.id;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
async function load() {
  await loadFiles();
  await loadEditor();
}
watch(() => props.requirementId, load, { immediate: true });
watch(all, loadFiles);
let saveTimer: ReturnType<typeof setTimeout> | undefined;
watch(recordHtml, (value) => {
  if (value === savedHtml.value) return;
  autoState.value = "pending";
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveRecord, 800);
});
async function saveRecord() {
  const fileId = recordFileId.value;
  const payload = recordHtml.value;
  if (!fileId || payload === savedHtml.value) return;
  autoState.value = "saving";
  try {
    await requirementFileApi.saveContent(
      props.requirementId,
      fileId,
      payload,
    );
    savedHtml.value = payload;
    autoState.value = payload === recordHtml.value ? "saved" : "pending";
  } catch (error) {
    autoState.value = "failed";
    ElMessage.error(errorMessage(error));
  }
}
function onRecordHtml(html: string) {
  recordHtml.value = html;
}
function onRecordText(text: string) {
  recordText.value = text;
}
onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer);
  const fileId = recordFileId.value;
  if (!fileId || recordHtml.value === savedHtml.value) return;
  requirementFileApi
    .saveContent(props.requirementId, fileId, recordHtml.value)
    .catch(() => undefined);
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
    await requirementFileApi.upload(props.requirementId, {
      phase: "analysis",
      category: activeCategory.value as FileCategory,
      name: file.name,
      mime: file.type || "application/octet-stream",
      data,
      isFinal: false,
    });
    await loadFiles();
    ElMessage.success("文件已上传");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    uploading.value = false;
    if (input.value) input.value.value = "";
  }
}
async function toggleFinal(file: RequirementFile) {
  try {
    await requirementFileApi.update(props.requirementId, file.id, {
      isFinal: !file.isFinal,
    });
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
    await requirementFileApi.update(props.requirementId, file.id, {
      name: value,
    });
    await loadFiles();
    ElMessage.success("文件已重命名");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
async function removeFile(file: RequirementFile) {
  try {
    await ElMessageBox.confirm(`确定删除「${file.name}」吗？`, "删除文件", {
      confirmButtonText: "确认删除",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  try {
    await requirementFileApi.remove(props.requirementId, file.id);
    await loadFiles();
    ElMessage.success("文件已删除");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
</script>
<template>
  <div class="analysis-page" v-loading="loading">
    <section class="md-panel">
      <header class="panel-head">
        <h3>需求分析记录</h3>
      </header>
      <InlineRichTextEditor
        v-if="recordFileId"
        :html="recordHtml"
        :requirement-id="requirementId"
        label="需求分析记录内容"
        @update:html="onRecordHtml"
        @update:text="onRecordText"
      />
      <p v-else class="muted">尚未创建分析记录文件。</p>
      <div class="md-footer">
        <span>{{ recordText.length }} 字符 · {{ autoLabel }}</span>
      </div>
    </section>
    <section class="files-panel">
      <header class="panel-head">
        <h3>分析产物文件夹</h3>
        <div class="files-actions">
          <span class="switch-label">展示全部文件</span>
          <el-switch v-model="all" />
          <el-button
            size="small"
            :icon="Upload"
            :loading="uploading"
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
            <div v-for="file in group.files" :key="file.id" class="file-row">
              <img
                v-if="isImage(file)"
                class="file-thumb"
                :src="requirementFileApi.rawUrl(requirementId, file.id)"
                :alt="file.name"
              />
              <div class="file-main">
                <strong class="file-name">{{ file.name }}</strong>
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
                  @click="toggleFinal(file)"
                  >{{ file.isFinal ? "取消确认" : "标记确认" }}</el-button
                >
                <el-button
                  link
                  type="primary"
                  size="small"
                  :icon="EditPen"
                  @click="rename(file)"
                  >重命名</el-button
                >
                <el-button
                  link
                  type="danger"
                  size="small"
                  :icon="Delete"
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
  border: 1px solid #e7ebf1;
  border-radius: 8px;
  padding: 16px 18px;
  background: #fff;
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
  color: #344761;
}
.files-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.switch-label {
  font-size: 12px;
  color: #7a879b;
}
.md-footer {
  margin-top: 10px;
  font-size: 11px;
  color: #99a7bd;
}
.files-hint {
  font-size: 12px;
  color: #a1864f;
  background: #fdf8ec;
  border: 1px solid #f3e6c8;
  border-radius: 6px;
  padding: 8px 12px;
  margin: 0 0 12px;
  line-height: 1.7;
}
.tab-count {
  margin-left: 4px;
  font-size: 11px;
  color: #98a5b8;
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
  border: 1px solid #eef1f6;
  border-radius: 6px;
  background: #fbfcfe;
}
.file-thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid #e3e9f1;
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
  color: #3b4d67;
  overflow-wrap: anywhere;
}
.file-meta {
  font-size: 11px;
  color: #9aa8bd;
}
.file-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.file-link {
  font-size: 12px;
  color: #4e6ef2;
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
