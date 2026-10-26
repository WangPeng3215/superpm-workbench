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
    <div class="field-row">
      <div class="field">
        <span class="field-label">会议类型</span>
        <el-radio-group v-model="type" @change="markDirty">
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
    </div>
    <div class="field">
      <span class="field-label">关联需求</span>
      <MeetingRequirementSelect
        v-model="requirements"
        :disabled="saving"
        @update:model-value="markDirty"
      />
      <span class="field-hint"
        >可按编号或名称搜索，支持关联多个需求，也可以暂不关联。</span
      >
    </div>
    <div class="field">
      <span class="field-label">会议内容</span>
      <InlineRichTextEditor
        :html="contentHtml"
        label="会议内容"
        placeholder="记录会议议题、结论与后续行动…"
        enable-colors
        enable-requirement-refs
        @update:html="onContentHtml"
        @open-requirement="emit('open-requirement', $event)"
      />
    </div>
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
  </form>
</template>

<style scoped>
.meeting-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
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
.field-row {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(240px, 1fr);
  gap: 16px;
}
.field-row :deep(.el-radio-group) {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--border-soft);
}
.form-actions :deep(.el-button) {
  margin: 0;
}
@media (max-width: 760px) {
  .field-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
