<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { marked } from "marked";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  ArrowRight,
  ChatDotRound,
  CircleCheck,
  Close,
  Delete,
  Document,
  Download,
  Folder,
  InfoFilled,
  Link,
  Plus,
  Switch,
} from "@element-plus/icons-vue";
import {
  issueAssetRelationLabels,
  issueStatuses,
  issueStatusLabels,
  issueTypes,
  issueTypeLabels,
  stageLabels,
  type Issue,
  type IssueActivity,
  type IssueAssetLink,
  type IssueDetail,
  type IssueLinkedArtifact,
  type IssuePhase,
  type IssueStatus,
  type IssueType,
} from "@superpm/shared";
import { issueApi, type IssueUpdatePayload } from "../../api/issues";
import { artifactApi } from "../../api/artifacts";
import { errorMessage } from "../../api/client";
import InlineRichTextEditor from "./InlineRichTextEditor.vue";

const props = defineProps<{
  requirementId: number;
  phase: IssuePhase;
  requirementName?: string;
}>();

// 正文加载：md 文件内容可能是纯 markdown 或编辑器 html，统一转为编辑器可回显的 html
const htmlSourcePattern =
  /^\s*<(?:!doctype|h[1-6]|p|ul|ol|li|div|table|pre|blockquote|img)\b/i;
function toEditorHtml(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (htmlSourcePattern.test(trimmed)) return trimmed;
  return String(marked.parse(content, { async: false }));
}

// ===== 左栏：问题列表 =====
const issues = ref<Issue[]>([]);
const loading = ref(false);
// 状态筛选：空串表示全部
const statusFilter = ref<IssueStatus | "">("");

async function loadList() {
  loading.value = true;
  try {
    const result = await issueApi.list(
      props.requirementId,
      props.phase,
      statusFilter.value || undefined,
    );
    // 服务端按创建倒序返回，这里按更新时间倒序展示
    issues.value = [...result.items].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    // 清理已不存在（删除/被过滤）的选择项
    const alive = new Set(issues.value.map((issue) => issue.id));
    selectedIds.value = selectedIds.value.filter((id) => alive.has(id));
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

// 切换阶段：关闭详情并重新拉取（状态筛选一并还原）
watch(
  () => props.phase,
  () => {
    cancelDescSave();
    descDirty.value = false;
    detail.value = undefined;
    selectedIds.value = [];
    if (statusFilter.value === "") {
      void loadList();
    } else {
      statusFilter.value = ""; // 触发筛选 watcher 重新拉取
    }
  },
);
watch(statusFilter, () => void loadList());
onMounted(loadList);
onBeforeUnmount(() => {
  cancelDescSave();
  void flushDescSave(); // 卸载前保存未落盘的正文
});

// ===== 多选导出 Markdown =====
const selectedIds = ref<number[]>([]);
const exporting = ref(false);
function isSelected(id: number) {
  return selectedIds.value.includes(id);
}
function onItemCheck(issue: Issue, checked: boolean | string | number) {
  if (checked === true) {
    if (!selectedIds.value.includes(issue.id))
      selectedIds.value = [...selectedIds.value, issue.id];
  } else {
    selectedIds.value = selectedIds.value.filter((id) => id !== issue.id);
  }
}
const allSelected = computed(
  () =>
    issues.value.length > 0 &&
    issues.value.every((issue) => selectedIds.value.includes(issue.id)),
);
function toggleAll(checked: boolean | string | number) {
  selectedIds.value = checked === true ? issues.value.map((i) => i.id) : [];
}

function downloadTextFile(fileName: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildExportMarkdown(name: string, details: IssueDetail[]): string {
  const blocks = details.map((issue) => {
    const lines: string[] = [];
    lines.push(`# ${name}-${issue.title}`);
    lines.push("");
    lines.push(
      `- 分类：${issue.issueType ? issueTypeLabels[issue.issueType] : "未分类"}`,
    );
    lines.push(`- 状态：${issueStatusLabels[issue.status]}`);
    lines.push(`- 阶段：${stageLabels[issue.phase]}`);
    lines.push(`- 编号：${issue.issueKey ?? `#${issue.id}`}`);
    lines.push(`- 创建时间：${formatTime(issue.createdAt)}`);
    lines.push(`- 更新时间：${formatTime(issue.updatedAt)}`);
    lines.push("");
    lines.push("## 问题描述");
    lines.push("");
    lines.push(issue.description.trim() || "暂无描述");
    lines.push("");
    lines.push("## 解决说明");
    lines.push("");
    lines.push(issue.solution?.trim() || "暂无");
    lines.push("");
    lines.push("## 动态时间线");
    lines.push("");
    if (!issue.activities.length) lines.push("暂无动态");
    for (const activity of issue.activities)
      lines.push(`- [${formatTime(activity.createdAt)}] ${activityText(activity)}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n---\n\n") + "\n";
}

async function exportSelected() {
  if (!selectedIds.value.length || exporting.value) return;
  exporting.value = true;
  try {
    const details: IssueDetail[] = [];
    for (const id of selectedIds.value)
      details.push(await issueApi.detail(props.requirementId, id));
    const name = props.requirementName?.trim() || `需求${props.requirementId}`;
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    downloadTextFile(`${name}-问题记录-${stamp}.md`, buildExportMarkdown(name, details));
    ElMessage.success(`已导出 ${details.length} 条问题`);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    exporting.value = false;
  }
}

// ===== 新建问题：内联小表单 =====
const showCreate = ref(false);
const creating = ref(false);
const createTitle = ref("");
const createDescription = ref("");
const createType = ref<IssueType | "">("");
const typeOptions = issueTypes.map((value) => ({
  value,
  label: issueTypeLabels[value],
}));

function toggleCreate() {
  showCreate.value = !showCreate.value;
  createTitle.value = "";
  createDescription.value = "";
  createType.value = "";
}

async function submitCreate() {
  const title = createTitle.value.trim();
  if (!title) {
    ElMessage.warning("请输入问题标题");
    return;
  }
  creating.value = true;
  try {
    await issueApi.create(props.requirementId, {
      phase: props.phase,
      title,
      description: createDescription.value.trim(),
      issueType: createType.value || undefined,
    });
    ElMessage.success("问题已创建");
    showCreate.value = false;
    createTitle.value = "";
    createDescription.value = "";
    createType.value = "";
    await loadList();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    creating.value = false;
  }
}

// ===== 右栏：问题详情（md 编辑器） =====
const detail = ref<IssueDetail>();
const detailLoading = ref(false);
// 状态流转请求进行中，防止重复提交
const acting = ref(false);
const commentText = ref("");
const sending = ref(false);

// 正文草稿：html 与纯文本双写，防抖自动保存
const descHtml = ref("");
const descText = ref("");
const descDirty = ref(false);
let saveTimer: number | undefined;

function onDescHtml(html: string) {
  descHtml.value = html;
  scheduleDescSave();
}
function onDescText(text: string) {
  descText.value = text;
  scheduleDescSave();
}
function scheduleDescSave() {
  descDirty.value = true;
  cancelDescSave();
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void flushDescSave();
  }, 800);
}
function cancelDescSave() {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
  }
}
async function flushDescSave() {
  cancelDescSave();
  if (!descDirty.value || !detail.value) return;
  descDirty.value = false;
  try {
    // 正文（编辑器 html）落盘为 md 文件内容，由服务端写入工作区
    const updated = await issueApi.update(props.requirementId, detail.value.id, {
      description: descHtml.value,
    });
    if (detail.value?.id === updated.id)
      detail.value = { ...detail.value, ...updated };
    syncListIssue(updated);
  } catch (error) {
    // 保存失败恢复脏标记：关闭/切换时会再次提示
    descDirty.value = true;
    ElMessage.error(errorMessage(error));
  }
}

async function openDetail(issue: Issue) {
  if (detail.value?.id === issue.id) return;
  await flushDescSave(); // 切换前保存当前正文
  detailLoading.value = true;
  try {
    const loaded = await issueApi.detail(props.requirementId, issue.id);
    detail.value = loaded;
    descHtml.value = toEditorHtml(loaded.description);
    descText.value =
      new DOMParser().parseFromString(descHtml.value, "text/html").body
        .textContent ?? "";
    descDirty.value = false;
    commentText.value = "";
    await loadAssets();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    detailLoading.value = false;
  }
}

async function closeDetail() {
  if (descDirty.value) {
    try {
      await ElMessageBox.confirm(
        "正文修改尚未保存，关闭前将自动保存。",
        "关闭问题详情",
        {
          confirmButtonText: "保存并关闭",
          cancelButtonText: "取消",
          type: "info",
        },
      );
    } catch {
      return; // 取消关闭：留在详情
    }
  }
  await flushDescSave();
  detail.value = undefined;
  // 详情内的编辑/流转会改变列表数据，关闭时重新拉取
  void loadList();
}

function syncListIssue(updated: Issue) {
  const index = issues.value.findIndex((item) => item.id === updated.id);
  if (index < 0) return;
  const next = [...issues.value];
  next[index] = updated;
  issues.value = next;
}

async function applyUpdate(payload: IssueUpdatePayload, successText: string) {
  if (!detail.value || acting.value) return;
  acting.value = true;
  try {
    const updated = await issueApi.update(
      props.requirementId,
      detail.value.id,
      payload,
    );
    if (detail.value?.id === updated.id)
      detail.value = { ...detail.value, ...updated };
    syncListIssue(updated);
    ElMessage.success(successText);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    acting.value = false;
  }
}

// 状态自由流转：四态下拉任选，切换即保存（服务端无解决说明前置校验，不再弹窗）
function onStatusChange(value: unknown) {
  if (typeof value !== "string") return;
  void applyUpdate({ status: value as IssueStatus }, "状态已更新");
}

async function sendComment() {
  const content = commentText.value.trim();
  if (!content || !detail.value || sending.value) return;
  sending.value = true;
  try {
    // 评论接口返回最新详情（含新活动），直接替换
    const result = await issueApi.comment(
      props.requirementId,
      detail.value.id,
      content,
    );
    detail.value = result;
    syncListIssue(result);
    commentText.value = "";
    ElMessage.success("评论已发送");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    sending.value = false;
  }
}

async function removeIssue() {
  if (!detail.value) return;
  try {
    await ElMessageBox.confirm(
      "删除后该问题及其动态不可恢复，确定删除吗？",
      "删除问题",
      {
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
  } catch {
    return;
  }
  const issueId = detail.value.id;
  try {
    await issueApi.remove(props.requirementId, issueId);
    ElMessage.success("问题已删除");
    detail.value = undefined;
    await loadList();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

// ===== 关联产出物（artifacts 体系：文件夹 + 文件） =====
const assets = ref<IssueAssetLink[]>([]);
const linkDialogVisible = ref(false);
const linkSaving = ref(false);
const linkedIds = computed(() => new Set(assets.value.map((l) => l.assetId)));

async function loadAssets() {
  if (!detail.value) return;
  try {
    const result = await issueApi.listAssets(
      props.requirementId,
      detail.value.id,
    );
    assets.value = result.items;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

// 已关联条目按相对路径组织成文件夹 + 文件树形展示
interface AssetDisplayNode {
  key: string;
  name: string;
  nodeType: IssueLinkedArtifact["nodeType"];
  link: IssueAssetLink | null;
  children: AssetDisplayNode[];
}
const assetRows = computed<{ node: AssetDisplayNode; depth: number }[]>(() => {
  const roots: AssetDisplayNode[] = [];
  const index = new Map<string, AssetDisplayNode>();
  const links = [...assets.value].sort((a, b) =>
    a.asset.relativePath.localeCompare(b.asset.relativePath, "zh-Hans-CN"),
  );
  for (const link of links) {
    const segments = link.asset.relativePath.split("/");
    let prefix = "";
    let siblings = roots;
    segments.forEach((segment, position) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const isLeaf = position === segments.length - 1;
      let node = index.get(prefix);
      if (!node) {
        node = {
          key: prefix,
          name: segment,
          nodeType: isLeaf ? link.asset.nodeType : "folder",
          link: isLeaf ? link : null,
          children: [],
        };
        index.set(prefix, node);
        siblings.push(node);
      } else if (isLeaf) {
        node.link = link; // 文件夹本身被关联
      }
      siblings = node.children;
    });
  }
  // 文件夹在前、名称升序
  const sortNodes = (nodes: AssetDisplayNode[]) => {
    nodes.sort((a, b) =>
      a.nodeType === b.nodeType
        ? a.name.localeCompare(b.name, "zh-Hans-CN")
        : a.nodeType === "folder"
          ? -1
          : 1,
    );
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  const rows: { node: AssetDisplayNode; depth: number }[] = [];
  const walk = (nodes: AssetDisplayNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.children.length) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
});

async function unlink(node: AssetDisplayNode) {
  if (!node.link || !detail.value) return;
  try {
    await issueApi.unlinkAsset(props.requirementId, detail.value.id, node.link.assetId);
    await loadAssets();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

// 关联选择器：递归拉取 artifacts 目录树，文件夹可展开，文件夹/文件均可勾选
interface ArtifactTreeItem {
  id: number;
  name: string;
  nodeType: IssueLinkedArtifact["nodeType"];
  disabled: boolean;
  children: ArtifactTreeItem[];
}
const treeLoading = ref(false);
const artifactTree = ref<ArtifactTreeItem[]>([]);
const checkedIds = ref<number[]>([]);
const expandedIds = ref<Set<number>>(new Set());

async function loadTreeLevel(parentId: number | null): Promise<ArtifactTreeItem[]> {
  const directory = await artifactApi.list(props.requirementId, parentId);
  const folderItems = await Promise.all(
    directory.folders.map(async (folder) => ({
      id: folder.id,
      name: folder.name,
      nodeType: "folder" as const,
      disabled: linkedIds.value.has(folder.id),
      children: await loadTreeLevel(folder.id),
    })),
  );
  const fileItems = directory.files.map((file) => ({
    id: file.id,
    name: file.name,
    nodeType: "file" as const,
    disabled: linkedIds.value.has(file.id),
    children: [],
  }));
  return [...folderItems, ...fileItems];
}

async function openLinkDialog() {
  linkDialogVisible.value = true;
  treeLoading.value = true;
  checkedIds.value = [];
  expandedIds.value = new Set();
  try {
    artifactTree.value = await loadTreeLevel(null);
    // 根层文件夹默认展开，深层按需点击
    for (const item of artifactTree.value)
      if (item.nodeType === "folder") expandedIds.value.add(item.id);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    treeLoading.value = false;
  }
}

const treeRows = computed<{ item: ArtifactTreeItem; depth: number }[]>(() => {
  const rows: { item: ArtifactTreeItem; depth: number }[] = [];
  const walk = (items: ArtifactTreeItem[], depth: number) => {
    for (const item of items) {
      rows.push({ item, depth });
      if (item.nodeType === "folder" && expandedIds.value.has(item.id))
        walk(item.children, depth + 1);
    }
  };
  walk(artifactTree.value, 0);
  return rows;
});

function toggleExpanded(item: ArtifactTreeItem) {
  const next = new Set(expandedIds.value);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  expandedIds.value = next;
}

function onTreeCheck(item: ArtifactTreeItem, checked: boolean | string | number) {
  if (checked === true) {
    if (!checkedIds.value.includes(item.id))
      checkedIds.value = [...checkedIds.value, item.id];
  } else {
    checkedIds.value = checkedIds.value.filter((id) => id !== item.id);
  }
}

async function confirmLink() {
  if (!detail.value) return;
  // 已关联的条目在弹窗中禁用，这里仅提交新增项
  const targets = checkedIds.value.filter((id) => !linkedIds.value.has(id));
  if (!targets.length) {
    linkDialogVisible.value = false;
    return;
  }
  linkSaving.value = true;
  try {
    for (const assetId of targets) {
      await issueApi.linkAsset(
        props.requirementId,
        detail.value.id,
        assetId,
        "reference",
      );
    }
    ElMessage.success("已关联产出物");
    linkDialogVisible.value = false;
    await loadAssets();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    linkSaving.value = false;
  }
}

// ===== 展示辅助 =====
function typeTone(issue: Issue): string {
  switch (issue.issueType) {
    case "ui":
      return "tone-teal";
    case "development":
      return "tone-blue";
    case "defect":
      return "tone-red";
    case "change":
      return "tone-purple";
    case "question":
      return "tone-amber";
    default:
      return "tone-gray";
  }
}

function statusTone(status: IssueStatus): string {
  switch (status) {
    case "pending":
      return "tone-amber";
    case "processing":
      return "tone-blue";
    case "testing":
      return "tone-purple";
    case "resolved":
      return "tone-green";
  }
}

const activityIcons = {
  comment: ChatDotRound,
  solution: CircleCheck,
  status_change: Switch,
  system: InfoFilled,
} as const;

function activityText(activity: IssueActivity): string {
  if (activity.activityType === "status_change") {
    const oldLabel = activity.oldStatus
      ? issueStatusLabels[activity.oldStatus]
      : "—";
    const newLabel = activity.newStatus
      ? issueStatusLabels[activity.newStatus]
      : "—";
    return `状态变更：${oldLabel} → ${newLabel}`;
  }
  if (activity.activityType === "comment") return `评论：${activity.content}`;
  if (activity.activityType === "solution")
    return `解决说明：${activity.content}`;
  return activity.content; // system 初始记录
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
</script>
<template>
  <aside
    class="surface issues-panel"
    :class="{ 'has-detail': !!detail }"
    v-loading="loading || detailLoading"
  >
    <!-- 左栏：问题列表（默认形态） -->
    <section class="issues-left">
      <header class="issues-toolbar">
        <div class="status-filter" role="group" aria-label="按状态筛选">
          <button
            type="button"
            :class="{ active: statusFilter === '' }"
            @click="statusFilter = ''"
          >
            全部
          </button>
          <button
            v-for="status in issueStatuses"
            :key="status"
            type="button"
            :class="{ active: statusFilter === status }"
            @click="statusFilter = status"
          >
            {{ issueStatusLabels[status] }}
          </button>
        </div>
        <button class="issue-new" type="button" @click="toggleCreate">
          <el-icon :size="13"><Plus /></el-icon>新建问题
        </button>
      </header>
      <form v-if="showCreate" class="issue-create-form" @submit.prevent="submitCreate">
        <el-input
          v-model="createTitle"
          maxlength="200"
          placeholder="问题标题（必填）"
        />
        <el-input
          v-model="createDescription"
          type="textarea"
          :rows="2"
          maxlength="2000"
          placeholder="问题描述（可选）"
        />
        <div class="issue-create-row">
          <el-select
            v-model="createType"
            class="issue-type-select"
            placeholder="问题分类（可选）"
            clearable
          >
            <el-option
              v-for="option in typeOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <button class="issue-btn issue-btn--primary" type="submit" :disabled="creating">
            创建
          </button>
          <button
            class="issue-btn"
            type="button"
            @click="showCreate = false"
          >
            取消
          </button>
        </div>
      </form>
      <div class="issue-list">
        <div
          v-for="issue in issues"
          :key="issue.id"
          class="issue-item"
          :class="{ active: detail?.id === issue.id }"
        >
          <el-checkbox
            class="issue-check"
            :model-value="isSelected(issue.id)"
            @change="onItemCheck(issue, $event)"
          />
          <el-tag
            v-if="issue.issueType"
            size="small"
            class="enum-tag"
            :class="typeTone(issue)"
            >{{ issueTypeLabels[issue.issueType] }}</el-tag
          >
          <button class="issue-title" type="button" @click="openDetail(issue)">
            {{ issue.title }}
          </button>
          <el-tag size="small" class="enum-tag" :class="statusTone(issue.status)"
            >{{ issueStatusLabels[issue.status] }}</el-tag
          >
          <span class="issue-time">{{ formatTime(issue.updatedAt) }}</span>
        </div>
        <el-empty
          v-if="!issues.length"
          description="暂无问题"
          :image-size="48"
        />
      </div>
      <footer class="issues-footer">
        <el-checkbox
          class="select-all"
          :model-value="allSelected"
          :disabled="!issues.length"
          @change="toggleAll($event)"
          >全选</el-checkbox
        >
        <button
          class="issue-btn issue-btn--primary issue-export"
          type="button"
          :disabled="!selectedIds.length || exporting"
          @click="exportSelected"
        >
          <el-icon :size="12"><Download /></el-icon>导出 Markdown<template
            v-if="selectedIds.length"
          >
            （{{ selectedIds.length }}）</template
          >
        </button>
      </footer>
    </section>
    <!-- 右栏：问题详情（点击问题打开，可关闭） -->
    <section v-if="detail" class="issues-right">
      <header class="issues-head">
        <strong class="issues-title">{{ detail.title }}</strong>
        <el-tag size="small" class="enum-tag" :class="statusTone(detail.status)"
          >{{ issueStatusLabels[detail.status] }}</el-tag
        >
        <button
          class="issues-close"
          type="button"
          aria-label="关闭详情"
          @click="closeDetail"
        >
          <el-icon :size="14"><Close /></el-icon>
        </button>
      </header>
      <div class="issue-detail">
        <!-- 正文 md 编辑器：随问题切换重建，编辑后防抖自动保存 -->
        <InlineRichTextEditor
          :key="detail.id"
          :html="descHtml"
          :text="descText"
          :requirement-id="requirementId"
          label="问题正文"
          @update:html="onDescHtml"
          @update:text="onDescText"
        />
        <!-- 状态自由流转：四态下拉任选，切换即保存 -->
        <div class="issue-flow">
          <el-select
            class="issue-status-select"
            :model-value="detail.status"
            :disabled="acting"
            aria-label="问题状态"
            @change="onStatusChange"
          >
            <el-option
              v-for="status in issueStatuses"
              :key="status"
              :label="issueStatusLabels[status]"
              :value="status"
            />
          </el-select>
          <button
            class="issue-btn issue-btn--danger"
            type="button"
            @click="removeIssue"
          >
            <el-icon :size="12"><Delete /></el-icon>删除问题
          </button>
        </div>
        <!-- 解决说明展示块 -->
        <div v-if="detail.solution" class="issue-solution">
          <span class="block-label">解决说明</span>
          <p>{{ detail.solution }}</p>
        </div>
        <!-- 关联产出物：文件夹 + 文件树形展示 -->
        <div class="issue-assets">
          <div class="assets-head-row">
            <span class="block-label">关联产出物</span>
            <button class="issue-link-btn" type="button" @click="openLinkDialog">
              <el-icon :size="12"><Link /></el-icon>关联产出物
            </button>
          </div>
          <div
            v-for="row in assetRows"
            :key="row.node.key"
            class="asset-row"
            :style="{ paddingLeft: `${10 + row.depth * 16}px` }"
          >
            <el-icon
              class="asset-icon"
              :class="{ 'asset-icon--folder': row.node.nodeType === 'folder' }"
              :size="13"
            >
              <Folder v-if="row.node.nodeType === 'folder'" />
              <Document v-else />
            </el-icon>
            <span
              class="asset-name"
              :title="row.node.link?.asset.relativePath"
              >{{ row.node.name }}</span
            >
            <el-tag v-if="row.node.link" size="small" effect="plain">{{
              issueAssetRelationLabels[row.node.link.relationType]
            }}</el-tag>
            <button
              v-if="row.node.link"
              class="issue-unlink"
              type="button"
              @click="unlink(row.node)"
            >
              解除
            </button>
          </div>
          <p v-if="!assets.length" class="muted-line">暂无关联产出物</p>
        </div>
        <!-- 活动时间线（时间正序，服务端已排序） -->
        <div class="issue-activities">
          <span class="block-label">动态</span>
          <div
            v-for="activity in detail.activities"
            :key="activity.id"
            class="activity-row"
          >
            <el-icon
              class="activity-icon"
              :class="`activity--${activity.activityType}`"
              :size="13"
            >
              <component :is="activityIcons[activity.activityType]" />
            </el-icon>
            <span class="activity-text">{{
              activityText(activity)
            }}</span>
            <span class="activity-time">{{
              formatTime(activity.createdAt)
            }}</span>
          </div>
        </div>
        <!-- 评论输入 -->
        <div class="issue-comment">
          <el-input
            v-model="commentText"
            type="textarea"
            :rows="2"
            maxlength="2000"
            placeholder="填写处理说明…"
          />
          <button
            class="issue-btn issue-btn--primary"
            type="button"
            :disabled="sending || !commentText.trim()"
            @click="sendComment"
          >
            发送
          </button>
        </div>
      </div>
    </section>
    <!-- 关联产出物选择弹窗：artifacts 目录树，文件夹/文件均可勾选 -->
    <el-dialog
      v-model="linkDialogVisible"
      title="关联产出物"
      width="440px"
      append-to-body
    >
      <div class="link-dialog-body" v-loading="treeLoading">
        <div
          v-for="row in treeRows"
          :key="row.item.id"
          class="tree-row"
          :style="{ paddingLeft: `${6 + row.depth * 16}px` }"
          @click="row.item.nodeType === 'folder' && toggleExpanded(row.item)"
        >
          <span
            v-if="row.item.nodeType === 'folder'"
            class="tree-caret"
            :class="{ expanded: expandedIds.has(row.item.id) }"
          >
            <el-icon :size="11"><ArrowRight /></el-icon>
          </span>
          <span v-else class="tree-caret tree-caret--leaf"></span>
          <el-icon
            class="asset-icon"
            :class="{ 'asset-icon--folder': row.item.nodeType === 'folder' }"
            :size="13"
          >
            <Folder v-if="row.item.nodeType === 'folder'" />
            <Document v-else />
          </el-icon>
          <span class="tree-name">{{ row.item.name }}</span>
          <el-checkbox
            class="tree-check"
            :model-value="checkedIds.includes(row.item.id)"
            :disabled="row.item.disabled"
            @click.stop
            @change="onTreeCheck(row.item, $event)"
          />
        </div>
        <el-empty
          v-if="!artifactTree.length && !treeLoading"
          description="暂无可关联的产出物"
          :image-size="48"
        />
      </div>
      <template #footer>
        <button
          class="issue-btn"
          type="button"
          @click="linkDialogVisible = false"
        >
          取消
        </button>
        <button
          class="issue-btn issue-btn--primary"
          type="button"
          :disabled="linkSaving || !checkedIds.length"
          @click="confirmLink"
        >
          确定关联
        </button>
      </template>
    </el-dialog>
  </aside>
</template>
<style scoped>
.issues-panel {
  /* 两栏布局：左列表右详情；未打开详情时列表占满整行 */
  display: flex;
  flex-direction: row;
  align-items: stretch;
  min-width: 0;
  /* 左栏 flex 子项：占满剩余高度；根容器不滚，滚动交给内部列表/详情区 */
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.issues-panel.has-detail .issues-left {
  flex: 0 0 320px;
  width: 320px;
  border-right: 1px solid var(--border-soft);
}
.issues-left {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.issues-right {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.issues-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 0;
  flex: none;
}
/* 紧凑状态筛选按钮组 */
.status-filter {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border-base);
  border-radius: 8px;
  background: var(--bg-surface);
}
.status-filter button {
  padding: 2px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
}
.status-filter button:hover {
  color: var(--brand);
  background: var(--bg-hover);
}
.status-filter button.active {
  background: var(--bg-brand-soft);
  color: var(--brand);
  font-weight: 600;
}
.issue-new {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-light, var(--border-base));
  background: none;
  color: var(--brand);
  font-size: 12px;
  cursor: pointer;
  flex: none;
}
.issue-new:hover {
  border-color: var(--brand);
  background: var(--bg-brand-soft);
}
/* 内联新建表单 */
.issue-create-form {
  display: grid;
  gap: 8px;
  margin: 10px 10px 0;
  padding: 10px;
  border: 1px solid var(--border-base);
  border-radius: 8px;
  background: var(--bg-subtle);
  flex: none;
}
.issue-create-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.issue-type-select {
  flex: 1 1 auto;
  min-width: 0;
}
.issue-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-base);
  background: none;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.issue-btn:hover:not(:disabled) {
  color: var(--brand);
  border-color: var(--brand);
}
.issue-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.issue-btn--primary {
  color: var(--brand);
  border-color: var(--brand);
}
.issue-btn--primary:hover:not(:disabled) {
  background: var(--bg-brand-soft);
}
.issue-btn--danger {
  color: var(--danger-text);
}
.issue-btn--danger:hover:not(:disabled) {
  color: var(--danger-text);
  border-color: var(--danger-text);
}
.issue-list {
  flex: 1 1 auto;
  min-height: 0;
  /* 问题条目列表独立滚动 */
  overflow-y: auto;
  padding: 8px 10px 10px;
}
.issue-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 8px;
}
.issue-item:hover {
  background: var(--bg-hover);
}
.issue-item.active {
  background: var(--bg-brand-soft);
}
/* 列表多选框：压缩默认高度避免撑高条目 */
.issue-check {
  flex: none;
  height: auto;
}
.issue-check :deep(.el-checkbox__label) {
  display: none;
}
.issue-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  background: none;
  border: 0;
  padding: 0;
  color: var(--text-primary, var(--text-title));
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.issue-title:hover {
  color: var(--brand);
}
.issue-time {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
}
/* 底部：全选 + 导出 */
.issues-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--border-soft);
  flex: none;
}
.select-all {
  height: auto;
}
.select-all :deep(.el-checkbox__label) {
  font-size: 12px;
  color: var(--text-secondary);
}
.issue-export {
  padding: 5px 12px;
}
/* 详情视图 */
.issues-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 0;
  flex: none;
}
.issues-close {
  display: inline-flex;
  padding: 4px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text-tertiary, var(--text-muted));
  cursor: pointer;
  flex: none;
}
.issues-close:hover {
  color: var(--brand);
  background: var(--bg-hover);
}
.issues-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--text-primary, var(--text-title));
}
.issue-detail {
  display: grid;
  gap: 12px;
  padding: 10px;
  align-content: start;
  /* 问题详情视图独立滚动：内容超出时滚动条在面板内 */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.muted-line {
  color: var(--text-faint);
}
.issue-flow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.issue-status-select {
  width: 132px;
}
.block-label {
  font-size: 11px;
  color: var(--text-muted);
}
.issue-solution {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--tone-green-bd);
  background: var(--tone-green-bg);
}
.issue-solution p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--tone-green-fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.assets-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.issue-link-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  font-size: 12px;
  color: var(--brand);
  cursor: pointer;
}
.issue-link-btn:hover {
  text-decoration: underline;
}
.asset-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  background: var(--bg-subtle);
}
.asset-icon {
  flex: none;
  color: var(--text-faint);
}
.asset-icon--folder {
  color: var(--tone-amber-fg, var(--brand));
}
.asset-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-regular);
}
.issue-unlink {
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
}
.issue-unlink:hover {
  color: var(--danger-text);
}
.activity-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--border-soft);
}
.activity-row:last-child {
  border-bottom: 0;
}
.activity-icon {
  flex: none;
  align-self: center;
  color: var(--text-faint);
}
.activity--comment {
  color: var(--brand);
}
.activity--solution {
  color: var(--tone-green-fg);
}
.activity--status_change {
  color: var(--tone-amber-fg);
}
.activity-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-regular);
  overflow-wrap: anywhere;
}
.activity-time {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
}
.issue-comment {
  display: grid;
  gap: 8px;
  justify-items: end;
}
/* 关联弹窗：artifacts 目录树 */
.link-dialog-body {
  display: grid;
  gap: 2px;
  max-height: 360px;
  min-height: 120px;
  overflow: auto;
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: default;
  user-select: none;
}
.tree-row:hover {
  background: var(--bg-hover);
}
.tree-caret {
  display: inline-flex;
  flex: none;
  width: 14px;
  color: var(--text-faint);
  transition: transform 0.15s ease;
}
.tree-caret.expanded {
  transform: rotate(90deg);
}
.tree-caret--leaf {
  visibility: hidden;
}
.tree-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-regular);
}
.tree-check {
  flex: none;
  height: auto;
}
.tree-check :deep(.el-checkbox__label) {
  display: none;
}
</style>
