import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

// Markdown 没有对齐与块级缩进的语法，编辑器以行内 HTML 属性承载：
// 对齐写 style="text-align: …"，缩进写 data-indent，保存时由 doc-markdown 原样保留。
export type BlockAlign = "left" | "center" | "right" | "justify";

const ALIGNS: readonly string[] = ["left", "center", "right", "justify"];
export const MAX_BLOCK_INDENT = 6;
const BLOCK_TYPES = new Set(["paragraph", "heading"]);

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockStyle: {
      setBlockAlign: (align: BlockAlign | null) => ReturnType;
      indentBlock: (delta: 1 | -1) => ReturnType;
    };
  }
}

function parseAlign(element: HTMLElement): BlockAlign | null {
  const value = (element.style.textAlign || "").trim().toLowerCase();
  return ALIGNS.includes(value) ? (value as BlockAlign) : null;
}

function parseIndent(element: HTMLElement): number {
  const value = Number(element.getAttribute("data-indent"));
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_BLOCK_INDENT, Math.max(0, Math.trunc(value)));
}

function indentable(node: ProseMirrorNode) {
  return BLOCK_TYPES.has(node.type.name);
}

// 光标所在块或选区覆盖的块（段落、标题）；列表缩进仍由 sink/liftListItem 处理
function selectedBlocks(state: EditorState) {
  const { from, to, $from } = state.selection;
  const blocks: Array<{ pos: number; node: ProseMirrorNode }> = [];
  if (from === to) {
    if (indentable($from.parent))
      blocks.push({ pos: $from.before($from.depth), node: $from.parent });
    return blocks;
  }
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!indentable(node)) return;
    blocks.push({ pos, node });
    return false;
  });
  return blocks;
}

export const BlockStyle = Extension.create({
  name: "blockStyle",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (element) => parseAlign(element),
            renderHTML: (attributes) =>
              attributes.textAlign
                ? { style: `text-align: ${attributes.textAlign}` }
                : {},
          },
          indent: {
            default: 0,
            parseHTML: (element) => parseIndent(element),
            renderHTML: (attributes) =>
              attributes.indent
                ? { "data-indent": String(attributes.indent) }
                : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setBlockAlign:
        (align) =>
        ({ state, tr, dispatch }) => {
          const blocks = selectedBlocks(state);
          if (!blocks.length) return false;
          if (dispatch) {
            for (const { pos, node } of blocks)
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                textAlign: align,
              });
            dispatch(tr);
          }
          return true;
        },
      indentBlock:
        (delta) =>
        ({ state, tr, dispatch }) => {
          const blocks = selectedBlocks(state);
          if (!blocks.length) return false;
          let changed = false;
          for (const { pos, node } of blocks) {
            const current = Number(node.attrs.indent) || 0;
            const next = Math.min(
              MAX_BLOCK_INDENT,
              Math.max(0, current + delta),
            );
            if (next === current) continue;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
            changed = true;
          }
          if (!changed) return false;
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});
