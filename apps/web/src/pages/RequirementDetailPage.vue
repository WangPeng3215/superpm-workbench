<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowLeft, Delete, Document } from "@element-plus/icons-vue";
import {
  dateFields,
  dateLabels,
  priorities,
  requirementStatuses,
  requirementTypes,
  stageLabels,
  stages,
  statusLabels,
  typeLabels,
  type Requirement,
  type RequirementRelations,
  type RequirementUpdate,
  type Stage,
  type StageHistory,
} from "@superpm/shared";
import { requirementApi } from "../api/requirements";
import { errorMessage } from "../api/client";
import RequirementAnalysisPanel from "../features/requirements/RequirementAnalysisPanel.vue";
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
const history = ref<StageHistory[]>([]);
const draft = ref<Editable>();
const initial = ref("");
const loading = ref(false),
  saving = ref(false),
  error = ref("");
const activeTab = ref<"detail" | "progress">("detail");
const viewingStage = ref<Stage>("analysis");
const stageSaving = ref(false);
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
const extraDates = dateFields.filter((key) => key !== "proposedAt");
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
    const [detail, records, related] = await Promise.all([
      requirementApi.get(id.value),
      requirementApi.history(id.value),
      requirementApi.relations(id.value),
    ]);
    if (token !== revision) return;
    item.value = detail;
    history.value = records;
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
    history.value = await requirementApi.history(item.value.id);
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
      <section class="surface detail-hero">
        <div class="hero-main">
          <div class="hero-title">
            <span class="hero-no">{{ item.requirementNo }}</span>
            <h1>{{ item.name }}</h1>
          </div>
          <div class="hero-tags">
            <el-tag class="enum-tag" :class="tagTone('type', item.type)">{{
              typeLabels[item.type]
            }}</el-tag>
            <el-tag
              class="enum-tag"
              :class="tagTone('priority', item.priority)"
              >{{ item.priority }}</el-tag
            >
            <el-tag class="enum-tag" :class="tagTone('status', item.status)">{{
              statusLabels[item.status]
            }}</el-tag>
            <el-tag
              class="enum-tag"
              :class="tagTone('currentStage', item.currentStage)"
              >{{ stageLabels[item.currentStage] }}</el-tag
            >
            <el-tag v-if="item.parentId" size="small" effect="plain"
              >子需求</el-tag
            >
          </div>
        </div>
        <div class="hero-actions">
          <el-button type="danger" plain :icon="Delete" @click="remove"
            >删除</el-button
          >
        </div>
      </section>
      <section class="surface detail-body">
        <el-tabs v-model="activeTab">
          <el-tab-pane label="需求详情" name="detail">
            <div class="detail-grid">
              <article class="detail-desc">
                <header class="panel-head">
                  <h2>需求描述</h2>
                  <span class="panel-note"
                    >直接编辑内容，保存后写入需求描述</span
                  >
                </header>
                <InlineRichTextEditor
                  v-if="draft"
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
            <div class="stage-header">
              <XlyTimeline direction="horizontal" class="stage-timeline">
                <XlyTimelineItem
                  v-for="stage in stages"
                  :key="stage"
                  :status="statusOf(stage)"
                  @click="viewingStage = stage"
                >
                  <span class="stage-name">{{ stageLabels[stage] }}</span>
                </XlyTimelineItem>
              </XlyTimeline>
              <div class="stage-switch">
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
              </div>
            </div>
            <RequirementAnalysisPanel
              v-if="viewingStage === 'analysis'"
              :requirement-id="item.id"
            />
            <div v-else class="stage-placeholder">
              <el-icon><Document /></el-icon>
              <strong
                >{{
                  stageLabels[viewingStage]
                }}页面将在后续批次迁移到此处</strong
              >
              <p>
                当前批次只迁移了「需求分析」，其余阶段将在后续批次逐步完成。
              </p>
            </div>
            <el-collapse class="stage-history">
              <el-collapse-item title="阶段历史" name="history">
                <div v-for="key in extraDates" :key="key" class="history-date">
                  <span>{{ dateLabels[key] }}</span>
                  <strong>{{ item[key] || "未设置" }}</strong>
                </div>
                <p v-if="!history.length" class="muted">尚未发生阶段切换。</p>
                <div
                  v-for="record in history"
                  :key="record.id"
                  class="stage-history-row"
                >
                  <span
                    >{{ stageLabels[record.fromStage] }} →
                    {{ stageLabels[record.toStage] }}</span
                  >
                  <time>{{
                    new Date(record.createdAt).toLocaleString("zh-CN")
                  }}</time>
                </div>
              </el-collapse-item>
            </el-collapse>
          </el-tab-pane>
        </el-tabs>
      </section>
    </template>
  </div>
</template>
<style scoped>
.detail-page {
  display: grid;
  gap: 16px;
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
  color: #7a879b;
  cursor: pointer;
  justify-self: start;
}
.back-link:hover {
  color: #4e6ef2;
}
.detail-hero {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 22px;
  box-shadow: 0 6px 18px rgba(37, 50, 73, 0.06);
}
.hero-title {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.hero-no {
  font-family: Consolas, monospace;
  font-size: 13px;
  color: #7d8a9c;
}
.hero-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.hero-actions {
  display: flex;
  gap: 8px;
  flex: none;
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
  border: 1px solid #e7ebf1;
  border-radius: 8px;
  padding: 16px 18px;
  background: #fbfcfe;
  align-self: start;
}
.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.panel-head h2 {
  margin: 0;
}
.panel-note {
  font-size: 11px;
  color: #99a7bd;
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
  color: #8b98ac;
}
.field :deep(.el-select),
.field :deep(.el-date-editor) {
  width: 100%;
}
.related-block {
  border-top: 1px solid #eef1f6;
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
  border: 1px solid #eef1f6;
  border-radius: 6px;
  background: #fbfcfe;
}
.related-row .link-button {
  font-size: 12px;
  color: #41556f;
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
  color: #4e6ef2;
}
.field-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  border-top: 1px solid #eef1f6;
  padding-top: 14px;
  margin-top: 4px;
}
.field-actions > span {
  margin-right: auto;
  font-size: 11px;
  color: #99a7bd;
}
.stage-header {
  display: flex;
  align-items: center;
  gap: 20px;
  margin: 6px 0 20px;
}
.stage-timeline {
  flex: 1;
  min-width: 0;
}
.stage-timeline :deep(.xly-timeline-item) {
  cursor: pointer;
}
.stage-name {
  font-size: 13px;
  color: #8e8ea0;
}
.stage-timeline :deep(.xly-timeline-item--finish) .stage-name {
  color: #344761;
}
.stage-timeline :deep(.xly-timeline-item--process) .stage-name {
  color: #4f6ef7;
  font-weight: 600;
}
.stage-switch {
  flex: none;
}
.stage-placeholder {
  padding: 42px 22px;
  background: #fafbfd;
  border: 1px dashed #dce4f0;
  border-radius: 8px;
  text-align: center;
}
.stage-placeholder > .el-icon {
  font-size: 26px;
  color: #a6b5d0;
}
.stage-placeholder > strong {
  display: block;
  font-size: 13px;
  color: #7183a1;
  margin-top: 12px;
}
.stage-placeholder > p {
  font-size: 12px;
  color: #9aa8bd;
  margin: 8px 0 18px;
}
.stage-history {
  margin-top: 26px;
  border-top: 1px solid #e7ecf3;
}
.history-date {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 18px 12px 0;
  font-size: 11px;
  color: #9aabc1;
}
.history-date strong {
  font-size: 12px;
  font-weight: 500;
  color: #607692;
}
.stage-history-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #7790b2;
  line-height: 2.4;
}
.stage-history-row time {
  font-size: 10px;
  color: #a3b0c3;
}
@media (max-width: 1100px) {
  .detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 700px) {
  .detail-hero {
    flex-direction: column;
    align-items: flex-start;
  }
  .field-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
