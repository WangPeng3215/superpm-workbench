<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import {
  formatWorklogDuration,
  projectWorklogApi,
  type ProjectWorklogItem,
} from "../../api/project-worklog";
const props = defineProps<{ projectId: number }>();
const loading = ref(false);
const error = ref("");
const totalSeconds = ref(0);
const items = ref<ProjectWorklogItem[]>([]);
let revision = 0;
async function load() {
  const token = ++revision;
  loading.value = true;
  error.value = "";
  try {
    const response = await projectWorklogApi.list(props.projectId);
    if (revision !== token) return;
    totalSeconds.value = response.totalSeconds;
    items.value = response.items;
  } catch (cause) {
    if (revision !== token) return;
    error.value = cause instanceof Error ? cause.message : "项目工时读取失败";
  } finally {
    if (revision === token) loading.value = false;
  }
}
function refresh() {
  void load().catch(() => ElMessage.warning("项目工时刷新失败"));
}
function rowKey(row: ProjectWorklogItem) {
  return row.projectTaskId + ":" + row.workerUserId;
}
onMounted(refresh);
watch(() => props.projectId, refresh);
</script>

<template>
  <section class="worklog" v-loading="loading">
    <div class="worklog-head">
      <div>
        <h2>项目工时</h2>
        <p>仅汇总已关联项目任务的工时记录，不包含个人安排和私人备注。</p>
      </div>
      <div class="total" aria-live="polite">
        <span>累计</span>
        <strong>{{ formatWorklogDuration(totalSeconds) }}</strong>
      </div>
    </div>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />
    <el-empty
      v-else-if="!loading && !items.length"
      description="暂无已关联任务的工时"
      :image-size="64"
    />
    <el-table v-else :data="items" size="small" :row-key="rowKey" stripe>
      <el-table-column
        prop="title"
        label="项目任务"
        min-width="220"
        show-overflow-tooltip
      />
      <el-table-column
        prop="assigneeName"
        label="当前执行人"
        width="140"
      />
      <el-table-column prop="workerName" label="工时记录人" width="140" />
      <el-table-column label="累计工时" width="160" align="right">
        <template #default="scope">{{
          formatWorklogDuration(scope.row.totalSeconds)
        }}</template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.worklog {
  padding: 16px 0;
}
.worklog-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
}
.worklog-head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
}
.worklog-head p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}
.total {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.total strong {
  color: var(--text-title);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}
</style>
