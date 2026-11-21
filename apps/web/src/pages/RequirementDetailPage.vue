<script setup lang="ts">
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import type { TabPaneName } from "element-plus";
import {
  dateFields,
  dateLabels,
  optimizationPointStatusLabels,
  priorities,
  requirementStatuses,
  requirementTypes,
  stageLabels,
  stages,
  statusLabels,
  typeLabels,
  type ArtifactNode,
  type ProjectDetail,
  type Requirement,
  type RequirementOptimizationPointRef,
  type RequirementRelations,
  type RequirementUpdate,
  type Stage,
} from "@superpm/shared";
import { requirementApi } from "../api/requirements";
import { projectApi } from "../api/projects";
import { ApiError, errorMessage } from "../api/client";
import { setTabLabel } from "../stores/tabs";
import { authStore } from "../stores/auth";
import { registerEditingSession } from "../stores/editing-sessions";
import DocTabEditor from "../features/requirements/DocTabEditor.vue";
import RequirementDocManager from "../features/requirements/RequirementDocManager.vue";
import RequirementIssuesPanel from "../features/requirements/RequirementIssuesPanel.vue";
import InlineRichTextEditor from "../features/requirements/InlineRichTextEditor.vue";
import { tagTone } from "../features/requirements/enum-tags";
import {
  createVersionedAutoSave,
  type VersionedSaveState,
} from "../features/editing/versioned-autosave";
import {
  mergeRequirementDraft,
  readRequirementDraft,
  requirementDraftKey,
  requirementSnapshot as snapshot,
  writeRequirementDraft,
  type RequirementDraft as Editable,
} from "../features/requirements/requirement-draft";
import { optimizationStatusTone } from "../features/optimization-points/format";
import { requirementResponsibilityMembers } from "../features/requirements/project-members";
import { stageTransitionNeedsNote } from "../features/requirements/stage-transition";
import ProjectTasksPanel from "../features/projects/ProjectTasksPanel.vue";
import { clearResourceDrafts } from "../features/requirements/resource-draft";
const route = useRoute();
const router = useRouter();
// 详情路由按 fullPath 缓存（router/index.ts 中的 keepAlive），每个页面实例固定对应一个需求；
// 不使用全局 route.params，以免缓存页失活时被其他路由的参数变化重新加载覆盖草稿
const id = Number(route.params.id);
const path = route.path;
const accountId = authStore.user?.id;
const item = ref<Requirement>();
const projectContext = ref<ProjectDetail>();
const projectLoading = ref(false);
const projectError = ref("");
let projectRevision = 0;
const relations = ref<RequirementRelations>();
// 来源优化点：由优化点转换而来时展示，可点击回到来源记录
const sourcePoints = ref<RequirementOptimizationPointRef[]>([]);
const draft = ref<Editable>();
const savedDraft = ref<Editable>();
const stageNote = ref("");
const descriptionEditor = ref<InstanceType<typeof InlineRichTextEditor>>();
const loading = ref(false);
const error = ref("");
const saveState = ref<VersionedSaveState>("idle");
const saving = computed(() => saveState.value === "saving");
const saveError = ref("");
const storageError = ref("");
const conflictServer = ref<Requirement>();
const accessLost = ref(false);
let draftVersion = 0;
let storageKey: string | undefined;
let disposed = false;
let unregisterSession: (() => void) | undefined;
let permissionTimer: ReturnType<typeof setInterval> | undefined;
// 顶层页签：固定「需求详情」「文档管理」「问题记录」+ 动态文档页签（doc-<nodeId>）
const activeTab = ref("detail");
const propertiesOpen = ref(true);
// 动态文档页签：点击「文档管理」中的 md 文件（含需求记忆）时打开，可关闭
const docTabs = ref<{ node: ArtifactNode }[]>([]);
const docEditors = new Map<number, InstanceType<typeof DocTabEditor>>();
// 问题记录面板：保存流程在切换问题/页签时统一冲刷
const issuesPanel = ref<InstanceType<typeof RequirementIssuesPanel>>();
function setDocEditor(nodeId: number, el: unknown) {
  const comp = el as InstanceType<typeof DocTabEditor> | null;
  if (comp) docEditors.set(nodeId, comp);
  else docEditors.delete(nodeId);
}
// 冲刷所有文档页签的未保存内容；任一失败返回 false（导航中止）
async function flushDocs() {
  for (const editor of docEditors.values()) {
    if (!(await editor.flush())) return false;
  }
  return true;
}
// 右栏文件卡片点开 md（含需求记忆）：先冲刷未保存内容，再新增/激活文档页签（同文件不重复开）
async function onOpenDoc(node: ArtifactNode) {
  if (!(await flushDocs())) return;
  if (!docTabs.value.some((tab) => tab.node.id === node.id))
    docTabs.value.push({ node });
  activeTab.value = `doc-${node.id}`;
}
// 关闭文档页签：先冲刷；仍有未保存修改时由用户确认是否放弃
async function closeDocTab(nodeId: number) {
  const index = docTabs.value.findIndex((tab) => tab.node.id === nodeId);
  if (index < 0) return;
  const editor = docEditors.get(nodeId);
  if (editor && !(await editor.flush())) {
    try {
      await ElMessageBox.confirm(
        "该文档仍有未保存的修改，关闭后将丢失这些修改。",
        "未保存的修改",
        {
          confirmButtonText: "关闭页签",
          cancelButtonText: "继续编辑",
          type: "warning",
        },
      );
    } catch {
      return;
    }
  }
  docTabs.value.splice(index, 1);
  if (activeTab.value === `doc-${nodeId}`) {
    const next = docTabs.value[index] ?? docTabs.value[index - 1];
    activeTab.value = next ? `doc-${next.node.id}` : "progress";
  }
}
function onTabRemove(name: TabPaneName) {
  const nodeId = Number(String(name).slice(4));
  if (Number.isInteger(nodeId)) void closeDocTab(nodeId);
}
// 文档管理删除文档后关闭对应页签
function onDocDeleted(nodeId: number) {
  if (docTabs.value.some((tab) => tab.node.id === nodeId))
    void closeDocTab(nodeId);
}
async function flushAnalysis() {
  if (accessLost.value) return true;
  if (!(await flushDetail())) return false;
  if (issuesPanel.value && !(await issuesPanel.value.flush())) return false;
  return flushDocs();
}
onBeforeRouteLeave(flushAnalysis);
onBeforeRouteUpdate(flushAnalysis);
// 提出时间与开始时间并排一行，其余日期字段两列排布
const leadDates: string[] = ["proposedAt", "startedAt"];
const extraDates = dateFields.filter((key) => !leadDates.includes(key));
function editableKeys(source: Editable) {
  return Object.keys(source) as (keyof Editable)[];
}
const dirty = computed(() => {
  const current = draft.value;
  const saved = savedDraft.value;
  return current && saved
    ? editableKeys(saved).some((key) => current[key] !== saved[key])
    : false;
});
const needsStageNote = computed(
  () =>
    !!draft.value &&
    !!savedDraft.value &&
    stageTransitionNeedsNote(
      savedDraft.value.currentStage,
      draft.value.currentStage,
    ),
);
const blockedHint = computed(() => {
  if (draft.value && !draft.value.name.trim()) return "填写需求名称后自动保存";
  if (needsStageNote.value && !stageNote.value.trim())
    return "跳过或退回阶段需填写原因后自动保存";
  return "";
});
const saveFailed = computed(() => dirty.value && saveState.value === "error");
const responsibilityMembers = computed(() =>
  requirementResponsibilityMembers(projectContext.value?.members),
);
function hasResponsibilityMember(userId: number) {
  return responsibilityMembers.value.some((member) => member.userId === userId);
}
const projectFieldsEditable = computed(
  () =>
    !!projectContext.value?.capabilities.canManageRequirements &&
    !projectContext.value.project.archivedAt &&
    !["closed", "cancelled"].includes(projectContext.value.project.status) &&
    !["conflict", "unauthorized", "forbidden"].includes(saveState.value),
);
const detailEditable = computed(
  () => item.value?.projectId === null || projectFieldsEditable.value,
);
function unavailableMemberLabel(userId: number) {
  const member = projectContext.value?.members.find((m) => m.userId === userId);
  return `${member?.displayName || member?.username || `成员 #${userId}`}（不可再分配）`;
}
async function refreshProjectContext(projectId = item.value?.projectId) {
  if (disposed || accessLost.value) return;
  const token = ++projectRevision;
  if (projectContext.value?.project.id !== projectId)
    projectContext.value = undefined;
  projectError.value = "";
  if (projectId == null) {
    projectLoading.value = false;
    return;
  }
  projectLoading.value = true;
  try {
    const current = await projectApi.get(projectId);
    if (token !== projectRevision || disposed || accessLost.value) return;
    projectContext.value = current;
  } catch (e) {
    if (token !== projectRevision || disposed || accessLost.value) return;
    projectContext.value = undefined;
    if (e instanceof ApiError && [403, 404].includes(e.status))
      invalidateDetail();
    else projectError.value = `无法读取项目成员：${errorMessage(e)}`;
  } finally {
    if (token === projectRevision) projectLoading.value = false;
  }
}
function onMembersVisible(visible: boolean) {
  if (visible) void refreshProjectContext();
}
const saveLabel = computed(() => {
  if (saveState.value === "conflict") return "版本冲突，草稿已保留";
  if (saveState.value === "unauthorized") return "登录已失效，草稿已保留";
  if (dirty.value && blockedHint.value) return blockedHint.value;
  if (saving.value) return "正在保存…";
  if (saveFailed.value) return "保存失败";
  return dirty.value ? "等待自动保存…" : "已同步到本地";
});

function applySavedDetail(detail: Requirement, sent?: Editable) {
  const saved = snapshot(detail);
  const current = draft.value;
  if (!sent || current?.currentStage === sent.currentStage)
    stageNote.value = "";
  const next =
    sent && current
      ? mergeRequirementDraft(detail, sent, current)
      : { ...saved };
  item.value = detail;
  draftVersion = detail.version;
  savedDraft.value = saved;
  draft.value = next;
  setTabLabel(path, `${detail.requirementNo} · ${detail.name}`);
}

let revision = 0;
let autoSave:
  ReturnType<typeof createVersionedAutoSave<Requirement, Editable>> | undefined;
function prepareAutoSave(detail: Requirement) {
  autoSave?.dispose();
  autoSave = createVersionedAutoSave<Requirement, Editable>({
    initial: detail,
    snapshot: () =>
      draft.value &&
      !blockedHint.value &&
      !accessLost.value &&
      detailEditable.value
        ? { ...draft.value }
        : null,
    persist: (changes, expectedVersion) => {
      revision += 1;
      const patch: RequirementUpdate = { ...changes, expectedVersion };
      if (patch.currentStage && stageNote.value.trim())
        patch.stageNote = stageNote.value.trim();
      if (
        ("description" in patch || "descriptionHtml" in patch) &&
        draft.value
      ) {
        patch.description = draft.value.description;
        patch.descriptionHtml = draft.value.descriptionHtml;
      }
      return requirementApi.update(id, patch);
    },
    apply: applySavedDetail,
    onStateChange: (state) => {
      saveState.value = state;
    },
    onError: handleSaveError,
  });
}
function clearStoredDraft() {
  try {
    if (storageKey) sessionStorage.removeItem(storageKey);
    if (accountId == null) return;
    const prefix = `superpm.requirement-draft.v1.${accountId}.`;
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(prefix) && key.endsWith(`.${id}`))
        sessionStorage.removeItem(key);
    }
  } catch {
    storageError.value = "无法清理本次会话草稿，请关闭当前标签页。";
  }
}
function invalidateDetail() {
  accessLost.value = true;
  loading.value = false;
  revision += 1;
  autoSave?.invalidate();
  issuesPanel.value?.invalidate();
  for (const editor of docEditors.values()) editor.invalidate();
  clearStoredDraft();
  if (accountId !== undefined) {
    try {
      for (const kind of ["artifact", "issue"] as const)
        clearResourceDrafts(sessionStorage, {
          accountId,
          projectId: null,
          requirementId: id,
          kind,
        });
    } catch {
      storageError.value = "无法清理本次会话草稿，请关闭当前标签页。";
    }
  }
  conflictServer.value = undefined;
  docTabs.value = [];
  draft.value = undefined;
  savedDraft.value = undefined;
  stageNote.value = "";
  item.value = undefined;
  relations.value = undefined;
  sourcePoints.value = [];
  projectRevision += 1;
  projectContext.value = undefined;
  projectError.value = "";
  error.value = "该需求已不可访问，已清理内容和本地草稿。";
}
function handleSaveError(e: unknown) {
  saveError.value = errorMessage(e);
  if (!(e instanceof ApiError)) return;
  if (e.status === 403 || e.status === 404) {
    invalidateDetail();
    return;
  }
  if (e.status === 409) {
    const current = (e.details as { current?: Requirement } | undefined)
      ?.current;
    if (current?.id === id) conflictServer.value = current;
  }
}
watch(
  [draft, stageNote],
  () => {
    if (accessLost.value || disposed || !draft.value) return;
    try {
      if (storageKey && dirty.value)
        writeRequirementDraft(
          sessionStorage,
          storageKey,
          draftVersion,
          draft.value,
          stageNote.value,
        );
      else if (storageKey) sessionStorage.removeItem(storageKey);
    } catch {
      storageError.value = "会话草稿存储失败，刷新前请复制未保存内容。";
    }
    if (
      dirty.value &&
      !["conflict", "unauthorized", "forbidden"].includes(saveState.value)
    )
      autoSave?.schedule();
  },
  { deep: true, flush: "sync" },
);

async function flushDetail() {
  if (accessLost.value) return true;
  if (["conflict", "unauthorized", "forbidden"].includes(saveState.value)) {
    ElMessage.warning(saveLabel.value);
    return false;
  }
  await descriptionEditor.value?.waitForUpload();
  if (!dirty.value && !saving.value) return true;
  if (!autoSave || (await autoSave.flush())) return true;
  ElMessage.warning(blockedHint.value || "需求保存失败，请重试");
  return false;
}

function beforeTabLeave(_next: TabPaneName, current: TabPaneName) {
  return current === "detail" ? flushDetail() : true;
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value && !saving.value) return;
  event.preventDefault();
  event.returnValue = "";
}
function onVisibilityChange() {
  if (!document.hidden) void refresh();
}
onMounted(() => {
  window.addEventListener("beforeunload", onBeforeUnload);
  document.addEventListener("visibilitychange", onVisibilityChange);
  permissionTimer = setInterval(() => {
    if (!document.hidden) void refresh();
  }, 30000);
});
onBeforeUnmount(() => {
  disposed = true;
  revision += 1;
  window.removeEventListener("beforeunload", onBeforeUnload);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  clearInterval(permissionTimer);
  unregisterSession?.();
  autoSave?.dispose();
});

async function load() {
  if (!Number.isInteger(id) || id <= 0) {
    error.value = "需求 ID 无效";
    return;
  }
  const token = ++revision;
  loading.value = true;
  error.value = "";
  try {
    const [detail, related, sources] = await Promise.all([
      requirementApi.get(id),
      requirementApi.relations(id),
      requirementApi.optimizationPoints(id),
    ]);
    if (token !== revision || disposed) return;
    await refreshProjectContext(detail.projectId);
    if (token !== revision || disposed || accessLost.value) return;
    relations.value = related;
    sourcePoints.value = sources;
    applySavedDetail(detail);
    prepareAutoSave(detail);
    unregisterSession?.();
    unregisterSession = registerEditingSession(path, {
      projectId: detail.projectId,
      flush: flushAnalysis,
      invalidate: invalidateDetail,
      dispose: () => autoSave?.dispose(),
    });
    if (accountId != null) {
      storageKey = requirementDraftKey(accountId, detail.projectId, id);
      try {
        const stored = readRequirementDraft(sessionStorage, storageKey);
        if (stored) {
          draftVersion = stored.version;
          stageNote.value = stored.stageNote ?? "";
          if (stored.version !== detail.version) {
            conflictServer.value = detail;
            saveState.value = "conflict";
          }
          draft.value = stored.values;
        }
      } catch {
        storageError.value = "无法读取会话草稿，请在关闭前确认内容已保存。";
      }
    }
  } catch (e) {
    if (token === revision && !disposed) {
      if (e instanceof ApiError && [403, 404].includes(e.status))
        invalidateDetail();
      else error.value = errorMessage(e);
    }
  } finally {
    if (token === revision) loading.value = false;
  }
}
void load();
// 页面被缓存后，从其他功能切回时静默刷新需求基础数据；
// 页签、已打开文档等界面状态保持不变，有未保存修改时也不覆盖本地草稿
let firstActivation = true;
onActivated(() => {
  if (firstActivation) {
    firstActivation = false;
    return;
  }
  void refresh();
});
async function refresh() {
  if (!item.value || saving.value || accessLost.value || disposed) return;
  const token = ++revision;
  try {
    const [detail, related, sources] = await Promise.all([
      requirementApi.get(id),
      requirementApi.relations(id),
      requirementApi.optimizationPoints(id),
    ]);
    if (token !== revision || disposed) return;
    await refreshProjectContext(detail.projectId);
    if (token !== revision || disposed || accessLost.value) return;
    if (dirty.value) {
      if (detail.version !== item.value?.version) {
        autoSave?.dispose();
        conflictServer.value = detail;
        saveState.value = "conflict";
      }
      return;
    }
    relations.value = related;
    sourcePoints.value = sources;
    applySavedDetail(detail);
    autoSave?.reset(detail);
  } catch (e) {
    if (token !== revision || disposed) return;
    if (e instanceof ApiError && [403, 404].includes(e.status))
      invalidateDetail();
    // 刷新失败时保留缓存内容，用户仍可继续查看与编辑
  }
}
async function revert() {
  if (!savedDraft.value || !dirty.value || saving.value) return;
  const resume = saveState.value === "pending";
  autoSave?.cancel();
  try {
    await ElMessageBox.confirm("确定放弃未保存的修改吗？", "未保存的修改", {
      confirmButtonText: "放弃修改",
      cancelButtonText: "继续编辑",
    });
  } catch {
    if (resume && dirty.value) autoSave?.schedule();
    return;
  }
  if (!savedDraft.value || saving.value) return;
  draft.value = { ...savedDraft.value };
  stageNote.value = "";
}
async function onStageChange(value: Stage) {
  if (
    !draft.value ||
    !savedDraft.value ||
    !detailEditable.value ||
    value === draft.value.currentStage
  )
    return;
  let note = "";
  if (stageTransitionNeedsNote(savedDraft.value.currentStage, value)) {
    try {
      const result = await ElMessageBox.prompt(
        `将阶段调整为「${stageLabels[value]}」，请说明跳过或退回的原因。`,
        "阶段变更原因",
        {
          inputType: "textarea",
          inputValue: stageNote.value,
          inputValidator: (text) =>
            (Boolean(text?.trim()) && text.trim().length <= 2000) ||
            "请填写 1—2000 字的原因",
          confirmButtonText: "确认变更",
          cancelButtonText: "取消",
        },
      );
      note = result.value.trim();
    } catch {
      return;
    }
  }
  if (!draft.value || accessLost.value || disposed) return;
  stageNote.value = note;
  draft.value.currentStage = value;
}
async function copyDraft() {
  if (!draft.value) return;
  try {
    await navigator.clipboard.writeText(
      JSON.stringify(
        {
          ...draft.value,
          ...(stageNote.value ? { stageNote: stageNote.value } : {}),
        },
        null,
        2,
      ),
    );
    ElMessage.success("草稿已复制");
  } catch {
    ElMessage.error("复制失败，请手动复制正文后再重载。");
  }
}
async function reloadLatest() {
  try {
    await ElMessageBox.confirm(
      "读取最新内容会替换本地草稿，请先复制需要保留的修改。",
      "读取最新版本",
      {
        confirmButtonText: "替换草稿",
        cancelButtonText: "继续保留",
        type: "warning",
      },
    );
  } catch {
    return;
  }
  try {
    const detail = await requirementApi.get(id);
    if (disposed || accessLost.value) return;
    await refreshProjectContext(detail.projectId);
    if (disposed || accessLost.value) return;
    saveState.value = "idle";
    conflictServer.value = undefined;
    applySavedDetail(detail);
    prepareAutoSave(detail);
    clearStoredDraft();
    saveError.value = "";
  } catch (e) {
    handleSaveError(e);
  }
}
function onDescriptionHtml(html: string) {
  if (draft.value) draft.value.descriptionHtml = html;
}
function onDescriptionText(text: string) {
  if (draft.value) draft.value.description = text;
}
function go(target: Requirement) {
  router.push(`/requirements/${target.id}`);
}
function openRequirement(requirementId: number) {
  void router.push(`/requirements/${requirementId}`);
}
// 来源优化点：打开来源记录查看评估过程（未保存的需求改动由路由守卫处理）
function openSourcePoint(pointId: number) {
  void router.push(`/optimization-points/${pointId}`);
}
</script>
<template>
  <div class="detail-page" v-loading="loading">
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      :closable="false"
      class="error-alert"
    />
    <template v-if="item">
      <section class="surface detail-head">
        <div class="head-row">
          <div class="head-identity">
            <span class="hero-no">{{ item.requirementNo }}</span>
            <h1 class="head-title">{{ item.name }}</h1>
          </div>
          <el-tag
            size="small"
            class="enum-tag head-stage"
            :class="tagTone('currentStage', item.currentStage)"
          >
            {{ stageLabels[item.currentStage] }}
          </el-tag>
          <div class="head-actions">
            <span class="detail-save-state" :class="{ dirty }" role="status">
              {{ saveLabel }}
            </span>
            <el-button
              size="small"
              :disabled="
                !dirty ||
                !detailEditable ||
                saving ||
                saveState === 'conflict' ||
                saveState === 'unauthorized'
              "
              @click="revert"
            >
              重置
            </el-button>
            <el-button
              size="small"
              type="primary"
              :loading="saving"
              :disabled="
                !dirty ||
                !detailEditable ||
                !!blockedHint ||
                saveState === 'conflict' ||
                saveState === 'unauthorized'
              "
              @click="flushDetail"
            >
              {{ saveFailed ? "重试保存" : "立即保存" }}
            </el-button>
            <el-button
              size="small"
              class="properties-toggle"
              :aria-expanded="propertiesOpen"
              @click="propertiesOpen = !propertiesOpen"
            >
              {{ propertiesOpen ? "隐藏属性" : "显示属性" }}
            </el-button>
          </div>
        </div>
      </section>
      <el-alert
        v-if="storageError"
        :title="storageError"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-alert
        v-if="item.projectId !== null && projectContext && !detailEditable"
        title="当前项目角色或状态仅允许查看需求。"
        type="info"
        :closable="false"
        show-icon
      />
      <el-alert
        v-if="saveState === 'unauthorized'"
        title="登录已失效，已暂停保存；重新登录同一账号并验证权限后可恢复会话草稿。"
        type="warning"
        :closable="false"
        show-icon
      />
      <section
        v-if="saveState === 'conflict'"
        class="surface conflict-panel"
        role="alert"
      >
        <strong>内容已被其他成员修改，本地草稿已保留。</strong>
        <p v-if="conflictServer">
          服务器版本 {{ conflictServer.version }}：{{ conflictServer.name }}
        </p>
        <pre v-if="conflictServer">{{ conflictServer.description }}</pre>
        <p>请复制草稿，读取最新内容后手动合并修改。</p>
        <el-button size="small" @click="copyDraft">复制本地草稿</el-button>
        <el-button size="small" @click="reloadLatest">读取最新内容</el-button>
      </section>
      <el-alert
        v-if="saveFailed"
        :title="saveError"
        type="error"
        show-icon
        :closable="false"
      />
      <section class="surface detail-body">
        <el-tabs
          v-model="activeTab"
          :before-leave="beforeTabLeave"
          @tab-remove="onTabRemove"
        >
          <el-tab-pane label="需求详情" name="detail">
            <div
              class="detail-grid"
              :class="{ 'properties-collapsed': !propertiesOpen }"
            >
              <article class="detail-desc">
                <InlineRichTextEditor
                  v-if="draft"
                  ref="descriptionEditor"
                  fill-card
                  :html="draft.descriptionHtml"
                  :text="draft.description"
                  :requirement-id="item.id"
                  :readonly="saveState === 'unauthorized' || !detailEditable"
                  @update:html="onDescriptionHtml"
                  @update:text="onDescriptionText"
                  @open-requirement="openRequirement"
                />
              </article>
              <div v-show="propertiesOpen" class="detail-fields">
                <el-form
                  v-if="draft"
                  class="field-form"
                  :disabled="!detailEditable || saveState === 'unauthorized'"
                  @submit.prevent="flushDetail"
                >
                  <label class="field">
                    <span>需求名称</span>
                    <el-input
                      v-model="draft.name"
                      maxlength="200"
                      placeholder="输入需求名称"
                    />
                  </label>
                  <div class="field-row">
                    <label class="field">
                      <span>需求类型</span>
                      <el-select v-model="draft.type"
                        ><template #label="{ label, value }"
                          ><el-tag
                            size="small"
                            class="enum-tag"
                            :class="tagTone('type', value)"
                            >{{ label }}</el-tag
                          ></template
                        ><el-option
                          v-for="value in requirementTypes"
                          :key="value"
                          :label="typeLabels[value]"
                          :value="value"
                          ><el-tag
                            class="enum-tag"
                            :class="tagTone('type', value)"
                            >{{ typeLabels[value] }}</el-tag
                          ></el-option
                        ></el-select
                      >
                    </label>
                    <label class="field">
                      <span>优先级</span>
                      <el-select v-model="draft.priority"
                        ><template #label="{ label, value }"
                          ><el-tag
                            size="small"
                            class="enum-tag"
                            :class="tagTone('priority', value)"
                            >{{ label }}</el-tag
                          ></template
                        ><el-option
                          v-for="value in priorities"
                          :key="value"
                          :label="value"
                          :value="value"
                          ><el-tag
                            class="enum-tag"
                            :class="tagTone('priority', value)"
                            >{{ value }}</el-tag
                          ></el-option
                        ></el-select
                      >
                    </label>
                  </div>
                  <div class="field-row">
                    <label class="field">
                      <span>状态</span>
                      <el-select v-model="draft.status"
                        ><template #label="{ label, value }"
                          ><el-tag
                            size="small"
                            class="enum-tag"
                            :class="tagTone('status', value)"
                            >{{ label }}</el-tag
                          ></template
                        ><el-option
                          v-for="value in requirementStatuses"
                          :key="value"
                          :label="statusLabels[value]"
                          :value="value"
                          ><el-tag
                            class="enum-tag"
                            :class="tagTone('status', value)"
                            >{{ statusLabels[value] }}</el-tag
                          ></el-option
                        ></el-select
                      >
                    </label>
                    <label class="field">
                      <span>当前阶段</span>
                      <el-select
                        :model-value="draft.currentStage"
                        @change="onStageChange"
                        ><template #label="{ label, value }"
                          ><el-tag
                            size="small"
                            class="enum-tag"
                            :class="tagTone('currentStage', value)"
                            >{{ label }}</el-tag
                          ></template
                        ><el-option
                          v-for="value in stages"
                          :key="value"
                          :label="stageLabels[value]"
                          :value="value"
                          ><el-tag
                            class="enum-tag"
                            :class="tagTone('currentStage', value)"
                            >{{ stageLabels[value] }}</el-tag
                          ></el-option
                        ></el-select
                      >
                    </label>
                  </div>
                  <label v-if="needsStageNote" class="field">
                    <span>阶段变更原因</span>
                    <el-input
                      v-model="stageNote"
                      type="textarea"
                      :rows="2"
                      maxlength="2000"
                      placeholder="说明跳过或退回阶段的原因"
                    />
                  </label>
                  <template v-if="item.projectId !== null">
                    <el-alert
                      v-if="projectError"
                      :title="projectError"
                      type="warning"
                      :closable="false"
                    >
                      <el-button size="small" @click="refreshProjectContext()">
                        重新读取成员
                      </el-button>
                    </el-alert>
                    <div class="field-row">
                      <label class="field">
                        <span>需求负责人</span>
                        <el-select
                          v-model="draft.assigneeUserId"
                          filterable
                          placeholder="选择需求负责人"
                          :disabled="!projectFieldsEditable"
                          :loading="projectLoading"
                          @visible-change="onMembersVisible"
                        >
                          <el-option
                            v-if="
                              draft.assigneeUserId &&
                              !hasResponsibilityMember(draft.assigneeUserId)
                            "
                            :label="
                              unavailableMemberLabel(draft.assigneeUserId)
                            "
                            :value="draft.assigneeUserId"
                            disabled
                          />
                          <el-option
                            v-for="member in responsibilityMembers"
                            :key="member.userId"
                            :label="member.displayName || member.username"
                            :value="member.userId"
                          />
                        </el-select>
                      </label>
                      <label class="field">
                        <span>开发负责人</span>
                        <el-select
                          v-model="draft.developerUserId"
                          filterable
                          clearable
                          :value-on-clear="null"
                          placeholder="未设置"
                          :disabled="!projectFieldsEditable"
                          :loading="projectLoading"
                          @visible-change="onMembersVisible"
                        >
                          <el-option
                            v-if="
                              draft.developerUserId &&
                              !hasResponsibilityMember(draft.developerUserId)
                            "
                            :label="
                              unavailableMemberLabel(draft.developerUserId)
                            "
                            :value="draft.developerUserId"
                            disabled
                          />
                          <el-option
                            v-for="member in responsibilityMembers"
                            :key="member.userId"
                            :label="member.displayName || member.username"
                            :value="member.userId"
                          />
                        </el-select>
                      </label>
                    </div>
                    <label class="field">
                      <span>验收标准</span>
                      <el-input
                        v-model="draft.acceptanceCriteria"
                        type="textarea"
                        :rows="4"
                        maxlength="50000"
                        show-word-limit
                        placeholder="填写可验证的验收标准"
                        :disabled="!projectFieldsEditable"
                      />
                    </label>
                  </template>
                  <div class="field-row">
                    <label class="field">
                      <span>{{ dateLabels.proposedAt }}</span>
                      <el-date-picker
                        v-model="draft.proposedAt"
                        type="date"
                        value-format="YYYY-MM-DD"
                        placeholder="选择日期"
                        :clearable="false"
                      />
                    </label>
                    <label class="field">
                      <span>{{ dateLabels.startedAt }}</span>
                      <el-date-picker
                        v-model="draft.startedAt"
                        type="date"
                        value-format="YYYY-MM-DD"
                        placeholder="未设置"
                        :value-on-clear="null"
                        clearable
                      />
                    </label>
                  </div>
                  <div class="field-row">
                    <label v-for="key in extraDates" :key="key" class="field">
                      <span>{{ dateLabels[key] }}</span>
                      <el-date-picker
                        v-model="draft[key]"
                        type="date"
                        value-format="YYYY-MM-DD"
                        placeholder="未设置"
                        :value-on-clear="null"
                        clearable
                      />
                    </label>
                  </div>
                  <div class="related-block">
                    <h2>关联需求</h2>
                    <div
                      v-for="parent in relations?.parent
                        ? [relations.parent]
                        : []"
                      :key="parent.id"
                      class="related-row"
                    >
                      <el-tag size="small" effect="plain">父需求</el-tag>
                      <button
                        type="button"
                        class="link-button"
                        @click="go(parent)"
                      >
                        {{ parent.requirementNo }} · {{ parent.name }}
                      </button>
                    </div>
                    <div v-if="relations?.children.length" class="related-list">
                      <div
                        v-for="child in relations.children"
                        :key="child.id"
                        class="related-row"
                      >
                        <el-tag size="small" effect="plain">子需求</el-tag>
                        <button
                          type="button"
                          class="link-button"
                          @click="go(child)"
                        >
                          {{ child.requirementNo }} · {{ child.name }}
                        </button>
                        <el-tag
                          class="enum-tag"
                          :class="tagTone('status', child.status)"
                          >{{ statusLabels[child.status] }}</el-tag
                        >
                      </div>
                    </div>
                    <p
                      v-if="!relations?.parent && !relations?.children.length"
                      class="muted"
                    >
                      暂无关联的父需求或子需求。
                    </p>
                  </div>
                  <div v-if="sourcePoints.length" class="related-block">
                    <h2>来源优化点</h2>
                    <div class="related-list">
                      <div
                        v-for="source in sourcePoints"
                        :key="source.id"
                        class="related-row"
                      >
                        <el-tag size="small" effect="plain">优化点</el-tag>
                        <button
                          type="button"
                          class="link-button"
                          @click="openSourcePoint(source.id)"
                        >
                          #{{ source.id }} · {{ source.name }}
                        </button>
                        <el-tag
                          class="enum-tag"
                          :class="optimizationStatusTone[source.status]"
                          >{{
                            optimizationPointStatusLabels[source.status]
                          }}</el-tag
                        >
                      </div>
                    </div>
                  </div>
                </el-form>
              </div>
            </div>
          </el-tab-pane>
          <el-tab-pane
            v-if="
              item.projectId !== null &&
              projectContext &&
              !relations?.children.length
            "
            label="项目任务"
            name="tasks"
            lazy
          >
            <ProjectTasksPanel
              :project-id="item.projectId"
              :members="projectContext.members"
              :requirement-id="item.id"
              :requirement-name="item.requirementNo + ' · ' + item.name"
            />
          </el-tab-pane>
          <el-tab-pane label="文档管理" name="progress">
            <!-- 文件面板直接铺满页签；md 文件（含需求记忆）点击后在顶层新增文档页签打开 -->
            <RequirementDocManager
              class="doc-manager-pane"
              :requirement-id="item.id"
              :requirement-name="item.name"
              @open-doc="onOpenDoc"
              @doc-deleted="onDocDeleted"
            />
          </el-tab-pane>
          <el-tab-pane label="问题记录" name="issues">
            <!-- 四个需求阶段都可记录问题；产生阶段作为独立字段 -->
            <RequirementIssuesPanel
              ref="issuesPanel"
              :key="item.id"
              :requirement-id="item.id"
              :project-id="item.projectId"
              :current-stage="item.currentStage"
              @open-requirement="openRequirement"
              @access-lost="invalidateDetail"
            />
          </el-tab-pane>
          <el-tab-pane
            v-for="tab in docTabs"
            :key="tab.node.id"
            :label="tab.node.name"
            :name="`doc-${tab.node.id}`"
            closable
          >
            <DocTabEditor
              :ref="(el) => setDocEditor(tab.node.id, el)"
              :requirement-id="item.id"
              :project-id="item.projectId"
              :node="tab.node"
              @open-requirement="openRequirement"
              @access-lost="invalidateDetail"
            />
          </el-tab-pane>
        </el-tabs>
      </section>
    </template>
  </div>
</template>
<style scoped>
.conflict-panel {
  padding: 12px 18px;
}
.conflict-panel p {
  margin: 8px 0;
}
.conflict-panel pre {
  white-space: pre-wrap;
  max-height: 120px;
  overflow: auto;
}
.doc-manager-pane {
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.detail-page {
  /* 视口限高：顶栏与页头卡片固定不滚动，内容区（页签）自行消化溢出。
     40px = 全局 .page-content 的上下内边距（20px × 2） */
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: calc(100dvh - var(--app-header-h) - 40px);
}
.detail-head {
  /* 单行头部：编号 + 标题 + 当前阶段 tag，无步骤条 */
  padding: 8px 18px;
}
.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.head-identity {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}
.head-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.2px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-no {
  font-family: Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  padding: 2px 9px;
  border-radius: 999px;
  color: var(--brand);
  background: var(--bg-brand-soft);
  flex: none;
}
.head-stage {
  flex: none;
}
.head-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}
.head-actions .el-button {
  margin: 0;
}
.detail-save-state {
  margin-right: 4px;
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}
.detail-save-state.dirty {
  color: var(--warning-text);
}
.detail-body {
  padding: 12px 22px 22px;
  /* 占满限高剩余空间，页签头固定、页签内容区独立消化高度 */
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
/* el-tabs 头/内容分离控制：头不滚，内容区弹性占满并可兜底滚动 */
.detail-body :deep(.el-tabs) {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.detail-body :deep(.el-tabs__header) {
  flex: none;
}
.detail-body :deep(.el-tabs__content) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.detail-body :deep(.el-tab-pane) {
  height: 100%;
}
.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
  gap: 20px;
  height: 100%;
  padding-top: 8px;
}
.detail-grid.properties-collapsed {
  grid-template-columns: minmax(0, 1fr);
}
.detail-desc {
  /* 高度由外层 grid 行决定：编辑器绝对定位铺满本格，内容超出时内部滚动 */
  position: relative;
  min-height: 0;
}
.detail-desc > .inline-rich {
  position: absolute;
  inset: 0;
}
.detail-fields {
  min-width: 0;
  /* 右列表单栏独立滚动，与左编辑器互不影响 */
  overflow-y: auto;
}
.field-form {
  display: grid;
  gap: 14px;
}
.field-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.field {
  display: grid;
  gap: 6px;
}
.field > span {
  font-size: 11px;
  color: var(--text-muted);
}
.field :deep(.el-select),
.field :deep(.el-date-editor) {
  width: 100%;
}
.related-block {
  border-top: 1px solid var(--border-soft);
  padding-top: 16px;
  display: grid;
  gap: 8px;
}
.related-block h2 {
  margin: 0;
}
.related-list {
  display: grid;
  gap: 6px;
}
.related-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  padding: 7px 10px;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  background: var(--bg-subtle);
}
.related-row .link-button {
  font-size: 12px;
  color: var(--text-regular);
  flex: 1;
  text-align: left;
}
.link-button {
  border: 0;
  background: none;
  padding: 0;
  cursor: pointer;
}
.link-button:hover {
  color: var(--brand);
}
@media (max-width: 1100px) {
  .head-row {
    flex-wrap: wrap;
  }
  .head-identity {
    flex-basis: 55%;
  }
  .head-actions {
    width: 100%;
    justify-content: flex-end;
  }
  .detail-grid {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }
  .detail-desc {
    min-height: 360px;
  }
  .doc-manager-pane {
    min-height: 420px;
  }
}
@media (max-width: 700px) {
  .detail-head {
    padding: 10px 12px;
  }
  .detail-body {
    padding-inline: 12px;
  }
  .head-identity {
    flex-basis: 100%;
  }
  .head-stage {
    order: 2;
  }
  .detail-save-state {
    margin-right: auto;
  }
  .head-actions {
    flex-wrap: wrap;
    justify-content: flex-start;
  }
  .field-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
