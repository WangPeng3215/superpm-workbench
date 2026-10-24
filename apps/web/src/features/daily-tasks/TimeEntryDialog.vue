<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import type { DailyTask, DailyTaskDay, DailyTimeEntry } from "@superpm/shared";
import { dailyTimeEntryEndReasonLabels } from "@superpm/shared";
import { dailyTaskApi } from "../../api/daily-tasks";
import { errorMessage } from "../../api/client";
import {
  dateParts,
  dateValue,
  formatDuration,
  timeValue,
  wallTimeToIso,
} from "./format";

const props = defineProps<{
  modelValue: boolean;
  task: DailyTask | null;
  timeZone: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [day: DailyTaskDay];
}>();

interface EntryRow {
  id: number;
  entryDate: string;
  started: string;
  ended: string;
  durationSeconds: number;
  status: DailyTimeEntry["status"];
  endReason: DailyTimeEntry["endReason"];
  reason: string;
  saving: boolean;
}

const loading = ref(false);
const loadError = ref("");
const rows = reactive<EntryRow[]>([]);

function resetRows(entries: DailyTimeEntry[]) {
  rows.splice(
    0,
    rows.length,
    ...entries.map((entry) => ({
      id: entry.id,
      entryDate: dateValue(entry.startedAt, props.timeZone),
      started: timeValue(entry.startedAt, props.timeZone),
      ended: entry.endedAt ? timeValue(entry.endedAt, props.timeZone) : "",
      durationSeconds: entry.durationSeconds,
      status: entry.status,
      endReason: entry.endReason,
      reason: "",
      saving: false,
    })),
  );
}

async function loadEntries() {
  if (!props.task) return;
  loading.value = true;
  loadError.value = "";
  try {
    resetRows(await dailyTaskApi.entries(props.task.id));
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) void loadEntries();
  },
);

function reasonLabel(row: EntryRow) {
  if (row.status === "active") return "计时中";
  return row.endReason
    ? dailyTimeEntryEndReasonLabels[row.endReason]
    : "已结束";
}

async function save(row: EntryRow) {
  if (row.status === "active") {
    ElMessage.warning("进行中的计时需要先结束，才能修正时间");
    return;
  }
  if (!row.started || !row.ended) {
    ElMessage.warning("请填写完整的开始与结束时间");
    return;
  }
  if (row.started >= row.ended) {
    ElMessage.warning("结束时间必须晚于开始时间");
    return;
  }
  row.saving = true;
  try {
    const result = await dailyTaskApi.updateEntry(row.id, {
      startedAt: wallTimeToIso(row.entryDate, row.started, props.timeZone),
      endedAt: wallTimeToIso(row.entryDate, row.ended, props.timeZone),
      reason: row.reason.trim(),
    });
    row.durationSeconds = result.entry.durationSeconds;
    row.started = timeValue(result.entry.startedAt, props.timeZone);
    row.ended = result.entry.endedAt
      ? timeValue(result.entry.endedAt, props.timeZone)
      : "";
    row.reason = "";
    ElMessage.success("工时记录已修正");
    emit("saved", result.day);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    row.saving = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="工时校正"
    width="min(720px, 95vw)"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p class="entry-intro">
      <strong>{{ task?.title }}</strong>
      <span>仅可修正已完成记录；每次修改都会留下审计记录。</span>
    </p>
    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      show-icon
      class="entry-alert"
    />
    <div v-if="loading" v-loading="true" class="entry-loading" />
    <div v-else-if="!rows.length" class="entry-empty">
      还没有工时记录，开始计时后会自动生成。
    </div>
    <div v-else class="entry-list">
      <div
        v-for="row in rows"
        :key="row.id"
        class="entry-row"
        :class="{ active: row.status === 'active' }"
      >
        <div class="entry-head">
          <span class="entry-date">
            {{ dateParts(row.entryDate).monthDayLabel }}
            {{ dateParts(row.entryDate).weekdayLabel }}
          </span>
          <span class="entry-reason" :class="{ live: row.status === 'active' }">
            {{ reasonLabel(row) }}
          </span>
          <span class="entry-duration">
            {{ formatDuration(row.durationSeconds) }}
          </span>
        </div>
        <div class="entry-controls">
          <el-time-picker
            v-model="row.started"
            format="HH:mm"
            value-format="HH:mm"
            :clearable="false"
            :disabled="row.status === 'active'"
            aria-label="开始时间"
          />
          <span class="entry-dash">至</span>
          <el-time-picker
            v-model="row.ended"
            format="HH:mm"
            value-format="HH:mm"
            :clearable="false"
            :disabled="row.status === 'active'"
            aria-label="结束时间"
          />
          <el-input
            v-model="row.reason"
            maxlength="200"
            placeholder="修正原因（可选）"
            :disabled="row.status === 'active'"
          />
          <el-button
            type="primary"
            plain
            size="small"
            :loading="row.saving"
            :disabled="row.status === 'active'"
            @click="save(row)"
          >
            保存
          </el-button>
        </div>
        <p v-if="row.status === 'active'" class="entry-hint">
          正在计时，结束后可修正该记录。
        </p>
      </div>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.entry-intro {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0 0 14px;
  color: var(--text-muted);
  font-size: 12px;
}
.entry-intro strong {
  color: var(--text-heading);
  font-size: 14px;
  font-weight: 600;
}
.entry-alert {
  margin-bottom: 12px;
}
.entry-loading {
  min-height: 120px;
}
.entry-empty {
  padding: 32px 16px;
  border: 1px dashed var(--border-base);
  border-radius: var(--radius-md);
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}
.entry-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.entry-row {
  padding: 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.entry-row.active {
  border-color: var(--border-brand);
  background: var(--bg-brand-soft);
}
.entry-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 9px;
}
.entry-date {
  color: var(--text-title);
  font-size: 12px;
  font-weight: 600;
}
.entry-reason {
  padding: 1px 7px;
  border: 1px solid var(--border-base);
  border-radius: 99px;
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 10px;
}
.entry-reason.live {
  border-color: var(--tone-teal-bd);
  background: var(--tone-teal-bg);
  color: var(--tone-teal-fg);
}
.entry-duration {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.entry-controls {
  display: grid;
  grid-template-columns: 104px auto 104px minmax(120px, 1fr) auto;
  gap: 8px;
  align-items: center;
}
.entry-dash {
  color: var(--text-faint);
  font-size: 11px;
}
.entry-hint {
  margin: 8px 0 0;
  color: var(--tone-teal-fg);
  font-size: 11px;
}
@media (max-width: 640px) {
  .entry-controls {
    grid-template-columns: 1fr auto 1fr;
  }
  .entry-controls :deep(.el-input) {
    grid-column: 1 / -1;
  }
  .entry-controls .el-button {
    grid-column: 1 / -1;
  }
}
</style>
