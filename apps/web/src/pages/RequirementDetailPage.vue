<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowLeft, Delete } from "@element-plus/icons-vue";
import {
  dateFields,
  dateLabels,
  issuePhases,
  priorities,
  requirementStatuses,
  requirementTypes,
  stageLabels,
  stages,
  statusLabels,
  typeLabels,
  type IssuePhase,
  type Requirement,
  type RequirementFile,
  type RequirementRelations,
  type RequirementUpdate,
  type Stage,
} from "@superpm/shared";
import { requirementApi } from "../api/requirements";
import { errorMessage } from "../api/client";
import RequirementAnalysisPanel from "../features/requirements/RequirementAnalysisPanel.vue";
import RequirementAssetsPanel from "../features/requirements/RequirementAssetsPanel.vue";
import RequirementIssuesPanel from "../features/requirements/RequirementIssuesPanel.vue";
import InlineRichTextEditor from "../features/requirements/InlineRichTextEditor.vue";
import XlyTimeline from "../components/ease-ui/xly-timeline/index.vue";
import XlyTimelineItem from "../components/ease-ui/xly-timeline/timeline-item.vue";
import { tagTone } from "../features/requirements/enum-tags";
type Editable = Pick<
  Requirement,
  | "name"
  | "type"
  | "priority"
  | "status"
  | "currentStage"
  | "description"
  | "descriptionHtml"
  | "proposedAt"
  | "expectedAt"
  | "startedAt"
  | "completedAt"
  | "plannedReleaseAt"
  | "releasedAt"
>;
const route = useRoute();
const router = useRouter();
const id = computed(() => Number(route.params.id));
const item = ref<Requirement>();
const relations = ref<RequirementRelations>();
const draft = ref<Editable>();
const initial = ref("");
const loading = ref(false),
  saving = ref(false),
  error = ref("");
const activeTab = ref<"detail" | "progress">("detail");
const viewingStage = ref<Stage>("analysis");
// 左栏视图：文档编辑器 / 问题面板（仅在问题阶段可切到问题视图）
const viewMode = ref<"doc" | "issues">("doc");
const stageSaving = ref(false);
const stageSwitching = ref(false);
const analysisPanel = ref<InstanceType<typeof RequirementAnalysisPanel>>();
const assetsPanel = ref<InstanceType<typeof RequirementAssetsPanel>>();
// 当前查看阶段是否为问题阶段（UI 设计/开发跟进/需求测试）
const activeIssuePhase = computed<IssuePhase | null>(() =>
  (issuePhases as readonly string[]).includes(viewingStage.value)
    ? (viewingStage.value as IssuePhase)
    : null,
);
// 阶段变化自动切换左栏视图：问题阶段展示问题面板，其余回到文档编辑器
watch(viewingStage, (stage) => {
  viewMode.value = (issuePhases as readonly string[]).includes(stage)
    ? "issues"
    : "doc";
});
// 右栏点开 markdown 文档：编辑器常驻左栏，任意阶段直接加载（补充文档 5.1）
async function onOpenDoc(file: RequirementFile) {
  if (file.phase !== "analysis" && viewingStage.value !== file.phase) {
    // 先保存当前编辑内容，再切换查看阶段（右侧产物区跟随刷新）
    await viewStage(file.phase);
  }
  // 强制回到文档视图：编辑器即将打开
  viewMode.value = "doc";
  await nextTick();
  void analysisPanel.value?.loadEditor(file);
}
// 右栏删除文档后，左栏若正编辑该文档则回退默认分析记录
async function onDocRemoved(file: RequirementFile) {
  await analysisPanel.value?.reloadIfCurrent(file.id);
}
async function flushAnalysis() {
  return (await analysisPanel.value?.flush()) ?? true;
}
onBeforeRouteLeave(flushAnalysis);
onBeforeRouteUpdate(flushAnalysis);
async function viewStage(stage: Stage) {
  if (stage === viewingStage.value || stageSwitching.value) return;
  stageSwitching.value = true;
  try {
    if (await flushAnalysis()) viewingStage.value = stage;
  } finally {
    stageSwitching.value = false;
  }
}
// 顶部步骤条点击：切到「需求进展」页签并跟随该阶段刷新
async function goStage(stage: Stage) {
  activeTab.value = "progress";
  await viewStage(stage);
}
const dirty = computed(
  () => Boolean(draft.value) && JSON.stringify(draft.value) !== initial.value,
);
function statusOf(stage: Stage): "finish" | "process" | "wait" {
  if (!item.value) return "wait";
  const current = stages.indexOf(item.value.currentStage);
  const target = stages.indexOf(stage);
  if (target < current) return "finish";
  if (target === current) return "process";
  return "wait";
}
// 提出时间与开始时间并排一行，其余日期字段两列排布
const leadDates: string[] = ["proposedAt", "startedAt"];
const extraDates = dateFields.filter((key) => !leadDates.includes(key));
function snapshot(source: Requirement): Editable {
  const {
    name,
    type,
    priority,
    status,
    currentStage,
    description,
    descriptionHtml,
    proposedAt,
    expectedAt,
    startedAt,
    completedAt,
    plannedReleaseAt,
    releasedAt,
  } = source;
  return {
    name,
    type,
    priority,
    status,
    currentStage,
    description,
    descriptionHtml,
    proposedAt,
    expectedAt,
    startedAt,
    completedAt,
    plannedReleaseAt,
    releasedAt,
  };
}
function resetDraft(source: Requirement) {
  draft.value = snapshot(source);
  initial.value = JSON.stringify(draft.value);
}
let revision = 0;
async function load() {
  if (!Number.isInteger(id.value) || id.value <= 0) {
    error.value = "需求 ID 无效";
    return;
  }
  const token = ++revision;
  loading.value = true;
  error.value = "";
  try {
    const [detail, related] = await Promise.all([
      requirementApi.get(id.value),
      requirementApi.relations(id.value),
    ]);
    if (token !== revision) return;
    item.value = detail;
    relations.value = related;
    viewingStage.value = detail.currentStage;
    resetDraft(detail);
  } catch (e) {
    if (token === revision) error.value = errorMessage(e);
  } finally {
    if (token === revision) loading.value = false;
  }
}
watch(id, load, { immediate: true });
async function save() {
  if (!item.value || !draft.value || saving.value) return;
  if (!draft.value.name.trim()) {
    ElMessage.warning("请填写需求名称");
    return;
  }
  saving.value = true;
  try {
    const updated = await requirementApi.update(item.value.id, {
      ...draft.value,
    } as RequirementUpdate);
    item.value = updated;
    resetDraft(updated);
    ElMessage.success("需求已保存");
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    saving.value = false;
  }
}
async function revert() {
  if (!item.value || !dirty.value) return;
  try {
    await ElMessageBox.confirm("确定放弃未保存的修改吗？", "未保存的修改", {
      confirmButtonText: "放弃修改",
      cancelButtonText: "继续编辑",
    });
  } catch {
    return;
  }
  resetDraft(item.value);
}
function onDescriptionHtml(html: string) {
  if (draft.value) draft.value.descriptionHtml = html;
}
function onDescriptionText(text: string) {
  if (draft.value) draft.value.description = text;
}
async function changeStage(stage: Stage) {
  if (!item.value || stageSaving.value) return;
  stageSaving.value = true;
  try {
    const updated = await requirementApi.update(item.value.id, {
      currentStage: stage,
    });
    item.value = updated;
    viewingStage.value = stage;
    resetDraft(updated);
    ElMessage.success("当前阶段已更新");
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    stageSaving.value = false;
  }
}
async function remove() {
  if (!item.value) return;
  try {
    await ElMessageBox.confirm(
      `确定软删除「${item.value.name}」吗？`,
      "删除需求",
      {
        confirmButtonText: "确认删除",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
  } catch {
    return;
  }
  try {
    if (!(await flushAnalysis())) return;
    await requirementApi.remove(item.value.id);
    ElMessage.success("需求已删除");
    router.push("/requirements");
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}
function go(target: Requirement) {
  router.push(`/requirements/${target.id}`);
}
</script>
<template>
  <div class="detail-page" v-loading="loading">
    <button
      class="back-link"
      type="button"
      @click="router.push('/requirements')"
    >
      <el-icon><ArrowLeft /></el-icon>返回需求列表
    </button>
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
          <div class="head-actions">
            <el-button
              v-if="viewingStage !== item.currentStage"
              type="primary"
              plain
              size="small"
              :loading="stageSaving"
              @click="changeStage(viewingStage)"
              >设为当前阶段</el-button
            >
            <el-tag v-else effect="plain" size="small">当前阶段</el-tag>
            <el-button
              type="danger"
              plain
              size="small"
              :icon="Delete"
              @click="remove"
              >删除</el-button
            >
          </div>
        </div>
        <XlyTimeline direction="horizontal" class="stage-timeline">
          <XlyTimelineItem
            v-for="stage in stages"
            :key="stage"
            :status="statusOf(stage)"
            @click="goStage(stage)"
          >
            <span class="stage-name">{{ stageLabels[stage] }}</span>
          </XlyTimelineItem>
        </XlyTimeline>
      </section>
      <section class="surface detail-body">
        <el-tabs v-model="activeTab">
          <el-tab-pane label="需求详情" name="detail">
            <div class="detail-grid">
              <article class="detail-desc">
                <InlineRichTextEditor
                  v-if="draft"
                  fill-card
                  :html="draft.descriptionHtml"
                  :text="draft.description"
                  :requirement-id="item.id"
                  @update:html="onDescriptionHtml"
                  @update:text="onDescriptionText"
                />
              </article>
              <div class="detail-fields">
                <form v-if="draft" class="field-form" @submit.prevent="save">
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
                      <el-select v-model="draft.currentStage"
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
                  <div class="field-actions">
                    <span>{{ dirty ? "有未保存的修改" : "已同步到本地" }}</span>
                    <el-button :disabled="!dirty || saving" @click="revert"
                      >重置</el-button
                    >
                    <el-button
                      type="primary"
                      :loading="saving"
                      :disabled="!dirty"
                      @click="save"
                      >保存修改</el-button
                    >
                  </div>
                </form>
              </div>
            </div>
          </el-tab-pane>
          <el-tab-pane label="需求进展" name="progress">
            <div class="progress-layout">
              <div class="progress-main">
                <!-- 左栏视图切换：文档 / 问题（问题视图仅在问题阶段可用） -->
                <div class="view-switch" role="group" aria-label="左栏视图切换">
                  <button
                    type="button"
                    :class="{ active: viewMode === 'doc' }"
                    @click="viewMode = 'doc'"
                  >
                    文档
                  </button>
                  <button
                    type="button"
                    :class="{ active: viewMode === 'issues' }"
                    :disabled="!activeIssuePhase"
                    @click="viewMode = 'issues'"
                  >
                    问题
                  </button>
                </div>
                <!-- 问题面板：问题阶段的问题视图下渲染 -->
                <RequirementIssuesPanel
                  v-if="activeIssuePhase && viewMode === 'issues'"
                  :key="item.id"
                  :requirement-id="item.id"
                  :phase="activeIssuePhase"
                />
                <!-- 编辑器常驻左栏：跨阶段打开文档不再切换宿主（补充文档 5.1）；
                     问题视图下隐藏但保持挂载，冲刷未保存内容不中断 -->
                <RequirementAnalysisPanel
                  v-show="!activeIssuePhase || viewMode === 'doc'"
                  ref="analysisPanel"
                  :key="item.id"
                  :requirement-id="item.id"
                />
              </div>
              <RequirementAssetsPanel
                ref="assetsPanel"
                class="progress-side"
                :requirement-id="item.id"
                :active-phase="viewingStage"
                @open-doc="onOpenDoc"
                @doc-removed="onDocRemoved"
              />
            </div>
          </el-tab-pane>
        </el-tabs>
      </section>
    </template>
  </div>
</template>
<style scoped>
.progress-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
  gap: 14px;
  align-items: stretch;
}
.progress-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
/* 左栏视图切换条：文档 / 问题（segmented 风格） */
.view-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border-base);
  border-radius: 8px;
  background: var(--bg-surface);
  flex: none;
  align-self: flex-start;
  margin-bottom: 8px;
}
.view-switch button {
  padding: 3px 14px;
  border: 0;
  border-radius: 6px;
  background: none;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}
.view-switch button:hover:not(:disabled):not(.active) {
  color: var(--brand);
  background: var(--bg-hover);
}
.view-switch button.active {
  background: var(--bg-brand-soft);
  color: var(--brand);
  font-weight: 600;
}
.view-switch button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
  color: var(--text-faint);
}
.progress-side {
  min-width: 0;
}
.detail-page {
  display: grid;
  gap: 10px;
  align-content: start;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: none;
  padding: 0;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  justify-self: start;
}
.back-link:hover {
  color: var(--brand);
}
.detail-head {
  display: grid;
  gap: 8px;
  padding: 10px 18px 12px;
}
.head-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}
.head-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
}
.head-title {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.2px;
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
.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.detail-head .stage-timeline {
  min-width: 0;
}
.detail-body {
  padding: 12px 22px 22px;
}
.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 26px;
  padding-top: 6px;
}
.detail-desc {
  /* 高度跟随右侧表单列：编辑器绝对定位铺满本格，内容超出时内部滚动 */
  position: relative;
  min-height: 360px;
}
.detail-desc > .inline-rich {
  position: absolute;
  inset: 0;
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
.field-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  border-top: 1px solid var(--border-soft);
  padding-top: 14px;
  margin-top: 4px;
}
.field-actions > span {
  margin-right: auto;
  font-size: 11px;
  color: var(--text-faint);
}
.stage-timeline {
  min-width: 0;
}
.stage-timeline :deep(.xly-timeline-item) {
  cursor: pointer;
}
.stage-name {
  font-size: 13px;
  line-height: 1.4;
  color: var(--text-muted);
}
.stage-timeline :deep(.xly-timeline-item--finish) .stage-name {
  color: var(--text-title);
}
.stage-timeline :deep(.xly-timeline-item--process) .stage-name {
  color: var(--brand-strong);
  font-weight: 600;
}
@media (max-width: 1100px) {
  .detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 700px) {
  .head-row {
    align-items: flex-start;
  }
  .head-actions {
    margin-left: 0;
    width: 100%;
  }
  .field-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
