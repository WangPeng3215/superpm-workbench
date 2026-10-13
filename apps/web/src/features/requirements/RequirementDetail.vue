<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  Delete,
  Document,
  Link,
  Plus,
  EditPen,
  Download,
} from "@element-plus/icons-vue";
import {
  stages,
  stageLabels,
  stageDescriptions,
  statusLabels,
  typeLabels,
  dateFields,
  dateLabels,
  type Requirement,
  type Stage,
  type StageHistory,
  type StageWorkspace,
  type WorkspaceRecord,
} from "@superpm/shared";
import DOMPurify from "dompurify";
import { requirementApi } from "../../api/requirements";
import { errorMessage } from "../../api/client";
import XlyDrawer from "../../components/ease-ui/xly-drawer/index.vue";
import RichTextEditor from "./RichTextEditor.vue";
const props = defineProps<{
  selected?: Requirement;
  history: StageHistory[];
  stageSaving: boolean;
}>();
const open = defineModel<boolean>({ required: true });
const viewingStage = defineModel<Stage>("viewingStage", { required: true });
const emit = defineEmits<{
  edit: [requirement: Requirement];
  remove: [requirement: Requirement];
  changeStage: [stage: Stage];
  createChild: [
    parentId: number,
    name: string,
    description: string,
    descriptionHtml: string,
  ];
  updated: [];
}>();
const workspace = ref<StageWorkspace>();
const loading = ref(false),
  saving = ref(false),
  error = ref(""),
  initial = ref("");
const dirty = computed(
  () => workspace.value && JSON.stringify(workspace.value) !== initial.value,
);
const richOpen = ref(false),
  recordOpen = ref(false),
  richField = ref<"bodyHtml" | "answerHtml">("bodyHtml");
const recordStage = ref<"design" | "development" | "testing">("design");
const recordDraft = ref<WorkspaceRecord>();
const recordInitial = ref("");
const assetTab = ref<"analysisText" | "prdText">("analysisText");
const records = computed(() =>
  viewingStage.value === "analysis"
    ? []
    : (workspace.value?.[viewingStage.value] ?? []),
);
const statusNames = {
  open: "待处理",
  processing: "处理中",
  resolved: "已解决",
};
const recordNames = {
  design: "设计变更",
  development: "开发问题",
  testing: "测试问题",
};
const sanitized = (html: string) => DOMPurify.sanitize(html);
let revision = 0;
async function load() {
  if (!props.selected) return;
  const id = props.selected.id;
  const token = ++revision;
  loading.value = true;
  error.value = "";
  try {
    const result = await requirementApi.workspace(id);
    if (token === revision) {
      workspace.value = result;
      initial.value = JSON.stringify(result);
    }
  } catch (e) {
    if (token === revision) error.value = errorMessage(e);
  } finally {
    if (token === revision) loading.value = false;
  }
}
watch(() => props.selected?.id, load, { immediate: true });
async function saveWorkspace() {
  if (!props.selected || !workspace.value || saving.value) return false;
  saving.value = true;
  error.value = "";
  try {
    workspace.value = await requirementApi.saveWorkspace(
      props.selected.id,
      workspace.value,
    );
    initial.value = JSON.stringify(workspace.value);
    ElMessage.success("阶段内容已保存到本地");
    return true;
  } catch (e) {
    error.value = errorMessage(e);
    return false;
  } finally {
    saving.value = false;
  }
}
async function mayClose() {
  if (saving.value) return false;
  if (
    dirty.value ||
    (recordOpen.value &&
      JSON.stringify(recordDraft.value) !== recordInitial.value)
  ) {
    try {
      await ElMessageBox.confirm(
        "阶段内容尚未保存，确定放弃吗？",
        "未保存的记录",
        { confirmButtonText: "放弃修改", cancelButtonText: "继续编辑" },
      );
    } catch {
      return false;
    }
  }
  return true;
}
async function close(value: boolean) {
  if (value) {
    open.value = true;
    return;
  }
  if (richOpen.value || recordOpen.value) return;
  if (await mayClose()) open.value = false;
}
onBeforeRouteLeave(mayClose);
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || recordOpen.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onMounted(() => window.addEventListener("beforeunload", beforeUnload));
onBeforeUnmount(() => {
  revision++;
  window.removeEventListener("beforeunload", beforeUnload);
});
function newRecord() {
  if (viewingStage.value === "analysis") return;
  recordStage.value = viewingStage.value;
  recordDraft.value = {
    id: crypto.randomUUID(),
    title: "",
    bodyHtml: "",
    answerHtml: "",
    status: "open",
    createdAt: new Date().toISOString(),
    linkedChildId: null,
  };
  recordInitial.value = JSON.stringify(recordDraft.value);
  recordOpen.value = true;
}
function editRecord(record: WorkspaceRecord) {
  if (viewingStage.value === "analysis") return;
  recordStage.value = viewingStage.value;
  recordDraft.value = JSON.parse(JSON.stringify(record));
  recordInitial.value = JSON.stringify(recordDraft.value);
  recordOpen.value = true;
}
async function closeRecord(done?: () => void) {
  if (saving.value || richOpen.value) return;
  if (JSON.stringify(recordDraft.value) !== recordInitial.value) {
    try {
      await ElMessageBox.confirm("记录尚未保存，确定放弃吗？", "未保存的记录", {
        confirmButtonText: "放弃修改",
        cancelButtonText: "继续编辑",
      });
    } catch {
      return;
    }
  }
  recordOpen.value = false;
  done?.();
}
async function saveRecord() {
  if (!workspace.value || !recordDraft.value || saving.value) return;
  if (!recordDraft.value.title.trim()) {
    ElMessage.warning("请填写记录标题");
    return;
  }
  const previous = JSON.parse(JSON.stringify(workspace.value));
  const bucket = workspace.value[recordStage.value];
  const index = bucket.findIndex(
    (record) => record.id === recordDraft.value!.id,
  );
  const saved = JSON.parse(JSON.stringify(recordDraft.value));
  if (index < 0) bucket.push(saved);
  else bucket[index] = saved;
  if (await saveWorkspace()) {
    recordOpen.value = false;
  } else workspace.value = previous;
}
function rich(field: "bodyHtml" | "answerHtml") {
  richField.value = field;
  richOpen.value = true;
}
function applyRich(html: string) {
  if (recordDraft.value) recordDraft.value[richField.value] = html;
}
async function deleteRecord(record: WorkspaceRecord) {
  if (!workspace.value || viewingStage.value === "analysis") return;
  try {
    await ElMessageBox.confirm("确定移除这条记录吗？", "移除记录", {
      confirmButtonText: "移除",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  const previous = JSON.parse(JSON.stringify(workspace.value));
  workspace.value[viewingStage.value] = workspace.value[
    viewingStage.value
  ].filter((item) => item.id !== record.id);
  if (!(await saveWorkspace())) workspace.value = previous;
}
async function child(record?: WorkspaceRecord) {
  if (!props.selected || props.selected.parentId) return;
  if (dirty.value && !(await saveWorkspace())) return;
  const html = record
    ? `<h2>问题</h2>${record.bodyHtml}<h2>回答 / 处理方案</h2>${record.answerHtml || "<p>待补充</p>"}`
    : "";
  const element = document.createElement("div");
  element.innerHTML = sanitized(html);
  open.value = false;
  emit(
    "createChild",
    props.selected.id,
    record?.title ?? "",
    element.textContent ?? "",
    sanitized(html),
  );
}
function download() {
  if (!workspace.value) return;
  const text = workspace.value.analysis[assetTab.value];
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/markdown;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${props.selected?.requirementNo}-${assetTab.value === "analysisText" ? "需求分析" : "初版PRD"}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
async function editRequirement() {
  if (!props.selected || !(await mayClose())) return;
  open.value = false;
  emit("edit", props.selected);
}
</script>
<template>
  <XlyDrawer
    :model-value="open"
    @update:model-value="close"
    direction="right"
    size="min(940px, 100vw)"
    :title="
      selected ? `${selected.requirementNo} · ${selected.name}` : '需求详情'
    "
    custom-class="requirement-workspace"
    :close-on-click-modal="false"
  >
    <template v-if="selected">
      <div class="workspace-detail-header">
        <div>
          <div class="detail-meta">
            <el-tag size="small" effect="plain">{{
              statusLabels[selected.status]
            }}</el-tag
            ><span>{{ typeLabels[selected.type] }}</span
            ><span>{{ selected.priority }}</span
            ><span v-if="selected.parentId">子需求</span>
          </div>
          <div
            v-if="selected.descriptionHtml"
            class="rich-render detail-summary"
            v-html="sanitized(selected.descriptionHtml)"
          ></div>
          <p v-else class="detail-summary">
            {{ selected.description || "还没有填写需求描述" }}
          </p>
        </div>
        <div class="detail-actions">
          <el-button
            :icon="EditPen"
            circle
            aria-label="编辑需求"
            @click="editRequirement"
          /><el-button
            :icon="Delete"
            circle
            type="danger"
            plain
            aria-label="软删除需求"
            @click="emit('remove', selected)"
          />
        </div>
      </div>
      <nav class="stage-navigation" aria-label="需求阶段">
        <button
          v-for="(stage, index) in stages"
          :key="stage"
          :class="{
            active: viewingStage === stage,
            current: selected.currentStage === stage,
          }"
          class="progress-stage"
          @click="viewingStage = stage"
        >
          <span class="stage-number">{{
            String(index + 1).padStart(2, "0")
          }}</span
          ><span>{{ stageLabels[stage] }}</span
          ><i v-if="selected.currentStage === stage" title="当前阶段"></i>
        </button>
      </nav>
      <div v-loading="loading" class="stage-content">
        <el-alert
          v-if="error"
          :title="error"
          type="error"
          show-icon
          :closable="false"
        />
        <div class="stage-title">
          <div>
            <h2>{{ stageLabels[viewingStage] }}</h2>
            <p>{{ stageDescriptions[viewingStage] }}</p>
          </div>
          <el-button
            v-if="viewingStage !== selected.currentStage"
            :loading="stageSaving"
            type="primary"
            plain
            size="small"
            @click="emit('changeStage', viewingStage)"
            >设为当前阶段</el-button
          ><el-tag v-else effect="plain" size="small">当前阶段</el-tag>
        </div>
        <template v-if="workspace">
          <template v-if="viewingStage === 'analysis'"
            ><div class="analysis-tabs">
              <button
                :class="{ active: assetTab === 'analysisText' }"
                @click="assetTab = 'analysisText'"
              >
                <el-icon><Document /></el-icon>需求分析记录</button
              ><button
                :class="{ active: assetTab === 'prdText' }"
                @click="assetTab = 'prdText'"
              >
                <el-icon><Document /></el-icon>初版 PRD</button
              ><el-button link :icon="Download" @click="download"
                >导出文件</el-button
              >
            </div>
            <div class="document-caption">
              <span>{{
                assetTab === "analysisText"
                  ? "梳理背景、目标、范围和待确认问题"
                  : "整理需求说明、用户流程与验收标准"
              }}</span
              ><span>Markdown 文件</span>
            </div>
            <el-input
              v-model="workspace.analysis[assetTab]"
              type="textarea"
              :rows="13"
              :placeholder="
                assetTab === 'analysisText'
                  ? '# 需求分析\n\n## 背景与目标\n\n## 范围与边界\n\n## 待确认问题'
                  : '# 初版 PRD\n\n## 需求概述\n\n## 用户流程\n\n## 功能说明\n\n## 验收标准'
              "
            />
            <div class="document-save">
              <span
                >保存后生成
                {{ assetTab === "analysisText" ? "analysis.md" : "prd.md" }}
                本地文件</span
              ><el-button
                type="primary"
                :loading="saving"
                @click="saveWorkspace"
                >保存分析产物</el-button
              >
            </div></template
          >
          <template v-else>
            <div v-if="viewingStage === 'design'" class="design-link">
              <div>
                <el-icon><Link /></el-icon><strong>UI 设计稿</strong>
              </div>
              <el-input
                v-model="workspace.designUrl"
                placeholder="粘贴 Figma、即时设计或其他设计稿链接"
                aria-label="UI 设计稿链接"
              /><el-button
                :loading="saving"
                type="primary"
                plain
                @click="saveWorkspace"
                >保存链接</el-button
              ><a
                v-if="/^https?:\/\//i.test(workspace.designUrl)"
                :href="workspace.designUrl"
                target="_blank"
                rel="noopener noreferrer"
                >打开 ↗</a
              >
            </div>
            <div class="record-list-heading">
              <strong
                >{{ recordNames[viewingStage] }}
                <span>{{ records.length }}</span></strong
              >
              <div>
                <el-button
                  v-if="viewingStage === 'development' && !selected.parentId"
                  :icon="Plus"
                  plain
                  @click="child()"
                  >快速创建子需求</el-button
                ><el-button type="primary" :icon="Plus" @click="newRecord">{{
                  viewingStage === "design" ? "新增变更" : "记录问题"
                }}</el-button>
              </div>
            </div>
            <div v-if="!records.length" class="workspace-empty">
              <el-icon><Document /></el-icon
              ><strong>{{
                viewingStage === "design"
                  ? "还没有设计变更"
                  : viewingStage === "development"
                    ? "还没有开发问题"
                    : "还没有测试问题"
              }}</strong>
              <p>
                {{
                  viewingStage === "design"
                    ? "记录每次方案调整及确认结论，保留设计演进过程。"
                    : viewingStage === "development"
                      ? "记录问题与回答，必要时将其转为子需求继续推进。"
                      : "记录发现的问题、处理方案和当前处理状态。"
                }}
              </p>
              <el-button plain @click="newRecord">{{
                viewingStage === "design" ? "记录第一条变更" : "记录第一个问题"
              }}</el-button>
            </div>
            <article
              v-for="record in records"
              :key="record.id"
              class="workspace-record"
            >
              <div class="record-head">
                <h3>{{ record.title }}</h3>
                <el-tag
                  size="small"
                  :type="
                    record.status === 'resolved'
                      ? 'success'
                      : record.status === 'processing'
                        ? 'warning'
                        : 'info'
                  "
                  effect="light"
                  >{{ statusNames[record.status] }}</el-tag
                ><el-button link @click="editRecord(record)">编辑</el-button>
              </div>
              <div
                class="rich-render"
                v-html="sanitized(record.bodyHtml)"
              ></div>
              <div v-if="record.answerHtml" class="record-answer">
                <span>{{
                  viewingStage === "design" ? "确认结论" : "回答 / 处理情况"
                }}</span>
                <div
                  class="rich-render"
                  v-html="sanitized(record.answerHtml)"
                ></div>
              </div>
              <div class="record-foot">
                <time>{{
                  new Date(record.createdAt).toLocaleString("zh-CN")
                }}</time
                ><el-button
                  v-if="viewingStage === 'development' && !selected.parentId"
                  link
                  type="primary"
                  @click="child(record)"
                  >从问题创建子需求 ↗</el-button
                ><el-button
                  link
                  type="danger"
                  :disabled="saving"
                  @click="deleteRecord(record)"
                  >移除</el-button
                >
              </div>
            </article>
          </template>
        </template>
      </div>
      <el-collapse class="workspace-facts"
        ><el-collapse-item title="需求时间与阶段历史" name="facts"
          ><div class="fact-grid">
            <div v-for="key in dateFields" :key="key">
              <span>{{ dateLabels[key] }}</span
              ><strong>{{ selected[key] || "未设置" }}</strong>
            </div>
          </div>
          <h4>阶段历史</h4>
          <p v-if="!history.length" class="muted">尚未发生阶段切换</p>
          <div v-for="item in history" :key="item.id" class="stage-history-row">
            <span
              >{{ stageLabels[item.fromStage] }} →
              {{ stageLabels[item.toStage] }}</span
            ><time>{{ new Date(item.createdAt).toLocaleString("zh-CN") }}</time>
          </div></el-collapse-item
        ></el-collapse
      >
    </template>
    <template #footer
      ><div class="workspace-drawer-footer">
        <span>{{ dirty ? "有未保存的阶段内容" : "内容保存在本机" }}</span
        ><el-button @click="close(false)">关闭</el-button
        ><el-button
          v-if="dirty"
          type="primary"
          :loading="saving"
          @click="saveWorkspace"
          >保存阶段内容</el-button
        >
      </div></template
    >
  </XlyDrawer>
  <el-dialog
    v-model="recordOpen"
    :title="recordNames[recordStage]"
    width="min(720px,94vw)"
    append-to-body
    :before-close="closeRecord"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    ><el-form v-if="recordDraft" label-position="top" @submit.prevent
      ><el-form-item label="记录标题"
        ><el-input
          v-model="recordDraft.title"
          placeholder="简要描述变更或问题"
          maxlength="200" /></el-form-item
      ><el-form-item :label="recordStage === 'design' ? '变更说明' : '问题描述'"
        ><button type="button" class="rich-record-input" @click="rich('bodyHtml')">
          <span v-if="!recordDraft.bodyHtml"
            >点击打开富文本编辑器，可插入本地图片</span
          >
          <div
            v-else
            class="rich-render"
            v-html="sanitized(recordDraft.bodyHtml)"
          ></div></button></el-form-item
      ><el-form-item
        :label="recordStage === 'design' ? '确认结论' : '回答 / 处理情况'"
        ><button type="button" class="rich-record-input" @click="rich('answerHtml')">
          <span v-if="!recordDraft.answerHtml"
            >补充回答、处理方案或验证结果</span
          >
          <div
            v-else
            class="rich-render"
            v-html="sanitized(recordDraft.answerHtml)"
          ></div></button></el-form-item
      ><el-form-item label="处理状态"
        ><el-radio-group v-model="recordDraft.status"
          ><el-radio-button value="open">待处理</el-radio-button
          ><el-radio-button value="processing">处理中</el-radio-button
          ><el-radio-button value="resolved"
            >已解决</el-radio-button
          ></el-radio-group
        ></el-form-item
      ></el-form
    ><template #footer
      ><el-button :disabled="saving" @click="closeRecord()">取消</el-button
      ><el-button type="primary" :loading="saving" @click="saveRecord"
        >保存记录</el-button
      ></template
    ></el-dialog
  >
  <RichTextEditor
    v-model="richOpen"
    :title="
      richField === 'bodyHtml' ? '编辑问题 / 变更说明' : '编辑回答 / 处理情况'
    "
    :html="recordDraft?.[richField]"
    :requirement-id="selected?.id"
    @save="applyRich"
  />
</template>
<style scoped src="./stage-workspace.css"></style>
