<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import {
  ArrowLeftOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons-vue";
import {
  noteTypeLabels,
  noteTypes,
  type Note,
  type NoteType,
} from "@superpm/shared";
import { errorMessage } from "../api/client";
import { noteApi } from "../api/notes";
import XlyEmpty from "../components/ease-ui/xly-empty/index.vue";
import { decorative } from "../components/decorativeIcon";
import NoteCard from "../features/notes/NoteCard.vue";

const SearchIcon = decorative(SearchOutlined);
const PlusIcon = decorative(PlusOutlined);
const ReloadIcon = decorative(ReloadOutlined);

type CardNote = Note & { clientKey: string };
type FilterValue = "all" | NoteType | "pinned";

const router = useRouter();
const notes = ref<CardNote[]>([]);
const loading = ref(false);
const loadError = ref("");
const keyword = ref("");
const filter = ref<FilterValue>("all");
const archivedView = ref(false);
const cardRefs = ref<Array<InstanceType<typeof NoteCard>>>([]);
let loadSeq = 0;
let draftSeq = 0;

const filterOptions: Array<{ value: FilterValue; label: string }> = [
  { value: "all", label: "全部类型" },
  ...noteTypes.map((value) => ({
    value,
    label: noteTypeLabels[value],
  })),
  { value: "pinned", label: "已置顶" },
];

const hasFilters = computed(
  () => Boolean(keyword.value.trim()) || filter.value !== "all",
);

const visibleNotes = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  const filtered = notes.value.filter((note) => {
    const isDraft = note.id < 0;
    if (!isDraft && query) {
      if (
        !note.title.toLowerCase().includes(query) &&
        !note.content.toLowerCase().includes(query)
      )
        return false;
    }
    if (isDraft) return true;
    if (filter.value === "pinned") return note.isPinned;
    if (filter.value !== "all") return note.type === filter.value;
    return true;
  });
  return [...filtered].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return (
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
      b.id - a.id
    );
  });
});

const countLabel = computed(() =>
  archivedView.value
    ? `${visibleNotes.value.length} 张归档便签`
    : `${visibleNotes.value.length} 张便签`,
);

function toCardNote(note: Note): CardNote {
  return { ...note, clientKey: `note-${note.id}` };
}

async function load() {
  const seq = ++loadSeq;
  loading.value = true;
  loadError.value = "";
  try {
    const items = await noteApi.list(archivedView.value);
    if (seq === loadSeq) notes.value = items.map(toCardNote);
  } catch (error) {
    if (seq === loadSeq) loadError.value = errorMessage(error);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

async function flushCards() {
  const results = await Promise.all(
    cardRefs.value.map((card) => card.flush().catch(() => false)),
  );
  return results.every(Boolean);
}

async function reloadNotes() {
  if (!(await flushCards())) {
    ElMessage.error("有便签保存失败，请先重试后再刷新");
    return;
  }
  await load();
}

async function toggleArchivedView() {
  if (!archivedView.value && !(await flushCards())) {
    ElMessage.error("有便签保存失败，请先重试后再查看归档");
    return;
  }
  archivedView.value = !archivedView.value;
  keyword.value = "";
  filter.value = "all";
  await load();
}

function clearFilters() {
  keyword.value = "";
  filter.value = "all";
}

function createNote() {
  if (archivedView.value) return;
  notes.value = notes.value.filter(
    (note) => note.id > 0 || note.title || note.content,
  );
  const now = new Date().toISOString();
  const draft: CardNote = {
    id: -(Date.now() + ++draftSeq),
    title: "",
    content: "",
    type: "inspiration",
    color: "yellow",
    isPinned: false,
    isArchived: false,
    convertedTaskId: null,
    convertedTask: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    clientKey: `draft-${draftSeq}-${Date.now()}`,
  };
  notes.value.unshift(draft);
  clearFilters();
  void nextTick(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function onSaved(key: string, note: Note) {
  const index = notes.value.findIndex((item) => item.clientKey === key);
  if (index < 0) return;
  notes.value[index] = { ...note, clientKey: key };
}

function removeCard(key: string) {
  notes.value = notes.value.filter((item) => item.clientKey !== key);
}

function onRestored(key: string) {
  removeCard(key);
}

function openTask(taskId: number, planDate: string) {
  void router.push({
    path: "/tasks",
    query: { date: planDate, task: String(taskId) },
  });
}

onMounted(load);
</script>

<template>
  <div class="notes-page">
    <div class="notes-toolbar">
      <el-input
        v-model="keyword"
        clearable
        class="note-search"
        placeholder="搜索标题或内容"
        aria-label="搜索便签"
        :prefix-icon="SearchIcon"
      />
      <el-select
        v-model="filter"
        class="note-filter"
        aria-label="筛选便签"
        placeholder="全部类型"
      >
        <el-option
          v-for="option in filterOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <span class="note-count">{{ countLabel }}</span>
      <span class="toolbar-spacer" />
      <el-button
        v-if="archivedView"
        text
        :icon="ArrowLeftOutlined"
        @click="toggleArchivedView"
      >
        返回便签
      </el-button>
      <el-button v-else text :icon="InboxOutlined" @click="toggleArchivedView">
        归档
      </el-button>
      <el-button
        text
        :icon="ReloadIcon"
        :loading="loading"
        @click="reloadNotes"
      >
        刷新
      </el-button>
      <el-button
        v-if="!archivedView"
        type="primary"
        :icon="PlusIcon"
        @click="createNote"
      >
        新建便签
      </el-button>
    </div>

    <section v-if="archivedView" class="archive-banner">
      <span class="archive-dot" aria-hidden="true" />
      <span>正在查看归档便签，恢复后可继续编辑</span>
    </section>

    <div v-if="loadError" class="load-error">
      <el-alert :title="loadError" type="error" :closable="false" show-icon />
      <el-button size="small" @click="load">重新加载</el-button>
    </div>

    <div v-loading="loading" class="notes-board">
      <template v-if="visibleNotes.length">
        <NoteCard
          v-for="note in visibleNotes"
          :key="note.clientKey"
          ref="cardRefs"
          :note="note"
          :card-key="note.clientKey"
          :archived-view="archivedView"
          @saved="onSaved"
          @archived="removeCard"
          @removed="removeCard"
          @discarded="removeCard"
          @restored="onRestored"
          @open-task="openTask"
        />
        <button
          v-if="!archivedView && !hasFilters"
          type="button"
          class="note-add-card"
          @click="createNote"
        >
          <el-icon :size="20" aria-hidden="true"><PlusOutlined /></el-icon>
          <span>新建便签</span>
        </button>
      </template>

      <div v-else-if="!loading" class="notes-empty">
        <XlyEmpty
          v-if="hasFilters"
          type="search"
          size="small"
          :description="
            archivedView ? '没有匹配的归档便签' : '没有找到匹配的便签'
          "
        >
          <el-button plain @click="clearFilters">清除筛选</el-button>
        </XlyEmpty>
        <XlyEmpty
          v-else
          type="list"
          size="small"
          :description="
            archivedView ? '还没有归档便签' : '还没有便签，记录第一条灵感吧'
          "
        >
          <el-button
            v-if="!archivedView"
            type="primary"
            plain
            :icon="PlusIcon"
            @click="createNote"
          >
            新建便签
          </el-button>
          <el-button v-else plain @click="toggleArchivedView">
            返回便签
          </el-button>
        </XlyEmpty>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notes-page {
  min-width: 0;
}
.notes-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-base);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
}
.note-search {
  flex: 0 1 280px;
  min-width: 180px;
}
.note-filter {
  flex: 0 0 132px;
}
.note-count {
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.toolbar-spacer {
  flex: 1;
}
.archive-banner {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 12px;
  padding: 7px 11px;
  border: 1px solid var(--tone-amber-bd);
  border-radius: 8px;
  background: var(--tone-amber-bg);
  color: var(--tone-amber-fg);
  font-size: 11px;
}
.archive-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.72;
}
.load-error {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.load-error :deep(.el-alert) {
  flex: 1;
}
.notes-board {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(252px, 1fr));
  gap: 14px;
  align-items: start;
  min-height: 260px;
}
.note-add-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 200px;
  padding: 20px;
  border: 1.5px dashed var(--border-line);
  border-radius: 4px 14px 4px 4px;
  background: color-mix(in srgb, var(--bg-subtle) 46%, transparent);
  color: var(--text-faint);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 160ms var(--ease-standard),
    background 160ms var(--ease-standard),
    color 160ms var(--ease-standard);
}
.note-add-card:hover {
  border-color: var(--border-brand);
  background: var(--bg-brand-soft);
  color: var(--brand);
}
.notes-empty {
  grid-column: 1 / -1;
  display: flex;
  justify-content: center;
  padding: 16px 0 40px;
}
@media (max-width: 760px) {
  .notes-toolbar {
    flex-wrap: wrap;
  }
  .note-search {
    flex: 1 1 200px;
  }
  .toolbar-spacer {
    display: none;
  }
}
@media (max-width: 620px) {
  .notes-board {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .notes-toolbar {
    padding: 9px 10px;
  }
  .note-search,
  .note-filter {
    flex: 1 1 100%;
  }
  .note-count {
    order: 1;
  }
}
</style>
