<script setup lang="ts">
import { computed, ref, watch } from "vue";
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
  priorities,
  requirementStatuses,
  requirementTypes,
  stageLabels,
  stages,
  statusLabels,
  typeLabels,
  type ArtifactNode,
  type Requirement,
  type RequirementRelations,
  type RequirementUpdate,
} from "@superpm/shared";
import { requirementApi } from "../api/requirements";
import { errorMessage } from "../api/client";
import { setTabLabel } from "../stores/tabs";
import DocTabEditor from "../features/requirements/DocTabEditor.vue";
import RequirementDocManager from "../features/requirements/RequirementDocManager.vue";
import RequirementIssuesPanel from "../features/requirements/RequirementIssuesPanel.vue";
import InlineRichTextEditor from "../features/requirements/InlineRichTextEditor.vue";
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
  if (issuesPanel.value && !(await issuesPanel.value.flush())) return false;
  return flushDocs();
}
onBeforeRouteLeave(flushAnalysis);
onBeforeRouteUpdate(flushAnalysis);
const dirty = computed(
  () => Boolean(draft.value) && JSON.stringify(draft.value) !== initial.value,
);
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
    resetDraft(detail);
    // 顶栏页签回填真实文案「编号 · 名称」（进入时先以「需求 #id」占位）
    setTabLabel(route.path, `${detail.requirementNo} · ${detail.name}`);
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
    // 改名/改编号后同步刷新顶栏页签文案
    setTabLabel(route.path, `${updated.requirementNo} · ${updated.name}`);
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
function go(target: Requirement) {
  router.push(`/requirements/${target.id}`);
}
function openRequirement(requirementId: number) {
  void router.push(`/requirements/${requirementId}`);
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
            <span class="detail-save-state" :class="{ dirty }">
              {{ dirty ? "有未保存的修改" : "已同步到本地" }}
            </span>
            <el-button
              size="small"
              :disabled="!dirty || saving"
              @click="revert"
            >
              重置
            </el-button>
            <el-button
              size="small"
              type="primary"
              :loading="saving"
              :disabled="!dirty"
              @click="save"
            >
              保存修改
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
      <section class="surface detail-body">
        <el-tabs v-model="activeTab" @tab-remove="onTabRemove">
          <el-tab-pane label="需求详情" name="detail">
            <div
              class="detail-grid"
              :class="{ 'properties-collapsed': !propertiesOpen }"
            >
              <article class="detail-desc">
                <InlineRichTextEditor
                  v-if="draft"
                  fill-card
                  :html="draft.descriptionHtml"
                  :text="draft.description"
                  :requirement-id="item.id"
                  @update:html="onDescriptionHtml"
                  @update:text="onDescriptionText"
                  @open-requirement="openRequirement"
                />
              </article>
              <div v-show="propertiesOpen" class="detail-fields">
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
                </form>
              </div>
            </div>
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
              :current-stage="item.currentStage"
              @open-requirement="openRequirement"
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
              :node="tab.node"
              @open-requirement="openRequirement"
            />
          </el-tab-pane>
        </el-tabs>
      </section>
    </template>
  </div>
</template>
<style scoped>
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
