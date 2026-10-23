<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { UpdateCheckResult, UpdateStatus } from "@superpm/shared";
import { ApiError, errorMessage } from "../../api/client";
import {
  checkUpdate,
  fetchUpdateStatus,
  installUpdate,
} from "../../api/update";

const status = ref<UpdateStatus | null>(null);
const statusLoading = ref(false);
const statusError = ref("");
const checking = ref(false);
const checkError = ref("");
const checkResult = ref<UpdateCheckResult | null>(null);
const installDialogVisible = ref(false);
const forceMcp = ref(false);
const starting = ref(false);
const watching = ref(false);
const offline = ref(false);
const targetVersion = ref("");
const finalResult = ref<"success" | "failed" | "rollback-failed" | null>(null);
const finalMessage = ref("");
let pollTimer = 0;
let reloadTimer = 0;
let polling = false;
let watchStartedAt = 0;
let watchDeadline = 0;

const currentVersion = computed(() => status.value?.currentVersion ?? "—");
const install = computed(() => status.value?.install ?? null);
const progress = computed(() => status.value?.progress ?? null);
const updaterProgressing = computed(
  () =>
    progress.value?.status === "starting" ||
    progress.value?.status === "running",
);
const mcpProcesses = computed(() => status.value?.mcpProcesses ?? []);
const busy = computed(
  () =>
    checking.value ||
    starting.value ||
    watching.value ||
    Boolean(status.value?.updateLock),
);
const percent = computed(() => {
  // 服务端下载阶段占前 90%，更新器自身阶段占后 10%，避免交接时进度回退。
  const value =
    install.value && install.value.status !== "installing"
      ? install.value.percent * 0.9
      : updaterProgressing.value
        ? 90 + (progress.value?.percent ?? 0) * 0.1
        : (install.value?.percent ?? progress.value?.percent ?? 0);
  return Math.min(100, Math.max(0, Math.round(value)));
});
const progressMessage = computed(() => {
  if (offline.value) return "本地服务正在重启，等待新版本就绪";
  if (
    install.value &&
    ["downloading", "verifying", "launching"].includes(install.value.status)
  )
    return install.value.message;
  if (updaterProgressing.value && progress.value?.message)
    return progress.value.message;
  if (install.value) return install.value.message;
  if (progress.value) return progress.value.message;
  return "正在等待更新状态";
});
const progressDetail = computed(() => {
  if (
    install.value &&
    install.value.status === "downloading" &&
    install.value.total > 0
  )
    return `${formatSize(install.value.received)} / ${formatSize(
      install.value.total,
    )}`;
  return "";
});
const sourceHost = computed(() => {
  try {
    return new URL(status.value?.manifestUrl ?? "").hostname;
  } catch {
    return status.value?.manifestUrl ?? "";
  }
});
const lastUpdate = computed(() => status.value?.lastUpdate ?? null);
const lastUpdateText = computed(() => {
  const result = lastUpdate.value;
  if (!result) return "";
  switch (result.status) {
    case "updated":
      return "更新成功";
    case "up-to-date":
      return "已是最新版本";
    case "failed":
      return "更新失败，旧版本保持运行";
    case "rolled-back":
      return "更新失败，已恢复旧版本与数据";
    case "rollback-failed":
      return "回滚失败，需要手动处理";
    default:
      return result.status;
  }
});
const lastUpdateTone = computed(() => {
  const code = lastUpdate.value?.status;
  if (code === "updated" || code === "up-to-date") return "success";
  if (code === "rollback-failed") return "danger";
  return "warning";
});

async function loadStatus() {
  statusLoading.value = true;
  statusError.value = "";
  try {
    applyStatus(await fetchUpdateStatus());
  } catch (error) {
    statusError.value = errorMessage(error);
  } finally {
    statusLoading.value = false;
  }
}

function applyStatus(next: UpdateStatus) {
  status.value = next;
  if (watching.value) {
    evaluateFinal(next);
    return;
  }
  if (
    next.install &&
    ["downloading", "verifying", "launching", "installing"].includes(
      next.install.status,
    )
  ) {
    startWatching(next.install.version, false);
    return;
  }
  if (next.install?.status === "failed") {
    finalResult.value = "failed";
    finalMessage.value = next.install.error ?? next.install.message;
    return;
  }
  if (
    next.updateLock &&
    next.progress &&
    (next.progress.status === "running" || next.progress.status === "starting")
  )
    startWatching(next.progress.to ?? "", false);
}

async function onCheck() {
  checking.value = true;
  checkError.value = "";
  checkResult.value = null;
  finalResult.value = null;
  try {
    checkResult.value = await checkUpdate();
  } catch (error) {
    checkError.value = errorMessage(error);
  } finally {
    checking.value = false;
  }
}

function openInstallDialog() {
  forceMcp.value = false;
  installDialogVisible.value = true;
  void loadStatus();
}

async function confirmInstall() {
  const result = checkResult.value;
  if (!result?.installable) return;
  if (forceMcp.value) {
    try {
      await ElMessageBox.confirm(
        "强制更新会结束仍在运行的 MCP 进程，正在执行的调用会失败，客户端可能需要重新连接。确定继续？",
        "强制更新确认",
        {
          type: "warning",
          confirmButtonText: "强制更新",
          cancelButtonText: "取消",
        },
      );
    } catch {
      return;
    }
  }
  starting.value = true;
  try {
    await installUpdate(result.latestVersion, forceMcp.value);
    installDialogVisible.value = false;
    startWatching(result.latestVersion, true);
  } catch (error) {
    if (error instanceof ApiError && error.code === "UPDATE_MCP_RUNNING")
      await loadStatus();
    ElMessage.error(errorMessage(error));
  } finally {
    starting.value = false;
  }
}

function startWatching(version: string, initiated: boolean) {
  if (watching.value) return;
  if (version) targetVersion.value = version;
  watching.value = true;
  offline.value = false;
  finalResult.value = null;
  finalMessage.value = "";
  watchStartedAt = Date.now();
  watchDeadline = watchStartedAt + 10 * 60 * 1000;
  if (initiated) checkResult.value = null;
  void poll();
  pollTimer = window.setInterval(() => void poll(), 1000);
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
  }
  watching.value = false;
  offline.value = false;
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const next = await fetchUpdateStatus();
    applyStatus(next);
  } catch (error) {
    const retryable =
      error instanceof ApiError && (error.status === 0 || error.status >= 500);
    if (retryable) {
      offline.value = true;
      if (Date.now() > watchDeadline)
        finishFailure(
          "等待服务重启超时。请查看数据根 logs/update.log 与 updates/last-update.json。",
          "failed",
        );
      return;
    }
    finishFailure(errorMessage(error), "failed");
  } finally {
    polling = false;
  }
}

function evaluateFinal(next: UpdateStatus) {
  const finish = finalState(next);
  if (finish) {
    if (finish.kind === "success") {
      stopPolling();
      finalResult.value = "success";
      finalMessage.value = `已更新到 v${next.currentVersion}，页面即将重新加载。`;
      reloadTimer = window.setTimeout(() => window.location.reload(), 2000);
    } else {
      finishFailure(finish.message, finish.kind);
    }
    return;
  }
  if (
    next.progress?.status === "running" &&
    !next.updateLock &&
    Date.now() - watchStartedAt > 20000
  ) {
    finishFailure(
      "更新器未完成且更新锁已释放。请查看数据根 logs/update.log 与 updates/last-update.json。",
      "failed",
    );
    return;
  }
  if (Date.now() > watchDeadline)
    finishFailure(
      "等待更新完成超时。请查看数据根 logs/update.log 与 updates/last-update.json。",
      "failed",
    );
}

function finalState(next: UpdateStatus): {
  kind: "success" | "failed" | "rollback-failed";
  message: string;
} | null {
  const recent = (value: string | undefined) => {
    const time = Date.parse(value ?? "");
    return Number.isFinite(time) && time >= watchStartedAt - 5000;
  };
  if (next.install?.status === "failed")
    return {
      kind: "failed",
      message: next.install.error ?? next.install.message,
    };
  const value = next.progress;
  if (
    value &&
    recent(value.updatedAt) &&
    [
      "updated",
      "up-to-date",
      "failed",
      "rolled-back",
      "rollback-failed",
    ].includes(value.status)
  ) {
    if (value.status === "updated" || value.status === "up-to-date")
      return { kind: "success", message: value.message };
    return {
      kind: value.status === "rollback-failed" ? "rollback-failed" : "failed",
      message: value.error ?? value.message,
    };
  }
  const last = next.lastUpdate;
  if (
    last &&
    recent(last.finishedAt) &&
    (last.to === targetVersion.value || last.version === targetVersion.value)
  ) {
    if (last.ok) return { kind: "success", message: lastUpdateText.value };
    return {
      kind: last.status === "rollback-failed" ? "rollback-failed" : "failed",
      message: last.error ?? lastUpdateText.value,
    };
  }
  if (
    targetVersion.value &&
    next.currentVersion === targetVersion.value &&
    !next.updateLock
  )
    return { kind: "success", message: "更新完成" };
  return null;
}

function finishFailure(message: string, kind: "failed" | "rollback-failed") {
  stopPolling();
  finalResult.value = kind;
  finalMessage.value = message || "更新失败";
}

function resetResult() {
  finalResult.value = null;
  finalMessage.value = "";
  checkError.value = "";
  void loadStatus();
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

onMounted(loadStatus);
onBeforeUnmount(() => {
  stopPolling();
  if (reloadTimer) window.clearTimeout(reloadTimer);
});
</script>

<template>
  <section
    class="surface settings-section update-panel"
    v-loading="statusLoading"
  >
    <div class="update-heading">
      <div>
        <h2>版本与更新</h2>
        <p class="muted">
          从 GitHub Releases 检查正式版本；更新前自动备份数据库与工作区。
        </p>
      </div>
      <el-tag effect="plain">当前版本 {{ currentVersion }}</el-tag>
    </div>

    <el-alert
      v-if="statusError"
      :title="statusError"
      type="error"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="status && !status.installSupported"
      :title="status.unsupportedReason ?? '当前环境不支持应用内更新'"
      type="info"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="status?.updateLock && !watching"
      title="更新正在进行"
      :description="`更新进程 PID ${status.updateLock.pid}，开始于 ${formatDate(
        status.updateLock.createdAt,
      )}。完成后请刷新页面。`"
      type="warning"
      :closable="false"
      show-icon
    />

    <div class="update-row">
      <el-button
        type="primary"
        :loading="checking"
        :disabled="busy || !status"
        @click="onCheck"
      >
        检查更新
      </el-button>
      <span class="muted update-source">
        更新源 {{ sourceHost || "—" }}
        <template v-if="status?.updaterVersion">
          · 更新器 v{{ status.updaterVersion }}
        </template>
      </span>
    </div>

    <el-alert
      v-if="checkError"
      :title="checkError"
      type="error"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="finalResult === 'success'"
      :title="finalMessage"
      type="success"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="finalResult === 'failed' || finalResult === 'rollback-failed'"
      :title="finalResult === 'rollback-failed' ? '回滚失败' : '更新失败'"
      :description="finalMessage"
      type="error"
      :closable="false"
      show-icon
    />
    <div v-if="finalResult" class="update-row">
      <el-button size="small" @click="resetResult">刷新状态</el-button>
    </div>

    <div v-if="checkResult" class="update-result">
      <template v-if="!checkResult.available">
        <el-alert
          :title="`当前已是最新版本 v${checkResult.currentVersion}`"
          type="success"
          :closable="false"
          show-icon
        />
        <span class="muted"
          >检查时间 {{ formatDate(checkResult.checkedAt) }}</span
        >
      </template>
      <template v-else>
        <div class="update-version">
          <strong>发现新版本 v{{ checkResult.latestVersion }}</strong>
          <el-tag size="small" effect="plain"
            >当前 v{{ checkResult.currentVersion }}</el-tag
          >
        </div>
        <div class="update-meta">
          <span>发布 {{ formatDate(checkResult.releasedAt) }}</span>
          <span>更新包 {{ formatSize(checkResult.updateSize) }}</span>
          <span>数据库 schema {{ checkResult.schemaVersion }}</span>
          <span v-if="checkResult.minUpdaterVersion"
            >最低更新器 {{ checkResult.minUpdaterVersion }}</span
          >
        </div>
        <pre v-if="checkResult.notes" class="update-notes">{{
          checkResult.notes
        }}</pre>
        <el-alert
          v-if="checkResult.blockedReason"
          :title="checkResult.blockedReason"
          type="warning"
          :closable="false"
          show-icon
        />
        <div class="update-actions">
          <el-button
            type="primary"
            :disabled="!checkResult.installable || busy"
            @click="openInstallDialog"
          >
            下载并安装 v{{ checkResult.latestVersion }}
          </el-button>
          <span v-if="mcpProcesses.length" class="muted"
            >{{ mcpProcesses.length }} 个 MCP 进程正在运行</span
          >
        </div>
      </template>
    </div>

    <div v-if="watching || install" class="update-progress">
      <el-progress
        :percentage="percent"
        :status="finalResult === 'failed' ? 'exception' : undefined"
        :stroke-width="8"
      />
      <div class="update-progress-text">
        <span>{{ progressMessage }}</span>
        <span v-if="progressDetail" class="muted">{{ progressDetail }}</span>
      </div>
      <p v-if="offline" class="muted">
        页面与本地服务暂时断开，更新器可能正在替换程序或迁移数据；服务恢复后页面会自动刷新。
      </p>
    </div>

    <div v-if="lastUpdate && !watching" class="last-update">
      <div class="update-version">
        <h3>上次更新</h3>
        <el-tag :type="lastUpdateTone" size="small" effect="plain">{{
          lastUpdateText
        }}</el-tag>
      </div>
      <div class="update-meta">
        <span v-if="lastUpdate.from || lastUpdate.to">
          v{{ lastUpdate.from ?? "?" }} → v{{ lastUpdate.to ?? "?" }}
        </span>
        <span v-if="lastUpdate.finishedAt"
          >完成于 {{ formatDate(lastUpdate.finishedAt) }}</span
        >
        <span v-if="lastUpdate.backupId">备份 {{ lastUpdate.backupId }}</span>
      </div>
      <p v-if="lastUpdate.error" class="update-error">
        {{ lastUpdate.error }}
      </p>
      <p v-if="lastUpdate.rollbackError" class="update-error">
        回滚错误：{{ lastUpdate.rollbackError }}
      </p>
    </div>
  </section>

  <el-dialog
    v-model="installDialogVisible"
    title="确认安装更新"
    width="520px"
    :close-on-click-modal="false"
  >
    <div v-if="checkResult" class="install-confirm">
      <p>
        将安装 <strong>v{{ checkResult.latestVersion }}</strong
        >。本地服务会短暂停止，程序文件被替换并执行数据库迁移。
      </p>
      <p class="muted">
        更新器会先创建更新前备份；失败时自动恢复旧程序与数据。
      </p>
      <el-alert
        v-if="mcpProcesses.length"
        type="warning"
        :closable="false"
        show-icon
        title="检测到 MCP 进程正在运行"
      >
        <div class="mcp-list">
          <el-tag
            v-for="process in mcpProcesses"
            :key="process.pid"
            size="small"
            effect="plain"
            >PID {{ process.pid }} · v{{ process.version }}</el-tag
          >
        </div>
        <p>
          请先关闭 MCP 客户端。更新器会等待 15
          秒让进程优雅退出；超时后只能强制结束。
        </p>
      </el-alert>
      <el-checkbox v-if="mcpProcesses.length" v-model="forceMcp">
        若 15 秒内未退出，强制结束 MCP 进程
      </el-checkbox>
      <p v-if="forceMcp" class="update-error">
        强制更新会使正在执行的 MCP 调用失败，客户端可能需要重新连接或重启。
      </p>
    </div>
    <template #footer>
      <el-button @click="installDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="starting" @click="confirmInstall">
        开始更新
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.update-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.update-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.update-heading h2 {
  margin: 0 0 6px;
}
.update-heading p {
  margin: 0;
}
.update-row,
.update-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.update-source {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.update-result {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--border-base);
  border-radius: 8px;
  background: var(--bg-subtle);
}
.update-version {
  display: flex;
  align-items: center;
  gap: 10px;
}
.update-version h3 {
  margin: 0;
  font-size: 14px;
}
.update-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  color: var(--text-muted);
  font-size: 12px;
}
.update-notes {
  max-height: 190px;
  overflow: auto;
  margin: 0;
  padding: 12px;
  border-radius: 6px;
  background: var(--bg-code);
  color: var(--text-regular);
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.update-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
}
.update-progress-text {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 6px 16px;
  font-size: 12px;
}
.update-progress p {
  margin: 0;
  font-size: 12px;
}
.last-update {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--border-soft);
}
.update-error {
  margin: 0;
  color: var(--danger-text);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.install-confirm {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.install-confirm p {
  margin: 0;
  line-height: 1.7;
}
.mcp-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
}
</style>
