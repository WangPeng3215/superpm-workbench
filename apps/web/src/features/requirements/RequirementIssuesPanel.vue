<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  ArrowLeft,
  ChatDotRound,
  CircleCheck,
  Delete,
  InfoFilled,
  Link,
  Plus,
  Switch,
} from "@element-plus/icons-vue";
import {
  assetCategories,
  issueAssetRelationLabels,
  issueStatuses,
  issueStatusLabels,
  issueTypes,
  issueTypeLabels,
  type Issue,
  type IssueActivity,
  type IssueAssetLink,
  type IssueDetail,
  type IssuePhase,
  type IssueStatus,
  type IssueType,
  type RequirementFile,
} from "@superpm/shared";
import { issueApi, type IssueUpdatePayload } from "../../api/issues";
import { requirementFileApi } from "../../api/requirement-files";
import { errorMessage } from "../../api/client";

const props = defineProps<{ requirementId: number; phase: IssuePhase }>();

// ===== 两级视图（列表 / 详情），参考产物区两态实现 =====
const view = ref<"list" | "detail">("list");
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
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

// 切换阶段：重置回列表视图并重新拉取（状态筛选一并还原）
watch(
  () => props.phase,
  () => {
    view.value = "list";
    detail.value = undefined;
    if (statusFilter.value === "") {
      void loadList();
    } else {
      statusFilter.value = ""; // 触发筛选 watcher 重新拉取
    }
  },
);
watch(statusFilter, () => {
  if (view.value === "list") void loadList();
});
onMounted(loadList);

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

// ===== 详情视图 =====
const detail = ref<IssueDetail>();
const detailLoading = ref(false);
// 状态流转请求进行中，防止重复提交
const acting = ref(false);
const commentText = ref("");
const sending = ref(false);

async function openDetail(issue: Issue) {
  detailLoading.value = true;
  try {
    detail.value = await issueApi.detail(props.requirementId, issue.id);
    view.value = "detail";
    commentText.value = "";
    await loadAssets();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    detailLoading.value = false;
  }
}

function backToList() {
  detail.value = undefined;
  view.value = "list";
  // 详情内的流转会改变列表排序与状态，返回时重新拉取
  void loadList();
}

async function refreshDetail(id: number) {
  detail.value = await issueApi.detail(props.requirementId, id);
}

async function applyUpdate(payload: IssueUpdatePayload, successText: string) {
  if (!detail.value || acting.value) return;
  acting.value = true;
  try {
    await issueApi.update(props.requirementId, detail.value.id, payload);
    await refreshDetail(detail.value.id);
    ElMessage.success(successText);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    acting.value = false;
  }
}

function startProgress() {
  void applyUpdate({ status: "in_progress" }, "已开始处理");
}

// 标记解决：服务端强制要求解决说明，弹窗内必填校验
async function markResolved() {
  let solution: string;
  try {
    const result = await ElMessageBox.prompt(
      "解决说明将记录到问题时间线（必填）",
      "标记解决",
      {
        inputPlaceholder: "填写解决说明",
        confirmButtonText: "确定",
        cancelButtonText: "取消",
        inputValidator: (text: string) =>
          text.trim() ? true : "请输入解决说明",
      },
    );
    solution = result.value.trim();
  } catch {
    return; // 取消弹窗：不做任何更新
  }
  await applyUpdate({ status: "resolved", solution }, "已标记解决");
}

function closeIssue() {
  void applyUpdate({ status: "closed" }, "问题已关闭");
}

function reopen() {
  void applyUpdate({ status: "open" }, "问题已重新打开");
}

async function sendComment() {
  const content = commentText.value.trim();
  if (!content || !detail.value || sending.value) return;
  sending.value = true;
  try {
    // 评论接口返回最新详情（含新活动），直接替换
    detail.value = await issueApi.comment(
      props.requirementId,
      detail.value.id,
      content,
    );
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
    view.value = "list";
    await loadList();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

// ===== 关联产出物 =====
const assets = ref<IssueAssetLink[]>([]);
const linkDialogVisible = ref(false);
const linkSaving = ref(false);
const allFiles = ref<RequirementFile[]>([]);
const selectedAssetIds = ref<number[]>([]);
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

async function openLinkDialog() {
  linkDialogVisible.value = true;
  selectedAssetIds.value = [];
  try {
    const result = await requirementFileApi.list(
      props.requirementId,
      "all",
      true,
    );
    allFiles.value = result.groups.flatMap((group) => group.files);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

// 弹窗内按固定分类分组展示（与产物区分类一致）
const fileGroups = computed(() =>
  assetCategories
    .map((entry) => ({
      label: entry.label,
      files: allFiles.value.filter((file) => file.category === entry.key),
    }))
    .filter((group) => group.files.length > 0),
);

async function confirmLink() {
  if (!detail.value) return;
  // 已关联的条目在弹窗中禁用，这里仅提交新增项
  const targets = selectedAssetIds.value.filter(
    (id) => !linkedIds.value.has(id),
  );
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

async function unlink(assetId: number) {
  if (!detail.value) return;
  try {
    await issueApi.unlinkAsset(props.requirementId, detail.value.id, assetId);
    await loadAssets();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

// ===== 展示辅助 =====
function typeTone(issue: Issue): string {
  switch (issue.issueType) {
    case "design":
      return "tone-teal";
    case "development":
      return "tone-blue";
    case "bug":
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
    case "open":
      return "tone-amber";
    case "in_progress":
      return "tone-blue";
    case "resolved":
      return "tone-green";
    case "closed":
      return "tone-gray";
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
  <aside class="surface issues-panel" v-loading="loading || detailLoading">
    <!-- 一级：问题列表 -->
    <template v-if="view === 'list'">
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
            placeholder="问题类型（可选）"
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
        <div v-for="issue in issues" :key="issue.id" class="issue-item">
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
    </template>
    <!-- 二级：问题详情 -->
    <template v-else-if="detail">
      <header class="issues-head">
        <button
          class="issues-back"
          type="button"
          aria-label="返回问题列表"
          @click="backToList"
        >
          <el-icon :size="14"><ArrowLeft /></el-icon>
        </button>
        <strong class="issues-title">{{ detail.title }}</strong>
        <el-tag size="small" class="enum-tag" :class="statusTone(detail.status)"
          >{{ issueStatusLabels[detail.status] }}</el-tag
        >
      </header>
      <div class="issue-detail">
        <p v-if="detail.description" class="issue-desc">{{
          detail.description
        }}</p>
        <p v-else class="issue-desc muted-line">暂无描述</p>
        <!-- 状态流转按钮组 -->
        <div class="issue-flow">
          <button
            v-if="detail.status === 'open'"
            class="issue-btn issue-btn--primary"
            type="button"
            :disabled="acting"
            @click="startProgress"
          >
            开始处理
          </button>
          <button
            v-if="detail.status !== 'closed'"
            class="issue-btn"
            type="button"
            :disabled="acting"
            @click="markResolved"
          >
            标记解决
          </button>
          <button
            v-if="detail.status === 'open' || detail.status === 'in_progress'"
            class="issue-btn"
            type="button"
            :disabled="acting"
            @click="closeIssue"
          >
            关闭问题
          </button>
          <button
            v-if="detail.status === 'resolved'"
            class="issue-btn"
            type="button"
            :disabled="acting"
            @click="reopen"
          >
            重新打开
          </button>
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
        <!-- 关联产出物 -->
        <div class="issue-assets">
          <div class="assets-head-row">
            <span class="block-label">关联产出物</span>
            <button class="issue-link-btn" type="button" @click="openLinkDialog">
              <el-icon :size="12"><Link /></el-icon>关联产出物
            </button>
          </div>
          <div v-for="link in assets" :key="link.assetId" class="asset-row">
            <el-tag size="small" effect="plain">{{
              issueAssetRelationLabels[link.relationType]
            }}</el-tag>
            <span class="asset-name">{{ link.asset.name }}</span>
            <button
              class="issue-unlink"
              type="button"
              @click="unlink(link.assetId)"
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
    </template>
    <!-- 关联产出物选择弹窗：多选后按「参考」关系建立关联 -->
    <el-dialog
      v-model="linkDialogVisible"
      title="关联产出物"
      width="420px"
      append-to-body
    >
      <div class="link-dialog-body">
        <div
          v-for="group in fileGroups"
          :key="group.label"
          class="link-dialog-group"
        >
          <span class="link-dialog-label">{{ group.label }}</span>
          <el-checkbox-group v-model="selectedAssetIds">
            <el-checkbox
              v-for="file in group.files"
              :key="file.id"
              :label="file.id"
              :disabled="linkedIds.has(file.id)"
            >
              {{ file.name }}
            </el-checkbox>
          </el-checkbox-group>
        </div>
        <el-empty
          v-if="!fileGroups.length"
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
          :disabled="linkSaving"
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
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* 左栏 flex 子项：占满剩余高度；根容器不滚，滚动交给内部列表/详情区 */
  flex: 1 1 auto;
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
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
}
.issue-item:hover {
  background: var(--bg-hover);
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
/* 详情视图 */
.issues-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 0;
  flex: none;
}
.issues-back {
  display: inline-flex;
  padding: 4px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text-tertiary, var(--text-muted));
  cursor: pointer;
  flex: none;
}
.issues-back:hover {
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
.issue-desc {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-soft);
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-regular);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.muted-line {
  color: var(--text-faint);
}
.issue-flow {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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
/* 关联弹窗 */
.link-dialog-body {
  display: grid;
  gap: 10px;
  max-height: 320px;
  overflow: auto;
}
.link-dialog-group {
  display: grid;
  gap: 4px;
}
.link-dialog-group :deep(.el-checkbox-group) {
  display: grid;
  gap: 2px;
}
.link-dialog-label {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
