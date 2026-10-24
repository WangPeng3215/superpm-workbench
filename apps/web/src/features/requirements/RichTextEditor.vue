<script setup lang="ts">
import { ref, watch } from "vue";
import DOMPurify from "dompurify";
import { ElMessageBox } from "element-plus";
import InlineRichTextEditor from "./InlineRichTextEditor.vue";

// 列表内的描述编辑弹窗：复用详情页同一套编辑器，避免两处工具栏与行为分叉
const props = defineProps<{
  modelValue: boolean;
  html?: string;
  text?: string;
  title: string;
  requirementId?: number;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  save: [html: string, text: string];
}>();

const editor = ref<InstanceType<typeof InlineRichTextEditor>>();
const dirty = ref(false);
const textLength = ref(0);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    dirty.value = false;
    textLength.value = (props.text ?? "").length;
  },
  { immediate: true },
);
function onHtml() {
  dirty.value = true;
}
function onText(text: string) {
  dirty.value = true;
  textLength.value = text.length;
}
async function close(done?: () => void) {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm(
        "富文本修改还未应用，确定放弃吗？",
        "未应用的内容",
        { confirmButtonText: "放弃修改", cancelButtonText: "继续编辑" },
      );
    } catch {
      return;
    }
  }
  emit("update:modelValue", false);
  done?.();
}
async function apply() {
  await editor.value?.waitForUpload();
  const content = editor.value?.getContent();
  if (!content) return;
  emit("save", DOMPurify.sanitize(content.html), content.text);
  emit("update:modelValue", false);
}
</script>
<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="min(940px, 94vw)"
    append-to-body
    :before-close="close"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
  >
    <InlineRichTextEditor
      v-if="modelValue"
      ref="editor"
      label="富文本内容"
      placeholder="在这里输入需求描述…"
      :html="html ?? ''"
      :text="text ?? ''"
      :requirement-id="requirementId"
      @update:html="onHtml"
      @update:text="onText"
    />
    <div class="rich-footer">{{ textLength }} 字 · 应用后仍需保存所在行</div>
    <template #footer
      ><el-button @click="close()">取消</el-button
      ><el-button type="primary" @click="apply">应用内容</el-button></template
    >
  </el-dialog>
</template>
<style scoped>
.rich-footer {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-faint);
}
</style>
