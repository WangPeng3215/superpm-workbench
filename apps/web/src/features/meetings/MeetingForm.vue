<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  meetingTypeLabels,
  meetingTypes,
  type Meeting,
  type MeetingCreate,
  type MeetingRequirementRef,
  type MeetingType,
} from "@superpm/shared";
import InlineRichTextEditor from "../requirements/InlineRichTextEditor.vue";
import MeetingRequirementSelect from "./MeetingRequirementSelect.vue";
import { defaultMeetingTime } from "./format";

const props = defineProps<{
  meeting?: Meeting | null;
  saving?: boolean;
  error?: string;
}>();
const emit = defineEmits<{
  submit: [payload: MeetingCreate];
  cancel: [];
  "open-requirement": [id: number];
}>();

function toDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const title = ref(props.meeting?.title ?? "");
const type = ref<MeetingType>(props.meeting?.type ?? "weekly");
const meetingTime = ref<Date | null>(
  props.meeting ? toDate(props.meeting.meetingTime) : defaultMeetingTime(),
);
const requirements = ref<MeetingRequirementRef[]>(
  props.meeting?.requirements.map((item) => ({ ...item })) ?? [],
);
const contentHtml = ref(props.meeting?.contentHtml ?? "");
const formError = ref("");
const dirty = ref(false);

function markDirty() {
  dirty.value = true;
}
function onContentHtml(html: string) {
  contentHtml.value = html;
  markDirty();
}
function isDirty() {
  return dirty.value;
}

function validate(): MeetingCreate | null {
  formError.value = "";
  if (!title.value.trim()) {
    formError.value = "请输入会议标题";
    return null;
  }
  if (!meetingTime.value || Number.isNaN(meetingTime.value.getTime())) {
    formError.value = "请选择有效的会议时间";
    return null;
  }
  return {
    title: title.value.trim(),
    type: type.value,
    meetingTime: meetingTime.value.toISOString(),
    requirementIds: requirements.value.map((item) => item.id),
    contentHtml: contentHtml.value,
  };
}

function submit() {
  if (props.saving) return;
  const payload = validate();
  if (payload) emit("submit", payload);
}

// 浏览器刷新/关闭兜底；站内跳转由页面级路由守卫处理
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value) return;
  event.preventDefault();
  event.returnValue = "";
}
onMounted(() => window.addEventListener("beforeunload", onBeforeUnload));
onBeforeUnmount(() =>
  window.removeEventListener("beforeunload", onBeforeUnload),
);

defineExpose({ isDirty });
</script>

<template>
  <form class="meeting-form" @submit.prevent="submit">
    <div class="form-main">
      <el-alert
        v-if="error || formError"
        :title="error || formError"
        type="error"
        :closable="false"
        show-icon
        class="form-alert"
      />
      <label class="field">
        <span class="field-label"
          >会议标题<i class="required" aria-hidden="true">*</i></span
        >
        <el-input
          v-model="title"
          maxlength="200"
          show-word-limit
          placeholder="例如：第 42 周项目周例会"
          @input="markDirty"
        />
      </label>
      <div class="content-field">
        <span class="field-label">会议内容</span>
        <InlineRichTextEditor
          fill-height
          :html="contentHtml"
          label="会议内容"
          placeholder="记录会议议题、结论与后续行动…"
          @update:html="onContentHtml"
          @open-requirement="emit('open-requirement', $event)"
        />
      </div>
    </div>
    <aside class="form-side">
      <section class="side-section">
        <span class="side-title">会议信息</span>
        <div class="field">
          <span class="field-label">会议类型</span>
          <el-radio-group v-model="type" size="small" @change="markDirty">
            <el-radio-button
              v-for="value in meetingTypes"
              :key="value"
              :value="value"
            >
              {{ meetingTypeLabels[value] }}
            </el-radio-button>
          </el-radio-group>
        </div>
        <label class="field">
          <span class="field-label"
            >会议时间<i class="required" aria-hidden="true">*</i></span
          >
          <el-date-picker
            v-model="meetingTime"
            type="datetime"
            format="YYYY-MM-DD HH:mm"
            placeholder="选择会议时间"
            :clearable="false"
            style="width: 100%"
            @change="markDirty"
          />
        </label>
      </section>
      <section class="side-section">
        <span class="side-title">关联需求</span>
        <div class="field">
          <MeetingRequirementSelect
            v-model="requirements"
            :disabled="saving"
            @update:model-value="markDirty"
            @open-requirement="emit('open-requirement', $event)"
          />
          <span class="field-hint"
            >搜索并点击结果即可添加到下方列表，支持关联多个需求，也可以暂不关联。</span
          >
        </div>
      </section>
      <div class="form-actions">
        <el-button :disabled="saving" @click="emit('cancel')">取消</el-button>
        <el-button
          type="primary"
          native-type="submit"
          :loading="saving"
          :disabled="saving"
        >
          {{ meeting ? "保存修改" : "保存会议" }}
        </el-button>
      </div>
    </aside>
  </form>
</template>

<style scoped>
.meeting-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
  gap: 20px;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.form-main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
}
.content-field {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 7px;
  min-height: 0;
}
.content-field > .inline-rich {
  flex: 1 1 auto;
  min-height: 0;
}
.form-alert {
  margin-bottom: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
.field-label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
}
.required {
  margin-left: 2px;
  color: var(--tone-red-fg);
  font-style: normal;
}
.field-hint {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
}
.form-side {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}
.side-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.side-title {
  color: var(--text-heading);
  font-size: 12px;
  font-weight: 600;
}
.form-side :deep(.el-radio-group) {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto;
  padding-top: 14px;
  border-top: 1px solid var(--border-soft);
}
.form-actions :deep(.el-button) {
  margin: 0;
}
@media (max-width: 980px) {
  .meeting-form {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }
  .content-field {
    flex: none;
    min-height: 360px;
  }
  .form-side {
    overflow: visible;
  }
}
</style>
