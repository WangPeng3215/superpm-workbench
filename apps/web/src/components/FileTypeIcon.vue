<script setup lang="ts">
import { computed, type Component } from "vue";
import {
  AudioFilled,
  CodeFilled,
  FileExcelFilled,
  FileImageFilled,
  FileMarkdownFilled,
  FilePdfFilled,
  FilePptFilled,
  FileTextFilled,
  FileUnknownFilled,
  FileWordFilled,
  FileZipFilled,
  FolderFilled,
  LinkOutlined,
  VideoCameraFilled,
} from "@ant-design/icons-vue";

type FileKind =
  | "folder"
  | "link"
  | "word"
  | "sheet"
  | "slide"
  | "pdf"
  | "image"
  | "markdown"
  | "code"
  | "archive"
  | "audio"
  | "video"
  | "text"
  | "unknown";

const props = withDefaults(
  defineProps<{
    nodeType?: "file" | "folder" | "link";
    name?: string;
  }>(),
  { nodeType: "file", name: "" },
);

const iconByKind: Record<FileKind, Component> = {
  folder: FolderFilled,
  link: LinkOutlined,
  word: FileWordFilled,
  sheet: FileExcelFilled,
  slide: FilePptFilled,
  pdf: FilePdfFilled,
  image: FileImageFilled,
  markdown: FileMarkdownFilled,
  code: CodeFilled,
  archive: FileZipFilled,
  audio: AudioFilled,
  video: VideoCameraFilled,
  text: FileTextFilled,
  unknown: FileUnknownFilled,
};

const kindsByExtension: Record<string, FileKind> = {
  doc: "word",
  docx: "word",
  odt: "word",
  rtf: "word",
  xls: "sheet",
  xlsx: "sheet",
  csv: "sheet",
  ods: "sheet",
  ppt: "slide",
  pptx: "slide",
  odp: "slide",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  tif: "image",
  tiff: "image",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  js: "code",
  mjs: "code",
  cjs: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  vue: "code",
  css: "code",
  scss: "code",
  less: "code",
  html: "code",
  htm: "code",
  json: "code",
  xml: "code",
  yaml: "code",
  yml: "code",
  toml: "code",
  py: "code",
  java: "code",
  go: "code",
  rs: "code",
  c: "code",
  h: "code",
  cpp: "code",
  cs: "code",
  php: "code",
  rb: "code",
  swift: "code",
  kt: "code",
  sql: "code",
  sh: "code",
  ps1: "code",
  bat: "code",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  bz2: "archive",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  aac: "audio",
  ogg: "audio",
  m4a: "audio",
  mp4: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  webm: "video",
  wmv: "video",
  txt: "text",
  log: "text",
  ini: "text",
  conf: "text",
};

const kind = computed<FileKind>(() => {
  if (props.nodeType === "folder") return "folder";
  if (props.nodeType === "link") return "link";
  const name = props.name.trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "unknown";
  return kindsByExtension[name.slice(dot + 1)] ?? "unknown";
});

const icon = computed(() => iconByKind[kind.value]);
</script>

<template>
  <span class="file-type-icon" :data-kind="kind" aria-hidden="true">
    <component :is="icon" />
  </span>
</template>

<style scoped>
.file-type-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  line-height: 1;
  color: var(--text-muted);
}
.file-type-icon[data-kind="folder"] {
  color: var(--brand);
}
.file-type-icon[data-kind="link"] {
  color: var(--success-text);
}
.file-type-icon[data-kind="word"] {
  color: var(--tone-blue-fg);
}
.file-type-icon[data-kind="sheet"] {
  color: var(--tone-green-fg);
}
.file-type-icon[data-kind="slide"] {
  color: var(--tone-amber-fg);
}
.file-type-icon[data-kind="pdf"] {
  color: var(--tone-red-fg);
}
.file-type-icon[data-kind="image"] {
  color: var(--tone-purple-fg);
}
.file-type-icon[data-kind="markdown"] {
  color: var(--tone-teal-fg);
}
.file-type-icon[data-kind="code"] {
  color: var(--brand);
}
.file-type-icon[data-kind="archive"] {
  color: var(--tone-amber-fg);
}
.file-type-icon[data-kind="audio"],
.file-type-icon[data-kind="video"] {
  color: var(--tone-purple-fg);
}
.file-type-icon[data-kind="text"] {
  color: var(--text-muted);
}
.file-type-icon[data-kind="unknown"] {
  color: var(--text-faint);
}
</style>
