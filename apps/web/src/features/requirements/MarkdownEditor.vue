<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { basicSetup } from "codemirror";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab, redo, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { ElMessage } from "element-plus";
import { requirementApi } from "../../api/requirements";
import { errorMessage } from "../../api/client";

const props = defineProps<{
  modelValue: string;
  requirementId?: number;
  label?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [content: string] }>();
const sourceHost = ref<HTMLDivElement>();
const imageInput = ref<HTMLInputElement>();
const uploading = ref(false);
const mode = ref<"source" | "split" | "preview">("split");
const modes = [
  { value: "source", label: "源码", title: "仅源码" },
  { value: "split", label: "分栏", title: "源码与预览" },
  { value: "preview", label: "预览", title: "仅预览" },
] as const;
const previewHtml = computed(() =>
  DOMPurify.sanitize(String(marked.parse(props.modelValue, { async: false, gfm: true }))),
);
let editor: EditorView | undefined;
let syncing = false;

function surround(before: string, after: string, placeholder: string) {
  if (!editor) return false;
  const { from, to } = editor.state.selection.main;
  const selected = editor.state.sliceDoc(from, to) || placeholder;
  editor.dispatch({
    changes: { from, to, insert: `${before}${selected}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  editor.focus();
  return true;
}
function prefixLines(prefix: string) {
  if (!editor) return;
  const selection = editor.state.selection.main;
  const from = editor.state.doc.lineAt(selection.from).from;
  const to = editor.state.doc.lineAt(selection.to).to;
  const content = editor.state.sliceDoc(from, to).replace(/^/gm, prefix);
  editor.dispatch({ changes: { from, to, insert: content }, scrollIntoView: true, userEvent: "input" });
  editor.focus();
}
function undoChange() {
  if (editor) { undo(editor); editor.focus(); }
}
function redoChange() {
  if (editor) { redo(editor); editor.focus(); }
}
onMounted(() => {
  if (!sourceHost.value) return;
  editor = new EditorView({
    parent: sourceHost.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        keymap.of([
          { key: "Mod-b", run: () => surround("**", "**", "粗体文字") },
          { key: "Mod-i", run: () => surround("*", "*", "斜体文字") },
          { key: "Mod-k", run: () => surround("[", "](https://example.com)", "链接文字") },
          indentWithTab,
        ]),
        basicSetup,
        markdown(),
        EditorState.tabSize.of(2),
        EditorState.lineSeparator.of(props.modelValue.includes("\r\n") ? "\r\n" : "\n"),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": props.label ?? "Markdown 源码", spellcheck: "false" }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px", color: "#34445d" },
          "&.cm-focused": { outline: "none" },
          ".cm-scroller": { fontFamily: "Consolas, 'SFMono-Regular', 'Microsoft YaHei', monospace", lineHeight: "1.8", overflow: "auto" },
          ".cm-content": { padding: "12px 0", minHeight: "360px" },
          ".cm-line": { padding: "0 12px" },
          ".cm-gutters": { backgroundColor: "#f8fafc", color: "#9aa8bd", borderRight: "1px solid #edf0f5" },
          ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#f0f4ff" },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncing) emit("update:modelValue", update.state.sliceDoc());
        }),
      ],
    }),
  });
});
watch(() => props.modelValue, (content) => {
  if (!editor || editor.state.sliceDoc() === content) return;
  syncing = true;
  try {
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: content },
      annotations: Transaction.addToHistory.of(false),
    });
  } finally { syncing = false; }
});
watch(mode, async () => { await nextTick(); editor?.requestMeasure(); });
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
async function uploadImage(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  const requirementId = props.requirementId;
  if (!file || !requirementId || !editor) return;
  uploading.value = true;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error("图片不能超过 5 MB");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const result = await requirementApi.uploadImage(requirementId, data, file.type);
    if (!editor) return;
    const alt = file.name.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
    const selection = editor.state.selection.main;
    const inserted = `![${alt}](${result.url})`;
    editor.dispatch({
      changes: { from: selection.from, to: selection.to, insert: inserted },
      selection: { anchor: selection.from + inserted.length },
      scrollIntoView: true,
      userEvent: "input",
    });
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    uploading.value = false;
    target.value = "";
  }
}
function previewClick(event: MouseEvent) {
  const link = (event.target as Element).closest("a");
  if (!link) return;
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
}
onBeforeUnmount(() => { editor?.destroy(); editor = undefined; });
</script>

<template>
  <div class="markdown-editor">
    <div class="markdown-toolbar">
      <div class="format-actions" role="group" aria-label="Markdown 格式">
        <button type="button" aria-label="撤销" title="撤销 Ctrl+Z" @click="undoChange">↶</button>
        <button type="button" aria-label="重做" title="重做 Ctrl+Y" @click="redoChange">↷</button>
        <span class="toolbar-divider"></span>
        <button type="button" aria-label="加粗" title="加粗 Ctrl+B" @click="surround('**', '**', '粗体文字')"><b>B</b></button>
        <button type="button" aria-label="斜体" title="斜体 Ctrl+I" @click="surround('*', '*', '斜体文字')"><i>I</i></button>
        <button type="button" @click="prefixLines('## ')">标题</button>
        <button type="button" @click="prefixLines('- ')">列表</button>
        <button type="button" @click="prefixLines('- [ ] ')">待办</button>
        <button type="button" @click="prefixLines('> ')">引用</button>
        <button type="button" @click="surround('\n```text\n', '\n```\n', '代码内容')">代码块</button>
        <button type="button" @click="surround('[', '](https://example.com)', '链接文字')">链接</button>
        <button type="button" :disabled="uploading || !requirementId" @click="imageInput?.click()">{{ uploading ? "上传中…" : "插入图片" }}</button>
        <input ref="imageInput" hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" @change="uploadImage" />
      </div>
      <div class="view-actions" role="group" aria-label="编辑器视图">
        <button v-for="option in modes" :key="option.value" type="button" :aria-label="option.title" :aria-pressed="mode === option.value" :class="{ active: mode === option.value }" @click="mode = option.value">{{ option.label }}</button>
      </div>
    </div>
    <div class="markdown-panes" :class="{ split: mode === 'split' }">
      <section v-show="mode !== 'preview'" class="source-pane">
        <div class="pane-label">MARKDOWN <span>源码</span></div>
        <div ref="sourceHost" class="source-host"></div>
      </section>
      <section v-show="mode !== 'source'" class="preview-pane">
        <div class="pane-label">PREVIEW <span>预览</span></div>
        <div class="markdown-preview" aria-label="Markdown 预览" @click="previewClick" v-html="previewHtml"></div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.markdown-editor { border: 1px solid #dfe5ee; border-radius: 8px; overflow: hidden; background: #fff; }
.markdown-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 7px 8px; background: #f7f9fc; border-bottom: 1px solid #e5eaf1; }
.format-actions, .view-actions { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.markdown-toolbar button { border: 0; background: transparent; padding: 5px 7px; border-radius: 4px; font-size: 12px; color: #536079; cursor: pointer; }
.markdown-toolbar button:hover, .markdown-toolbar button.active { background: #e8edff; color: #4e6ef2; }
.markdown-toolbar button:focus-visible { outline: 2px solid #4e6ef2; outline-offset: 1px; }
.markdown-toolbar button:disabled { opacity: 0.4; cursor: not-allowed; }
.toolbar-divider { height: 16px; width: 1px; background: #dfe5ee; margin: 0 3px; }
.view-actions { border: 1px solid #dfe5ee; border-radius: 5px; padding: 2px; }
.markdown-panes { display: grid; grid-template-columns: minmax(0, 1fr); }
.markdown-panes.split { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.source-pane, .preview-pane { min-width: 0; }
.split .preview-pane { border-left: 1px solid #e5eaf1; }
.pane-label { display: flex; justify-content: space-between; padding: 8px 12px; font-size: 10px; letter-spacing: 0.8px; color: #8b98ad; border-bottom: 1px solid #eef1f6; }
.pane-label span { letter-spacing: 0; }
.source-host { height: clamp(360px, 55vh, 680px); }
.markdown-preview { height: clamp(360px, 55vh, 680px); box-sizing: border-box; overflow: auto; padding: 12px 16px; font-size: 13px; line-height: 1.8; color: #34445d; overflow-wrap: anywhere; }
.markdown-preview :deep(> :first-child) { margin-top: 0; }
.markdown-preview :deep(h1) { font-size: 23px; line-height: 1.4; }
.markdown-preview :deep(h2) { font-size: 19px; border-bottom: 1px solid #e7ebf1; padding-bottom: 6px; }
.markdown-preview :deep(h3) { font-size: 16px; }
.markdown-preview :deep(p) { margin: 0 0 12px; }
.markdown-preview :deep(pre) { padding: 12px; border-radius: 5px; background: #f4f6fa; overflow: auto; }
.markdown-preview :deep(code) { font-family: Consolas, monospace; font-size: 12px; background: #f4f6fa; border-radius: 3px; }
.markdown-preview :deep(blockquote) { margin: 12px 0; padding-left: 12px; border-left: 3px solid #c6d2f8; color: #728199; }
.markdown-preview :deep(table) { border-collapse: collapse; display: block; max-width: 100%; overflow: auto; margin: 12px 0; }
.markdown-preview :deep(th), .markdown-preview :deep(td) { border: 1px solid #dfe5ee; padding: 6px 10px; }
.markdown-preview :deep(th) { background: #f4f6fa; }
.markdown-preview :deep(img) { max-width: 100%; height: auto; }
.markdown-preview :deep(a) { color: #4e6ef2; }
.markdown-preview :deep(input[type="checkbox"]) { margin-right: 5px; }
@media (max-width: 680px) {
  .markdown-panes.split { grid-template-columns: minmax(0, 1fr); }
  .split .preview-pane { border-left: 0; border-top: 1px solid #e5eaf1; }
}
</style>
