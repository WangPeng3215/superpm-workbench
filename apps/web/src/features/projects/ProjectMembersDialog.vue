<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import {
  projectRoleLabels,
  projectRoles,
  type ProjectDetail,
  type ProjectRole,
  type ProjectTaskResponsibilityTransfer,
} from "@superpm/shared";
import { projectApi, type ProjectMemberCandidate } from "../../api/projects";
import { projectTaskApi, type ProjectTask } from "../../api/project-tasks";
import { ApiError, errorMessage } from "../../api/client";
const props = defineProps<{ detail: ProjectDetail }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ updated: [detail: ProjectDetail]; denied: [] }>();
const candidates = ref<ProjectMemberCandidate[]>([]),
  selected = ref<number>(),
  roles = ref<ProjectRole[]>(["contributor"]);
const searching = ref(false),
  saving = ref(false),
  error = ref(""),
  errorDetails = ref("");
const memberRoles = ref<Record<number, ProjectRole[]>>({});
const owner = ref<number>(),
  productOwner = ref<number>();
type TransferRow = ProjectTask & {
  nextAssignee?: number;
  nextConfirmer?: number;
};
type TransferIntent =
  | { action: "roles"; userId: number; roles: ProjectRole[] }
  | { action: "remove"; userId: number };
const transferRows = ref<TransferRow[]>([]);
const transferIntent = ref<TransferIntent>();
const loadingTransfers = ref(false);
const transferLoadError = ref("");
const members = computed(() =>
  props.detail.members.filter((member) => member.status === "active"),
);
const canManage = computed(() => props.detail.capabilities.canManageMembers);
const transferTargets = computed(() =>
  members.value.filter(
    (member) =>
      member.userId !== transferIntent.value?.userId &&
      member.accountStatus === "active" &&
      member.roles.some((role) => role !== "viewer"),
  ),
);
const transferComplete = computed(
  () =>
    !!transferIntent.value &&
    transferRows.value.every(
      (task) =>
        (task.assigneeUserId !== transferIntent.value!.userId ||
          transferTargets.value.some(
            (member) => member.userId === task.nextAssignee,
          )) &&
        (task.confirmerUserId !== transferIntent.value!.userId ||
          transferTargets.value.some(
            (member) => member.userId === task.nextConfirmer,
          )),
    ),
);
let searchRevision = 0;
function reset() {
  memberRoles.value = Object.fromEntries(
    members.value.map((member) => [member.userId, [...member.roles]]),
  );
  owner.value = props.detail.project.ownerUserId;
  productOwner.value = props.detail.project.productOwnerUserId;
}
watch(() => props.detail, reset, { immediate: true });
watch(open, (value) => {
  searchRevision++;
  searching.value = false;
  if (value) {
    reset();
    candidates.value = [];
    selected.value = undefined;
    error.value = "";
    errorDetails.value = "";
    transferIntent.value = undefined;
    transferRows.value = [];
    transferLoadError.value = "";
  }
});
async function search(q: string) {
  const token = ++searchRevision;
  candidates.value = [];
  if (q.trim().length < 2 || !canManage.value) {
    searching.value = false;
    return;
  }
  searching.value = true;
  try {
    const result = await projectApi.memberCandidates(
      props.detail.project.id,
      q.trim(),
    );
    if (token === searchRevision && open.value)
      candidates.value = result.items.slice(0, 20);
  } catch (e) {
    if (token === searchRevision) error.value = errorMessage(e);
  } finally {
    if (token === searchRevision) searching.value = false;
  }
}
async function change(action: () => Promise<ProjectDetail>) {
  if (saving.value || !canManage.value) return;
  saving.value = true;
  error.value = "";
  errorDetails.value = "";
  try {
    emit("updated", await action());
    selected.value = undefined;
    candidates.value = [];
  } catch (e) {
    error.value = errorMessage(e);
    if (e instanceof ApiError && e.details)
      errorDetails.value = JSON.stringify(e.details, null, 2);
    if (e instanceof ApiError && [403, 404].includes(e.status)) {
      open.value = false;
      emit("denied");
    }
  } finally {
    saving.value = false;
  }
}
function add() {
  if (!selected.value || !roles.value.length) return;
  const userId = selected.value;
  void change(() =>
    projectApi.addMember(props.detail.project.id, {
      userId,
      roles: roles.value,
      expectedVersion: props.detail.project.version,
    }),
  );
}
async function tasksFor(userId: number): Promise<ProjectTask[]> {
  const readAll = async (filter: {
    assigneeUserId?: number;
    confirmerUserId?: number;
  }) => {
    const items: ProjectTask[] = [];
    let page = 1;
    let total = 0;
    do {
      const result = await projectTaskApi.list(props.detail.project.id, {
        ...filter,
        page,
        pageSize: 100,
      });
      items.push(...result.items);
      total = result.total;
      page++;
    } while (items.length < total);
    return items;
  };
  const [assigned, awaitingConfirmation] = await Promise.all([
    readAll({ assigneeUserId: userId }),
    readAll({ confirmerUserId: userId }),
  ]);
  const unique = new Map<number, ProjectTask>();
  for (const task of [...assigned, ...awaitingConfirmation])
    if (!["completed", "cancelled"].includes(task.status))
      unique.set(task.id, task);
  return [...unique.values()].sort((a, b) => a.id - b.id);
}
async function beginTransfer(intent: TransferIntent) {
  if (loadingTransfers.value || saving.value) return;
  loadingTransfers.value = true;
  transferLoadError.value = "";
  try {
    const tasks = await tasksFor(intent.userId);
    if (!tasks.length) {
      transferIntent.value = undefined;
      if (intent.action === "roles") {
        void change(() =>
          projectApi.updateMember(props.detail.project.id, intent.userId, {
            userId: intent.userId,
            roles: intent.roles,
            expectedVersion: props.detail.project.version,
          }),
        );
      } else {
        void change(() =>
          projectApi.removeMember(
            props.detail.project.id,
            intent.userId,
            props.detail.project.version,
          ),
        );
      }
      return;
    }
    transferIntent.value = intent;
    transferRows.value = tasks.map((task) => ({ ...task }));
  } catch (e) {
    transferLoadError.value = errorMessage(e);
  } finally {
    loadingTransfers.value = false;
  }
}
function saveRoles(userId: number) {
  const nextRoles = memberRoles.value[userId] ?? [];
  const currentRoles =
    members.value.find((member) => member.userId === userId)?.roles ?? [];
  const losesTaskCapability =
    currentRoles.some((role) => role !== "viewer") &&
    !nextRoles.some((role) => role !== "viewer");
  if (losesTaskCapability) {
    void beginTransfer({ action: "roles", userId, roles: [...nextRoles] });
    return;
  }
  void change(() =>
    projectApi.updateMember(props.detail.project.id, userId, {
      userId,
      roles: nextRoles,
      expectedVersion: props.detail.project.version,
    }),
  );
}
async function remove(userId: number, name: string) {
  try {
    await ElMessageBox.confirm(
      `移除「${name}」后，对方将无法继续访问此项目及关联需求资料。若仍承担未完成任务，将在下一步逐项移交。`,
      "移除项目成员",
      {
        type: "warning",
        confirmButtonText: "确认移除",
        cancelButtonText: "取消",
      },
    );
    await beginTransfer({ action: "remove", userId });
  } catch {}
}
function submitTransfer() {
  const intent = transferIntent.value;
  if (!intent || !transferComplete.value) return;
  const taskTransfers: ProjectTaskResponsibilityTransfer[] =
    transferRows.value.map((task) => ({
      taskId: task.id,
      expectedVersion: task.version,
      ...(task.assigneeUserId === intent.userId
        ? { assigneeUserId: task.nextAssignee }
        : {}),
      ...(task.confirmerUserId === intent.userId
        ? { confirmerUserId: task.nextConfirmer }
        : {}),
    }));
  void change(async () => {
    const result =
      intent.action === "roles"
        ? await projectApi.updateMember(
            props.detail.project.id,
            intent.userId,
            {
              userId: intent.userId,
              roles: intent.roles,
              expectedVersion: props.detail.project.version,
              taskTransfers,
            },
          )
        : await projectApi.removeMember(
            props.detail.project.id,
            intent.userId,
            props.detail.project.version,
            taskTransfers,
          );
    transferIntent.value = undefined;
    transferRows.value = [];
    return result;
  });
}
function saveLeads() {
  if (!owner.value || !productOwner.value) return;
  void change(() =>
    projectApi.updateLeads(props.detail.project.id, {
      ownerUserId: owner.value!,
      productOwnerUserId: productOwner.value!,
      expectedVersion: props.detail.project.version,
    }),
  );
}
</script>
<template>
  <el-dialog
    v-model="open"
    title="项目成员"
    width="min(900px, 94vw)"
    :close-on-click-modal="false"
  >
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <pre v-if="errorDetails" class="error-details">{{ errorDetails }}</pre>
    <p class="intro">
      一人可以兼任多个角色。主要负责人须具有对应角色，移除成员或角色前须先移交责任。
    </p>
    <div v-if="canManage" class="add-member">
      <el-select
        v-model="selected"
        filterable
        remote
        clearable
        :remote-method="search"
        :loading="searching"
        placeholder="输入至少 2 字搜索账号"
        aria-label="搜索项目成员账号"
        ><el-option
          v-for="candidate in candidates"
          :key="candidate.id"
          :value="candidate.id"
          :label="`${candidate.displayName}（${candidate.username}）`"
      /></el-select>
      <el-select v-model="roles" multiple aria-label="新增成员角色"
        ><el-option
          v-for="role in projectRoles"
          :key="role"
          :value="role"
          :label="projectRoleLabels[role]"
      /></el-select>
      <el-button
        type="primary"
        :loading="saving"
        :disabled="!selected || !roles.length"
        @click="add"
        >添加成员</el-button
      >
    </div>
    <el-table :data="members" row-key="userId">
      <el-table-column label="成员" min-width="170"
        ><template #default="{ row }"
          ><strong>{{ row.displayName }}</strong>
          <div class="username">
            {{ row.username
            }}{{ row.accountStatus === "disabled" ? " · 账号已停用" : "" }}
          </div></template
        ></el-table-column
      >
      <el-table-column label="角色（可兼任）" min-width="300"
        ><template #default="{ row }"
          ><el-select
            v-if="canManage"
            v-model="memberRoles[row.userId]"
            multiple
            :disabled="saving"
            :aria-label="row.displayName + '的角色'"
            ><el-option
              v-for="role in projectRoles"
              :key="role"
              :value="role"
              :label="projectRoleLabels[role]" /></el-select
          ><template v-else
            ><el-tag v-for="role in row.roles" :key="role">{{
              projectRoleLabels[role as ProjectRole]
            }}</el-tag></template
          ></template
        ></el-table-column
      >
      <el-table-column v-if="canManage" label="操作" width="180"
        ><template #default="{ row }"
          ><el-button
            link
            type="primary"
            :disabled="
              saving || loadingTransfers || !memberRoles[row.userId]?.length
            "
            @click="saveRoles(row.userId)"
            >保存角色</el-button
          ><el-button
            link
            type="danger"
            :disabled="saving || loadingTransfers"
            @click="remove(row.userId, row.displayName)"
            >移除</el-button
          ></template
        ></el-table-column
      >
    </el-table>
    <el-alert
      v-if="transferLoadError"
      class="transfer-load-error"
      :title="transferLoadError"
      type="error"
      :closable="false"
    />
    <section v-if="transferIntent" class="task-transfers">
      <div class="transfer-heading">
        <strong>任务责任移交（{{ transferRows.length }} 项）</strong>
        <span>逐项指定接收人后，与角色变更或成员移除一起保存。</span>
      </div>
      <el-alert
        v-if="!transferTargets.length"
        title="项目中没有可接收任务责任的有效成员，请先添加执行成员、产品负责人或项目负责人。"
        type="warning"
        :closable="false"
      />
      <el-table :data="transferRows" row-key="id" size="small" max-height="300">
        <el-table-column prop="title" label="未完成任务" min-width="180" />
        <el-table-column label="执行人移交" min-width="200">
          <template #default="{ row }">
            <el-select
              v-if="row.assigneeUserId === transferIntent.userId"
              v-model="row.nextAssignee"
              placeholder="选择新执行人"
              :disabled="saving"
            >
              <el-option
                v-for="member in transferTargets"
                :key="member.userId"
                :value="member.userId"
                :label="member.displayName"
              />
            </el-select>
            <span v-else>无需移交</span>
          </template>
        </el-table-column>
        <el-table-column label="确认人移交" min-width="200">
          <template #default="{ row }">
            <el-select
              v-if="row.confirmerUserId === transferIntent.userId"
              v-model="row.nextConfirmer"
              placeholder="选择新确认人"
              :disabled="saving"
            >
              <el-option
                v-for="member in transferTargets"
                :key="member.userId"
                :value="member.userId"
                :label="member.displayName"
              />
            </el-select>
            <span v-else>无需移交</span>
          </template>
        </el-table-column>
      </el-table>
      <div class="transfer-actions">
        <el-button
          :disabled="saving"
          @click="
            transferIntent = undefined;
            transferRows = [];
          "
          >取消</el-button
        >
        <el-button
          type="primary"
          :loading="saving"
          :disabled="!transferComplete"
          @click="submitTransfer"
        >
          {{
            transferIntent.action === "roles"
              ? "移交并保存角色"
              : "移交并移除成员"
          }}
        </el-button>
      </div>
    </section>
    <el-form v-if="canManage" class="leads" label-position="top">
      <el-form-item label="主要项目负责人"
        ><el-select v-model="owner" aria-label="主要项目负责人"
          ><el-option
            v-for="member in members.filter(
              (m) => m.roles.includes('owner') && m.accountStatus === 'active',
            )"
            :key="member.userId"
            :value="member.userId"
            :label="member.displayName" /></el-select
      ></el-form-item>
      <el-form-item label="主要产品负责人"
        ><el-select v-model="productOwner" aria-label="主要产品负责人"
          ><el-option
            v-for="member in members.filter(
              (m) =>
                m.roles.includes('product_owner') &&
                m.accountStatus === 'active',
            )"
            :key="member.userId"
            :value="member.userId"
            :label="member.displayName" /></el-select
      ></el-form-item>
      <el-button
        :loading="saving"
        :disabled="!owner || !productOwner"
        @click="saveLeads"
        >保存主要负责人</el-button
      >
    </el-form>
    <template #footer
      ><el-button @click="open = false">完成</el-button></template
    >
  </el-dialog>
</template>
<style scoped>
.intro,
.username {
  color: var(--text-secondary);
  line-height: 1.7;
}
.username {
  font-size: 12px;
}
.add-member {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
.add-member > .el-select {
  flex: 1;
  min-width: 0;
}
.transfer-load-error {
  margin-top: 12px;
}
.task-transfers {
  display: grid;
  gap: 12px;
  margin-top: 18px;
  padding: 14px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-subtle);
}
.transfer-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 14px;
}
.transfer-heading span {
  color: var(--text-secondary);
  font-size: 13px;
}
.transfer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.leads {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  margin-top: 20px;
}
.leads .el-form-item {
  flex: 1;
  margin: 0;
}
.error-details {
  white-space: pre-wrap;
  max-height: 180px;
  overflow: auto;
  padding: 12px;
  background: var(--bg-subtle);
  font-size: 12px;
}
</style>
