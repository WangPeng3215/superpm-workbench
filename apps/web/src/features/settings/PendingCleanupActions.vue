<script setup lang="ts">
import { ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { PendingOldData } from "@superpm/shared/data-root-contract";
import { cleanupHomeData } from "../../api/data-root";
import { errorMessage } from "../../api/client";
import { notifyDataRootChanged } from "../../stores/data-root";

const props = defineProps<{ pending: PendingOldData; newHome?: string }>();
const emit = defineEmits<{ resolved: [action: "keep" | "delete"] }>();
const busy = ref<"keep" | "delete" | "">("");
const error = ref("");

async function keep() {
  busy.value = "keep";
  error.value = "";
  try {
    await cleanupHomeData({
      action: "keep",
      jobId: props.pending.jobId,
      oldHome: props.pending.oldHome,
    });
    ElMessage.success("已保留旧数据目录");
    notifyDataRootChanged();
    emit("resolved", "keep");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = "";
  }
}

async function remove() {
  try {
    await ElMessageBox.confirm(
      `将永久删除旧数据目录中的数据库、工作区与备份：\n${props.pending.oldHome}\n\n此操作不可恢复。若仍有旧版本程序指向该目录，删除后它将无法读取原数据。`,
      "删除旧数据",
      {
        type: "warning",
        confirmButtonText: "永久删除",
        cancelButtonText: "取消",
        confirmButtonClass: "el-button--danger",
      },
    );
  } catch {
    return;
  }
  busy.value = "delete";
  error.value = "";
  try {
    const result = await cleanupHomeData({
      action: "delete",
      jobId: props.pending.jobId,
      oldHome: props.pending.oldHome,
      confirm: true,
    });
    if (result.failedPaths?.length) {
      error.value = `${result.error ?? "部分旧文件删除失败"}：${result.failedPaths.join("、")}`;
      return;
    }
    ElMessage.success("旧数据目录已删除");
    notifyDataRootChanged();
    emit("resolved", "delete");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = "";
  }
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<template>
  <div class="pending-cleanup">
    <div class="pending-cleanup-text">
      <span v-if="newHome"
        >数据已迁移到 <code>{{ newHome }}</code></span
      >
      <span
        >旧数据仍保留在 <code>{{ pending.oldHome }}</code></span
      >
      <span class="muted"
        >迁移于
        {{ formatDate(pending.movedAt) }}；确认新位置数据无误后再删除。</span
      >
      <span v-if="pending.managedPaths.length" class="pending-paths"
        >将删除：
        <code v-for="path in pending.managedPaths" :key="path">{{
          path
        }}</code></span
      >
    </div>
    <div class="pending-cleanup-actions">
      <el-button
        size="small"
        type="primary"
        :loading="busy === 'keep'"
        :disabled="!!busy"
        @click="keep"
        >保留旧数据</el-button
      >
      <el-button
        size="small"
        type="danger"
        plain
        :loading="busy === 'delete'"
        :disabled="!!busy"
        @click="remove"
        >删除旧数据</el-button
      >
    </div>
    <p v-if="error" class="pending-cleanup-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.pending-cleanup {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  padding: 12px 14px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.pending-cleanup-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  min-width: 0;
}
.pending-cleanup-text code {
  overflow-wrap: anywhere;
}
.pending-cleanup-text .muted {
  font-size: 12px;
}
.pending-paths {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 12px;
}
.pending-cleanup-actions {
  display: flex;
  gap: 8px;
}
.pending-cleanup-error {
  flex-basis: 100%;
  margin: 0;
  color: var(--danger-text);
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
