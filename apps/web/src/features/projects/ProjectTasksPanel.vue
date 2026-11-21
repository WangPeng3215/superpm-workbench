<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import type { ProjectMember } from "@superpm/shared";
import { authStore } from "../../stores/auth";
import { dailyTaskApi } from "../../api/daily-tasks";
import { errorMessage } from "../../api/client";
import { artifactApi } from "../../api/artifacts";
import { requirementApi } from "../../api/requirements";
import {
  projectTaskApi,
  type ProjectTask,
  type ProjectTaskAction,
  type ProjectTaskDetail,
  type ProjectTaskHistoryAction,
  type ProjectTaskInput,
  type ProjectTaskStatus,
  type ProjectTaskType,
  type TaskEvidence,
  type TaskRequirementOption,
} from "../../api/project-tasks";
import ProjectTaskFormDialog from "./ProjectTaskFormDialog.vue";

const props = defineProps<{
  projectId: number;
  members: ProjectMember[];
  requirementId?: number;
  requirementName?: string;
}>();
const router = useRouter();
const scope = ref<"all" | "mine" | "confirmation">("all");
const statusFilter = ref<"" | ProjectTaskStatus>("");
const page = ref(1);
const pageSize = 20;
const total = ref(0);
const tasks = ref<ProjectTask[]>([]);
const loading = ref(false);
const error = ref("");
const canCreateProjectTask = ref(false);
const requirementOption = ref<TaskRequirementOption>();
const selected = ref<ProjectTaskDetail>();
const detailOpen = ref(false);
const formOpen = ref(false);
const editing = ref<ProjectTask | null>(null);
const saving = ref(false);
const pendingAction = ref(false);
const planOpen = ref(false);
const planDate = ref("");
const planStart = ref("");
const planEnd = ref("");
const planEstimatedMinutes = ref(30);
const planBusy = ref(false);
const submitOpen = ref(false);
const submitBusy = ref(false);
const submission = ref({ summary: "", label: "", url: "" });
const evidenceOptions = ref<
  { key: string; label: string; evidence: TaskEvidence }[]
>([]);
const selectedEvidenceKeys = ref<string[]>([]);
const evidenceLoading = ref(false);
let revision = 0;

const statusLabels: Record<ProjectTaskStatus, string> = {
  pending: "待开始",
  in_progress: "进行中",
  pending_confirmation: "待确认",
  completed: "已完成",
  blocked: "已阻塞",
  cancelled: "已取消",
};
const typeLabels: Record<ProjectTaskType, string> = {
  design: "设计",
  development: "开发",
  testing: "测试",
  deployment: "部署",
  other: "其他",
};
const actionLabels: Record<ProjectTaskHistoryAction, string> = {
  created: "创建任务",
  edit: "编辑任务",
  start: "开始处理",
  block: "标记阻塞",
  resume: "恢复处理",
  submit: "提交确认",
  approve: "通过确认",
  return: "退回修改",
  cancel: "取消任务",
  reopen: "重新打开",
};
const canCreate = computed(() =>
  props.requirementId != null
    ? Boolean(requirementOption.value?.canCreate)
    : canCreateProjectTask.value,
);
const eligibleMembers = computed(() =>
  props.members.filter(
    (member) =>
      member.status === "active" &&
      member.accountStatus === "active" &&
      member.roles.some((role) => role !== "viewer"),
  ),
);
const membersById = computed(
  () => new Map(props.members.map((member) => [member.userId, member])),
);

function memberName(userId: number) {
  return membersById.value.get(userId)?.displayName ?? "成员 #" + userId;
}
function shortDate(value: string | null) {
  return value || "未设置";
}
function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
function statusType(status: ProjectTaskStatus) {
  if (status === "completed") return "success";
  if (status === "pending_confirmation") return "warning";
  if (status === "blocked" || status === "cancelled") return "danger";
  if (status === "in_progress") return "primary";
  return "info";
}
function taskTypeLabel(value: unknown) {
  return typeof value === "string" && value in typeLabels
    ? typeLabels[value as ProjectTaskType]
    : "其他";
}
function taskStatusLabel(value: unknown) {
  return typeof value === "string" && value in statusLabels
    ? statusLabels[value as ProjectTaskStatus]
    : "未知状态";
}
function filtersChanged() {
  page.value = 1;
  void load();
}
function setScope(value: "all" | "mine" | "confirmation") {
  scope.value = value;
  if (value === "confirmation") statusFilter.value = "";
  filtersChanged();
}
async function load() {
  const token = ++revision;
  loading.value = true;
  error.value = "";
  try {
    if (props.requirementId != null) {
      const candidateResult = await projectTaskApi.requirements(
        props.projectId,
        "",
        props.requirementId,
      );
      if (token !== revision) return;
      requirementOption.value = candidateResult.items.find(
        (item) => item.id === props.requirementId,
      );
    } else requirementOption.value = undefined;
    const query = {
      ...(props.requirementId == null
        ? {}
        : { requirementId: props.requirementId }),
      ...(scope.value === "mine" && authStore.user
        ? { assigneeUserId: authStore.user.id }
        : {}),
      ...(scope.value === "confirmation" && authStore.user
        ? {
            confirmerUserId: authStore.user.id,
            status: "pending_confirmation" as const,
          }
        : {}),
      ...(statusFilter.value && scope.value !== "confirmation"
        ? { status: statusFilter.value }
        : {}),
      page: page.value,
      pageSize,
    };
    const response = await projectTaskApi.list(props.projectId, query);
    if (token !== revision) return;
    const lastPage = Math.max(1, Math.ceil(response.total / pageSize));
    if (page.value > lastPage) {
      page.value = lastPage;
      await load();
      return;
    }
    tasks.value = response.items;
    total.value = response.total;
    canCreateProjectTask.value = response.canCreate;
  } catch (cause) {
    if (token === revision) error.value = errorMessage(cause);
  } finally {
    if (token === revision) loading.value = false;
  }
}
async function openTaskById(taskId: number) {
  if (!Number.isInteger(taskId) || taskId <= 0) return false;
  detailOpen.value = true;
  selected.value = undefined;
  try {
    selected.value = await projectTaskApi.get(taskId);
    return true;
  } catch (cause) {
    detailOpen.value = false;
    ElMessage.error(errorMessage(cause));
    return false;
  }
}
async function openTask(task: ProjectTask) {
  await openTaskById(task.id);
}
function newTask() {
  editing.value = null;
  formOpen.value = true;
}
function editTask() {
  if (!selected.value?.capabilities.canEdit) return;
  editing.value = selected.value;
  formOpen.value = true;
}
async function saveTask(input: ProjectTaskInput) {
  if (saving.value) return;
  saving.value = true;
  try {
    const updated = editing.value
      ? await projectTaskApi.update(editing.value.id, {
          ...input,
          expectedVersion: editing.value.version,
        })
      : await projectTaskApi.create(props.projectId, input);
    formOpen.value = false;
    selected.value = updated;
    if (editing.value) ElMessage.success("任务已更新");
    else {
      detailOpen.value = true;
      ElMessage.success("任务已拆分");
    }
    editing.value = null;
    await load();
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally {
    saving.value = false;
  }
}
async function action(actionName: ProjectTaskAction) {
  const task = selected.value;
  if (
    !task ||
    pendingAction.value ||
    !task.capabilities.actions.includes(actionName)
  )
    return;
  if (actionName === "submit") {
    submission.value = { summary: "", label: "", url: "" };
    selectedEvidenceKeys.value = [];
    void loadEvidenceOptions();
    submitOpen.value = true;
    return;
  }
  let reason = "";
  try {
    if (["block", "return", "cancel", "reopen"].includes(actionName)) {
      reason = (
        await ElMessageBox.prompt(
          "请填写处理原因，相关历史会保留。",
          actionLabels[actionName],
          {
            inputType: "textarea",
            inputValidator: (value) => Boolean(value?.trim()) || "请填写原因",
            confirmButtonText: "确认",
            cancelButtonText: "取消",
          },
        )
      ).value.trim();
    } else {
      await ElMessageBox.confirm(
        "确认" + actionLabels[actionName] + "？",
        actionLabels[actionName],
        {
          confirmButtonText: actionLabels[actionName],
          cancelButtonText: "取消",
        },
      );
    }
  } catch {
    return;
  }
  pendingAction.value = true;
  try {
    selected.value = await projectTaskApi.action(task.id, {
      action: actionName,
      expectedVersion: task.version,
      ...(reason ? { reason } : {}),
    });
    await load();
    ElMessage.success(actionLabels[actionName] + "完成");
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
    if (actionName === "approve" || actionName === "return")
      await refreshSelected(task.id);
  } finally {
    pendingAction.value = false;
  }
}
async function submitProgress() {
  const task = selected.value;
  if (!task || submitBusy.value) return;
  const summary = submission.value.summary.trim();
  const url = submission.value.url.trim();
  if (!summary && !url) {
    ElMessage.warning("请填写处理说明或提供至少一项产物证据");
    return;
  }
  let evidence: TaskEvidence[] = selectedEvidenceKeys.value
    .map(
      (key) =>
        evidenceOptions.value.find((option) => option.key === key)?.evidence,
    )
    .filter((item): item is TaskEvidence => Boolean(item));
  if (url) {
    try {
      const parsed = new URL(url);
      if (
        !["https:", "http:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw new Error();
      evidence.push({
        kind: "external_link",
        url: parsed.toString(),
        ...(submission.value.label.trim()
          ? { label: submission.value.label.trim() }
          : {}),
      });
    } catch {
      ElMessage.warning(
        "证据链接必须是有效的 HTTP 或 HTTPS 地址，且不能含账号密码",
      );
      return;
    }
  }
  submitBusy.value = true;
  try {
    selected.value = await projectTaskApi.action(task.id, {
      action: "submit",
      expectedVersion: task.version,
      ...(summary ? { summary } : {}),
      ...(evidence.length ? { evidence } : {}),
    });
    submitOpen.value = false;
    await load();
    ElMessage.success("已提交确认");
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally {
    submitBusy.value = false;
  }
}
async function loadEvidenceOptions() {
  const requirementId = selected.value?.requirementId;
  if (!requirementId) {
    evidenceOptions.value = [];
    return;
  }
  evidenceLoading.value = true;
  try {
    const [directory, fileList] = await Promise.all([
      artifactApi.list(requirementId, null),
      requirementApi.files(requirementId),
    ]);
    const linked = directory.files.map((node) => ({
      key: "artifact:" + node.id,
      label: "需求产物 · " + node.name,
      evidence: { kind: "artifact_node" as const, id: node.id },
    }));
    const linkedUrls = directory.links.map((link) => ({
      key: "artifact-link:" + link.id,
      label: "需求链接 · " + link.name,
      evidence: {
        kind: "external_link" as const,
        url: link.url,
        label: link.name,
      },
    }));
    const files = fileList.groups
      .flatMap((group) => group.files)
      .filter((file) => !file.isDeleted)
      .map((file) =>
        file.resourceType === "link" && file.linkUrl
          ? {
              key: "file-link:" + file.id,
              label: "需求文件链接 · " + file.name,
              evidence: {
                kind: "external_link" as const,
                url: file.linkUrl,
                label: file.name,
              },
            }
          : {
              key: "requirement-file:" + file.id,
              label: "需求文件 · " + file.name,
              evidence: { kind: "requirement_file" as const, id: file.id },
            },
      );
    evidenceOptions.value = [...linked, ...linkedUrls, ...files];
  } catch (cause) {
    evidenceOptions.value = [];
    ElMessage.warning(
      "未能加载需求产物列表，可补充处理说明或粘贴外部链接：" +
        errorMessage(cause),
    );
  } finally {
    evidenceLoading.value = false;
  }
}
async function refreshSelected(taskId = selected.value?.id) {
  if (!taskId) return;
  try {
    selected.value = await projectTaskApi.get(taskId);
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  }
}
async function openPlan() {
  if (!selected.value?.capabilities.canPlan) return;
  try {
    const day = await dailyTaskApi.day();
    planDate.value = day.today;
    planStart.value = "";
    planEnd.value = "";
    planEstimatedMinutes.value = 30;
    planOpen.value = true;
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  }
}
async function savePlan() {
  const task = selected.value;
  if (!task || !planDate.value || planBusy.value) return;
  if (Boolean(planStart.value) !== Boolean(planEnd.value)) {
    ElMessage.warning("请同时填写计划开始和结束时间");
    return;
  }
  if (planStart.value && planStart.value >= planEnd.value) {
    ElMessage.warning("计划结束时间必须晚于开始时间");
    return;
  }
  planBusy.value = true;
  try {
    const dailyTask = await projectTaskApi.plan(task.id, {
      date: planDate.value,
      expectedVersion: task.version,
      plannedStartAt: planStart.value || null,
      plannedEndAt: planEnd.value || null,
      estimatedMinutes: planEstimatedMinutes.value,
    });
    planOpen.value = false;
    ElMessage.success("已安排到 " + dailyTask.planDate + " 的个人日程");
    await router.push({
      path: "/tasks",
      query: { date: dailyTask.planDate, task: String(dailyTask.id) },
    });
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally {
    planBusy.value = false;
  }
}
function evidenceLabel(evidence: TaskEvidence & { displayName?: string }) {
  if (evidence.displayName) return evidence.displayName;
  if (evidence.kind === "external_link") return evidence.label || evidence.url;
  return (
    (evidence.kind === "artifact_node" ? "需求产物" : "需求文件") +
    " #" +
    evidence.id
  );
}
function evidenceHref(evidence: TaskEvidence) {
  return evidence.kind === "external_link" ? evidence.url : undefined;
}
function filteredHistory(task: ProjectTaskDetail) {
  return [...task.actions].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}
function historyChanges(entry: ProjectTaskDetail["actions"][number]) {
  if (entry.action !== "edit" || !entry.changes) return [];
  return ([
    ["assigneeUserId", "执行人"],
    ["confirmerUserId", "确认人"],
  ] as const).flatMap(([field, label]) => {
    const change = entry.changes?.[field];
    if (
      typeof change?.before !== "number" ||
      typeof change.after !== "number" ||
      change.before === change.after
    )
      return [];
    return [label + "：" + memberName(change.before) + " → " + memberName(change.after)];
  });
}
watch(() => [props.projectId, props.requirementId], filtersChanged);
onMounted(() => void load());
defineExpose({ openTaskById });
</script>

<template>
  <section class="tasks-panel">
    <header class="tasks-tools">
      <div class="views" role="tablist" aria-label="任务视图">
        <button
          type="button"
          role="tab"
          :aria-selected="scope === 'all'"
          :class="{ active: scope === 'all' }"
          @click="setScope('all')"
        >
          全部任务
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="scope === 'mine'"
          :class="{ active: scope === 'mine' }"
          @click="setScope('mine')"
        >
          分配给我
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="scope === 'confirmation'"
          :class="{ active: scope === 'confirmation' }"
          @click="setScope('confirmation')"
        >
          待确认
        </button>
      </div>
      <div class="filter-actions">
        <el-select
          v-model="statusFilter"
          clearable
          placeholder="所有状态"
          size="small"
          class="status-filter"
          :disabled="scope === 'confirmation'"
          @change="filtersChanged"
        >
          <el-option
            v-for="(label, value) in statusLabels"
            :key="value"
            :label="label"
            :value="value"
          />
        </el-select>
        <el-button v-if="canCreate" type="primary" size="small" @click="newTask"
          >拆分任务</el-button
        >
      </div>
    </header>
    <div v-if="requirementId" class="scope-note">
      当前末级需求：{{
        requirementName || requirementOption?.name || "#" + requirementId
      }}
    </div>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />
    <el-table
      v-loading="loading"
      :data="tasks"
      row-key="id"
      size="small"
      class="task-table"
      @row-click="openTask"
    >
      <el-table-column label="项目任务" min-width="260">
        <template #default="{ row }">
          <div class="task-title">{{ row.title }}</div>
          <div v-if="row.description" class="task-description">
            {{ row.description }}
          </div>
          <div class="task-meta">
            <span>{{ taskTypeLabel(row.type) }}</span
            ><span v-if="row.requirementId">需求 #{{ row.requirementId }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="112"
        ><template #default="{ row }"
          ><el-tag size="small" :type="statusType(row.status)" effect="light">{{
            taskStatusLabel(row.status)
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column label="执行人" width="128"
        ><template #default="{ row }">{{
          memberName(row.assigneeUserId)
        }}</template></el-table-column
      >
      <el-table-column label="确认人" width="128"
        ><template #default="{ row }">{{
          memberName(row.confirmerUserId)
        }}</template></el-table-column
      >
      <el-table-column label="截止日" width="108"
        ><template #default="{ row }">{{
          shortDate(row.dueDate)
        }}</template></el-table-column
      >
      <el-table-column label="操作" width="94" align="right"
        ><template #default="{ row }"
          ><el-button link type="primary" @click.stop="openTask(row)"
            >查看</el-button
          ></template
        ></el-table-column
      >
      <template #empty
        ><el-empty
          :description="
            scope === 'mine'
              ? '还没有分配给你的项目任务'
              : scope === 'confirmation'
                ? '暂无待你确认的任务'
                : '项目还没有拆分任务'
          "
          :image-size="72"
      /></template>
    </el-table>
    <footer v-if="total > pageSize" class="pagination">
      <span>共 {{ total }} 项</span
      ><el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next"
        small
        @current-change="load"
      />
    </footer>

    <ProjectTaskFormDialog
      v-model="formOpen"
      :project-id="projectId"
      :members="eligibleMembers"
      :requirement-id="requirementId"
      :lock-requirement="requirementId != null"
      :task="editing"
      :loading="saving"
      @submit="saveTask"
    />

    <el-drawer
      v-model="detailOpen"
      :title="selected?.title || '项目任务'"
      size="min(720px, 94vw)"
      destroy-on-close
      @closed="selected = undefined"
    >
      <el-skeleton v-if="!selected" :rows="6" animated />
      <template v-else>
        <div class="detail-toolbar">
          <el-tag size="small" :type="statusType(selected.status)">{{
            statusLabels[selected.status]
          }}</el-tag>
          <div class="detail-actions">
            <el-button
              v-if="selected.capabilities.canPlan"
              size="small"
              @click="openPlan"
              >安排到今天</el-button
            >
            <el-button
              v-if="selected.capabilities.canEdit"
              size="small"
              @click="editTask"
              >编辑</el-button
            >
            <template v-for="name in selected.capabilities.actions" :key="name">
              <el-button
                v-if="name !== 'submit'"
                size="small"
                :type="
                  name === 'approve'
                    ? 'success'
                    : name === 'return'
                      ? 'warning'
                      : name === 'cancel'
                        ? 'danger'
                        : 'default'
                "
                :loading="pendingAction"
                @click="action(name)"
                >{{ actionLabels[name] }}</el-button
              >
              <el-button
                v-else
                size="small"
                type="primary"
                :loading="submitBusy"
                @click="action(name)"
                >{{ actionLabels[name] }}</el-button
              >
            </template>
          </div>
        </div>
        <dl class="task-facts">
          <div>
            <dt>任务类型</dt>
            <dd>{{ typeLabels[selected.type] }}</dd>
          </div>
          <div>
            <dt>执行人</dt>
            <dd>{{ memberName(selected.assigneeUserId) }}</dd>
          </div>
          <div>
            <dt>确认人</dt>
            <dd>{{ memberName(selected.confirmerUserId) }}</dd>
          </div>
          <div>
            <dt>截止日期</dt>
            <dd>{{ shortDate(selected.dueDate) }}</dd>
          </div>
          <div v-if="selected.requirementId">
            <dt>关联需求</dt>
            <dd>
              {{
                requirementName ||
                requirementOption?.name ||
                "#" + selected.requirementId
              }}
            </dd>
          </div>
        </dl>
        <section v-if="selected.description" class="detail-block">
          <h3>任务说明</h3>
          <p class="description-text">{{ selected.description }}</p>
        </section>
        <section class="detail-block">
          <div class="section-title">
            <h3>提交与确认记录</h3>
            <span>{{ selected.submissions.length }} 次提交</span>
          </div>
          <el-empty
            v-if="!selected.submissions.length"
            description="尚无提交记录"
            :image-size="52"
          />
          <article
            v-for="item in [...selected.submissions].reverse()"
            :key="item.id"
            class="submission-card"
          >
            <div class="record-head">
              <strong>{{ memberName(item.submittedBy) }}</strong
              ><time>{{ dateTime(item.createdAt) }}</time>
            </div>
            <p v-if="item.summary" class="description-text">
              {{ item.summary }}
            </p>
            <ul v-if="item.evidence.length" class="evidence-list">
              <li v-for="(evidence, index) in item.evidence" :key="index">
                <a
                  v-if="evidenceHref(evidence)"
                  :href="evidenceHref(evidence)"
                  target="_blank"
                  rel="noopener noreferrer"
                  >{{ evidenceLabel(evidence) }}</a
                ><span v-else>{{ evidenceLabel(evidence) }}</span>
              </li>
            </ul>
            <div v-if="item.review" class="review-record">
              <el-tag
                size="small"
                :type="
                  item.review.result === 'approved' ? 'success' : 'warning'
                "
                >{{
                  item.review.result === "approved" ? "已通过" : "已退回"
                }}</el-tag
              ><span
                >{{ memberName(item.review.reviewerUserId) }} ·
                {{ dateTime(item.review.createdAt) }}</span
              >
              <p v-if="item.review.reason">{{ item.review.reason }}</p>
            </div>
            <div
              v-else-if="selected.status === 'pending_confirmation'"
              class="review-record"
            >
              <el-tag size="small" type="warning">等待确认</el-tag>
            </div>
          </article>
        </section>
        <section class="detail-block">
          <h3>任务历史</h3>
          <el-timeline v-if="selected.actions.length"
            ><el-timeline-item
              v-for="entry in filteredHistory(selected)"
              :key="entry.id"
              :timestamp="dateTime(entry.createdAt)"
              placement="top"
              ><strong>{{ actionLabels[entry.action] || entry.action }}</strong
              ><span class="history-actor">{{
                memberName(entry.actorUserId)
              }}</span>
              <p v-if="entry.reason" class="history-reason">
                {{ entry.reason }}
              </p>
              <p
                v-for="line in historyChanges(entry)"
                :key="line"
                class="history-reason"
              >
                {{ line }}
              </p></el-timeline-item
            ></el-timeline
          ><el-empty v-else description="暂无操作历史" :image-size="48" />
        </section>
      </template>
    </el-drawer>

    <el-dialog
      v-model="submitOpen"
      title="提交任务进展"
      width="500px"
      append-to-body
      ><el-form label-position="top"
        ><el-form-item label="处理说明"
          ><el-input
            v-model="submission.summary"
            type="textarea"
            :rows="4"
            maxlength="4000"
            placeholder="说明完成了什么，或当前的处理结果" /></el-form-item
        ><el-form-item v-if="selected?.requirementId" label="选择需求产物"
          ><el-select
            v-model="selectedEvidenceKeys"
            multiple
            collapse-tags
            collapse-tags-tooltip
            :loading="evidenceLoading"
            placeholder="选择已授权的产物或文件"
            style="width: 100%"
            ><el-option
              v-for="option in evidenceOptions"
              :key="option.key"
              :label="option.label"
              :value="option.key" /></el-select></el-form-item
        ><el-divider content-position="left">补充外部链接（可选）</el-divider
        ><el-form-item label="证据链接"
          ><el-input
            v-model="submission.url"
            type="url"
            placeholder="https://..." /></el-form-item
        ><el-form-item v-if="submission.url" label="链接名称"
          ><el-input
            v-model="submission.label"
            maxlength="200"
            placeholder="例如：验收环境、设计稿" /></el-form-item></el-form
      ><template #footer
        ><el-button @click="submitOpen = false">取消</el-button
        ><el-button type="primary" :loading="submitBusy" @click="submitProgress"
          >提交确认</el-button
        ></template
      ></el-dialog
    >
    <el-dialog
      v-model="planOpen"
      title="安排到个人日程"
      width="400px"
      append-to-body
    >
      <p class="plan-help">
        同一任务同一天只保留一条个人安排；重复安排会打开已有记录。
      </p>
      <el-form label-position="top">
        <el-form-item label="业务日期"
          ><el-date-picker
            v-model="planDate"
            type="date"
            value-format="YYYY-MM-DD"
            :clearable="false"
            style="width: 100%"
        /></el-form-item>
        <el-form-item label="预计耗时"
          ><el-select v-model="planEstimatedMinutes" style="width: 100%"
            ><el-option
              v-for="minutes in [
                30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360, 390,
                420, 450, 480,
              ]"
              :key="minutes"
              :label="
                minutes % 60
                  ? (Math.floor(minutes / 60)
                      ? Math.floor(minutes / 60) + ' 小时 '
                      : '') +
                    (minutes % 60) +
                    ' 分钟'
                  : minutes / 60 + ' 小时'
              "
              :value="minutes" /></el-select
        ></el-form-item>
        <div class="plan-time-row">
          <el-form-item label="计划开始"
            ><el-time-picker
              v-model="planStart"
              format="HH:mm"
              value-format="HH:mm"
              placeholder="不设置"
              style="width: 100%" /></el-form-item
          ><el-form-item label="计划结束"
            ><el-time-picker
              v-model="planEnd"
              format="HH:mm"
              value-format="HH:mm"
              placeholder="不设置"
              style="width: 100%"
          /></el-form-item>
        </div>
        <p class="plan-help">开始与结束时间需要同时填写。</p>
      </el-form>
      <template #footer
        ><el-button @click="planOpen = false">取消</el-button
        ><el-button type="primary" :loading="planBusy" @click="savePlan"
          >安排并打开日程</el-button
        ></template
      >
    </el-dialog>
  </section>
</template>

<style scoped>
.tasks-panel {
  min-width: 0;
}
.tasks-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 8px 0 12px;
}
.views {
  display: flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--border-base);
  border-radius: 7px;
  background: var(--bg-subtle);
}
.views button {
  min-height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 5px;
  color: var(--text-secondary);
  background: transparent;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.views button.active {
  background: var(--bg-surface);
  color: var(--text-title);
  box-shadow: 0 1px 3px #00000014;
  font-weight: 600;
}
.filter-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.status-filter {
  width: 140px;
}
.scope-note {
  padding: 8px 10px;
  margin-bottom: 10px;
  border-radius: 5px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 12px;
}
.task-table {
  width: 100%;
  cursor: pointer;
}
.task-title {
  color: var(--text-title);
  font-weight: 600;
  line-height: 1.4;
}
.task-description {
  max-width: 520px;
  margin-top: 3px;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-meta {
  display: flex;
  gap: 10px;
  margin-top: 5px;
  color: var(--text-muted);
  font-size: 11px;
}
.pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  color: var(--text-secondary);
  font-size: 12px;
}
.detail-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 14px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-base);
}
.detail-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
}
.detail-actions .el-button {
  margin: 0;
}
.task-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 20px;
  padding: 16px 0;
  margin: 0;
  border-bottom: 1px solid var(--border-base);
}
.task-facts div {
  min-width: 0;
}
.task-facts dt {
  color: var(--text-muted);
  font-size: 11px;
}
.task-facts dd {
  margin: 4px 0 0;
  color: var(--text-title);
  font-size: 13px;
}
.detail-block {
  padding: 16px 0;
  border-bottom: 1px solid var(--border-base);
}
.detail-block h3 {
  margin: 0 0 12px;
  font-size: 14px;
}
.description-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  line-height: 1.65;
}
.section-title,
.record-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
.section-title > span,
.record-head time {
  color: var(--text-muted);
  font-size: 11px;
}
.submission-card {
  padding: 12px 0;
  border-top: 1px solid var(--border-base);
}
.record-head strong {
  font-size: 12px;
}
.submission-card .description-text {
  margin: 8px 0;
}
.evidence-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
  padding-left: 18px;
  font-size: 12px;
}
.review-record {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  color: var(--text-secondary);
  font-size: 11px;
}
.review-record p {
  flex-basis: 100%;
  margin: 0 0 0 58px;
  color: var(--text-secondary);
  white-space: pre-wrap;
}
.history-actor {
  margin-left: 8px;
  color: var(--text-muted);
  font-size: 11px;
}
.history-reason {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: pre-wrap;
}
.plan-help {
  margin: 0 0 14px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.plan-time-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
@media (max-width: 680px) {
  .detail-toolbar {
    flex-direction: column;
  }
  .detail-actions {
    justify-content: flex-start;
  }
  .task-facts {
    grid-template-columns: 1fr 1fr;
  }
  .status-filter {
    width: 120px;
  }
}
</style>
