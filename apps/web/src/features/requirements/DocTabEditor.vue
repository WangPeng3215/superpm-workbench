<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { marked } from "marked";
import type { ArtifactNode } from "@superpm/shared";
import { artifactApi } from "../../api/artifacts";
import { ApiError, errorMessage } from "../../api/client";
import InlineRichTextEditor from "./InlineRichTextEditor.vue";

// 文档动态页签的编辑器：一个页签对应一个文件（含需求记忆），按 nodeId 读写知识库并自动保存
const props = defineProps<{ requirementId: number; node: ArtifactNode }>();
const opening = ref(true);
const ready = ref(false);
const loadError = ref("");
const html = ref("");
const savedHtml = ref("");
const text = ref("");
const current = ref<ArtifactNode>(props.node);
const autoState = ref<"saved" | "pending" | "saving" | "failed">("saved");
const editor = ref<InstanceType<typeof InlineRichTextEditor>>();
let disposed = false;
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
// 加载文件内容（页签创建时执行一次，失败时页签内展示错误）
async function load() {
  const nodeId = props.node.id;
  opening.value = true;
  loadError.value = "";
  try {
    const result = await artifactApi.content(nodeId);
    if (disposed || nodeId !== props.node.id) return;
    const next = toEditorHtml(result.content);
    html.value = next;
    savedHtml.value = next;
    text.value =
      new DOMParser().parseFromString(next, "text/html").body.textContent ?? "";
    current.value = result.node;
    autoState.value = "saved";
    ready.value = true;
  } catch (error) {
    if (!disposed) {
      loadError.value = errorMessage(error);
      ElMessage.error(loadError.value);
    }
  } finally {
    if (!disposed) opening.value = false;
  }
}
void load();
watch(html, (value) => {
  clearSaveTimer();
  if (value === savedHtml.value) {
    if (autoState.value !== "saving") autoState.value = "saved";
    return;
  }
  autoState.value = "pending";
  saveTimer = setTimeout(() => void saveNow(), 800);
});
async function persist() {
  while (current.value && html.value !== savedHtml.value) {
    const node = current.value;
    const payload = html.value;
    autoState.value = "saving";
    try {
      const updated = await artifactApi.saveContent(node.id, payload);
      savedHtml.value = payload;
      current.value = { ...node, updatedAt: updated.updatedAt };
      autoState.value = payload === html.value ? "saved" : "pending";
    } catch (error) {
      // 外部修改冲突：不静默覆盖，由用户确认后强制保存
      if (error instanceof ApiError && error.code === "FILE_CONFLICT") {
        try {
          await ElMessageBox.confirm(
            `${errorMessage(error)}是否覆盖保存？`,
            "文件已被外部修改",
            {
              confirmButtonText: "覆盖保存",
              cancelButtonText: "暂不保存",
              type: "warning",
            },
          );
        } catch {
          autoState.value = "failed";
          return false;
        }
        try {
          const updated = await artifactApi.saveContent(node.id, payload, true);
          savedHtml.value = payload;
          current.value = { ...node, updatedAt: updated.updatedAt };
          autoState.value = payload === html.value ? "saved" : "pending";
        } catch (retryError) {
          autoState.value = "failed";
          if (!disposed) ElMessage.error(errorMessage(retryError));
          return false;
        }
      } else {
        autoState.value = "failed";
        if (!disposed) ElMessage.error(errorMessage(error));
        return false;
      }
    }
  }
  return true;
}
function saveNow() {
  clearSaveTimer();
  if (!saveTask) {
    saveTask = persist().finally(() => {
      saveTask = undefined;
    });
  }
  return saveTask;
}
// 冲刷未保存内容：等待图片上传结束后交由自动保存通道落盘
async function flush() {
  if (opening.value) return false;
  opening.value = true;
  try {
    await editor.value?.waitForUpload();
    return saveNow();
  } finally {
    opening.value = false;
  }
}
defineExpose({ flush });
function onHtml(value: string) {
  html.value = value;
}
function onText(value: string) {
  text.value = value;
}
onBeforeUnmount(() => {
  disposed = true;
  void saveNow();
});
</script>
<template>
  <div class="analysis-page" v-loading="opening">
    <section class="md-panel">
      <InlineRichTextEditor
        v-if="ready"
        ref="editor"
        :key="current.id"
        :html="html"
        :requirement-id="requirementId"
        label="文档内容"
        fill-height
        @update:html="onHtml"
        @update:text="onText"
      />
      <p v-else-if="loadError" class="muted">{{ loadError }}</p>
      <div class="md-footer">
        <span>{{ text.length }} 字符 · {{ autoLabel }}</span>
        <el-button
          v-if="autoState === 'failed'"
          link
          type="primary"
          size="small"
          @click="saveNow"
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
  /* 页签内容区高度 100%：编辑器占满页签并在内部滚动 */
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
