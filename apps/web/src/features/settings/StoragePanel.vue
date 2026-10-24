<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { SystemInfo } from "@superpm/shared";
import {
  dataRootLockedReasonLabels,
  dataRootSourceLabels,
  type HomeMovePhase,
  type HomeMoveView,
  type HomeValidationResult,
} from "@superpm/shared/data-root-contract";
import { ApiError, errorMessage } from "../../api/client";
import {
  fetchHomeMove,
  openHomeDirectory,
  pickHomeDirectory,
  startHomeMove,
  validateHomeParent,
} from "../../api/data-root";
import PendingCleanupActions from "./PendingCleanupActions.vue";

const props = defineProps<{ info: SystemInfo }>();
const emit = defineEmits<{ refresh: [] }>();

const phaseLabels: Record<HomeMovePhase, string> = {
  preparing: "正在准备迁移",
  stopping: "正在停止本地服务",
  copying: "正在复制数据",
  verifying: "正在校验副本",
  switching: "正在切换数据目录",
  restarting: "正在重启本地服务",
  completed: "迁移完成",
  failed: "迁移失败",
};

const sourceLabel = computed(() => dataRootSourceLabels[props.info.homeSource]);
const lockedLabel = computed(() =>
  props.info.dataRootLockedReason
    ? dataRootLockedReasonLabels[props.info.dataRootLockedReason]
    : "",
);

const dialogVisible = ref(false);
const parent = ref("");
const validation = ref<HomeValidationResult | null>(null);
const validateError = ref("");
const picking = ref(false);
const validating = ref(false);
const starting = ref(false);
const startError = ref("");
const opening = ref(false);

const watching = ref(false);
const offline = ref(false);
const moveState = ref<HomeMoveView | null>(null);
const watchResult = ref<"" | "success" | "failed">("");
const watchError = ref("");
const successMessage = ref("");
const elapsedSeconds = ref(0);
let pollTimer = 0;
let reloadTimer = 0;
let watchDeadline = 0;
let watchStartedAt = 0;
let consecutiveFailures = 0;

const canStart = computed(
  () =>
    Boolean(validation.value) &&
    validation.value!.blockedReasons.length === 0 &&
    Boolean(parent.value.trim()) &&
    props.info.dataRootEditable &&
    !props.info.moveInProgress &&
    !watching.value &&
    !starting.value,
);
const percent = computed(() => {
  const state = moveState.value;
  if (!state) return 0;
  if (state.status === "completed") return 100;
  if (
    state.phase === "copying" &&
    state.progress &&
    state.progress.totalBytes > 0
  )
    return Math.min(
      80,
      10 +
        Math.round(
          (state.progress.copiedBytes / state.progress.totalBytes) * 70,
        ),
    );
  const fallback: Record<HomeMovePhase, number> = {
    preparing: 5,
    stopping: 10,
    copying: 15,
    verifying: 85,
    switching: 92,
    restarting: 96,
    completed: 100,
    failed: 0,
  };
  return fallback[state.phase ?? "preparing"];
});
const phaseText = computed(() => {
  if (offline.value) return "本地服务正在重启，等待新位置就绪";
  return phaseLabels[moveState.value?.phase ?? "preparing"];
});
const progressDetail = computed(() => {
  const value = moveState.value?.progress;
  if (!value || moveState.value?.phase !== "copying") return "";
  return `${value.copiedFiles}/${value.totalFiles} 个文件 · ${formatSize(
    value.copiedBytes,
  )}/${formatSize(value.totalBytes)}`;
});

watch(parent, () => {
  validation.value = null;
  validateError.value = "";
});

function openDialog() {
  parent.value = "";
  validation.value = null;
  validateError.value = "";
  startError.value = "";
  dialogVisible.value = true;
}

async function openDirectory() {
  opening.value = true;
  try {
    await openHomeDirectory();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    opening.value = false;
  }
}

async function pick() {
  picking.value = true;
  try {
    const result = await pickHomeDirectory();
    if (result.path) parent.value = result.path;
  } catch (error) {
    validateError.value = errorMessage(error);
  } finally {
    picking.value = false;
  }
}

async function validate() {
  const value = parent.value.trim();
  if (!value) return;
  validating.value = true;
  validateError.value = "";
  validation.value = null;
  try {
    validation.value = await validateHomeParent(value);
  } catch (error) {
    validateError.value = errorMessage(error);
  } finally {
    validating.value = false;
  }
}

async function confirmMove() {
  const result = validation.value;
  if (!result) return;
  try {
    await ElMessageBox.confirm(
      `将把数据迁移到：\n${result.targetHome}\n\n迁移期间本地服务会停止，完成后自动重启；旧数据目录会先保留，之后你可以决定是否删除。`,
      "确认迁移数据",
      {
        type: "warning",
        confirmButtonText: "开始迁移",
        cancelButtonText: "取消",
      },
    );
  } catch {
    return;
  }
  starting.value = true;
  startError.value = "";
  try {
    const started = await startHomeMove({
      parent: parent.value.trim(),
      confirmTarget: result.targetHome,
    });
    dialogVisible.value = false;
    moveState.value = {
      status: "running",
      phase: "preparing",
      jobId: started.jobId,
      toHome: started.targetHome,
    };
    startWatching();
    ElMessage.success("迁移已开始，本地服务即将短暂停止");
  } catch (error) {
    startError.value = errorMessage(error);
  } finally {
    starting.value = false;
  }
}

function startWatching() {
  if (watching.value) return;
  watching.value = true;
  offline.value = false;
  watchResult.value = "";
  watchError.value = "";
  successMessage.value = "";
  elapsedSeconds.value = 0;
  consecutiveFailures = 0;
  watchStartedAt = Date.now();
  watchDeadline = watchStartedAt + 10 * 60 * 1000;
  void poll();
}

function stopPolling() {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }
  watching.value = false;
  offline.value = false;
}

async function poll() {
  if (!watching.value) return;
  updateElapsed();
  try {
    const next = await fetchHomeMove();
    moveState.value = next;
    offline.value = false;
    consecutiveFailures = 0;
    if (next.status === "completed") {
      finishSuccess(next);
      return;
    }
    if (next.status === "failed") {
      finishFailure(next);
      return;
    }
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 0 || error.status >= 500)
    ) {
      offline.value = true;
      consecutiveFailures += 1;
      if (Date.now() > watchDeadline)
        finishFailure(
          null,
          "等待迁移完成超时，请查看配置目录 logs 下的迁移日志。",
        );
      return;
    }
    finishFailure(null, errorMessage(error));
    return;
  } finally {
    schedulePoll();
  }
}

function schedulePoll() {
  if (!watching.value) return;
  const delay = offline.value
    ? Math.min(5000, 1000 + consecutiveFailures * 1000)
    : 1000;
  pollTimer = window.setTimeout(() => void poll(), delay);
}

function updateElapsed() {
  const started = Date.parse(moveState.value?.startedAt ?? "");
  const base = Number.isFinite(started) ? started : watchStartedAt;
  if (!base) return;
  elapsedSeconds.value = Math.max(0, Math.floor((Date.now() - base) / 1000));
}

function formatDuration(total: number) {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function finishSuccess(next: HomeMoveView) {
  stopPolling();
  watchResult.value = "success";
  successMessage.value = `迁移完成，数据已保存到 ${next.toHome ?? "新位置"}，页面即将重新加载。`;
  emit("refresh");
  reloadTimer = window.setTimeout(() => window.location.reload(), 2500);
}

function finishFailure(next: HomeMoveView | null, fallback?: string) {
  stopPolling();
  watchResult.value = "failed";
  watchError.value = next ? describeFailure(next) : (fallback ?? "迁移失败");
}

function describeFailure(state: HomeMoveView) {
  const error = state.error;
  if (!error) return "迁移未完成，请查看配置目录 logs 下的迁移日志后重试。";
  const rollback =
    error.rollback === "restored-old"
      ? "旧版本与旧数据已恢复。"
      : error.rollback === "failed"
        ? "回滚失败，请手动启动旧版本并检查迁移日志。"
        : "";
  return `${error.message}（阶段：${phaseLabels[error.phase]}）${
    rollback ? ` ${rollback}` : ""
  }`;
}

async function restoreState() {
  try {
    const next = await fetchHomeMove();
    if (next.status === "running") {
      moveState.value = next;
      startWatching();
      return;
    }
    if (next.status === "failed") {
      const updatedAt = Date.parse(next.updatedAt ?? "");
      if (Number.isFinite(updatedAt) && updatedAt >= Date.now() - 86_400_000) {
        moveState.value = next;
        watchResult.value = "failed";
        watchError.value = describeFailure(next);
      }
    }
  } catch {
    // 状态不可读时保持面板默认展示
  }
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

onMounted(restoreState);
onBeforeUnmount(() => {
  stopPolling();
  if (reloadTimer) window.clearTimeout(reloadTimer);
});
</script>

<template>
  <section class="surface settings-section storage-panel">
    <h2>本地存储</h2>
    <p class="muted">
      数据库保存结构化事实，工作区保存文件产物；修改保存位置时会一并迁移。
    </p>

    <el-descriptions :column="1" border>
      <el-descriptions-item label="保存位置">
        <div class="home-path">
          <code>{{ info.homePath }}</code>
          <el-tag size="small" effect="plain">{{ sourceLabel }}</el-tag>
        </div>
      </el-descriptions-item>
      <el-descriptions-item label="数据库位置">
        <code>{{ info.databasePath }}</code>
      </el-descriptions-item>
      <el-descriptions-item label="文件工作区">
        <code>{{ info.workspacePath }}</code>
      </el-descriptions-item>
      <el-descriptions-item label="应用版本">
        {{ info.version }} · 数据库 schema {{ info.schemaVersion }}
      </el-descriptions-item>
    </el-descriptions>

    <el-alert
      v-if="lockedLabel"
      :title="lockedLabel"
      description="如需更换保存位置，请调整启动配置或改用正式发布包。"
      type="info"
      :closable="false"
      show-icon
    />
    <el-alert
      v-else-if="!info.dataRootEditable"
      title="当前环境不支持从应用内修改保存位置"
      type="info"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="info.moveInProgress && !watching && watchResult !== 'failed'"
      title="已有迁移任务正在进行"
      description="迁移完成后刷新页面即可查看新的保存位置。"
      type="warning"
      :closable="false"
      show-icon
    />

    <div class="storage-actions">
      <el-button :loading="opening" @click="openDirectory"
        >在资源管理器中打开</el-button
      >
      <el-button
        type="primary"
        :disabled="!info.dataRootEditable || info.moveInProgress || watching"
        @click="openDialog"
      >
        修改保存位置
      </el-button>
      <span class="muted">迁移会先备份现有数据，成功后自动重启本地服务。</span>
    </div>

    <PendingCleanupActions
      v-if="info.pendingOldData && !watching"
      :pending="info.pendingOldData"
      :new-home="info.homePath"
    />

    <div v-if="watching" class="move-progress">
      <el-progress
        :percentage="percent"
        :stroke-width="8"
        :status="offline ? 'warning' : undefined"
      />
      <div class="move-progress-text">
        <span>{{ phaseText }}</span>
        <span class="muted"
          >已用 {{ formatDuration(elapsedSeconds)
          }}<template v-if="progressDetail">
            · {{ progressDetail }}</template
          ></span
        >
      </div>
      <p class="muted">
        迁移期间本地服务会停止，页面与服务的连接可能短暂中断。
      </p>
    </div>
    <el-alert
      v-else-if="watchResult === 'success'"
      :title="successMessage"
      type="success"
      :closable="false"
      show-icon
    />
    <el-alert
      v-else-if="watchResult === 'failed'"
      title="数据迁移未完成"
      :description="watchError"
      type="error"
      :closable="false"
      show-icon
    />
    <div v-if="watchResult === 'failed'" class="storage-actions">
      <el-button size="small" type="primary" @click="openDialog"
        >重新选择位置</el-button
      >
    </div>

    <el-dialog
      v-model="dialogVisible"
      title="修改数据保存位置"
      width="min(620px, 92vw)"
      :close-on-click-modal="false"
      :show-close="!starting"
    >
      <div class="home-dialog">
        <p class="muted">
          选择保存数据的父目录，应用会在其中创建或复用
          <code>superPM</code> 子目录作为数据根。
        </p>
        <p class="muted">
          迁移期间请不要关闭窗口或断开目标磁盘；旧数据会保留，完成后可再决定是否删除。
        </p>
        <div class="home-input-row">
          <el-input
            v-model="parent"
            placeholder="例如 D:\superPMData"
            clearable
            :disabled="starting"
            @keyup.enter="validate"
          />
          <el-button :loading="picking" :disabled="starting" @click="pick"
            >选择目录…</el-button
          >
          <el-button
            :loading="validating"
            :disabled="!parent.trim() || starting"
            @click="validate"
            >校验</el-button
          >
        </div>

        <el-alert
          v-if="validateError"
          :title="validateError"
          type="error"
          :closable="false"
          show-icon
        />
        <template v-if="validation">
          <div class="validation-target">
            <span class="muted">目标数据目录</span>
            <code>{{ validation.targetHome }}</code>
          </div>
          <el-alert
            v-if="validation.blockedReasons.length"
            title="该位置不可用"
            type="error"
            :closable="false"
            show-icon
          >
            <ul class="validation-list">
              <li v-for="reason in validation.blockedReasons" :key="reason">
                {{ reason }}
              </li>
            </ul>
          </el-alert>
          <el-alert
            v-if="validation.warnings.length"
            title="注意事项"
            type="warning"
            :closable="false"
            show-icon
          >
            <ul class="validation-list">
              <li v-for="warning in validation.warnings" :key="warning">
                {{ warning }}
              </li>
            </ul>
          </el-alert>
          <div class="validation-metrics">
            <div>
              <span class="muted">待迁移数据</span>
              <strong>{{ formatSize(validation.sourceBytes) }}</strong>
            </div>
            <div>
              <span class="muted">需要空间</span>
              <strong>{{ formatSize(validation.requiredBytes) }}</strong>
            </div>
            <div>
              <span class="muted">可用空间</span>
              <strong>{{ formatSize(validation.freeBytes) }}</strong>
            </div>
            <div>
              <span class="muted">数据库</span>
              <strong>{{
                validation.databaseExists
                  ? `${validation.databaseRows ?? 0} 条记录`
                  : "无"
              }}</strong>
            </div>
            <div>
              <span class="muted">工作区文件</span>
              <strong>{{ validation.workspaceFiles }}</strong>
            </div>
          </div>
        </template>

        <el-alert
          v-if="startError"
          :title="startError"
          type="error"
          :closable="false"
          show-icon
        />
      </div>
      <template #footer>
        <el-button :disabled="starting" @click="dialogVisible = false"
          >取消</el-button
        >
        <el-button
          type="primary"
          :disabled="!canStart"
          :loading="starting"
          @click="confirmMove"
          >开始迁移</el-button
        >
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.storage-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.home-path {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.home-path code,
.storage-actions code {
  overflow-wrap: anywhere;
}
.storage-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.storage-actions .muted {
  font-size: 12px;
}
.move-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
}
.move-progress-text {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 6px 16px;
  font-size: 12px;
}
.move-progress p {
  margin: 0;
  font-size: 12px;
}
.home-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.home-dialog p {
  margin: 0;
  line-height: 1.7;
}
.home-input-row {
  display: flex;
  gap: 8px;
}
.home-input-row .el-input {
  flex: 1;
  min-width: 0;
}
.validation-target {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.validation-target code {
  overflow-wrap: anywhere;
}
.validation-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
.validation-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px 16px;
  padding: 12px 14px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.validation-metrics div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}
.validation-metrics .muted {
  font-size: 12px;
}
@media (max-width: 700px) {
  .home-input-row {
    flex-wrap: wrap;
  }
  .home-input-row .el-input {
    flex-basis: 100%;
  }
}
</style>
