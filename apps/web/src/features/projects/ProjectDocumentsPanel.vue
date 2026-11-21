<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import {
  projectDocumentsApi,
  projectDocumentKindLabels,
  type ProjectArtifact,
  type ProjectDocument,
  type ProjectDocumentKind,
} from "../../api/project-documents";
import { meetingApi } from "../../api/meetings";
import type { MeetingSummary } from "@superpm/shared";
import { errorMessage } from "../../api/client";

const props = withDefaults(
  defineProps<{ projectId: number; readonly?: boolean }>(),
  { readonly: false },
);
const documents = ref<ProjectDocument[]>([]);
const artifacts = ref<ProjectArtifact[]>([]);
const loading = ref(false);
const error = ref("");
const activeKind = ref<"all" | ProjectDocumentKind>("all");
const searchText = ref("");
const dialogOpen = ref(false);
const saving = ref(false);
const editing = ref<ProjectDocument>();
const form = ref({
  kind: "note" as ProjectDocumentKind,
  title: "",
  content: "",
  url: "",
  meetingTime: "",
});
const meetingDialogOpen = ref(false);
const meetingLoading = ref(false);
const meetingSearch = ref("");
const meetings = ref<MeetingSummary[]>([]);
const selectedMeeting = ref<number>();
const deletingId = ref<number>();
let revision = 0;

const editable = computed(() => !props.readonly);
const documentKinds = ["note", "decision", "meeting", "link"] as const;
const filteredDocuments = computed(() => {
  const q = searchText.value.trim().toLocaleLowerCase();
  return documents.value.filter((item) => {
    if (activeKind.value !== "all" && item.kind !== activeKind.value)
      return false;
    if (!q) return true;
    return (item.title + " " + item.content + " " + (item.url ?? ""))
      .toLocaleLowerCase()
      .includes(q);
  });
});

async function load() {
  const token = ++revision;
  loading.value = true;
  error.value = "";
  try {
    const [documentResult, artifactResult] = await Promise.all([
      projectDocumentsApi.list(props.projectId),
      projectDocumentsApi.artifacts(props.projectId),
    ]);
    if (token !== revision) return;
    documents.value = documentResult.items;
    artifacts.value = artifactResult.items;
  } catch (cause) {
    if (token === revision) error.value = errorMessage(cause);
  } finally {
    if (token === revision) loading.value = false;
  }
}
function openCreate(kind: ProjectDocumentKind = "note") {
  if (!editable.value) return;
  editing.value = undefined;
  form.value = { kind, title: "", content: "", url: "", meetingTime: "" };
  dialogOpen.value = true;
}
function openEdit(item: ProjectDocument) {
  if (!editable.value) return;
  editing.value = item;
  form.value = {
    kind: item.kind,
    title: item.title,
    content: item.content,
    url: item.url ?? "",
    meetingTime: item.meetingTime ?? "",
  };
  dialogOpen.value = true;
}
async function save() {
  const title = form.value.title.trim();
  if (!title || saving.value) return;
  if (form.value.kind === "link" && !form.value.url.trim()) {
    error.value = "请输入链接地址";
    return;
  }
  if (form.value.kind === "meeting" && !form.value.meetingTime) {
    error.value = "请选择会议时间";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    const item = editing.value;
    if (item) {
      await projectDocumentsApi.update(props.projectId, item.id, {
        expectedVersion: item.version,
        title,
        ...(item.kind === "link"
          ? { url: form.value.url.trim() }
          : { content: form.value.content }),
        ...(item.kind === "meeting"
          ? { meetingTime: form.value.meetingTime }
          : {}),
      });
    } else {
      await projectDocumentsApi.create(props.projectId, {
        kind: form.value.kind,
        title,
        ...(form.value.kind === "link"
          ? { url: form.value.url.trim() }
          : { content: form.value.content }),
        ...(form.value.kind === "meeting"
          ? { meetingTime: form.value.meetingTime }
          : {}),
      });
    }
    dialogOpen.value = false;
    await load();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function remove(item: ProjectDocument) {
  if (!editable.value || deletingId.value) return;
  try {
    await ElMessageBox.confirm(
      "确定删除“" + item.title + "”吗？删除后项目成员将无法查看。",
      "删除项目资料",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  deletingId.value = item.id;
  try {
    await projectDocumentsApi.remove(props.projectId, item.id, item.version);
    await load();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    deletingId.value = undefined;
  }
}
async function findMeetings() {
  meetingLoading.value = true;
  error.value = "";
  try {
    meetings.value = await meetingApi.list({ q: meetingSearch.value.trim() });
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    meetingLoading.value = false;
  }
}
async function openMeetingPicker() {
  if (!editable.value) return;
  meetingSearch.value = "";
  meetings.value = [];
  selectedMeeting.value = undefined;
  meetingDialogOpen.value = true;
  await findMeetings();
}
async function copyMeeting() {
  if (!selectedMeeting.value || meetingLoading.value) return;
  try {
    await ElMessageBox.confirm(
      "系统会把你有权查看的会议标题、时间和正文复制为项目纪要快照。之后私人会议的修改不会同步到项目。",
      "复制为项目纪要",
      {
        type: "warning",
        confirmButtonText: "确认复制",
        cancelButtonText: "取消",
      },
    );
  } catch {
    return;
  }
  meetingLoading.value = true;
  error.value = "";
  try {
    await projectDocumentsApi.copyMeeting(
      props.projectId,
      selectedMeeting.value,
    );
    meetingDialogOpen.value = false;
    await load();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    meetingLoading.value = false;
  }
}
function artifactUrl(item: ProjectArtifact) {
  return item.kind === "link" ? item.url : undefined;
}
async function openDocumentById(documentId: number) {
  await load();
  const item = documents.value.find((document) => document.id === documentId);
  if (!item) return;
  activeKind.value = "all";
  searchText.value = item.title;
}
onMounted(() => void load());
watch(
  () => props.projectId,
  () => void load(),
);
defineExpose({
  refresh: load,
  openDocumentById,
  invalidate: () => {
    revision++;
    documents.value = [];
    artifacts.value = [];
  },
});
</script>

<template>
  <section class="documents-panel" v-loading="loading" aria-label="项目资料">
    <header class="panel-heading">
      <div>
        <h2>项目资料</h2>
        <p>项目成员可查看的笔记、决策、纪要、链接与需求产物。</p>
      </div>
      <div class="heading-actions">
        <el-tag v-if="readonly" size="small" type="info">只读</el-tag>
        <el-button size="small" :loading="loading" @click="load"
          >刷新</el-button
        >
        <el-dropdown v-if="editable" @command="openCreate">
          <el-button size="small" type="primary">新增资料</el-button>
          <template #dropdown
            ><el-dropdown-menu
              ><el-dropdown-item command="note">项目笔记</el-dropdown-item
              ><el-dropdown-item command="decision">决策记录</el-dropdown-item
              ><el-dropdown-item command="link">外部链接</el-dropdown-item
              ><el-dropdown-item command="meeting"
                >项目纪要</el-dropdown-item
              ></el-dropdown-menu
            ></template
          >
        </el-dropdown>
        <el-button v-if="editable" size="small" @click="openMeetingPicker"
          >复制我的会议</el-button
        >
      </div>
    </header>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />
    <section class="content-section" aria-labelledby="project-documents-title">
      <div class="section-heading">
        <h3 id="project-documents-title">项目资料</h3>
        <span>{{ filteredDocuments.length }} 项</span>
      </div>
      <div class="filters">
        <el-input
          v-model="searchText"
          clearable
          size="small"
          placeholder="搜索资料标题或正文"
          aria-label="搜索项目资料"
        /><el-select
          v-model="activeKind"
          size="small"
          aria-label="按资料类型筛选"
          ><el-option label="全部类型" value="all" /><el-option
            v-for="kind in documentKinds"
            :key="kind"
            :label="projectDocumentKindLabels[kind]"
            :value="kind"
        /></el-select>
      </div>
      <el-empty
        v-if="!filteredDocuments.length && !loading"
        description="暂无项目资料"
        :image-size="56"
        ><el-button
          v-if="editable"
          type="primary"
          size="small"
          @click="openCreate()"
          >新增资料</el-button
        ></el-empty
      >
      <ul v-else class="document-list">
        <li
          v-for="item in filteredDocuments"
          :key="item.id"
          class="document-row"
        >
          <div class="document-copy">
            <div class="document-title-line">
              <el-tag size="small" effect="plain">{{
                projectDocumentKindLabels[item.kind]
              }}</el-tag
              ><a
                v-if="item.kind === 'link' && item.url"
                :href="item.url"
                target="_blank"
                rel="noopener noreferrer"
                class="document-title"
                >{{ item.title }}</a
              ><strong v-else class="document-title">{{ item.title }}</strong
              ><time v-if="item.meetingTime" :datetime="item.meetingTime">{{
                new Date(item.meetingTime).toLocaleString("zh-CN")
              }}</time>
            </div>
            <p v-if="item.content" class="document-content">
              {{ item.content }}
            </p>
            <a
              v-if="item.kind !== 'link' && item.url"
              :href="item.url"
              target="_blank"
              rel="noopener noreferrer"
              class="document-url"
              >{{ item.url }}</a
            ><time class="updated-at" :datetime="item.updatedAt"
              >更新于
              {{ new Date(item.updatedAt).toLocaleString("zh-CN") }}</time
            >
          </div>
          <div v-if="editable" class="row-actions">
            <el-button link type="primary" @click="openEdit(item)"
              >编辑</el-button
            ><el-button
              link
              type="danger"
              :loading="deletingId === item.id"
              @click="remove(item)"
              >删除</el-button
            >
          </div>
        </li>
      </ul>
    </section>
    <section class="content-section" aria-labelledby="project-artifacts-title">
      <div class="section-heading">
        <h3 id="project-artifacts-title">需求产物</h3>
        <span>{{ artifacts.length }} 项</span>
      </div>
      <el-empty
        v-if="!artifacts.length && !loading"
        description="项目需求暂无文件或外链产物"
        :image-size="48"
      />
      <ul v-else class="artifact-list">
        <li
          v-for="item in artifacts"
          :key="item.kind + ':' + item.id"
          class="artifact-row"
        >
          <div class="artifact-copy">
            <a
              v-if="artifactUrl(item)"
              :href="artifactUrl(item)"
              target="_blank"
              rel="noopener noreferrer"
              >{{ item.name }}</a
            ><strong v-else>{{ item.name }}</strong
            ><span>{{ item.requirementNo }} · {{ item.requirementName }}</span>
          </div>
          <div class="artifact-meta">
            <el-tag v-if="item.isFinal" size="small" type="success"
              >最终版</el-tag
            ><el-tag size="small" effect="plain">{{
              item.kind === "file" ? "文件" : "外链"
            }}</el-tag>
          </div>
        </li>
      </ul>
    </section>
    <el-dialog
      v-model="dialogOpen"
      :title="
        editing ? '编辑项目资料' : '新增' + projectDocumentKindLabels[form.kind]
      "
      width="min(680px, 94vw)"
      :close-on-click-modal="false"
    >
      <el-form label-position="top" @submit.prevent="save"
        ><el-form-item v-if="!editing" label="资料类型"
          ><el-select v-model="form.kind" aria-label="资料类型"
            ><el-option
              v-for="kind in documentKinds"
              :key="kind"
              :label="projectDocumentKindLabels[kind]"
              :value="kind" /></el-select></el-form-item
        ><el-form-item label="标题" required
          ><el-input
            v-model="form.title"
            maxlength="200"
            show-word-limit /></el-form-item
        ><el-form-item v-if="form.kind === 'meeting'" label="会议时间" required
          ><el-date-picker
            v-model="form.meetingTime"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item
        ><el-form-item v-if="form.kind === 'link'" label="链接地址" required
          ><el-input
            v-model="form.url"
            type="url"
            maxlength="4000"
            placeholder="https://" /></el-form-item
        ><el-form-item v-else label="正文"
          ><el-input
            v-model="form.content"
            type="textarea"
            :rows="8"
            maxlength="2000000"
            show-word-limit /></el-form-item
      ></el-form>
      <template #footer
        ><el-button @click="dialogOpen = false">取消</el-button
        ><el-button
          type="primary"
          :loading="saving"
          :disabled="!form.title.trim()"
          @click="save"
          >保存</el-button
        ></template
      >
    </el-dialog>
    <el-dialog
      v-model="meetingDialogOpen"
      title="选择要复制的私人会议"
      width="min(760px, 94vw)"
      :close-on-click-modal="false"
      ><el-alert
        title="只会列出当前账号有权访问的会议。选中后需再次确认，复制内容会作为独立项目纪要共享。"
        type="info"
        :closable="false"
        show-icon
      />
      <div class="meeting-search">
        <el-input
          v-model="meetingSearch"
          clearable
          placeholder="搜索会议标题"
          aria-label="搜索我的会议"
          @keyup.enter="findMeetings"
        /><el-button :loading="meetingLoading" @click="findMeetings"
          >搜索</el-button
        >
      </div>
      <el-table
        v-loading="meetingLoading"
        :data="meetings"
        highlight-current-row
        @row-click="(row: MeetingSummary) => (selectedMeeting = row.id)"
        ><el-table-column width="54"
          ><template #default="{ row }"
            ><el-radio
              v-model="selectedMeeting"
              :value="row.id"
              :aria-label="'选择' + row.title"
              ><span /></el-radio></template></el-table-column
        ><el-table-column
          prop="title"
          label="会议标题"
          min-width="260"
          show-overflow-tooltip /><el-table-column label="会议时间" width="180"
          ><template #default="{ row }">{{
            new Date(row.meetingTime).toLocaleString("zh-CN")
          }}</template></el-table-column
        ><template #empty
          ><el-empty
            description="没有可复制的私人会议"
            :image-size="52" /></template></el-table
      ><template #footer
        ><el-button @click="meetingDialogOpen = false">取消</el-button
        ><el-button
          type="primary"
          :loading="meetingLoading"
          :disabled="!selectedMeeting"
          @click="copyMeeting"
          >复制为项目纪要</el-button
        ></template
      ></el-dialog
    >
  </section>
</template>

<style scoped>
.documents-panel {
  display: grid;
  gap: 22px;
  padding: 16px 0;
  min-width: 0;
}
.panel-heading,
.section-heading,
.document-title-line,
.document-row,
.artifact-row,
.heading-actions,
.row-actions,
.artifact-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.panel-heading,
.section-heading,
.document-row,
.artifact-row {
  justify-content: space-between;
}
.panel-heading h2 {
  margin: 0;
  font-size: 17px;
}
.panel-heading p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}
.heading-actions {
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.content-section {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.section-heading {
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-base);
}
.section-heading h3 {
  margin: 0;
  font-size: 14px;
}
.section-heading > span,
.updated-at,
.document-title-line time {
  color: var(--text-muted);
  font-size: 11px;
}
.filters {
  display: flex;
  gap: 8px;
  max-width: 560px;
}
.filters > .el-input {
  flex: 1;
}
.filters > .el-select {
  width: 150px;
  flex: none;
}
.document-list,
.artifact-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
.document-row,
.artifact-row {
  gap: 14px;
  padding: 12px 4px;
  border-bottom: 1px solid var(--border-soft);
  align-items: flex-start;
}
.document-copy,
.artifact-copy {
  display: grid;
  gap: 7px;
  min-width: 0;
  flex: 1;
}
.document-title-line {
  flex-wrap: wrap;
}
.document-title {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-title);
  font-size: 13px;
  font-weight: 600;
}
.document-title-line time {
  margin-left: auto;
}
.document-content {
  margin: 0;
  color: var(--text-regular);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.6;
  max-height: 120px;
  overflow: auto;
}
.document-url {
  overflow-wrap: anywhere;
  font-size: 12px;
}
.updated-at {
  font-size: 10px;
}
.row-actions {
  flex: none;
}
.artifact-copy a,
.artifact-copy strong {
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.artifact-copy span {
  color: var(--text-secondary);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.artifact-meta {
  flex: none;
}
.meeting-search {
  display: flex;
  gap: 8px;
  margin: 14px 0;
}
.meeting-search .el-input {
  flex: 1;
}
.documents-panel :deep(.el-select),
.documents-panel :deep(.el-date-editor) {
  width: 100%;
}
.documents-panel :deep(.el-form-item) {
  margin-bottom: 16px;
}
@media (max-width: 700px) {
  .panel-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .heading-actions {
    justify-content: flex-start;
  }
  .document-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .row-actions {
    align-self: flex-end;
  }
  .filters {
    max-width: none;
  }
  .artifact-row {
    align-items: flex-start;
  }
}
</style>
