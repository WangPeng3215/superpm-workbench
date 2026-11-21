<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowLeftOutlined } from "@ant-design/icons-vue";
import {
  projectCreateSchema,
  projectStatusLabels,
  type Project,
  type ProjectCreateParsed,
  type ProjectDetail,
  type ProjectLifecycleAction,
} from "@superpm/shared";
import { projectApi } from "../api/projects";
import { deliveryApi } from "../api/deliveries";
import { ApiError, errorMessage } from "../api/client";
import { decorative } from "../components/decorativeIcon";
import { authStore } from "../stores/auth";
import { setTabLabel } from "../stores/tabs";
import {
  invalidateProjectSessions,
  registerEditingSession,
} from "../stores/editing-sessions";
import {
  createVersionedAutoSave,
  type VersionedSaveState,
} from "../features/editing/versioned-autosave";
import ProjectMembersDialog from "../features/projects/ProjectMembersDialog.vue";
import ProjectRequirementsPanel from "../features/projects/ProjectRequirementsPanel.vue";
import ProjectTasksPanel from "../features/projects/ProjectTasksPanel.vue";
import ProjectWorklogPanel from "../features/projects/ProjectWorklogPanel.vue";
import ProjectDeliveryPanel from "../features/projects/ProjectDeliveryPanel.vue";
import ProjectOverviewPanel from "../features/projects/ProjectOverviewPanel.vue";
import ProjectActivityPanel from "../features/projects/ProjectActivityPanel.vue";
import ProjectDocumentsPanel from "../features/projects/ProjectDocumentsPanel.vue";
import type { ProjectNavigationTarget } from "../features/projects/project-panels";
const BackIcon = decorative(ArrowLeftOutlined);
const route = useRoute(),
  router = useRouter();
const id = Number(route.params.id),
  path = `/projects/${id}`;
const detail = ref<ProjectDetail>(),
  draft = ref<ProjectCreateParsed>(),
  base = ref<ProjectCreateParsed>();
const loading = ref(false),
  error = ref(""),
  actionError = ref(""),
  actionDetails = ref(""),
  storageError = ref("");
const state = ref<VersionedSaveState>("idle"),
  saveError = ref(""),
  membersOpen = ref(false),
  acting = ref(false);
const closureCheck =
  ref<Awaited<ReturnType<typeof deliveryApi.closureCheck>>>();
const activeTab = ref("overview"),
  recoveredConflict = ref(false);
const requirements = ref<InstanceType<typeof ProjectRequirementsPanel>>();
const tasks = ref<InstanceType<typeof ProjectTasksPanel>>();
const delivery = ref<InstanceType<typeof ProjectDeliveryPanel>>();
const documentsPanel = ref<InstanceType<typeof ProjectDocumentsPanel>>();
const storageKey = `superpm.draft.${authStore.user?.id}.project.${id}`;
const fields = [
  "name",
  "goal",
  "scopeSummary",
  "customerName",
  "customerContact",
  "plannedStartDate",
  "targetDeliveryDate",
] as const;
const pick = (project: Project): ProjectCreateParsed =>
  Object.fromEntries(
    fields.map((key) => [key, project[key]]),
  ) as ProjectCreateParsed;
const dirty = computed(
  () =>
    !!draft.value &&
    !!base.value &&
    fields.some((key) => draft.value![key] !== base.value![key]),
);
const owner = computed(() =>
  detail.value?.members.some(
    (member) =>
      member.userId === authStore.user?.id &&
      member.status === "active" &&
      member.accountStatus === "active" &&
      member.roles.includes("owner"),
  ),
);
const editable = computed(
  () =>
    !!detail.value?.capabilities.canEditProject &&
    !recoveredConflict.value &&
    state.value !== "conflict",
);
const saveLabel = computed(
  () =>
    ({
      idle: "已同步",
      pending: "等待自动保存…",
      saving: "正在保存…",
      saved: "已自动保存",
      blocked: "请检查项目名称和日期",
      error: "保存失败",
      conflict: "存在版本冲突",
      unauthorized: "登录已失效，草稿已保留",
      forbidden: "访问权限已失效",
    })[recoveredConflict.value ? "conflict" : state.value],
);
let saver:
  | ReturnType<typeof createVersionedAutoSave<Project, ProjectCreateParsed>>
  | undefined;
let savedResponse: ProjectDetail | undefined;
let applying = false,
  revision = 0,
  initialRestore = true;
function clearDraftStorage() {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {}
}
function persistDraft() {
  if (!draft.value || !detail.value) return;
  try {
    if (dirty.value)
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ version: saverVersion, draft: draft.value }),
      );
    else clearDraftStorage();
  } catch {
    storageError.value =
      "浏览器无法保存会话草稿，请勿刷新页面，并确认内容已保存到服务。";
  }
}
let saverVersion = 1;
function deny() {
  revision++;
  saver?.invalidate();
  requirements.value?.invalidate();
  detail.value = undefined;
  draft.value = undefined;
  base.value = undefined;
  membersOpen.value = false;
  clearDraftStorage();
  error.value = "你已无权访问此项目，已清理本页缓存。";
}
function handleError(e: unknown) {
  if (e instanceof ApiError && [403, 404].includes(e.status)) {
    deny();
    invalidateProjectSessions(id);
  }
}
function installSaver(project: Project) {
  saver?.dispose();
  saverVersion = project.version;
  saver = createVersionedAutoSave<Project, ProjectCreateParsed>({
    initial: project,
    snapshot: () => {
      if (
        !draft.value ||
        !detail.value?.capabilities.canEditProject ||
        recoveredConflict.value
      )
        return null;
      const parsed = projectCreateSchema.safeParse(draft.value);
      return parsed.success ? { ...draft.value } : null;
    },
    persist: async (patch, expectedVersion) => {
      const response = await projectApi.update(id, {
        ...patch,
        expectedVersion,
      });
      savedResponse = response;
      return response.project;
    },
    apply(server, sent) {
      if (savedResponse) detail.value = savedResponse;
      const saved = pick(server),
        current = draft.value,
        next = { ...saved };
      if (current)
        for (const key of fields)
          if (current[key] !== sent[key])
            Object.assign(next, { [key]: current[key] });
      applying = true;
      draft.value = next;
      base.value = saved;
      saverVersion = server.version;
      applying = false;
      setTabLabel(path, `${server.projectNo} · ${server.name}`);
      persistDraft();
    },
    onStateChange: (value) => {
      state.value = value;
    },
    onError(e) {
      saveError.value = errorMessage(e);
      if (e instanceof ApiError && e.status === 409)
        saveError.value =
          "项目已被其他成员修改，本地草稿已保留。请复制草稿后读取最新内容并手动合并。";
      handleError(e);
    },
  });
}
watch(
  draft,
  () => {
    if (applying || !draft.value) return;
    persistDraft();
    if (dirty.value && !recoveredConflict.value) saver?.schedule();
  },
  { deep: true, flush: "sync" },
);
async function load() {
  const token = ++revision;
  loading.value = true;
  error.value = "";
  try {
    const response = await projectApi.get(id);
    if (token !== revision) return;
    applying = true;
    detail.value = response;
    base.value = pick(response.project);
    draft.value = { ...base.value };
    applying = false;
    recoveredConflict.value = false;
    installSaver(response.project);
    setTabLabel(
      path,
      `${response.project.projectNo} · ${response.project.name}`,
    );
    if (initialRestore && response.capabilities.canEditProject) {
      initialRestore = false;
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (raw) {
          const stored = JSON.parse(raw) as { version: number; draft: unknown };
          const parsed = projectCreateSchema.safeParse(stored.draft);
          if (parsed.success) {
            applying = true;
            draft.value = parsed.data;
            applying = false;
            if (stored.version !== response.project.version) {
              recoveredConflict.value = true;
              state.value = "conflict";
            } else if (dirty.value) saver?.schedule();
          }
        }
      } catch {
        storageError.value = "未能恢复会话草稿，请检查浏览器存储设置。";
      }
    }
  } catch (e) {
    if (token === revision) {
      error.value = errorMessage(e);
      handleError(e);
    }
  } finally {
    if (token === revision) loading.value = false;
  }
}
async function flush() {
  if (!detail.value) return true;
  if (recoveredConflict.value || state.value === "conflict") return false;
  const ok = await saver?.flush();
  if (ok === false) {
    ElMessage.warning("项目尚未保存，请处理保存提示后继续。");
    return false;
  }
  return (await requirements.value?.flush()) ?? true;
}
const unregister = registerEditingSession(path, {
  flush,
  projectId: id,
  invalidate: deny,
  dispose: () => saver?.dispose(),
});
onBeforeRouteLeave(flush);
async function reloadLatest() {
  try {
    if (dirty.value)
      await ElMessageBox.confirm(
        "读取最新内容将放弃本页草稿。请先复制需要保留的修改。",
        "读取最新项目",
        {
          confirmButtonText: "读取最新内容",
          cancelButtonText: "保留草稿",
          type: "warning",
        },
      );
    clearDraftStorage();
    initialRestore = false;
    await load();
  } catch {}
}
async function copyDraft() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(draft.value, null, 2));
    ElMessage.success("草稿已复制");
  } catch {
    ElMessage.warning("无法访问剪贴板，请在下方草稿区手动复制。");
  }
}
function updated(response: ProjectDetail) {
  detail.value = response;
  applying = true;
  base.value = pick(response.project);
  draft.value = { ...base.value };
  applying = false;
  installSaver(response.project);
  clearDraftStorage();
}
async function openMembers() {
  if (await flush()) membersOpen.value = true;
}
async function waitForPanelRef<T>(read: () => T | undefined) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = read();
    if (value) return value;
    await nextTick();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return read();
}
async function handleProjectNavigate(target: ProjectNavigationTarget) {
  if (!(await flush())) return;
  if (target.type === "requirement") {
    await router.push(`/requirements/${target.id}`);
    return;
  }
  activeTab.value =
    target.type === "task"
      ? "tasks"
      : target.type === "delivery"
        ? "delivery"
        : target.type === "document"
          ? "documents"
          : "overview";
  await nextTick();
  if (target.type === "task")
    await (await waitForPanelRef(() => tasks.value))?.openTaskById(target.id);
  if (target.type === "delivery")
    await (
      await waitForPanelRef(() => delivery.value)
    )?.openDeliveryById(target.id);
  if (target.type === "document")
    await (
      await waitForPanelRef(() => documentsPanel.value)
    )?.openDocumentById(target.id);
}
async function mutate(action: () => Promise<ProjectDetail>) {
  if (acting.value) return;
  acting.value = true;
  actionError.value = "";
  actionDetails.value = "";
  try {
    updated(await action());
  } catch (e) {
    actionError.value = errorMessage(e);
    if (e instanceof ApiError && e.details)
      actionDetails.value = JSON.stringify(e.details, null, 2);
    handleError(e);
  } finally {
    acting.value = false;
  }
}
const actionLabels: Partial<Record<ProjectLifecycleAction, string>> = {
  start: "开始项目",
  pause: "暂停项目",
  resume: "恢复项目",
  cancel: "取消项目",
  reopen: "重开项目",
  close: "结项项目",
};
async function lifecycle(action: ProjectLifecycleAction) {
  if (!(await flush()) || !detail.value) return;
  let reason = "";
  try {
    if (action !== "start")
      reason = (
        await ElMessageBox.prompt(
          "请说明本次操作原因，历史记录会保留。",
          actionLabels[action],
          {
            inputType: "textarea",
            inputValidator: (value) => !!value?.trim() || "请填写操作原因",
            confirmButtonText: "确认",
            cancelButtonText: "取消",
          },
        )
      ).value.trim();
    else
      await ElMessageBox.confirm(
        "确认项目与产品负责人后，即可开始推进项目。",
        "开始项目",
        { confirmButtonText: "开始项目", cancelButtonText: "取消" },
      );
  } catch {
    return;
  }
  await mutate(() => {
    if (action === "close")
      return deliveryApi.closeProject(id, {
        expectedVersion: detail.value!.project.version,
        reason,
      });
    if (action === "reopen" && detail.value!.project.status === "closed")
      return deliveryApi.reopenProject(id, {
        expectedVersion: detail.value!.project.version,
        reason,
      });
    return projectApi.lifecycle(id, {
      action,
      reason,
      expectedVersion: detail.value!.project.version,
    });
  });
}
async function closeProject() {
  if (
    !detail.value ||
    !detail.value.capabilities.canCloseProject ||
    !(await flush())
  )
    return;
  try {
    closureCheck.value = await deliveryApi.closureCheck(id);
    if (!closureCheck.value.canClose) {
      actionError.value = "当前项目尚不能结项";
      actionDetails.value = closureCheck.value.blockers
        .map((item) => item.reason)
        .join("；");
      return;
    }
  } catch (e) {
    actionError.value = errorMessage(e);
    return;
  }
  await lifecycle("close");
}
async function archive() {
  if (!(await flush()) || !detail.value) return;
  const archived = !detail.value.project.archivedAt;
  try {
    await ElMessageBox.confirm(
      archived
        ? "归档后项目默认只读，可以随时解除归档。"
        : "解除归档后，项目仍保留原业务状态。",
      archived ? "归档项目" : "解除归档",
      { confirmButtonText: "确认", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  await mutate(() =>
    projectApi.archive(id, {
      archived,
      expectedVersion: detail.value!.project.version,
    }),
  );
}
async function refreshPermission() {
  if (
    !detail.value ||
    loading.value ||
    acting.value ||
    state.value === "saving"
  )
    return;
  const token = revision;
  try {
    const response = await projectApi.get(id);
    if (token !== revision || !detail.value) return;
    if (!dirty.value) updated(response);
    else {
      detail.value.members = response.members;
      detail.value.capabilities = response.capabilities;
      if (!response.capabilities.canEditProject) {
        saver?.invalidate();
        applying = true;
        draft.value = pick(response.project);
        base.value = pick(response.project);
        applying = false;
        clearDraftStorage();
      }
    }
  } catch (e) {
    handleError(e);
  }
}
function visibility() {
  if (document.visibilityState === "visible") void refreshPermission();
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || state.value === "saving") {
    event.preventDefault();
    event.returnValue = "";
  }
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(() => void refreshPermission(), 30_000);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("beforeunload", beforeUnload);
});
onActivated(() => {
  if (detail.value) void refreshPermission();
});
onBeforeUnmount(() => {
  revision++;
  saver?.dispose();
  unregister();
  clearInterval(timer);
  document.removeEventListener("visibilitychange", visibility);
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>
<template>
  <div class="project-detail" v-loading="loading">
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    /><el-button v-if="error && !detail" @click="router.push('/projects')"
      >返回项目列表</el-button
    >
    <template v-if="detail && draft">
      <section class="surface project-header">
        <el-button
          class="back-button"
          size="small"
          :icon="BackIcon"
          @click="router.push('/projects')"
          >返回项目列表</el-button
        >
        <div class="header-scroll" aria-label="项目头部信息与操作">
          <div class="identity">
            <span class="project-no">{{ detail.project.projectNo }}</span>
            <h1 :title="detail.project.name">{{ detail.project.name }}</h1>
          </div>
          <div class="project-status">
            <el-tag size="small">{{
              projectStatusLabels[detail.project.status]
            }}</el-tag
            ><el-tag v-if="detail.project.archivedAt" size="small" type="info"
              >已归档</el-tag
            >
          </div>
          <div class="header-actions">
            <span role="status" class="save-state">{{ saveLabel }}</span
            ><el-button size="small" @click="openMembers"
              >成员
              {{
                detail.members.filter((m) => m.status === "active").length
              }}</el-button
            ><template v-if="owner && !detail.project.archivedAt"
              ><el-button
                v-if="detail.project.status === 'planning'"
                size="small"
                type="primary"
                :loading="acting"
                @click="lifecycle('start')"
                >开始项目</el-button
              ><el-button
                v-if="
                  ['active', 'awaiting_acceptance'].includes(
                    detail.project.status,
                  )
                "
                size="small"
                :disabled="acting"
                @click="lifecycle('pause')"
                >暂停项目</el-button
              ><el-button
                v-if="detail.project.status === 'paused'"
                size="small"
                :disabled="acting"
                @click="lifecycle('resume')"
                >恢复项目</el-button
              ><el-button
                v-if="!['closed', 'cancelled'].includes(detail.project.status)"
                size="small"
                :disabled="acting"
                @click="lifecycle('cancel')"
                >取消项目</el-button
              ><el-button
                v-if="detail.project.status === 'cancelled'"
                size="small"
                :disabled="acting"
                @click="lifecycle('reopen')"
                >重开项目</el-button
              ><el-button
                v-if="detail.project.status === 'closed'"
                size="small"
                :disabled="acting"
                @click="lifecycle('reopen')"
                >重开项目</el-button
              ><el-button
                v-if="
                  detail.capabilities.canCloseProject &&
                  ['active', 'awaiting_acceptance'].includes(
                    detail.project.status,
                  )
                "
                size="small"
                type="primary"
                :disabled="acting"
                @click="closeProject"
                >结项项目</el-button
              ></template
            ><el-button
              v-if="
                owner &&
                (detail.project.archivedAt ||
                  ['closed', 'cancelled'].includes(detail.project.status))
              "
              size="small"
              :disabled="acting"
              @click="archive"
              >{{
                detail.project.archivedAt ? "解除归档" : "归档项目"
              }}</el-button
            >
          </div>
        </div>
      </section>
      <el-alert
        v-if="!detail.capabilities.canEditProject"
        title="当前项目为只读状态，或当前账号没有项目维护权限。"
        type="info"
        :closable="false"
      />
      <el-alert
        v-if="storageError"
        :title="storageError"
        type="warning"
        :closable="false"
      />
      <el-alert
        v-if="actionError"
        :title="actionError"
        type="error"
        :closable="false"
      />
      <pre v-if="actionDetails" class="draft-preview">{{ actionDetails }}</pre>
      <section
        v-if="
          state === 'conflict' ||
          recoveredConflict ||
          state === 'error' ||
          state === 'unauthorized'
        "
        class="surface conflict-panel"
      >
        <el-alert
          :title="
            saveError ||
            '会话草稿的基准版本与服务器不同，请先保留草稿再读取最新内容。'
          "
          type="warning"
          :closable="false"
        />
        <div class="conflict-actions">
          <el-button @click="copyDraft">复制本地草稿</el-button
          ><el-button @click="reloadLatest">读取最新内容</el-button
          ><el-button
            v-if="state === 'error'"
            type="primary"
            @click="saver?.retry()"
            >重试保存</el-button
          >
        </div>
        <details>
          <summary>查看本地草稿</summary>
          <pre class="draft-preview">{{ JSON.stringify(draft, null, 2) }}</pre>
        </details>
      </section>
      <section class="surface project-content">
        <el-tabs v-model="activeTab" :before-leave="flush"
          ><el-tab-pane label="项目概览" name="overview"
            ><ProjectOverviewPanel
              :project-id="id"
              :readonly="!detail.capabilities.canEditProject"
              @navigate="handleProjectNavigate"
            />
            <div class="overview-intro">
              <div>
                <h2>项目基本信息</h2>
                <p>创建后可逐步完善，普通字段在停止输入后自动保存。</p>
              </div>
              <el-button :disabled="!dirty || !editable" @click="flush"
                >立即保存</el-button
              >
            </div>
            <el-form
              class="project-fields"
              label-position="top"
              :disabled="!editable"
              @submit.prevent="flush"
              ><el-form-item label="项目名称" required class="wide"
                ><el-input
                  v-model="draft.name"
                  aria-label="项目名称"
                  maxlength="200"
                  show-word-limit
                  @blur="flush" /></el-form-item
              ><el-form-item label="项目目标" class="wide"
                ><el-input
                  v-model="draft.goal"
                  aria-label="项目目标"
                  type="textarea"
                  :rows="2"
                  maxlength="5000"
                  placeholder="希望达成什么结果"
                  @blur="flush" /></el-form-item
              ><el-form-item label="范围说明" class="wide"
                ><el-input
                  v-model="draft.scopeSummary"
                  aria-label="范围说明"
                  type="textarea"
                  :rows="2"
                  maxlength="5000"
                  placeholder="本项目做什么，边界在哪里"
                  @blur="flush" /></el-form-item
              ><el-form-item label="客户 / 业务方"
                ><el-input
                  v-model="draft.customerName"
                  aria-label="客户或业务方"
                  maxlength="200"
                  @blur="flush" /></el-form-item
              ><el-form-item label="业务联系人"
                ><el-input
                  v-model="draft.customerContact"
                  aria-label="业务联系人"
                  maxlength="2000"
                  @blur="flush" /></el-form-item
              ><el-form-item label="计划开始日"
                ><el-date-picker
                  v-model="draft.plannedStartDate"
                  aria-label="计划开始日"
                  value-format="YYYY-MM-DD"
                  type="date"
                  @change="flush" /></el-form-item
              ><el-form-item label="目标交付日"
                ><el-date-picker
                  v-model="draft.targetDeliveryDate"
                  aria-label="目标交付日"
                  value-format="YYYY-MM-DD"
                  type="date"
                  @change="flush" /></el-form-item
            ></el-form>
            <div class="project-meta">
              <span
                >项目负责人：{{
                  detail.members.find(
                    (m) => m.userId === detail?.project.ownerUserId,
                  )?.displayName || "待确认"
                }}</span
              ><span
                >产品负责人：{{
                  detail.members.find(
                    (m) => m.userId === detail?.project.productOwnerUserId,
                  )?.displayName || "待确认"
                }}</span
              >
            </div> </el-tab-pane
          ><el-tab-pane label="项目需求" name="requirements" lazy
            ><ProjectRequirementsPanel
              ref="requirements"
              :detail="detail"
              :before-action="flush"
              @updated="updated"
              @denied="deny" /></el-tab-pane
          ><el-tab-pane label="执行任务" name="tasks" lazy
            ><ProjectTasksPanel
              ref="tasks"
              :project-id="id"
              :members="detail.members" /></el-tab-pane
          ><el-tab-pane label="项目工时" name="worklog" lazy
            ><ProjectWorklogPanel :project-id="id" /> </el-tab-pane
          ><el-tab-pane label="交付验收" name="delivery" lazy
            ><ProjectDeliveryPanel
              ref="delivery"
              :project-id="id"
              :detail="detail"
              :before-action="flush"
              @updated="updated"
              @denied="deny" /></el-tab-pane
          ><el-tab-pane label="项目动态" name="activity" lazy
            ><ProjectActivityPanel
              :project-id="id"
              :readonly="!detail.capabilities.canEditProject"
              @navigate="handleProjectNavigate" /></el-tab-pane
          ><el-tab-pane label="项目资料" name="documents" lazy
            ><ProjectDocumentsPanel
              ref="documentsPanel"
              :project-id="id"
              :readonly="!detail.capabilities.canEditProject" /></el-tab-pane
        ></el-tabs>
      </section>
      <ProjectMembersDialog
        v-model="membersOpen"
        :detail="detail"
        @updated="updated"
        @denied="deny"
      />
    </template>
  </div>
</template>
<style scoped>
.project-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.project-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0 12px;
}
.back-button {
  flex: none;
  white-space: nowrap;
}
.header-scroll {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}
.identity,
.project-status,
.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.identity {
  flex: 1 1 auto;
  min-width: 0;
  gap: 8px;
}
.project-no {
  flex: none;
  font-family: Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  padding: 2px 9px;
  border-radius: 999px;
  color: var(--brand);
  background: var(--bg-brand-soft);
}
.identity h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.2px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.project-status,
.header-actions {
  flex: none;
}
.header-actions {
  justify-content: flex-end;
}
.header-actions .el-button {
  margin: 0;
}
.save-state {
  color: var(--text-muted);
  font-size: 11px;
  margin-right: 4px;
  white-space: nowrap;
}
.project-content {
  padding: 8px 22px 16px;
}
.overview-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 0 12px;
}
.overview-intro h2 {
  margin: 0;
  font-size: 18px;
}
.overview-intro p {
  margin: 4px 0 0;
  color: var(--text-secondary);
}
.project-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 20px;
  max-width: 1100px;
}
.project-fields :deep(.el-form-item) {
  margin-bottom: 12px;
}
.project-fields :deep(.el-form-item__label) {
  padding-bottom: 4px;
  line-height: 1.25;
}
.project-fields .wide {
  grid-column: 1/-1;
}
.project-fields .el-date-editor {
  width: 100%;
}
.project-meta {
  display: flex;
  gap: 28px;
  padding-top: 12px;
  border-top: 1px solid var(--border-base);
  color: var(--text-secondary);
}
.conflict-panel {
  padding: 16px;
}
.conflict-actions {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}
.draft-preview {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 12px;
  background: var(--bg-subtle);
  max-height: 300px;
  overflow: auto;
}
@media (max-width: 1100px) {
  .project-header {
    flex-wrap: nowrap;
  }
  .header-scroll {
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }
  .header-scroll::-webkit-scrollbar {
    display: none;
  }
  .header-actions {
    flex: none;
    flex-wrap: nowrap;
  }
}
@media (max-width: 750px) {
  .project-header {
    padding: 0 8px;
  }
  .identity {
    flex: 0 0 160px;
  }
  .header-actions {
    flex: none;
    flex-wrap: nowrap;
  }
  .project-fields {
    grid-template-columns: 1fr;
  }
  .project-meta {
    flex-direction: column;
    gap: 10px;
  }
  .project-content {
    padding: 8px 14px 16px;
  }
}
</style>
