<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { useEditor, EditorContent } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import DOMPurify from "dompurify";
import { ElMessage, ElMessageBox } from "element-plus";
import { requirementApi } from "../../api/requirements";
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
const uploading = ref(false);
const input = ref<HTMLInputElement>();
const initial = ref("");
function content() {
  return props.html
    ? DOMPurify.sanitize(props.html)
    : (props.text ?? "")
        .split("\n")
        .map(
          (line) =>
            `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`,
        )
        .join("");
}
const editor = useEditor({
  extensions: [StarterKit, Image.configure({ allowBase64: false })],
  content: "",
  editorProps: {
    attributes: { class: "rich-document", "aria-label": "富文本内容" },
  },
});
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      editor.value?.commands.setContent(content());
      initial.value = editor.value?.getHTML() ?? "";
    }
  },
);
async function close(done?: () => void) {
  if (uploading.value) return;
  if ((editor.value?.getHTML() ?? "") !== initial.value) {
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
function apply() {
  if (!editor.value || uploading.value) return;
  emit(
    "save",
    DOMPurify.sanitize(editor.value.getHTML()),
    editor.value.getText(),
  );
  emit("update:modelValue", false);
}
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!props.requirementId) {
    ElMessage.info("请先保存需求，再插入本地图片");
    return;
  }
  uploading.value = true;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error("图片不能超过 5 MB");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const result = await requirementApi.uploadImage(
      props.requirementId,
      data,
      file.type,
    );
    editor.value
      ?.chain()
      .focus()
      .setImage({ src: result.url, alt: file.name })
      .run();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "图片上传失败");
  } finally {
    uploading.value = false;
    if (input.value) input.value.value = "";
  }
}
onBeforeUnmount(() => editor.value?.destroy());
</script>
<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="min(850px, 94vw)"
    append-to-body
    :before-close="close"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
  >
    <div v-if="editor" class="rich-shell">
      <div class="rich-toolbar">
        <button
          :class="{ active: editor.isActive('bold') }"
          aria-label="加粗"
          @click="editor.chain().focus().toggleBold().run()"
        >
          <b>B</b>
        </button>
        <button
          :class="{ active: editor.isActive('italic') }"
          aria-label="斜体"
          @click="editor.chain().focus().toggleItalic().run()"
        >
          <i>I</i>
        </button>
        <button
          :class="{ active: editor.isActive('heading', { level: 2 }) }"
          @click="editor.chain().focus().toggleHeading({ level: 2 }).run()"
        >
          标题
        </button>
        <span class="toolbar-divider"></span>
        <button @click="editor.chain().focus().toggleBulletList().run()">
          项目列表
        </button>
        <button @click="editor.chain().focus().toggleOrderedList().run()">
          编号列表
        </button>
        <button @click="editor.chain().focus().toggleBlockquote().run()">
          引用
        </button>
        <button @click="editor.chain().focus().toggleCodeBlock().run()">
          代码
        </button>
        <span class="toolbar-divider"></span>
        <button
          :disabled="uploading || !requirementId"
          :title="
            !requirementId ? '先保存需求后可插入图片' : '图片保存在本地工作区'
          "
          @click="input?.click()"
        >
          {{ uploading ? "上传中…" : "插入图片" }}
        </button>
        <input
          ref="input"
          hidden
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          @change="upload"
        />
      </div>
      <EditorContent :editor="editor" />
      <div class="rich-footer">
        {{ editor.getText().length }} 字 · 应用后仍需保存所在行或记录
      </div>
    </div>
    <template #footer
      ><el-button :disabled="uploading" @click="close()">取消</el-button
      ><el-button type="primary" :loading="uploading" @click="apply"
        >应用内容</el-button
      ></template
    >
  </el-dialog>
</template>
<style>
.rich-shell {
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  overflow: hidden;
}
.rich-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  padding: 10px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-base);
}
.rich-toolbar button {
  border: 0;
  background: transparent;
  padding: 6px 10px;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
}
.rich-toolbar button:hover,
.rich-toolbar button.active {
  background: var(--bg-brand-soft);
  color: var(--brand);
}
.rich-toolbar button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.toolbar-divider {
  height: 18px;
  width: 1px;
  background: var(--border-strong);
  margin: 0 4px;
}
.rich-document {
  padding: 22px;
  min-height: 320px;
  max-height: 55vh;
  overflow: auto;
  outline: 0;
  font-size: 14px;
  line-height: 1.8;
  color: var(--text-body);
}
.rich-document p {
  margin: 0 0 10px;
}
.rich-document img,
.rich-render img {
  max-width: 100%;
  border-radius: 6px;
}
.rich-document blockquote,
.rich-render blockquote {
  border-left: 3px solid var(--brand);
  padding-left: 14px;
  margin-left: 0;
  color: var(--text-muted);
}
.rich-document pre,
.rich-render pre {
  background: var(--bg-code);
  padding: 14px;
  white-space: pre-wrap;
}
.rich-footer {
  border-top: 1px solid var(--border-base);
  padding: 10px 16px;
  font-size: 11px;
  color: var(--text-faint);
}
.rich-render {
  font-size: 13px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.rich-render p {
  margin: 0 0 8px;
}
</style>
