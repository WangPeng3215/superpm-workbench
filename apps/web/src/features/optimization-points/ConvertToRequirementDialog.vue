<script setup lang="ts">
import { ref, watch } from "vue";
import type {
  OptimizationPoint,
  OptimizationPointConvert,
} from "@superpm/shared";
import InlineRichTextEditor from "../requirements/InlineRichTextEditor.vue";

const props = defineProps<{
  modelValue: boolean;
  point: OptimizationPoint | null;
  loading?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  confirm: [payload: OptimizationPointConvert];
}>();

const name = ref("");
const error = ref("");

// 每次打开都按优化点当前内容预填需求名称；正文整段继承，这里只做转换前确认
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    name.value = props.point?.name ?? "";
    error.value = "";
  },
);

function close() {
  if (props.loading) return;
  emit("update:modelValue", false);
}

function confirm() {
  if (props.loading) return;
  if (!name.value.trim()) {
    error.value = "请输入需求名称";
    return;
  }
  error.value = "";
  emit("confirm", { name: name.value.trim() });
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="转为正式需求"
    width="min(620px, 92vw)"
    :close-on-click-modal="!loading"
    :close-on-press-escape="!loading"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="convert-body">
      <p class="convert-intro">
        将按现有正式需求创建流程生成需求编号、需求文件夹与标准目录，并把优化点标记为「已转正式需求」。优化点内容会成为需求详情。
      </p>
      <label class="field">
        <span class="field-label"
          >需求名称<i class="required" aria-hidden="true">*</i></span
        >
        <el-input v-model="name" maxlength="200" show-word-limit />
      </label>
      <div class="field">
        <span class="field-label">需求详情（继承优化点内容）</span>
        <div class="content-preview">
          <InlineRichTextEditor
            v-if="point"
            readonly
            fill-card
            :html="point.descriptionHtml"
            :text="point.description"
            label="需求详情预览"
          />
        </div>
        <span class="field-hint"
          >转换后可继续在需求详情中编辑；如需先调整内容，请返回优化点修改。</span
        >
      </div>
      <dl class="convert-meta">
        <div>
          <dt>需求来源</dt>
          <dd>优化点管理</dd>
        </div>
        <div>
          <dt>需求类型</dt>
          <dd>优化</dd>
        </div>
        <div>
          <dt>初始状态</dt>
          <dd>未开始 · 需求分析</dd>
        </div>
        <div>
          <dt>所属模块</dt>
          <dd>{{ point?.module || "未填写（不写入需求字段）" }}</dd>
        </div>
      </dl>
      <p v-if="error" class="convert-error">{{ error }}</p>
    </div>
    <template #footer>
      <el-button :disabled="loading" @click="close">取消</el-button>
      <el-button type="primary" :loading="loading" @click="confirm">
        确认转换
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.convert-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.convert-intro {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
}
.field-hint {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
}
.required {
  margin-left: 2px;
  color: var(--tone-red-fg);
  font-style: normal;
}
/* 只读预览固定高度，内容超出时在编辑器内部滚动；
   只读编辑器自身不带外框，这里补一层容器框，让「可滚动预览」边界清晰 */
.content-preview {
  display: flex;
  height: 260px;
  min-height: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-base);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  overflow: hidden;
}
.content-preview > .inline-rich {
  flex: 1 1 auto;
}
.convert-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.convert-meta div {
  display: flex;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}
.convert-meta dt {
  flex: none;
  color: var(--text-faint);
  font-size: 11px;
}
.convert-meta dd {
  margin: 0;
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.convert-error {
  margin: 0;
  color: var(--tone-red-fg);
  font-size: 12px;
}
</style>
