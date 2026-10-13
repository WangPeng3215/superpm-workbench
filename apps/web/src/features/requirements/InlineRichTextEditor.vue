<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useEditor, EditorContent } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import DOMPurify from "dompurify";
import { ElMessage } from "element-plus";
import { requirementApi } from "../../api/requirements";

const props = defineProps<{
  html: string;
  text?: string;
  requirementId?: number;
  label?: string;
}>();
const emit = defineEmits<{
  "update:html": [html: string];
  "update:text": [text: string];
}>();
const uploading = ref(false);
const input = ref<HTMLInputElement>();
const lastEmitted = ref("");
function toHtml(source: string, text: string) {
  if (source) return DOMPurify.sanitize(source);
  return text
    .split("\n")
    .map(
      (line) =>
        `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`,
    )
    .join("");
}
const editor = useEditor({
  extensions: [StarterKit, Image.configure({ allowBase64: false })],
  content: toHtml(props.html, props.text ?? ""),
  editorProps: {
    attributes: {
      class: "rich-document",
      "aria-label": props.label ?? "需求描述内容",
    },
  },
  onUpdate: ({ editor: instance }) => {
    const html = DOMPurify.sanitize(instance.getHTML());
    lastEmitted.value = html;
    emit("update:html", html);
    emit("update:text", instance.getText());
  },
});
watch(
  () => `${props.html}\u0000${props.text ?? ""}`,
  () => {
    const instance = editor.value;
    if (!instance) return;
    const next = toHtml(props.html, props.text ?? "");
    if (next === lastEmitted.value || next === instance.getHTML()) return;
    instance.commands.setContent(next || "<p></p>", { emitUpdate: false });
  },
);
async function upload(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
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
    ElMessage.error(errorMessage(error));
  } finally {
    uploading.value = false;
    if (input.value) input.value.value = "";
  }
}
onBeforeUnmount(() => editor.value?.destroy());
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "图片上传失败";
}
</script>
<template>
  <div class="inline-rich" v-if="editor">
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
  </div>
</template>
<style scoped>
.inline-rich {
  border: 1px solid #dfe5ee;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}
.inline-rich .rich-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  padding: 8px 10px;
  background: #f7f9fc;
  border-bottom: 1px solid #e5eaf1;
}
.inline-rich .rich-toolbar button {
  border: 0;
  background: transparent;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  color: #536079;
  cursor: pointer;
}
.inline-rich .rich-toolbar button:hover,
.inline-rich .rich-toolbar button.active {
  background: #e8edff;
  color: #4e6ef2;
}
.inline-rich .rich-toolbar button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.inline-rich .toolbar-divider {
  height: 18px;
  width: 1px;
  background: #dfe5ee;
  margin: 0 4px;
}
.inline-rich :deep(.rich-document) {
  padding: 16px 18px;
  min-height: 240px;
  max-height: 60vh;
  overflow: auto;
  outline: 0;
  font-size: 13px;
  line-height: 1.8;
  color: #34445d;
}
.inline-rich :deep(.rich-document p) {
  margin: 0 0 10px;
}
</style>
