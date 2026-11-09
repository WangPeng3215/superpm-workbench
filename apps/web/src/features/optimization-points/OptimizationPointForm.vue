<script setup lang="ts">
import { ref, watch } from "vue";
import {
  editableOptimizationPointStatuses,
  optimizationPointModuleMaxLength,
  optimizationPointNameMaxLength,
  optimizationPointRemarkMaxLength,
  optimizationPointStatusLabels,
  type OptimizationPoint,
  type OptimizationPointCreate,
  type OptimizationPointStatus,
} from "@superpm/shared";
import InlineRichTextEditor from "../requirements/InlineRichTextEditor.vue";

const props = defineProps<{
  point?: OptimizationPoint | null;
  /** 详情页展示状态选择；新增弹窗不展示（新建恒为待评估） */
  showStatus?: boolean;
  disabled?: boolean;
  /** 详情页铺满可视高度；弹窗内改用固定编辑区高度，避免撑破弹窗 */
  fill?: boolean;
}>();
const emit = defineEmits<{ change: [] }>();

const name = ref(props.point?.name ?? "");
const module = ref(props.point?.module ?? "");
// 正文：内容以富文本 HTML 为准，纯文本投影与之一并保存（与需求描述同一形态）
const descriptionHtml = ref(props.point?.descriptionHtml ?? "");
const descriptionText = ref(props.point?.description ?? "");
const remark = ref(props.point?.remark ?? "");
const status = ref<OptimizationPointStatus>(props.point?.status ?? "pending");
const formError = ref("");

// 切换编辑对象时重置表单（同路由内切换 id 时组件会被复用）
watch(
  () => props.point?.id,
  () => {
    name.value = props.point?.name ?? "";
    module.value = props.point?.module ?? "";
    descriptionHtml.value = props.point?.descriptionHtml ?? "";
    descriptionText.value = props.point?.description ?? "";
    remark.value = props.point?.remark ?? "";
    status.value = props.point?.status ?? "pending";
    formError.value = "";
  },
);

function markDirty() {
  formError.value = "";
  emit("change");
}

function onContentHtml(html: string) {
  descriptionHtml.value = html;
  markDirty();
}

function onContentText(text: string) {
  descriptionText.value = text;
  markDirty();
}

/** 已转换且关联有效时状态不可改；关联失效（需求被删除）时允许改回其他状态 */
function statusLocked() {
  return (
    props.point?.status === "converted" && Boolean(props.point?.requirement)
  );
}

function statusHint() {
  if (props.point?.status !== "converted") return "";
  return props.point.requirement
    ? "已转为正式需求，状态不可直接修改。"
    : "关联的正式需求已被删除，可将状态改回评估中后重新转换。";
}

/**
 * 由父组件在提交前调用：必填项缺失时返回 null 并就地提示。
 * 返回体同时带上状态（仅详情页有效），新增时状态由后端置为待评估。
 */
function validate():
  (OptimizationPointCreate & { status?: OptimizationPointStatus }) | null {
  if (!name.value.trim()) {
    formError.value = "请输入优化点名称";
    return null;
  }
  // 只插入图片等非文字内容时纯文本投影为空、HTML 有值，按「有内容」处理
  if (!descriptionText.value.trim() && !descriptionHtml.value.trim()) {
    formError.value = "请填写优化点内容";
    return null;
  }
  formError.value = "";
  return {
    name: name.value.trim(),
    module: module.value.trim(),
    description: descriptionText.value,
    descriptionHtml: descriptionHtml.value,
    remark: remark.value.trim(),
    ...(props.showStatus && !statusLocked() ? { status: status.value } : {}),
  };
}

function isDirty(): boolean {
  if (!props.point) return true;
  return (
    name.value.trim() !== props.point.name ||
    module.value.trim() !== props.point.module ||
    descriptionHtml.value !== props.point.descriptionHtml ||
    descriptionText.value !== props.point.description ||
    remark.value.trim() !== props.point.remark ||
    (props.showStatus && !statusLocked() && status.value !== props.point.status)
  );
}

defineExpose({ validate, isDirty });
</script>

<template>
  <form class="point-form" :class="{ 'is-fill': fill }" @submit.prevent>
    <div class="form-main">
      <p v-if="formError" class="form-error">{{ formError }}</p>
      <span class="field-label">优化点内容</span>
      <InlineRichTextEditor
        fill-card
        label="优化点内容"
        placeholder="记录发现的问题、使用场景，以及初步的优化思路…"
        :html="descriptionHtml"
        :text="descriptionText"
        @update:html="onContentHtml"
        @update:text="onContentText"
      />
    </div>

    <aside class="form-side">
      <section class="side-section">
        <span class="side-title">优化点信息</span>
        <label class="field">
          <span class="field-label"
            >优化点名称<i class="required" aria-hidden="true">*</i></span
          >
          <el-input
            v-model="name"
            :maxlength="optimizationPointNameMaxLength"
            show-word-limit
            placeholder="一句话说明发现的问题或机会"
            :disabled="disabled"
            @input="markDirty"
          />
        </label>
        <label class="field">
          <span class="field-label">所属模块</span>
          <el-input
            v-model="module"
            :maxlength="optimizationPointModuleMaxLength"
            placeholder="选填，如：需求管理"
            :disabled="disabled"
            @input="markDirty"
          />
        </label>
        <label v-if="showStatus" class="field">
          <span class="field-label">当前状态</span>
          <el-select
            v-model="status"
            class="status-select"
            aria-label="当前状态"
            :disabled="disabled || statusLocked()"
            @change="markDirty"
          >
            <el-option
              v-for="value in editableOptimizationPointStatuses"
              :key="value"
              :label="optimizationPointStatusLabels[value]"
              :value="value"
            />
            <el-option
              v-if="point?.status === 'converted'"
              :label="optimizationPointStatusLabels.converted"
              value="converted"
            />
          </el-select>
          <span v-if="statusHint()" class="field-hint">{{ statusHint() }}</span>
        </label>
      </section>

      <section class="side-section">
        <span class="side-title">备注</span>
        <el-input
          v-model="remark"
          type="textarea"
          :rows="3"
          resize="vertical"
          :maxlength="optimizationPointRemarkMaxLength"
          placeholder="选填，其他补充信息"
          :disabled="disabled"
          @input="markDirty"
        />
      </section>

      <slot name="side" />
    </aside>
  </form>
</template>

<style scoped>
.point-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 320px);
  gap: 16px;
  width: 100%;
  min-width: 0;
}
.point-form.is-fill {
  height: 100%;
  min-height: 0;
}
.form-main {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  min-height: 0;
}
/* 弹窗内没有可视高度可铺：给编辑器一个稳定的编辑区高度 */
.point-form:not(.is-fill) .form-main {
  height: 340px;
}
.form-main > .inline-rich {
  flex: 1 1 auto;
  min-height: 0;
}
.form-error {
  margin: 0 0 4px;
  padding: 7px 10px;
  border: 1px solid var(--tone-red-bd);
  border-radius: var(--radius-sm, 6px);
  background: var(--tone-red-bg);
  color: var(--tone-red-fg);
  font-size: 12px;
}
.form-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}
.side-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.side-title {
  color: var(--text-heading);
  font-size: 12px;
  font-weight: 600;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.field-label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
}
.required {
  margin-left: 2px;
  color: var(--tone-red-fg);
  font-style: normal;
}
.field-hint {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
}
.status-select {
  width: 100%;
}
@media (max-width: 980px) {
  .point-form {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }
  .point-form:not(.is-fill) .form-main,
  .point-form.is-fill {
    height: auto;
  }
  .point-form.is-fill .form-main {
    min-height: 360px;
  }
  .form-side {
    overflow: visible;
  }
}
</style>
