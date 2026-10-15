<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useEditor, EditorContent } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import DOMPurify from "dompurify";
import { ElMessage, ElMessageBox } from "element-plus";
import { requirementApi } from "../../api/requirements";

const props = defineProps<{
  html: string;
  text?: string;
  requirementId?: number;
  label?: string;
  fillHeight?: boolean;
}>();
const emit = defineEmits<{
  "update:html": [html: string];
  "update:text": [text: string];
}>();

// 写入与回显共用同一份净化配置，避免链接的 target 被滤掉
const SANITIZE = {
  ADD_ATTR: ["target"],
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick"],
};

const uploading = ref(false);
const input = ref<HTMLInputElement>();
const lastEmitted = ref("");
async function waitForUpload() {
  if (!uploading.value) return;
  await new Promise<void>((resolve) => {
    const stop = watch(uploading, (busy) => {
      if (busy) return;
      stop();
      resolve();
    });
  });
}
defineExpose({ waitForUpload });
function toHtml(source: string, text: string) {
  if (source) return DOMPurify.sanitize(source, SANITIZE);
  return text
    .split("\n")
    .map(
      (line) =>
        `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`,
    )
    .join("");
}
const editor = useEditor({
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      },
    }),
    Image.configure({ allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: "在这里输入或粘贴内容…" }),
  ],
  content: toHtml(props.html, props.text ?? ""),
  editorProps: {
    attributes: {
      class: "rich-document",
      "aria-label": props.label ?? "需求描述内容",
    },
  },
  onUpdate: ({ editor: instance }) => {
    const html = DOMPurify.sanitize(instance.getHTML(), SANITIZE);
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
function setParagraph() {
  editor.value?.chain().focus().setParagraph().run();
}
function setHeading(level: 1 | 2 | 3) {
  editor.value?.chain().focus().toggleHeading({ level }).run();
}
function toggleListTask() {
  editor.value?.chain().focus().toggleTaskList().run();
}
function indentList(outdent: boolean) {
  const instance = editor.value;
  if (!instance) return;
  const type = instance.isActive("taskItem") ? "taskItem" : "listItem";
  const chain = instance.chain().focus();
  (outdent
    ? chain.liftListItem(type)
    : chain.sinkListItem(type)
  ).run();
}
async function setLink() {
  const instance = editor.value;
  if (!instance) return;
  const current = (instance.getAttributes("link").href as string) ?? "";
  let value: string;
  try {
    const result = await ElMessageBox.prompt("输入链接地址", "插入链接", {
      inputValue: current,
      inputPlaceholder: "https://example.com",
      confirmButtonText: "确定",
      cancelButtonText: "取消",
      inputValidator: (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return true;
        return (
          /^(https?:\/\/|\/|mailto:)/i.test(trimmed) ||
          "请输入以 http(s)://、/ 或 mailto: 开头的地址"
        );
      },
    });
    value = result.value.trim();
  } catch {
    return;
  }
  if (!value) {
    instance.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  instance
    .chain()
    .focus()
    .extendMarkRange("link")
    .setLink({ href: value })
    .run();
}
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
  <div class="inline-rich" :class="{ 'fill-height': fillHeight }" v-if="editor">
    <div class="rich-toolbar">
      <div class="toolbar-group">
        <button
          :disabled="!editor.can().undo()"
          aria-label="撤销"
          title="撤销 (Ctrl+Z)"
          @click="editor.chain().focus().undo().run()"
        >
          撤销
        </button>
        <button
          :disabled="!editor.can().redo()"
          aria-label="重做"
          title="重做 (Ctrl+Shift+Z)"
          @click="editor.chain().focus().redo().run()"
        >
          重做
        </button>
      </div>
      <span class="toolbar-divider"></span>
      <div class="toolbar-group">
        <button
          :class="{ active: editor.isActive('bold') }"
          aria-label="加粗"
          title="加粗 (Ctrl+B)"
          @click="editor.chain().focus().toggleBold().run()"
        >
          <b>B</b>
        </button>
        <button
          :class="{ active: editor.isActive('italic') }"
          aria-label="斜体"
          title="斜体 (Ctrl+I)"
          @click="editor.chain().focus().toggleItalic().run()"
        >
          <i>I</i>
        </button>
        <button
          :class="{ active: editor.isActive('underline') }"
          aria-label="下划线"
          title="下划线 (Ctrl+U)"
          @click="editor.chain().focus().toggleUnderline().run()"
        >
          <u>U</u>
        </button>
        <button
          :class="{ active: editor.isActive('strike') }"
          aria-label="删除线"
          title="删除线"
          @click="editor.chain().focus().toggleStrike().run()"
        >
          <s>S</s>
        </button>
        <button
          :class="{ active: editor.isActive('code') }"
          aria-label="行内代码"
          title="行内代码"
          @click="editor.chain().focus().toggleCode().run()"
        >
          代码
        </button>
        <button
          aria-label="清除格式"
          title="清除格式"
          @click="editor.chain().focus().unsetAllMarks().clearNodes().run()"
        >
          清除格式
        </button>
      </div>
      <span class="toolbar-divider"></span>
      <div class="toolbar-group">
        <button
          :class="{ active: editor.isActive('paragraph') }"
          aria-label="正文"
          title="正文"
          @click="setParagraph"
        >
          正文
        </button>
        <button
          v-for="level in ([1, 2, 3] as const)"
          :key="level"
          :class="{ active: editor.isActive('heading', { level }) }"
          :aria-label="`标题 ${level}`"
          :title="`标题 ${level}`"
          @click="setHeading(level)"
        >
          H{{ level }}
        </button>
      </div>
      <span class="toolbar-divider"></span>
      <div class="toolbar-group">
        <button
          :class="{ active: editor.isActive('bulletList') }"
          aria-label="项目列表"
          title="项目列表"
          @click="editor.chain().focus().toggleBulletList().run()"
        >
          项目列表
        </button>
        <button
          :class="{ active: editor.isActive('orderedList') }"
          aria-label="编号列表"
          title="编号列表"
          @click="editor.chain().focus().toggleOrderedList().run()"
        >
          编号列表
        </button>
        <button
          :class="{ active: editor.isActive('taskList') }"
          aria-label="任务清单"
          title="任务清单"
          @click="toggleListTask"
        >
          任务清单
        </button>
        <button
          aria-label="减少缩进"
          title="减少缩进"
          @click="indentList(true)"
        >
          减少缩进
        </button>
        <button
          aria-label="增加缩进"
          title="增加缩进"
          @click="indentList(false)"
        >
          增加缩进
        </button>
      </div>
      <span class="toolbar-divider"></span>
      <div class="toolbar-group">
        <button
          :class="{ active: editor.isActive('blockquote') }"
          aria-label="引用"
          title="引用"
          @click="editor.chain().focus().toggleBlockquote().run()"
        >
          引用
        </button>
        <button
          :class="{ active: editor.isActive('codeBlock') }"
          aria-label="代码块"
          title="代码块"
          @click="editor.chain().focus().toggleCodeBlock().run()"
        >
          代码块
        </button>
        <button
          aria-label="分割线"
          title="分割线"
          @click="editor.chain().focus().setHorizontalRule().run()"
        >
          分割线
        </button>
      </div>
      <span class="toolbar-divider"></span>
      <div class="toolbar-group">
        <button
          :class="{ active: editor.isActive('link') }"
          aria-label="链接"
          title="插入或编辑链接"
          @click="setLink"
        >
          链接
        </button>
        <button
          :disabled="uploading || !requirementId"
          :title="
            !requirementId ? '先保存需求后可插入图片' : '图片保存在本地工作区'
          "
          aria-label="插入图片"
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
    </div>
    <EditorContent :editor="editor" />
  </div>
</template>
<style scoped>
.inline-rich {
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-surface);
}
.inline-rich .rich-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  row-gap: 6px;
  flex-wrap: wrap;
  padding: 8px 10px;
  max-height: 84px;
  overflow: auto;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-base);
}
.inline-rich .toolbar-group {
  display: flex;
  align-items: center;
  gap: 2px;
}
.inline-rich .rich-toolbar button {
  border: 0;
  background: transparent;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.2;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
}
.inline-rich .rich-toolbar button:hover,
.inline-rich .rich-toolbar button.active {
  background: var(--bg-brand-soft);
  color: var(--brand);
}
.inline-rich .rich-toolbar button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.inline-rich .toolbar-divider {
  height: 18px;
  width: 1px;
  flex: none;
  background: var(--border-strong);
  margin: 0 2px;
}
.inline-rich :deep(.rich-document) {
  padding: 16px 18px;
  min-height: 240px;
  max-height: 60vh;
  overflow: auto;
  outline: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-body);
}
/* 占满屏幕高度模式：工具栏固定，正文区域撑满并自行滚动 */
.inline-rich.fill-height {
  display: flex;
  flex-direction: column;
}
.inline-rich.fill-height .rich-toolbar {
  flex: none;
}
.inline-rich.fill-height :deep(.rich-document) {
  flex: 1 1 auto;
  min-height: calc(100vh - 330px);
  max-height: none;
}
.inline-rich :deep(.rich-document p) {
  margin: 0 0 10px;
}
.inline-rich :deep(.rich-document h1),
.inline-rich :deep(.rich-document h2),
.inline-rich :deep(.rich-document h3) {
  margin: 18px 0 10px;
  font-weight: 650;
  line-height: 1.4;
  letter-spacing: -0.2px;
}
.inline-rich :deep(.rich-document h1) {
  font-size: 20px;
}
.inline-rich :deep(.rich-document h2) {
  font-size: 17px;
}
.inline-rich :deep(.rich-document h3) {
  font-size: 15px;
}
.inline-rich :deep(.rich-document h1:first-child),
.inline-rich :deep(.rich-document h2:first-child),
.inline-rich :deep(.rich-document h3:first-child) {
  margin-top: 0;
}
.inline-rich :deep(.rich-document a) {
  color: var(--brand);
  text-decoration: underline;
  cursor: pointer;
}
.inline-rich :deep(.rich-document code) {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-code);
  font-size: 12px;
  font-family: "Cascadia Code", Consolas, monospace;
}
.inline-rich :deep(.rich-document pre) {
  margin: 0 0 10px;
  padding: 12px 14px;
  border-radius: 6px;
  background: var(--bg-code);
  overflow: auto;
}
.inline-rich :deep(.rich-document pre code) {
  padding: 0;
  background: none;
}
.inline-rich :deep(.rich-document blockquote) {
  margin: 0 0 10px;
  padding: 2px 0 2px 12px;
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
}
.inline-rich :deep(.rich-document hr) {
  border: 0;
  border-top: 1px solid var(--border-base);
  margin: 16px 0;
}
.inline-rich :deep(.rich-document ul),
.inline-rich :deep(.rich-document ol) {
  margin: 0 0 10px;
  padding-left: 22px;
}
.inline-rich :deep(.rich-document li p) {
  margin: 0 0 4px;
}
.inline-rich :deep(.rich-document img) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
}
.inline-rich :deep(.rich-document ul[data-type="taskList"]) {
  list-style: none;
  padding-left: 2px;
}
.inline-rich :deep(.rich-document ul[data-type="taskList"] li) {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.inline-rich :deep(.rich-document ul[data-type="taskList"] li > label) {
  flex: 1;
  min-width: 0;
}
.inline-rich :deep(.rich-document ul[data-type="taskList"] input) {
  margin: 5px 0 0;
  accent-color: var(--brand);
}
.inline-rich
  :deep(.rich-document p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  color: var(--text-faint);
  float: left;
  height: 0;
  pointer-events: none;
}
</style>
