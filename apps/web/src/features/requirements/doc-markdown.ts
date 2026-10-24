// 文档正文的 Markdown 序列化（V1.1 §12 存储约定）：磁盘上存原生 Markdown，
// 编辑器内保持所见即所得，读写时在 Markdown 与编辑器 HTML 之间双向转换。
// 转换只做「可读的等价表示」，不追求逐字节还原：列表、任务列表、表格、代码块、
// 引用、删除线与图片相对路径均保持语义，其余样式差异在保存时收敛为 Markdown。
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { Marked, Renderer, type Token } from "marked";

/** 是否为旧版以 HTML 保存的正文（首次编辑后会被改写为 Markdown） */
const HTML_SOURCE_PATTERN =
  /^\s*<(?:!doctype|h[1-6]|p|ul|ol|li|div|table|pre|blockquote|img)\b/i;

export function isLegacyHtmlContent(content: string): boolean {
  return HTML_SOURCE_PATTERN.test(content.trim());
}

// ===== Markdown → 编辑器 HTML =====
// Tiptap 的任务列表使用 <ul data-type="taskList"><li data-type="taskItem" data-checked>，
// 与 GFM 的 <li><input type="checkbox"> 结构不同，因此重写列表渲染以直接产出 Tiptap 结构。
// 行内 token 的类型联合里并非每个成员都带 tokens（如 codespan/escape），取用前收敛为数组。
function inlineTokens(token: Token): Token[] {
  const tokens = (token as { tokens?: Token[] }).tokens;
  return tokens && tokens.length ? tokens : [token];
}
function createMarkdownParser() {
  const parser = new Marked({ gfm: true, async: false });
  parser.use({
    renderer: {
      list(token) {
        const tag = token.ordered ? "ol" : "ul";
        const task = token.items.some((item) => item.task);
        const attrs = task ? ' data-type="taskList"' : "";
        const start =
          token.ordered && token.start !== "" && token.start !== 1
            ? ` start="${token.start}"`
            : "";
        let body = "";
        for (const item of token.items) body += this.listitem(item);
        return `<${tag}${attrs}${start}>${body}</${tag}>`;
      },
      listitem(token) {
        if (!token.task) return Renderer.prototype.listitem.call(this, token);
        // 任务项：勾选状态由 data-checked 表达，正文与嵌套列表都放进 div 内
        const nested: string[] = [];
        let head = "";
        for (const child of token.tokens ?? []) {
          if (child.type === "checkbox") continue;
          if (child.type === "list" || head) {
            nested.push(this.parser.parse([child]));
            continue;
          }
          head = this.parser.parseInline(inlineTokens(child));
        }
        const checked = token.checked ? "true" : "false";
        const box = token.checked ? " checked" : "";
        return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${box}><span></span></label><div><p>${head}</p>${nested.join("")}</div></li>`;
      },
    },
  });
  return parser;
}

const markdownParser = createMarkdownParser();

/** Markdown 正文 → 编辑器 HTML（未做图片地址转换，调用方按文档目录再处理） */
export function markdownToHtml(markdown: string): string {
  if (!markdown.trim()) return "";
  return String(markdownParser.parse(markdown));
}

/**
 * 纯文本是否带有明确的 Markdown 结构（用于粘贴时决定是否按 Markdown 解析）。
 * 只认块级标记与成对行内语法，避免把 C#、文件名里的下划线等普通文本误判为 Markdown。
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text.trim()) return false;
  const patterns = [
    /^\s{0,3}#{1,6}\s+\S/m,
    /^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/m,
    /^\s{0,3}>\s?\S/m,
    /^\s{0,3}(?:```|~~~)/m,
    /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m,
    /^\s*\|.+\|\s*$/m,
    /!?\[[^\]\n]+\]\([^)\s]*[:/.#][^)\s]*\)/,
    /\*\*[^*\n]+\*\*/,
    /(?<!\w)__[^_\n]+__(?!\w)/,
    /`[^`\n]+`/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * 磁盘正文 → 编辑器 HTML：旧版以 HTML 保存的正文原样沿用，其余按 Markdown 解析。
 * 旧内容在首次编辑保存后即改写为 Markdown，不做批量迁移。
 */
export function documentToEditorHtml(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (isLegacyHtmlContent(trimmed)) return trimmed;
  return markdownToHtml(content);
}

// ===== 编辑器 HTML → Markdown =====
// 单元格文本里的换行与竖线会破坏表格语法，统一收敛为空格与转义竖线
function cellText(content: string) {
  return content
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function isCell(node: Node) {
  return node.nodeName === "TH" || node.nodeName === "TD";
}

// 首行（或 thead 行）全部为 th 时作为表头；Tiptap 会在表格最前面插入 colgroup，
// 因此不能沿用 turndown-plugin-gfm 的「首个 tbody 且前无兄弟」判断。
function isHeaderRow(row: Element) {
  const parent = row.parentNode;
  if (!parent) return false;
  if (parent.nodeName === "THEAD") return true;
  const cells = Array.from(row.childNodes).filter(isCell);
  if (!cells.length) return false;
  if (!cells.every((cell) => cell.nodeName === "TH")) return false;
  const rows = Array.from(parent.childNodes).filter(
    (node) => node.nodeName === "TR",
  );
  return rows[0] === row;
}
// 列表项正文：内容内的空行会让列表变松散甚至截断列表，统一收敛为单换行，
// 续行按缩进对齐，保证嵌套层级可被 Markdown 解析还原
function listItem(content: string, prefix: string, indentSize: number) {
  const body = content.replace(/^\n+/, "").replace(/\n+$/, "");
  if (!body) return `${prefix.trimEnd()}\n`;
  const indent = " ".repeat(indentSize);
  const text = body
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((line, index) => (index === 0 ? line : line ? `${indent}${line}` : ""))
    .join("\n");
  return `${prefix}${text}\n`;
}

function createMarkdownWriter() {
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  service.use(gfm);
  // 列表项：保留起始序号与嵌套缩进（gfm 默认会把条目写成四空格缩进的松散列表）
  service.addRule("listItem", {
    filter: "li",
    replacement: (content, node, options) => {
      const parent = node.parentNode as Element | null;
      const ordered = parent?.nodeName === "OL";
      const start = parent?.getAttribute("start") ?? null;
      const index = parent
        ? Array.prototype.indexOf.call(parent.children, node)
        : 0;
      const prefix = ordered
        ? `${start ? Number(start) + index : index + 1}. `
        : `${options.bulletListMarker} `;
      return listItem(content, prefix, ordered ? prefix.length : 2);
    },
  });
  // 任务列表：Tiptap 把 checkbox 放在 label 内，gfm 的 checkbox 规则匹配不到
  service.addRule("taskItem", {
    filter: (node) =>
      node.nodeName === "LI" && node.getAttribute?.("data-type") === "taskItem",
    replacement: (content, node) =>
      listItem(
        content,
        `- [${node.getAttribute("data-checked") === "true" ? "x" : " "}] `,
        2,
      ),
  });
  // 表格：Tiptap 输出带 colgroup，需自行判定表头并补分隔行
  service.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content) => ` ${cellText(content)} |`,
  });
  service.addRule("tableRow", {
    filter: "tr",
    replacement: (content, node) => {
      const row = `|${content}\n`;
      if (!isHeaderRow(node as Element)) return row;
      const columns = Array.from(node.childNodes).filter(isCell).length;
      const border = Array.from<string>({ length: columns })
        .fill("---")
        .join(" | ");
      return `${row}| ${border} |\n`;
    },
  });
  service.addRule("tableSection", {
    filter: ["thead", "tbody", "tfoot"],
    replacement: (content) => content,
  });
  service.addRule("table", {
    filter: "table",
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });
  // 删除线统一写成 ~~，marked 只识别双波浪线；下划线没有 Markdown 语法，保留行内 HTML
  service.addRule("strikethrough", {
    filter: ["del", "s"],
    replacement: (content) => `~~${content}~~`,
  });
  service.keep(["u"]);
  return service;
}

const markdownWriter = createMarkdownWriter();

/** 编辑器 HTML → Markdown 正文（图片地址需先还原为相对文档目录的路径） */
export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return "";
  const markdown = markdownWriter.turndown(html).trim();
  // 空正文（如仅一个空段落）落盘为空文件，不留只有换行的内容
  return markdown ? `${markdown}\n` : "";
}
