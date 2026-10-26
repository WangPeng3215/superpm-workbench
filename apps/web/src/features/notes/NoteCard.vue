<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  ArrowRightOutlined,
  BgColorsOutlined,
  CalendarOutlined,
  DeleteOutlined,
  FileTextOutlined,
  InboxOutlined,
  MoreOutlined,
  PushpinFilled,
  PushpinOutlined,
  UndoOutlined,
} from "@ant-design/icons-vue";
import {
  noteColorLabels,
  noteColors,
  noteTypeLabels,
  type Note,
  type NoteColor,
  type NoteType,
} from "@superpm/shared";
import { errorMessage } from "../../api/client";
import { noteApi } from "../../api/notes";

const props = withDefaults(
  defineProps<{
    note: Note;
    cardKey: string;
    archivedView?: boolean;
  }>(),
  { archivedView: false },
);

const emit = defineEmits<{
  (event: "saved", key: string, note: Note): void;
  (event: "archived", key: string): void;
  (event: "removed", key: string): void;
  (event: "discarded", key: string): void;
  (event: "restored", key: string, note: Note): void;
  (event: "open-task", taskId: number, planDate: string): void;
}>();

const title = ref(props.note.title);
const content = ref(props.note.content);
const type = ref<NoteType>(props.note.type);
const color = ref<NoteColor>(props.note.color);
const isPinned = ref(props.note.isPinned);
const convertedTask = ref(props.note.convertedTask);
const updatedAt = ref(props.note.updatedAt);
const persistedId = ref<number | null>(
  props.note.id > 0 ? props.note.id : null,
);
const isDraft = ref(persistedId.value === null);

const dirty = ref(false);
const saving = ref(false);
const saveError = ref("");
const busy = ref(false);
const colorOpen = ref(false);
const removed = ref(false);

const cardEl = ref<HTMLElement>();
const contentEl = ref<HTMLTextAreaElement>();
const titleEl = ref<HTMLInputElement>();

let debounceTimer: number | undefined;
let activeSave: Promise<boolean> | null = null;
let queuedSave = false;
let version = 0;

const blankDraft = computed(
  () => !persistedId.value && !title.value.trim() && !content.value.trim(),
);

const saveState = computed<"error" | "saving" | "saved" | "auto">(() => {
  if (saveError.value) return "error";
  if (saving.value || dirty.value) return "saving";
  return isDraft.value ? "auto" : "saved";
});

const saveLabel = computed(() => {
  if (saveState.value === "error") return "保存失败";
  if (saveState.value === "saving") return "保存中…";
  if (saveState.value === "saved") return "已保存";
  return "自动保存";
});

const timeLabel = computed(() => {
  const value = updatedAt.value || props.note.createdAt;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const diff = Date.now() - time;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const date = new Date(time);
  const pad = (part: number) => String(part).padStart(2, "0");
  const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === new Date().getFullYear()
    ? stamp
    : `${date.getFullYear()}-${stamp}`;
});

const typeHint = computed(() =>
  type.value === "inspiration" ? "标记为工作备忘" : "标记为灵感",
);

const deleteLabel = computed(() => {
  const name = title.value.trim() || content.value.trim().slice(0, 20);
  return name || "未命名便签";
});

function scheduleSave() {
  dirty.value = true;
  saveError.value = "";
  version += 1;
  if (debounceTimer) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined;
    void triggerSave();
  }, 700);
}

function onInput() {
  scheduleSave();
}

function onFieldBlur(event: FocusEvent) {
  const next = event.relatedTarget as Node | null;
  if (next && cardEl.value?.contains(next)) return;
  if (blankDraft.value) {
    cancelTimer();
    removed.value = true;
    emit("discarded", props.cardKey);
    return;
  }
  void flush();
}

function cancelTimer() {
  if (debounceTimer) {
    window.clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
}

function triggerSave(): Promise<boolean> {
  if (activeSave) {
    queuedSave = true;
    return activeSave;
  }
  activeSave = performSave().finally(() => {
    activeSave = null;
    if (queuedSave) {
      queuedSave = false;
      void triggerSave();
    }
  });
  return activeSave;
}

async function performSave(): Promise<boolean> {
  if (!dirty.value) return true;
  if (!persistedId.value && !title.value.trim() && !content.value.trim())
    return true;
  cancelTimer();
  const snapshot = version;
  const payload = {
    title: title.value,
    content: content.value,
    type: type.value,
    color: color.value,
    isPinned: isPinned.value,
  };
  saving.value = true;
  saveError.value = "";
  dirty.value = false;
  try {
    const saved = persistedId.value
      ? await noteApi.update(persistedId.value, payload)
      : await noteApi.create(payload);
    persistedId.value = saved.id;
    isDraft.value = false;
    updatedAt.value = saved.updatedAt;
    convertedTask.value = saved.convertedTask;
    if (version !== snapshot) dirty.value = true;
    emit("saved", props.cardKey, saved);
    return true;
  } catch (error) {
    saveError.value = errorMessage(error);
    dirty.value = true;
    return false;
  } finally {
    saving.value = false;
  }
}

async function flush(): Promise<boolean> {
  cancelTimer();
  if (!persistedId.value && !title.value.trim() && !content.value.trim()) {
    removed.value = true;
    emit("discarded", props.cardKey);
    return true;
  }
  let ok = true;
  while (dirty.value || activeSave || queuedSave) {
    ok = await triggerSave();
    if (!ok) break;
  }
  return ok && !saveError.value;
}

async function togglePin() {
  if (busy.value || blankDraft.value) return;
  busy.value = true;
  const previous = isPinned.value;
  isPinned.value = !previous;
  version += 1;
  dirty.value = true;
  const ok = await flush();
  if (!ok) {
    isPinned.value = previous;
    version += 1;
    dirty.value = true;
  }
  busy.value = false;
}

async function changeType(next: NoteType) {
  if (busy.value || blankDraft.value || next === type.value) return;
  busy.value = true;
  const previous = type.value;
  type.value = next;
  version += 1;
  dirty.value = true;
  const ok = await flush();
  if (!ok) {
    type.value = previous;
    version += 1;
    dirty.value = true;
  }
  busy.value = false;
}

async function applyColor(next: NoteColor) {
  colorOpen.value = false;
  if (busy.value || blankDraft.value || next === color.value) return;
  busy.value = true;
  const previous = color.value;
  color.value = next;
  version += 1;
  dirty.value = true;
  const ok = await flush();
  if (!ok) {
    color.value = previous;
    version += 1;
    dirty.value = true;
  }
  busy.value = false;
}

async function archiveNote() {
  if (busy.value || props.archivedView) return;
  busy.value = true;
  const ok = await flush();
  if (!ok) {
    ElMessage.error("便签尚未保存成功，请重试后再归档");
    busy.value = false;
    return;
  }
  if (removed.value) {
    busy.value = false;
    return;
  }
  try {
    await noteApi.update(persistedId.value!, { isArchived: true });
    removed.value = true;
    emit("archived", props.cardKey);
    ElMessage.success("便签已归档");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}

async function restoreNote() {
  if (busy.value) return;
  busy.value = true;
  try {
    const restored = await noteApi.update(props.note.id, {
      isArchived: false,
    });
    removed.value = true;
    emit("restored", props.cardKey, restored);
    ElMessage.success("便签已恢复");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}

async function removeNote() {
  if (busy.value) return;
  try {
    await ElMessageBox.confirm(
      `删除“${deleteLabel.value}”吗？删除后无法恢复。`,
      "删除便签",
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
  busy.value = true;
  cancelTimer();
  if (activeSave) await activeSave;
  if (!persistedId.value) {
    removed.value = true;
    emit("discarded", props.cardKey);
    busy.value = false;
    return;
  }
  try {
    await noteApi.remove(persistedId.value);
    removed.value = true;
    emit("removed", props.cardKey);
    ElMessage.success("便签已删除");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}

async function convertNote() {
  if (busy.value || isDraft.value) return;
  busy.value = true;
  try {
    const ok = await flush();
    if (!ok) {
      ElMessage.error("便签尚未保存成功，请重试后再转换");
      return;
    }
    const result = await noteApi.convert(persistedId.value!);
    convertedTask.value = result.note.convertedTask;
    updatedAt.value = result.note.updatedAt;
    emit("saved", props.cardKey, result.note);
    ElMessage.success(
      result.created ? "已转为每日任务" : "该便签已转为每日任务",
    );
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}

function openConvertedTask() {
  const task = convertedTask.value;
  if (!task?.exists) return;
  emit("open-task", task.id, task.planDate);
}

function onCommand(command: string | number | object) {
  const action = String(command);
  if (action === "type")
    void changeType(type.value === "inspiration" ? "work_memo" : "inspiration");
  else if (action === "archive") void archiveNote();
  else if (action === "restore") void restoreNote();
  else if (action === "delete") void removeNote();
}

function onTitleEnter() {
  contentEl.value?.focus();
}

onMounted(() => {
  if (isDraft.value) void nextTick(() => contentEl.value?.focus());
});

onBeforeUnmount(() => {
  if (!removed.value && !props.archivedView) {
    cancelTimer();
    if (dirty.value) void triggerSave();
  }
});

defineExpose({ flush });
</script>

<template>
  <article
    ref="cardEl"
    class="note-card"
    :class="[
      `color-${color}`,
      {
        pinned: isPinned,
        draft: isDraft,
        archived: archivedView,
        busy,
        'save-failed': saveState === 'error',
      },
    ]"
  >
    <span class="note-tape" aria-hidden="true" />
    <header class="note-head">
      <span class="type-badge">{{ noteTypeLabels[type] }}</span>
      <span v-if="isPinned" class="pin-badge">置顶</span>
      <span class="head-spacer" />
      <div v-if="!archivedView" class="note-tools">
        <el-popover
          v-model:visible="colorOpen"
          trigger="click"
          placement="bottom-end"
          :width="148"
          popper-class="note-color-popper"
        >
          <template #reference>
            <button
              type="button"
              class="card-icon color-trigger"
              :aria-label="`便签颜色：${noteColorLabels[color]}`"
              title="更换颜色"
              :disabled="busy || blankDraft"
            >
              <el-icon :size="14" aria-hidden="true"
                ><BgColorsOutlined
              /></el-icon>
            </button>
          </template>
          <div class="color-palette" role="group" aria-label="便签颜色">
            <button
              v-for="item in noteColors"
              :key="item"
              type="button"
              class="color-swatch"
              :class="[`color-${item}`, { active: item === color }]"
              :aria-label="noteColorLabels[item]"
              :title="noteColorLabels[item]"
              @click="applyColor(item)"
            />
          </div>
        </el-popover>
        <button
          type="button"
          class="card-icon"
          :class="{ active: isPinned }"
          :aria-label="isPinned ? '取消置顶' : '置顶便签'"
          :title="isPinned ? '取消置顶' : '置顶'"
          :disabled="busy || blankDraft"
          @click="togglePin"
        >
          <el-icon :size="14" aria-hidden="true">
            <PushpinFilled v-if="isPinned" />
            <PushpinOutlined v-else />
          </el-icon>
        </button>
        <el-dropdown trigger="click" @command="onCommand">
          <button
            type="button"
            class="card-icon"
            aria-label="更多操作"
            :disabled="busy || blankDraft"
          >
            <el-icon :size="15" aria-hidden="true"><MoreOutlined /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="type">{{ typeHint }}</el-dropdown-item>
              <el-dropdown-item command="archive">归档便签</el-dropdown-item>
              <el-dropdown-item command="delete" divided>
                删除便签
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <div v-else class="note-tools">
        <button
          type="button"
          class="card-icon"
          aria-label="恢复便签"
          title="恢复便签"
          :disabled="busy"
          @click="restoreNote"
        >
          <el-icon :size="15" aria-hidden="true"><UndoOutlined /></el-icon>
        </button>
        <button
          type="button"
          class="card-icon"
          aria-label="删除便签"
          title="删除便签"
          :disabled="busy"
          @click="removeNote"
        >
          <el-icon :size="15" aria-hidden="true"><DeleteOutlined /></el-icon>
        </button>
      </div>
    </header>

    <template v-if="!archivedView">
      <input
        ref="titleEl"
        v-model="title"
        class="note-title"
        type="text"
        maxlength="120"
        placeholder="标题（可选）"
        aria-label="便签标题"
        :disabled="busy"
        @input="onInput"
        @blur="onFieldBlur"
        @keydown.enter.prevent="onTitleEnter"
      />
      <textarea
        ref="contentEl"
        v-model="content"
        class="note-content"
        rows="5"
        maxlength="20000"
        placeholder="记录灵感、待办或会议要点…"
        aria-label="便签内容"
        :disabled="busy"
        @input="onInput"
        @blur="onFieldBlur"
      />
    </template>
    <template v-else>
      <h3 class="note-title-read">{{ title || "未命名便签" }}</h3>
      <p class="note-content-read">{{ content || "（无正文）" }}</p>
    </template>

    <footer class="note-foot">
      <div class="note-meta">
        <span class="save-state" :class="saveState">
          <i aria-hidden="true" />
          <template v-if="saveState === 'error'">
            保存失败
            <button type="button" class="retry-btn" @click="flush">重试</button>
          </template>
          <template v-else>{{ saveLabel }}</template>
        </span>
        <span v-if="archivedView" class="note-time">已归档</span>
        <span v-else class="note-time">{{ timeLabel }}</span>
      </div>

      <div v-if="!archivedView" class="note-actions">
        <button
          v-if="convertedTask?.exists"
          type="button"
          class="task-action linked"
          :title="`打开每日任务：${convertedTask.title}`"
          @click="openConvertedTask"
        >
          <el-icon :size="12" aria-hidden="true"><CalendarOutlined /></el-icon>
          <span class="task-action-text">{{ convertedTask.title }}</span>
          <el-icon :size="10" aria-hidden="true"
            ><ArrowRightOutlined
          /></el-icon>
        </button>
        <button
          v-else
          type="button"
          class="task-action"
          :class="{ retry: convertedTask }"
          :disabled="busy || isDraft"
          @click="convertNote"
        >
          <el-icon :size="12" aria-hidden="true">
            <InboxOutlined v-if="convertedTask" />
            <FileTextOutlined v-else />
          </el-icon>
          <span>{{
            convertedTask ? "目标任务已删除，重新转换" : "转为每日任务"
          }}</span>
        </button>
      </div>
      <div v-else class="note-actions archived-note">
        <span>归档后只读，可恢复后继续编辑</span>
      </div>
    </footer>
  </article>
</template>

<style scoped>
.note-card {
  --note-paper: #fff4c9;
  --note-paper-top: #fffdf3;
  --note-border: #eed891;
  --note-ink: #4f421c;
  --note-muted: #8c7c4c;
  --note-accent: #c09a26;
  --note-tape: rgb(255 255 255 / 58%);
  --note-button-bg: color-mix(in srgb, #fff 28%, transparent);
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 232px;
  padding: 16px 14px 12px;
  border: 1px solid var(--note-border);
  border-radius: 4px 14px 4px 4px;
  background:
    radial-gradient(circle at 82% 8%, rgb(255 255 255 / 42%), transparent 34%),
    linear-gradient(180deg, var(--note-paper-top), var(--note-paper));
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 55%),
    0 12px 26px -20px rgb(50 40 10 / 55%);
  color: var(--note-ink);
  transition:
    transform 180ms var(--ease-standard),
    box-shadow 180ms var(--ease-standard),
    border-color 180ms var(--ease-standard);
}
.note-card::after {
  content: "";
  position: absolute;
  top: -1px;
  right: -1px;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 0 15px 15px 0;
  border-color: transparent var(--bg-page) transparent transparent;
  filter: drop-shadow(-1px 1px 0 rgb(0 0 0 / 7%));
  pointer-events: none;
}
.note-card:hover {
  transform: translateY(-2px);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 55%),
    0 18px 30px -22px rgb(50 40 10 / 65%);
}
.note-card:focus-within {
  border-color: color-mix(in srgb, var(--note-accent) 62%, var(--note-border));
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--note-accent) 18%, transparent),
    inset 0 1px 0 rgb(255 255 255 / 55%),
    0 18px 30px -22px rgb(50 40 10 / 60%);
}
.note-card.pinned {
  border-top-color: var(--note-accent);
}
.note-card.busy {
  cursor: progress;
}
.note-card.save-failed {
  border-color: color-mix(in srgb, #d65a5a 45%, var(--note-border));
}
.note-tape {
  position: absolute;
  top: -1px;
  left: 50%;
  width: 58px;
  height: 13px;
  transform: translateX(-50%);
  border-radius: 0 0 3px 3px;
  background: var(--note-tape);
  box-shadow: inset 0 -1px 0 rgb(0 0 0 / 5%);
  opacity: 0.7;
  pointer-events: none;
}
.note-card.color-pink {
  --note-paper: #ffe3ea;
  --note-paper-top: #fff7f9;
  --note-border: #f0c7d2;
  --note-ink: #662f40;
  --note-muted: #a06d7b;
  --note-accent: #cf6f8a;
}
.note-card.color-blue {
  --note-paper: #e3edff;
  --note-paper-top: #f7faff;
  --note-border: #c8d8f1;
  --note-ink: #263b60;
  --note-muted: #6c80a1;
  --note-accent: #5d83c7;
}
.note-card.color-green {
  --note-paper: #def4e7;
  --note-paper-top: #f5fdf8;
  --note-border: #c4e3d1;
  --note-ink: #224a35;
  --note-muted: #658f78;
  --note-accent: #4b9c6e;
}
.note-card.color-purple {
  --note-paper: #eee6ff;
  --note-paper-top: #faf7ff;
  --note-border: #d8c9f1;
  --note-ink: #3c2c5c;
  --note-muted: #7d6b9f;
  --note-accent: #8262c7;
}
.note-card.color-slate {
  --note-paper: #edf1f6;
  --note-paper-top: #fafcfe;
  --note-border: #d6dee7;
  --note-ink: #33404f;
  --note-muted: #748393;
  --note-accent: #708399;
}
html.dark .note-card {
  --note-paper: #3a3421;
  --note-paper-top: #45402b;
  --note-border: #5e5432;
  --note-ink: #f1e7c2;
  --note-muted: #c0b488;
  --note-accent: #d8bf6c;
  --note-tape: rgb(255 255 255 / 12%);
  --note-button-bg: rgb(255 255 255 / 6%);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 8%),
    0 14px 30px -22px rgb(0 0 0 / 70%);
}
html.dark .note-card.color-pink {
  --note-paper: #3b2a31;
  --note-paper-top: #453239;
  --note-border: #5c3d48;
  --note-ink: #f4d8e0;
  --note-muted: #bea0a9;
  --note-accent: #d989a1;
}
html.dark .note-card.color-blue {
  --note-paper: #252f40;
  --note-paper-top: #2c384c;
  --note-border: #3b4c68;
  --note-ink: #dbe6f8;
  --note-muted: #96a7c1;
  --note-accent: #7e9cd6;
}
html.dark .note-card.color-green {
  --note-paper: #25362d;
  --note-paper-top: #2c3f35;
  --note-border: #3a5344;
  --note-ink: #d8efdf;
  --note-muted: #94b3a0;
  --note-accent: #74bc92;
}
html.dark .note-card.color-purple {
  --note-paper: #2e283e;
  --note-paper-top: #373048;
  --note-border: #473d61;
  --note-ink: #e6dbf8;
  --note-muted: #aa9ac8;
  --note-accent: #a58adc;
}
html.dark .note-card.color-slate {
  --note-paper: #2b3038;
  --note-paper-top: #323842;
  --note-border: #414955;
  --note-ink: #e3e9f1;
  --note-muted: #a0abb9;
  --note-accent: #94a6bb;
}
.note-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  margin-bottom: 4px;
}
.type-badge,
.pin-badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 99px;
  background: color-mix(in srgb, var(--note-ink) 8%, transparent);
  color: var(--note-muted);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.2px;
  line-height: 1.6;
}
.pin-badge {
  background: color-mix(in srgb, var(--note-accent) 20%, transparent);
  color: var(--note-accent);
}
.head-spacer {
  flex: 1;
}
.note-tools {
  display: flex;
  align-items: center;
  gap: 1px;
  margin-right: -3px;
  opacity: 0.5;
  transition: opacity 160ms var(--ease-standard);
}
.note-card:hover .note-tools,
.note-card:focus-within .note-tools {
  opacity: 1;
}
.card-icon {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--note-muted);
  cursor: pointer;
  transition:
    background 150ms var(--ease-standard),
    color 150ms var(--ease-standard);
}
.card-icon:hover:not(:disabled) {
  background: var(--note-button-bg);
  color: var(--note-ink);
}
.card-icon.active {
  color: var(--note-accent);
}
.card-icon:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.color-trigger {
  position: relative;
}
.note-title {
  width: 100%;
  margin: 0;
  padding: 2px 0 5px;
  border: 0;
  background: transparent;
  color: var(--note-ink);
  font: inherit;
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.2px;
  outline: none;
}
.note-title::placeholder {
  color: var(--note-muted);
  font-weight: 500;
  opacity: 0.66;
}
.note-title-read {
  overflow: hidden;
  margin: 0;
  padding: 2px 0 6px;
  color: var(--note-ink);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.2px;
  line-height: 1.35;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.note-content {
  flex: 1;
  width: 100%;
  min-height: 108px;
  max-height: 200px;
  margin: 0;
  padding: 0 2px 0 0;
  border: 0;
  background: transparent;
  color: var(--note-ink);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.72;
  outline: none;
  overflow-y: auto;
  resize: none;
  scrollbar-width: thin;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.note-content::placeholder {
  color: var(--note-muted);
  opacity: 0.62;
}
.note-content-read {
  display: -webkit-box;
  flex: 1;
  overflow: auto;
  max-height: 200px;
  margin: 0;
  color: color-mix(in srgb, var(--note-ink) 88%, transparent);
  font-size: 12.5px;
  line-height: 1.72;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 9;
}
.note-foot {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed color-mix(in srgb, var(--note-ink) 15%, transparent);
}
.note-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--note-muted);
  font-size: 10px;
}
.save-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  white-space: nowrap;
}
.save-state i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.55;
}
.save-state.saving i {
  animation: save-pulse 1.1s ease-in-out infinite;
}
.save-state.saved {
  color: color-mix(in srgb, var(--note-accent) 78%, var(--note-muted));
}
.save-state.error {
  color: #cb4f4f;
}
html.dark .save-state.error {
  color: #ff9a92;
}
.retry-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 650;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.note-time {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-actions {
  display: flex;
  min-width: 0;
}
.task-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 4px 8px;
  border: 1px dashed color-mix(in srgb, var(--note-ink) 24%, transparent);
  border-radius: 7px;
  background: transparent;
  color: var(--note-ink);
  font: inherit;
  font-size: 10.5px;
  font-weight: 550;
  cursor: pointer;
  transition:
    background 150ms var(--ease-standard),
    border-color 150ms var(--ease-standard);
}
.task-action:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--note-ink) 42%, transparent);
  background: var(--note-button-bg);
}
.task-action:disabled {
  cursor: default;
  opacity: 0.5;
}
.task-action.linked {
  border-style: solid;
  border-color: color-mix(in srgb, var(--note-accent) 40%, transparent);
  color: color-mix(in srgb, var(--note-accent) 82%, var(--note-ink));
}
.task-action.retry {
  border-color: color-mix(in srgb, #cb4f4f 35%, var(--note-border));
}
.task-action-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.archived-note {
  color: var(--note-muted);
  font-size: 10px;
}
.color-palette {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 7px;
  padding: 2px;
}
.color-swatch {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid rgb(0 0 0 / 12%);
  border-radius: 50%;
  background: #fff4c9;
  cursor: pointer;
  transition:
    transform 140ms var(--ease-standard),
    box-shadow 140ms var(--ease-standard);
}
.color-swatch.color-yellow {
  background: #f5dd86;
}
.color-swatch.color-pink {
  background: #f2b6c8;
}
.color-swatch.color-blue {
  background: #b8cdf0;
}
.color-swatch.color-green {
  background: #b7dfc6;
}
.color-swatch.color-purple {
  background: #cfbdee;
}
.color-swatch.color-slate {
  background: #cbd5e1;
}
.color-swatch:hover {
  transform: scale(1.12);
}
.color-swatch.active {
  box-shadow:
    0 0 0 2px var(--bg-surface),
    0 0 0 3.5px var(--brand);
}
@keyframes save-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 0.95;
  }
}
@media (hover: none) {
  .note-tools {
    opacity: 1;
  }
}
</style>
