<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  ArrowLeftOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
} from "@ant-design/icons-vue";
import {
  meetingTypeLabels,
  type Meeting,
  type MeetingCreate,
} from "@superpm/shared";
import { meetingApi } from "../api/meetings";
import { errorMessage } from "../api/client";
import { decorative } from "../components/decorativeIcon";
import InlineRichTextEditor from "../features/requirements/InlineRichTextEditor.vue";
import MeetingForm from "../features/meetings/MeetingForm.vue";
import {
  formatMeetingTime,
  meetingTypeTone,
} from "../features/meetings/format";
import { removeTab, setTabLabel } from "../stores/tabs";

const BackIcon = decorative(ArrowLeftOutlined);
const ClockIcon = decorative(ClockCircleOutlined);
const EditIcon = decorative(EditOutlined);
const DeleteIcon = decorative(DeleteOutlined);

const route = useRoute();
const router = useRouter();
const id = computed(() => Number(route.params.id));
const meeting = ref<Meeting>();
const loading = ref(false);
const loadError = ref("");
const editing = ref(false);
const saving = ref(false);
const saveError = ref("");
const deleting = ref(false);
const form = ref<InstanceType<typeof MeetingForm>>();
let revision = 0;

async function load() {
  if (!Number.isInteger(id.value) || id.value <= 0) {
    loadError.value = "会议 ID 无效";
    return;
  }
  const token = ++revision;
  loading.value = true;
  loadError.value = "";
  try {
    const detail = await meetingApi.get(id.value);
    if (token !== revision) return;
    meeting.value = detail;
    editing.value = route.query.edit === "1";
    setTabLabel(route.path, detail.title);
  } catch (error) {
    if (token === revision) loadError.value = errorMessage(error);
  } finally {
    if (token === revision) loading.value = false;
  }
}

watch(id, load, { immediate: true });

async function confirmDiscard() {
  if (!editing.value || !form.value?.isDirty()) return true;
  try {
    await ElMessageBox.confirm(
      "当前修改尚未保存，离开后将丢失这些修改。",
      "未保存的修改",
      {
        type: "warning",
        confirmButtonText: "离开",
        cancelButtonText: "继续编辑",
      },
    );
    return true;
  } catch {
    return false;
  }
}

onBeforeRouteLeave(() => confirmDiscard());
onBeforeRouteUpdate(() => confirmDiscard());

function startEdit() {
  saveError.value = "";
  editing.value = true;
  if (route.query.edit !== "1")
    void router.replace({
      path: route.path,
      query: { ...route.query, edit: "1" },
    });
}

function closeEdit() {
  editing.value = false;
  saveError.value = "";
  if (route.query.edit) void router.replace({ path: route.path, query: {} });
}

async function cancelEdit() {
  if (form.value?.isDirty()) {
    try {
      await ElMessageBox.confirm("确定放弃未保存的修改吗？", "未保存的修改", {
        confirmButtonText: "放弃修改",
        cancelButtonText: "继续编辑",
      });
    } catch {
      return;
    }
  }
  closeEdit();
}

async function submit(payload: MeetingCreate) {
  if (!meeting.value || saving.value) return;
  saving.value = true;
  saveError.value = "";
  try {
    const updated = await meetingApi.update(meeting.value.id, payload);
    meeting.value = updated;
    setTabLabel(route.path, updated.title);
    ElMessage.success("会议记录已保存");
    closeEdit();
  } catch (error) {
    saveError.value = errorMessage(error);
  } finally {
    saving.value = false;
  }
}

async function back() {
  if (!(await confirmDiscard())) return;
  editing.value = false;
  await router.push("/meetings");
}

async function openRequirement(requirementId: number) {
  if (!(await confirmDiscard())) return;
  editing.value = false;
  await router.push(`/requirements/${requirementId}`);
}

async function removeMeeting() {
  if (!meeting.value || deleting.value) return;
  try {
    await ElMessageBox.confirm(
      "删除后，会议记录及其与需求的关联将一并移除。此操作不可撤销。",
      "删除会议记录",
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
  deleting.value = true;
  try {
    await meetingApi.remove(meeting.value.id);
    ElMessage.success("会议记录已删除");
    editing.value = false;
    removeTab(route.path);
    await router.push("/meetings");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="meeting-detail" v-loading="loading">
    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      class="load-error"
    />
    <template v-if="meeting">
      <section class="surface detail-head">
        <div class="head-row">
          <button
            type="button"
            class="back-button"
            title="返回会议列表"
            aria-label="返回会议列表"
            @click="back"
          >
            <el-icon aria-hidden="true"><component :is="BackIcon" /></el-icon>
          </button>
          <div class="head-identity">
            <el-tag
              size="small"
              class="enum-tag"
              :class="meetingTypeTone[meeting.type]"
            >
              {{ meetingTypeLabels[meeting.type] }}
            </el-tag>
            <h1 class="head-title" :title="meeting.title">
              {{ meeting.title }}
            </h1>
          </div>
          <div v-if="!editing" class="head-actions">
            <el-button size="small" :icon="EditIcon" @click="startEdit">
              编辑
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :icon="DeleteIcon"
              :loading="deleting"
              @click="removeMeeting"
            >
              删除
            </el-button>
          </div>
          <span v-else class="editing-hint">编辑中，保存后生效</span>
        </div>
        <div class="head-meta">
          <span class="meta-item">
            <el-icon aria-hidden="true"><component :is="ClockIcon" /></el-icon>
            {{ formatMeetingTime(meeting.meetingTime) }}
          </span>
        </div>
      </section>

      <section v-if="editing" class="surface detail-card">
        <MeetingForm
          ref="form"
          :key="meeting.id"
          :meeting="meeting"
          :saving="saving"
          :error="saveError"
          @submit="submit"
          @cancel="cancelEdit"
          @open-requirement="openRequirement"
        />
      </section>

      <template v-else>
        <section class="surface detail-card">
          <h2>关联需求</h2>
          <div v-if="meeting.requirements.length" class="requirement-chips">
            <button
              v-for="item in meeting.requirements"
              :key="item.id"
              type="button"
              class="requirement-chip"
              @click="openRequirement(item.id)"
            >
              <span class="chip-no">{{ item.requirementNo }}</span>
              <span class="chip-name">{{ item.name }}</span>
            </button>
          </div>
          <p v-else class="muted empty-text">未关联需求。</p>
        </section>

        <section class="surface detail-card">
          <h2>会议内容</h2>
          <InlineRichTextEditor
            v-if="meeting.contentHtml"
            :key="meeting.id"
            readonly
            :html="meeting.contentHtml"
            label="会议内容"
            enable-colors
            enable-requirement-refs
            @open-requirement="openRequirement"
          />
          <p v-else class="muted empty-text">暂无会议内容。</p>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.meeting-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
}
.load-error {
  margin-bottom: 0;
}
.detail-head {
  padding: 14px 18px 12px;
}
.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.back-button {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border-base);
  border-radius: 7px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    color var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard);
}
.back-button:hover {
  border-color: var(--border-brand);
  background: var(--bg-brand-soft);
  color: var(--brand);
}
.head-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
}
.head-title {
  margin: 0;
  overflow: hidden;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.2px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.head-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}
.head-actions :deep(.el-button) {
  margin: 0;
}
.editing-hint {
  flex: none;
  color: var(--warning-text);
  font-size: 11px;
}
.head-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 8px;
  padding-left: 38px;
  color: var(--text-muted);
  font-size: 12px;
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-variant-numeric: tabular-nums;
}
.detail-card {
  padding: 18px 22px;
}
.detail-card h2 {
  margin: 0 0 12px;
  font-size: 14px;
}
.requirement-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.requirement-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 4px 10px;
  border: 1px solid var(--border-brand);
  border-radius: 99px;
  background: var(--bg-brand-soft);
  color: var(--brand);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard);
}
.requirement-chip:hover {
  border-color: var(--brand);
  background: color-mix(in srgb, var(--brand) 14%, transparent);
}
.chip-no {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-text {
  margin: 0;
}
@media (max-width: 700px) {
  .detail-head {
    padding-inline: 12px;
  }
  .head-row {
    flex-wrap: wrap;
  }
  .head-identity {
    flex-basis: calc(100% - 38px);
  }
  .head-actions,
  .editing-hint {
    width: 100%;
    justify-content: flex-end;
  }
  .head-meta {
    padding-left: 0;
  }
  .detail-card {
    padding: 14px 12px;
  }
}
</style>
