<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { ArtifactNode } from "@superpm/shared";
import { artifactApi } from "../../api/artifacts";
import { requirementApi } from "../../api/requirements";
import { ApiError, errorMessage } from "../../api/client";
import InlineRichTextEditor from "./InlineRichTextEditor.vue";
import { toDisplayHtml, toStoredHtml } from "./doc-images";
import { documentToEditorHtml, htmlToMarkdown } from "./doc-markdown";
import { contentVersion } from "./content-version";
import { authStore } from "../../stores/auth";
import { resolveResourceAccessFailure } from "./resource-access";
import {
  clearResourceDrafts,
  readResourceDraft,
  resourceDraftKey,
  writeResourceDraft,
  type ResourceDraftScope,
} from "./resource-draft";

// 文档动态页签的编辑器：一个页签对应一个文件（含需求记忆），按 nodeId 读写知识库并自动保存
// 存储约定（V1.1 §12）：磁盘上保存原生 Markdown，编辑器内保持所见即所得，
// 读取时 Markdown → HTML，保存时 HTML → Markdown，图片始终写相对文档目录的路径。
const props = defineProps<{
  requirementId: number;
  projectId: number | null;
  node: ArtifactNode;
}>();
const emit = defineEmits<{
  "open-requirement": [id: number];
  "access-lost": [];
}>();
const opening = ref(true);
const ready = ref(false);
const loadError = ref("");
const html = ref("");
const savedHtml = ref("");
const expectedContentVersion = ref<string>();
const saveFrozen = ref(false);
const saveError = ref("");
const storageError = ref("");
const text = ref("");
const current = ref<ArtifactNode>(props.node);
const autoState = ref<"saved" | "pending" | "saving" | "failed">("saved");
const editor = ref<InstanceType<typeof InlineRichTextEditor>>();
let disposed = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveTask: Promise<boolean> | undefined;
let hydrating = false;
const accountId = authStore.user?.id;
const draftScope: ResourceDraftScope | undefined =
  accountId === undefined
    ? undefined
    : {
        accountId,
        projectId: props.projectId,
        requirementId: props.requirementId,
        kind: "artifact",
      };
const draftKey = draftScope
  ? resourceDraftKey(draftScope, props.node.id)
  : undefined;
function persistLocalDraft() {
  if (
    disposed ||
    hydrating ||
    !ready.value ||
    !draftKey ||
    !expectedContentVersion.value
  )
    return;
  try {
    if (html.value === savedHtml.value && !saveFrozen.value)
      sessionStorage.removeItem(draftKey);
    else
      writeResourceDraft(
        sessionStorage,
        draftKey,
        expectedContentVersion.value,
        { html: html.value },
      );
    storageError.value = "";
  } catch {
    storageError.value = "浏览器无法保存会话草稿；刷新或离开前请复制本地内容。";
  }
}
const autoLabel = computed(() => {
  if (opening.value) return "正在同步文件…";
  if (loadError.value) return "文件读取失败";
  if (autoState.value === "pending") return "有未保存的修改";
  if (autoState.value === "saving") return "保存中…";
  if (autoState.value === "failed") return "保存失败，请重试";
  return "已自动保存到本地文件";
});
function clearSaveTimer() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
}
// 加载文件内容（页签创建时执行一次，失败时页签内展示错误）
async function load(discardDraft = false) {
  const nodeId = props.node.id;
  opening.value = true;
  loadError.value = "";
  try {
    const result = await artifactApi.content(nodeId);
    if (disposed || nodeId !== props.node.id) return;
    // 磁盘中是相对文档目录的图片路径，编辑器内换成可访问地址预览
    const next = toDisplayHtml(
      documentToEditorHtml(result.content),
      props.requirementId,
      nodeId,
    );
    hydrating = true;
    html.value = next;
    savedHtml.value = next;
    text.value =
      new DOMParser().parseFromString(next, "text/html").body.textContent ?? "";
    current.value = result.node;
    expectedContentVersion.value = result.version;
    saveFrozen.value = false;
    saveError.value = "";
    autoState.value = "saved";
    ready.value = true;
    try {
      if (draftKey) {
        if (discardDraft) sessionStorage.removeItem(draftKey);
        else {
          const draft = readResourceDraft(
            sessionStorage,
            draftKey,
            result.version,
            (value): value is { html: string } =>
              Boolean(
                value &&
                typeof value === "object" &&
                typeof (value as { html?: unknown }).html === "string",
              ),
          );
          if (draft) {
            html.value = draft.values.html;
            text.value =
              new DOMParser().parseFromString(html.value, "text/html").body
                .textContent ?? "";
            expectedContentVersion.value = String(draft.version);
            if (draft.conflict) {
              saveFrozen.value = true;
              saveError.value =
                "服务器正文已更新；会话草稿已恢复并暂停保存，请复制后读取最新内容。";
              autoState.value = "failed";
            }
          }
        }
      }
      storageError.value = "";
    } catch {
      storageError.value = "浏览器无法读取会话草稿；离开前请复制本地内容。";
    } finally {
      hydrating = false;
    }
    onDraftChange();
  } catch (error) {
    if (!disposed) {
      if (await handleResourceFailure(error)) return;
      loadError.value = errorMessage(error);
      ElMessage.error(loadError.value);
    }
  } finally {
    if (!disposed) opening.value = false;
  }
}
void load();
function onDraftChange() {
  if (hydrating || !ready.value) return;
  persistLocalDraft();
  clearSaveTimer();
  if (disposed || saveFrozen.value) return;
  if (html.value === savedHtml.value) {
    if (autoState.value !== "saving") autoState.value = "saved";
    return;
  }
  autoState.value = "pending";
  saveTimer = setTimeout(() => void saveNow(), 800);
}
watch(html, onDraftChange, { flush: "sync" });
async function persist() {
  while (!disposed && current.value && html.value !== savedHtml.value) {
    const node = current.value;
    const payload = html.value;
    // 保存前把预览地址还原为相对文档目录的路径，再序列化为 Markdown（文档 §12.4）
    const stored = htmlToMarkdown(toStoredHtml(payload, props.requirementId));
    autoState.value = "saving";
    try {
      const hash = await contentVersion(stored);
      if (disposed) return false;
      const updated = await artifactApi.saveContent(
        node.id,
        stored,
        false,
        expectedContentVersion.value,
      );
      if (disposed) return false;
      expectedContentVersion.value = hash;
      savedHtml.value = payload;
      current.value = updated;
      autoState.value = payload === html.value ? "saved" : "pending";
      persistLocalDraft();
    } catch (error) {
      if (disposed) return false;
      if (await handleResourceFailure(error)) return false;
      if (error instanceof ApiError && [401, 409].includes(error.status)) {
        if (error.code !== "FILE_CONFLICT") {
          saveFrozen.value = true;
          saveError.value =
            error.status === 409
              ? "服务器正文已更新；本地修改已保留，请复制后读取最新内容。"
              : "登录已失效，已暂停保存，请保留当前草稿。";
          autoState.value = "failed";
          return false;
        }
      }
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
          if (disposed) return false;
          const updated = await artifactApi.saveContent(
            node.id,
            stored,
            true,
            expectedContentVersion.value,
          );
          if (disposed) return false;
          expectedContentVersion.value = await contentVersion(stored);
          savedHtml.value = payload;
          current.value = updated;
          autoState.value = payload === html.value ? "saved" : "pending";
          persistLocalDraft();
        } catch (retryError) {
          if (await handleResourceFailure(retryError)) return false;
          if (
            retryError instanceof ApiError &&
            [401, 409].includes(retryError.status)
          ) {
            saveFrozen.value = true;
            saveError.value = errorMessage(retryError);
          }
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
  if (disposed) return Promise.resolve(true);
  if (saveFrozen.value) return Promise.resolve(false);
  if (!saveTask) {
    saveTask = persist().finally(() => {
      saveTask = undefined;
    });
  }
  return saveTask;
}
// 冲刷未保存内容：等待图片上传结束后交由自动保存通道落盘
async function flush() {
  if (disposed) return true;
  if (opening.value) return false;
  opening.value = true;
  try {
    await editor.value?.waitForUpload();
    return saveNow();
  } finally {
    opening.value = false;
  }
}
async function handleResourceFailure(error: unknown) {
  const result = await resolveResourceAccessFailure(error, () =>
    requirementApi.get(props.requirementId),
  );
  if (result === "unrelated") return false;
  if (disposed) return true;
  if (result === "requirement-lost") {
    invalidate();
    emit("access-lost");
    return true;
  }
  clearSaveTimer();
  if (result === "unverified") {
    persistLocalDraft();
    saveFrozen.value = true;
    saveError.value =
      "暂时无法确认需求访问权限，已保留会话草稿并暂停保存，请稍后重试。";
    if (!ready.value) loadError.value = saveError.value;
    autoState.value = "failed";
    return true;
  }
  ready.value = false;
  html.value = "";
  savedHtml.value = "";
  text.value = "";
  expectedContentVersion.value = undefined;
  saveFrozen.value = false;
  saveError.value = "";
  loadError.value = errorMessage(error);
  autoState.value = "saved";
  if (draftKey) {
    try {
      sessionStorage.removeItem(draftKey);
    } catch {
      storageError.value = "无法清理该资源的会话草稿，请关闭当前标签页。";
    }
  }
  ElMessage.error(loadError.value);
  return true;
}
function invalidate() {
  disposed = true;
  if (draftScope) {
    try {
      clearResourceDrafts(sessionStorage, draftScope);
    } catch {
      /* Storage may be unavailable. */
    }
  }
  clearSaveTimer();
  ready.value = false;
  html.value = "";
  savedHtml.value = "";
  text.value = "";
}
defineExpose({ flush, invalidate });
function onHtml(value: string) {
  html.value = value;
}
function onText(value: string) {
  text.value = value;
}
async function copyDraft() {
  try {
    await navigator.clipboard.writeText(text.value || html.value);
    ElMessage.success("草稿已复制");
  } catch {
    ElMessage.error("复制失败，请手动复制正文。");
  }
}
async function reloadLatest() {
  try {
    await ElMessageBox.confirm(
      "读取最新正文会替换本地草稿，请先复制需要保留的内容。",
      "读取最新内容",
      {
        confirmButtonText: "替换草稿",
        cancelButtonText: "继续保留",
        type: "warning",
      },
    );
  } catch {
    return;
  }
  await load(true);
}
function onBeforeUnload(event: BeforeUnloadEvent) {
  persistLocalDraft();
  if (html.value === savedHtml.value) return;
  event.preventDefault();
  event.returnValue = "";
}
onMounted(() => window.addEventListener("beforeunload", onBeforeUnload));
onBeforeUnmount(() => {
  persistLocalDraft();
  disposed = true;
  window.removeEventListener("beforeunload", onBeforeUnload);
  clearSaveTimer();
});
</script>
<template>
  <div class="analysis-page" v-loading="opening">
    <section class="md-panel">
      <el-alert
        v-if="storageError"
        :title="storageError"
        type="warning"
        :closable="false"
      />
      <el-alert
        v-if="saveError"
        :title="saveError"
        type="warning"
        :closable="false"
      />
      <div v-if="saveFrozen">
        <el-button size="small" @click="copyDraft">复制本地草稿</el-button>
        <el-button size="small" @click="reloadLatest">读取最新内容</el-button>
      </div>
      <InlineRichTextEditor
        v-if="ready"
        ref="editor"
        :key="current.id"
        :html="html"
        :requirement-id="requirementId"
        :node-id="current.id"
        label="文档内容"
        fill-height
        @update:html="onHtml"
        @update:text="onText"
        @open-requirement="emit('open-requirement', $event)"
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
  background: transparent;
}
.md-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 0 2px;
  font-size: 11px;
  color: var(--text-faint);
  flex: none;
}
</style>
