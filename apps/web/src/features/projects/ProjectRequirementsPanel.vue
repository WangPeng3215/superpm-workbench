<script setup lang="ts">
import { computed, ref } from "vue";
import type { ProjectDetail, Requirement } from "@superpm/shared";
import { projectApi, type ProjectSharePreview } from "../../api/projects";
import { requirementApi } from "../../api/requirements";
import { ApiError, errorMessage } from "../../api/client";
import RequirementTable from "../requirements/RequirementTable.vue";
const props = defineProps<{
  detail: ProjectDetail;
  beforeAction: () => Promise<boolean>;
}>();
const emit = defineEmits<{ updated: [detail: ProjectDetail]; denied: [] }>();
const table = ref<InstanceType<typeof RequirementTable>>();
const shareOpen = ref(false),
  loading = ref(false),
  saving = ref(false),
  error = ref(""),
  q = ref("");
const candidates = ref<Requirement[]>([]),
  selected = ref<number>(),
  preview = ref<ProjectSharePreview>();
const assignee = ref<number>(),
  developer = ref<number>();
const editable = computed(
  () => props.detail.capabilities.canManageRequirements,
);
const members = computed(() =>
  props.detail.members.filter(
    (m) =>
      m.status === "active" &&
      m.accountStatus === "active" &&
      m.roles.some((role) => role !== "viewer"),
  ),
);
let revision = 0;
function selectRow(row: Requirement) {
  selected.value = row.id;
}
async function find() {
  const token = ++revision;
  loading.value = true;
  error.value = "";
  try {
    const result = await requirementApi.list({
      q: q.value,
      unassigned: true,
      pageSize: 100,
    });
    if (token === revision && shareOpen.value) candidates.value = result.items;
  } catch (e) {
    if (token === revision) error.value = errorMessage(e);
  } finally {
    if (token === revision) loading.value = false;
  }
}
async function openShare() {
  if (
    !editable.value ||
    !(await props.beforeAction()) ||
    !(await table.value?.flush())
  )
    return;
  shareOpen.value = true;
  selected.value = undefined;
  preview.value = undefined;
  assignee.value = undefined;
  developer.value = undefined;
  q.value = "";
  candidates.value = [];
  error.value = "";
  await find();
}
async function makePreview() {
  if (!selected.value || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    preview.value = await projectApi.sharePreview(
      props.detail.project.id,
      selected.value,
    );
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}
async function confirmShare() {
  if (!preview.value || saving.value || !editable.value) return;
  saving.value = true;
  error.value = "";
  try {
    const result = await projectApi.share(props.detail.project.id, {
      token: preview.value.token,
      confirmed: true,
      expectedVersion: props.detail.project.version,
      assigneeUserId: assignee.value,
      developerUserId: developer.value,
    });
    emit("updated", result);
    shareOpen.value = false;
    preview.value = undefined;
    await table.value?.load();
  } catch (e) {
    error.value = errorMessage(e);
    if (e instanceof ApiError && [403, 404].includes(e.status)) {
      shareOpen.value = false;
      preview.value = undefined;
      candidates.value = [];
      emit("denied");
    }
  } finally {
    saving.value = false;
  }
}
function closeShare() {
  revision++;
  preview.value = undefined;
  candidates.value = [];
  selected.value = undefined;
}
function invalidate() {
  revision++;
  shareOpen.value = false;
  preview.value = undefined;
  candidates.value = [];
  table.value?.invalidate();
}
defineExpose({
  flush: async () => (await table.value?.flush()) ?? true,
  invalidate,
});
</script>
<template>
  <div class="project-requirements">
    <div class="panel-heading">
      <div>
        <h2>项目需求</h2>
        <p>在此创建的需求直接归属本项目，需求详情沿用统一工作台。</p>
      </div>
      <el-button v-if="editable" @click="openShare">关联已有私人需求</el-button>
    </div>
    <RequirementTable
      ref="table"
      :project-id="detail.project.id"
      :read-only="!editable"
    />
    <el-dialog
      v-model="shareOpen"
      :title="preview ? '确认共享整棵需求树' : '选择已有私人需求'"
      width="min(800px, 94vw)"
      :close-on-click-modal="false"
      @closed="closeShare"
    >
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <template v-if="!preview">
        <p class="intro">
          只能关联你本人创建、尚未加入项目的主需求。它的全部子需求将一起加入。
        </p>
        <div class="search-line">
          <el-input
            v-model="q"
            clearable
            aria-label="搜索私人需求"
            placeholder="名称或编号"
            @keyup.enter="find"
          /><el-button @click="find">搜索</el-button>
        </div>
        <el-table v-loading="loading" :data="candidates" @row-click="selectRow"
          ><el-table-column width="55"
            ><template #default="{ row }"
              ><el-radio
                v-model="selected"
                :value="row.id"
                :aria-label="'选择' + row.name"
                ><span /></el-radio></template></el-table-column
          ><el-table-column
            prop="requirementNo"
            label="需求编号"
            width="150" /><el-table-column
            prop="name"
            label="需求名称"
            min-width="250"
            show-overflow-tooltip /><template #empty
            ><el-empty description="没有可关联的私人主需求" /></template
        ></el-table>
      </template>
      <template v-else>
        <el-alert
          title="共享后，项目有效成员将可以按角色访问这些需求及其问题、文档、文件和图片。私人会议、便签等个人记录不会随之公开。此操作不会移动本地目录。"
          type="warning"
          :closable="false"
          show-icon
        />
        <p class="intro">
          以下 {{ preview.requirements.length }} 条需求将整体共享，同时包含
          {{ preview.issueCount }} 个问题、{{ preview.artifactCount }}
          项文档与文件资料。
        </p>
        <el-table :data="preview.requirements" max-height="300"
          ><el-table-column label="层级" width="90"
            ><template #default="{ row }">{{
              row.id === preview?.rootRequirementId ? "主需求" : "子需求"
            }}</template></el-table-column
          ><el-table-column
            prop="requirementNo"
            label="需求编号"
            width="150" /><el-table-column prop="name" label="需求名称"
        /></el-table>
        <div class="assignment">
          <el-select
            v-model="assignee"
            clearable
            placeholder="需求负责人（可稍后分配）"
            aria-label="共享需求负责人"
            ><el-option
              v-for="member in members"
              :key="member.userId"
              :value="member.userId"
              :label="member.displayName" /></el-select
          ><el-select
            v-model="developer"
            clearable
            placeholder="开发负责人（可稍后分配）"
            aria-label="共享需求开发负责人"
            ><el-option
              v-for="member in members"
              :key="member.userId"
              :value="member.userId"
              :label="member.displayName"
          /></el-select>
        </div>
        <p class="intro">
          预览有效至
          {{
            new Date(preview.expiresAt).toLocaleString("zh-CN")
          }}。确认时会再次校验内容、版本与权限。
        </p>
      </template>
      <template #footer
        ><el-button :disabled="saving" @click="shareOpen = false"
          >取消</el-button
        ><el-button
          v-if="preview"
          :disabled="saving"
          @click="preview = undefined"
          >返回选择</el-button
        ><el-button
          v-if="!preview"
          type="primary"
          :loading="saving"
          :disabled="!selected"
          @click="makePreview"
          >预览共享范围</el-button
        ><el-button
          v-else
          type="primary"
          :loading="saving"
          @click="confirmShare"
          >确认共享并关联</el-button
        ></template
      >
    </el-dialog>
  </div>
</template>
<style scoped>
.panel-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 18px;
}
.panel-heading h2 {
  font-size: 17px;
  margin: 0 0 8px;
}
.panel-heading p,
.intro {
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 8px 0 16px;
}
.search-line,
.assignment {
  display: flex;
  gap: 12px;
  margin: 16px 0;
}
.assignment > .el-select {
  flex: 1;
}
</style>
