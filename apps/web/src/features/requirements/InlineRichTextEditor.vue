<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useEditor, EditorContent } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import DOMPurify from "dompurify";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  AlignCenterOutlined,
  AlignLeftOutlined,
  AlignRightOutlined,
  BoldOutlined,
  CheckSquareOutlined,
  CodeOutlined,
  ItalicOutlined,
  LinkOutlined,
  MinusOutlined,
  OrderedListOutlined,
  PictureOutlined,
  RedoOutlined,
  StrikethroughOutlined,
  UnderlineOutlined,
  UndoOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons-vue";
import { artifactApi } from "../../api/artifacts";
import { errorMessage } from "../../api/client";
import { BlockStyle, MAX_BLOCK_INDENT, type BlockAlign } from "./block-style";
import { imageDisplayUrl, toDisplayHtml } from "./doc-images";
import { looksLikeMarkdown, markdownToHtml } from "./doc-markdown";

const props = defineProps<{
  html: string;
  text?: string;
  requirementId?: number;
  // 当前编辑的文档节点：图片相对路径以文档所在目录为基准（文档 §12.4）
  nodeId?: number | null;
  label?: string;
  placeholder?: string;
  fillHeight?: boolean;
  fillCard?: boolean;
  // 紧凑模式：单行工具条 + 较低的编辑区，用于问题记录等并排双编辑器
  compact?: boolean;
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
function getContent() {
  const instance = editor.value;
  if (!instance)
    return {
      html: toHtml(props.html, props.text ?? ""),
      text: props.text ?? "",
    };
  return {
    html: DOMPurify.sanitize(instance.getHTML(), SANITIZE),
    text: instance.getText(),
  };
}
defineExpose({ waitForUpload, getContent });
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
    // 表格：Markdown 表格需要可编辑承载，否则读入的表格会在保存时被丢弃
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    BlockStyle,
    Placeholder.configure({
      placeholder: props.placeholder ?? "在这里输入或粘贴内容…",
    }),
  ],
  content: toHtml(props.html, props.text ?? ""),
  editorProps: {
    attributes: {
      class: "rich-document",
      "aria-label": props.label ?? "需求描述内容",
    },
    // 粘贴：本地图片优先接管；纯文本带 Markdown 结构时按 Markdown 解析后插入
    handlePaste: (view, event) => {
      const files = imageFilesFrom(event.clipboardData);
      if (files.length) {
        event.preventDefault();
        void insertImages(files);
        return true;
      }
      // 只按纯文本判断：真正的富文本粘贴，其纯文本里不会出现 ##、- 等 Markdown 标记，
      // 而原始 Markdown 即使同时带 HTML（如网页 pre 区域）也应当被识别
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!looksLikeMarkdown(text)) return false;
      // 代码块与行内代码内保留原文，避免把代码里的 #、* 当成 Markdown 语法
      const { $from } = view.state.selection;
      if (
        $from.parent.type.name === "codeBlock" ||
        $from.marks().some((mark) => mark.type.name === "code")
      )
        return false;
      const instance = editor.value;
      if (!instance) return false;
      event.preventDefault();
      const html = DOMPurify.sanitize(markdownToHtml(text), SANITIZE);
      // 文档内图片按当前文档目录转成可访问地址，保存时再还原相对路径
      const display = props.requirementId
        ? toDisplayHtml(html, props.requirementId, props.nodeId)
        : html;
      instance.chain().focus().insertContent(display).run();
      return true;
    },
    // 拖拽图片：按落点插入，多图一次上传后整体插入
    handleDrop: (view, event, _slice, moved) => {
      if (moved) return false;
      const files = imageFilesFrom(event.dataTransfer);
      if (!files.length) return false;
      event.preventDefault();
      const position = view.posAtCoords({
        left: event.clientX,
        top: event.clientY,
      });
      void insertImages(files, position?.pos);
      return true;
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
// 列表内缩进改变嵌套层级；普通段落/标题则调整块级缩进量
function indentBlock(outdent: boolean) {
  const instance = editor.value;
  if (!instance) return;
  const inList = instance.isActive("taskItem") || instance.isActive("listItem");
  if (inList) {
    const type = instance.isActive("taskItem") ? "taskItem" : "listItem";
    const chain = instance.chain().focus();
    (outdent ? chain.liftListItem(type) : chain.sinkListItem(type)).run();
    return;
  }
  instance
    .chain()
    .focus()
    .indentBlock(outdent ? -1 : 1)
    .run();
}
function currentAlign(): BlockAlign | null {
  const instance = editor.value;
  if (!instance) return null;
  const attrs = instance.isActive("heading")
    ? instance.getAttributes("heading")
    : instance.getAttributes("paragraph");
  return (attrs.textAlign as BlockAlign | null) ?? null;
}
function currentIndent() {
  const instance = editor.value;
  if (!instance) return 0;
  const attrs = instance.isActive("heading")
    ? instance.getAttributes("heading")
    : instance.getAttributes("paragraph");
  return Number(attrs.indent) || 0;
}
function alignBlock(align: BlockAlign) {
  const instance = editor.value;
  if (!instance) return;
  // 再次点击当前对齐方式时恢复默认左对齐（不写入多余样式）
  instance
    .chain()
    .focus()
    .setBlockAlign(currentAlign() === align ? null : align)
    .run();
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
const failedImages = new Set<string>();
function onImageError(event: Event) {
  const target = event.target as HTMLElement | null;
  if (!target || target.tagName !== "IMG") return;
  const image = target as HTMLImageElement;
  image.classList.add("image-broken");
  image.title = "图片加载失败，请检查图片文件是否仍存在";
  if (failedImages.has(image.src)) return;
  failedImages.add(image.src);
  ElMessage.warning("有图片加载失败，请检查图片文件是否仍存在");
}
async function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
// 粘贴、拖拽与文件选择共用：先上传到需求根目录 images/，再以可访问地址插入
async function insertImages(files: File[], at?: number) {
  if (!files.length) return;
  if (!props.requirementId) {
    ElMessage.info("请先保存需求，再插入本地图片");
    return;
  }
  uploading.value = true;
  try {
    const nodes = [];
    for (const file of files) {
      if (!file.type.startsWith("image/"))
        throw new Error("仅支持插入图片文件");
      if (file.size > 5 * 1024 * 1024) throw new Error("图片不能超过 5 MB");
      const data = await readBase64(file);
      // 后端写入需求根目录 images/，返回相对当前文档目录的路径（文档 §12.4）
      const result = await artifactApi.uploadImage(props.requirementId, {
        nodeId: props.nodeId ?? null,
        mime: file.type,
        data,
        fileName: file.name,
      });
      nodes.push({
        type: "image",
        attrs: {
          // 编辑器内用可访问地址预览，保存时再转回相对路径
          src: imageDisplayUrl(
            props.requirementId,
            result.relativePath,
            props.nodeId,
          ),
          alt: file.name,
        },
      });
    }
    const chain = editor.value?.chain().focus();
    if (!chain) return;
    if (at === undefined) chain.insertContent(nodes).run();
    else chain.insertContentAt(at, nodes).run();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    uploading.value = false;
  }
}
function imageFilesFrom(data: DataTransfer | null) {
  return Array.from(data?.files ?? []).filter((file) =>
    file.type.startsWith("image/"),
  );
}
async function upload(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  await insertImages([file]);
  if (input.value) input.value.value = "";
}
onBeforeUnmount(() => editor.value?.destroy());
</script>
<template>
  <div
    class="inline-rich"
    :class="{ 'fill-height': fillHeight, 'fill-card': fillCard, compact }"
    v-if="editor"
    @error.capture="onImageError"
  >
    <div class="rich-toolbar" @mousedown.prevent>
      <div class="toolbar-group">
        <button
          type="button"
          :disabled="!editor.can().undo()"
          aria-label="撤销"
          title="撤销 (Ctrl+Z)"
          @click="editor.chain().focus().undo().run()"
        >
          <UndoOutlined />
        </button>
        <button
          type="button"
          :disabled="!editor.can().redo()"
          aria-label="重做"
          title="重做 (Ctrl+Shift+Z)"
          @click="editor.chain().focus().redo().run()"
        >
          <RedoOutlined />
        </button>
      </div>
      <span class="toolbar-divider"></span>
      <div class="toolbar-group">
        <button
          type="button"
          :class="{ active: editor.isActive('bold') }"
          aria-label="加粗"
          title="加粗 (Ctrl+B)"
          @click="editor.chain().focus().toggleBold().run()"
        >
          <BoldOutlined />
        </button>
        <button
          type="button"
          :class="{ active: editor.isActive('italic') }"
          aria-label="斜体"
          title="斜体 (Ctrl+I)"
          @click="editor.chain().focus().toggleItalic().run()"
        >
          <ItalicOutlined />
        </button>
        <button
          type="button"
          :class="{ active: editor.isActive('underline') }"
          aria-label="下划线"
          title="下划线 (Ctrl+U)"
          @click="editor.chain().focus().toggleUnderline().run()"
        >
          <UnderlineOutlined />
        </button>
        <button
          type="button"
          :class="{ active: editor.isActive('strike') }"
          aria-label="删除线"
          title="删除线"
          @click="editor.chain().focus().toggleStrike().run()"
        >
          <StrikethroughOutlined />
        </button>
        <button
          type="button"
          :class="{ active: editor.isActive('code') }"
          aria-label="行内代码"
          title="行内代码"
          @click="editor.chain().focus().toggleCode().run()"
        >
          代码
        </button>
        <button
          type="button"
          aria-label="清除格式"
          title="清除格式"
          @click="editor.chain().focus().unsetAllMarks().clearNodes().run()"
        >
          清除格式
        </button>
      </div>
      <span class="toolbar-divider toolbar-divider--heading"></span>
      <div class="toolbar-group toolbar-group--heading">
        <button
          type="button"
          :class="{ active: editor.isActive('paragraph') }"
          aria-label="正文"
          title="正文"
          @click="setParagraph"
        >
          正文
        </button>
        <button
          type="button"
          v-for="level in [1, 2, 3] as const"
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
      <div class="toolbar-group toolbar-group--align">
        <button
          type="button"
          :class="{ active: currentAlign() === 'left' }"
          aria-label="左对齐"
          title="左对齐"
          @click="alignBlock('left')"
        >
          <AlignLeftOutlined />
        </button>
        <button
          type="button"
          :class="{ active: currentAlign() === 'center' }"
          aria-label="居中对齐"
          title="居中对齐"
          @click="alignBlock('center')"
        >
          <AlignCenterOutlined />
        </button>
        <button
          type="button"
          :class="{ active: currentAlign() === 'right' }"
          aria-label="右对齐"
          title="右对齐"
          @click="alignBlock('right')"
        >
          <AlignRightOutlined />
        </button>
        <button
          type="button"
          :class="{ active: currentAlign() === 'justify' }"
          aria-label="两端对齐"
          title="两端对齐"
          @click="alignBlock('justify')"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M4 6h16" />
            <path d="M4 10h16" />
            <path d="M4 14h16" />
            <path d="M4 18h16" />
          </svg>
        </button>
      </div>
      <span class="toolbar-divider"></span>
      <div class="toolbar-group">
        <button
          type="button"
          :class="{ active: editor.isActive('bulletList') }"
          aria-label="项目列表"
          title="项目列表"
          @click="editor.chain().focus().toggleBulletList().run()"
        >
          <UnorderedListOutlined />
        </button>
        <button
          type="button"
          :class="{ active: editor.isActive('orderedList') }"
          aria-label="编号列表"
          title="编号列表"
          @click="editor.chain().focus().toggleOrderedList().run()"
        >
          <OrderedListOutlined />
        </button>
        <button
          type="button"
          :class="{ active: editor.isActive('taskList') }"
          aria-label="任务清单"
          title="任务清单"
          @click="toggleListTask"
        >
          <CheckSquareOutlined />
        </button>
        <button
          type="button"
          :disabled="
            !editor.isActive('listItem') &&
            !editor.isActive('taskItem') &&
            currentIndent() <= 0
          "
          aria-label="减少缩进"
          title="减少缩进"
          @click="indentBlock(true)"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M13 6h8" />
            <path d="M13 12h8" />
            <path d="M13 18h8" />
            <path d="m9 8-4 4 4 4" />
          </svg>
        </button>
        <button
          type="button"
          :disabled="
            !editor.isActive('listItem') &&
            !editor.isActive('taskItem') &&
            currentIndent() >= MAX_BLOCK_INDENT
          "
          aria-label="增加缩进"
          title="增加缩进"
          @click="indentBlock(false)"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M13 6h8" />
            <path d="M13 12h8" />
            <path d="M13 18h8" />
            <path d="m7 8 4 4-4 4" />
          </svg>
        </button>
      </div>
      <span class="toolbar-divider"></span>
      <div class="toolbar-group">
        <button
          type="button"
          :class="{ active: editor.isActive('blockquote') }"
          aria-label="引用"
          title="引用"
          @click="editor.chain().focus().toggleBlockquote().run()"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M7 5.5v13" stroke-width="2.6" />
            <path d="M12 7h8" />
            <path d="M12 12h8" />
            <path d="M12 17h6" />
          </svg>
        </button>
        <button
          type="button"
          :class="{ active: editor.isActive('codeBlock') }"
          aria-label="代码块"
          title="代码块"
          @click="editor.chain().focus().toggleCodeBlock().run()"
        >
          <CodeOutlined />
        </button>
        <button
          type="button"
          aria-label="分割线"
          title="分割线"
          @click="editor.chain().focus().setHorizontalRule().run()"
        >
          <MinusOutlined />
        </button>
      </div>
      <span class="toolbar-divider"></span>
      <div class="toolbar-group">
        <button
          type="button"
          :class="{ active: editor.isActive('link') }"
          aria-label="链接"
          title="插入或编辑链接"
          @click="setLink"
        >
          <LinkOutlined />
        </button>
        <button
          type="button"
          :disabled="uploading || !requirementId"
          :title="
            uploading
              ? '图片上传中…'
              : !requirementId
                ? '先保存需求后可插入图片'
                : '插入图片（保存在本地工作区）'
          "
          aria-label="插入图片"
          @click="input?.click()"
        >
          <PictureOutlined />
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
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-surface);
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard);
  /* 容器查询锚点：空间不足时自动隐藏正文/标题组 */
  container-type: inline-size;
}
.inline-rich:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--bg-brand-soft);
}
.inline-rich .rich-toolbar {
  display: flex;
  align-items: center;
  gap: 3px;
  row-gap: 6px;
  flex-wrap: wrap;
  min-height: 42px;
  box-sizing: border-box;
  padding: 6px 10px;
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
  height: 28px;
  border: 0;
  background: transparent;
  padding: 0 7px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.2;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    color var(--duration-fast) var(--ease-standard),
    background-color var(--duration-fast) var(--ease-standard);
}
.inline-rich .rich-toolbar button:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}
.inline-rich .rich-toolbar button svg {
  width: 15px;
  height: 15px;
  display: block;
  flex: none;
}
.inline-rich .rich-toolbar button .anticon {
  display: inline-flex;
  align-items: center;
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
/* 工具栏放不下时隐藏正文/H1/H2/H3，保证其余按钮一行展示 */
@container (max-width: 740px) {
  .inline-rich .toolbar-group--heading,
  .inline-rich .toolbar-divider--heading {
    display: none;
  }
}
.inline-rich :deep(.rich-document) {
  padding: 16px 18px;
  min-height: 240px;
  max-height: 60vh;
  overflow: auto;
  outline: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-body);
}
/* 撑满外层容器模式：工具栏固定，正文区域占满剩余高度并自行滚动。
   EditorContent 会多渲染一层无名包装 div，用 grid 行高分配绕开对它的选择器；
   容器高度完全跟随外层 flex/grid，不再使用视口级 calc，避免双重滚动 */
.inline-rich.fill-height {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  flex: 1 1 auto;
  min-height: 0;
}
.inline-rich.fill-height .rich-toolbar {
  flex: none;
}
.inline-rich.fill-height :deep(.rich-document) {
  height: 100%;
  min-height: 0;
  max-height: none;
}
/* 占满所在卡片高度模式：随卡片高度伸缩，正文区域撑满并自行滚动。
   EditorContent 会多渲染一层无名包装 div，用 grid 行高分配绕开对它的选择器 */
.inline-rich.fill-card {
  display: grid;
  grid-template-rows: auto minmax(200px, 1fr);
  flex: 1 1 auto;
}
/* 紧凑模式：工具条固定单行横向滚动，编辑区高度收敛，适合并排两个编辑器 */
.inline-rich.compact .rich-toolbar {
  flex-wrap: nowrap;
  max-height: none;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 5px 8px;
  scrollbar-width: none;
}
.inline-rich.compact .rich-toolbar::-webkit-scrollbar {
  display: none;
}
/* 窄容器（移动端堆叠 / 平板双栏）工具条改为换行展示，避免按钮被裁切 */
@container (max-width: 600px) {
  .inline-rich.compact .rich-toolbar {
    flex-wrap: wrap;
    overflow: visible;
    row-gap: 4px;
  }
}
.inline-rich.compact :deep(.rich-document) {
  min-height: 168px;
  max-height: 360px;
  padding: 12px 14px;
}
.inline-rich :deep(.rich-document img) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
}
.inline-rich :deep(.rich-document img.image-broken) {
  min-height: 40px;
  padding: 10px;
  outline: 1px dashed var(--tone-red-bd);
  outline-offset: 2px;
  background: var(--tone-red-bg);
  color: var(--tone-red-fg);
  font-size: 12px;
}
.inline-rich.fill-card :deep(.rich-document) {
  height: 100%;
  min-height: 0;
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
/* 表格（Markdown 表格的编辑承载）：边框与表头样式对齐正文排版 */
.inline-rich :deep(.rich-document table) {
  width: 100%;
  margin: 0 0 10px;
  border-collapse: collapse;
  table-layout: auto;
}
.inline-rich :deep(.rich-document th),
.inline-rich :deep(.rich-document td) {
  min-width: 60px;
  padding: 6px 10px;
  border: 1px solid var(--border-base);
  vertical-align: top;
  text-align: left;
}
.inline-rich :deep(.rich-document th) {
  background: var(--bg-subtle);
  font-weight: 600;
}
.inline-rich :deep(.rich-document th p),
.inline-rich :deep(.rich-document td p) {
  margin: 0;
}
.inline-rich :deep(.rich-document .selectedCell::after) {
  content: "";
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--brand) 12%, transparent);
  pointer-events: none;
}
.inline-rich :deep(.rich-document .column-resize-handle) {
  display: none;
}
/* 块级缩进：Markdown 没有缩进语法，段落/标题以 data-indent 记录层级 */
.inline-rich :deep(.rich-document [data-indent="1"]) {
  margin-left: 1.5em;
}
.inline-rich :deep(.rich-document [data-indent="2"]) {
  margin-left: 3em;
}
.inline-rich :deep(.rich-document [data-indent="3"]) {
  margin-left: 4.5em;
}
.inline-rich :deep(.rich-document [data-indent="4"]) {
  margin-left: 6em;
}
.inline-rich :deep(.rich-document [data-indent="5"]) {
  margin-left: 7.5em;
}
.inline-rich :deep(.rich-document [data-indent="6"]) {
  margin-left: 9em;
}
.inline-rich :deep(.rich-document ul[data-type="taskList"]) {
  list-style: none;
  padding-left: 2px;
}
/* 复选框独占一列，正文占另一列：文字紧跟复选框并从同一列换行 */
.inline-rich :deep(.rich-document ul[data-type="taskList"] li) {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  column-gap: 8px;
}
.inline-rich :deep(.rich-document ul[data-type="taskList"] li > label) {
  display: flex;
  align-items: center;
  padding-top: 5px;
}
.inline-rich :deep(.rich-document ul[data-type="taskList"] li > div) {
  min-width: 0;
}
.inline-rich :deep(.rich-document ul[data-type="taskList"] input) {
  margin: 0;
  accent-color: var(--brand);
}
.inline-rich :deep(.rich-document p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  color: var(--text-faint);
  float: left;
  height: 0;
  pointer-events: none;
}
</style>
