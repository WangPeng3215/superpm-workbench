import { describe, expect, it } from "vitest";
import {
  documentToEditorHtml,
  htmlToMarkdown,
  isLegacyHtmlContent,
  looksLikeMarkdown,
  markdownToHtml,
} from "../src/features/requirements/doc-markdown";

// 文档正文存储约定（V1.1 §12）：磁盘存原生 Markdown，编辑器内为所见即所得 HTML。
// 这里固定「Markdown → HTML → Markdown」的稳定性，避免保存时悄悄丢结构。
function roundtrip(markdown: string) {
  return htmlToMarkdown(markdownToHtml(markdown));
}

describe("document markdown serialization", () => {
  const stableSamples = [
    "# 标题\n\n正文 **粗体** *斜体* `行内` [链接](https://example.com)\n",
    "- 项目一\n- 项目二\n",
    "1. 第一\n2. 第二\n",
    "> 引用文本\n",
    "```ts\nconst a = 1;\n```\n",
    "---\n",
    "![流程图](../images/a.png)\n",
    "- 一级\n  - 二级\n    - 三级\n",
    "~~删除~~ 普通\n",
    "## 小节\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    "- [x] 主任务\n  - 子任务\n",
  ];

  for (const markdown of stableSamples) {
    it(`keeps ${JSON.stringify(markdown.trim().slice(0, 18))} stable`, () => {
      expect(roundtrip(markdown)).toBe(markdown);
    });
  }

  it("renders task lists with the editor's taskItem structure", () => {
    const html = markdownToHtml("- [x] 已完成\n- [ ] 未完成\n");
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('data-checked="false"');
    // 勾选框放在 label 内，Tiptap 才能把它识别为任务项而不是普通列表
    expect(html).toContain("<label><input");
  });

  it("writes task list state back to markdown", () => {
    const html =
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>已完成</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>未完成</p></div></li></ul>';
    expect(htmlToMarkdown(html)).toBe("- [x] 已完成\n- [ ] 未完成\n");
  });

  it("converts tables rendered with a colgroup and header row", () => {
    const html =
      '<table style="min-width: 75px"><colgroup><col style="min-width: 25px"><col style="min-width: 25px"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>字段</p></th><th colspan="1" rowspan="1"><p>类型</p></th></tr><tr><td colspan="1" rowspan="1"><p>id</p></td><td colspan="1" rowspan="1"><p>number</p></td></tr></tbody></table>';
    expect(htmlToMarkdown(html)).toBe(
      "| 字段 | 类型 |\n| --- | --- |\n| id | number |\n",
    );
  });

  it("keeps pipes inside cells escaped so the table survives", () => {
    const markdown = "| a | b |\n| --- | --- |\n| x \\| y | z |\n";
    expect(roundtrip(markdown)).toBe(markdown);
  });

  it("preserves ordered list start numbers", () => {
    expect(htmlToMarkdown(markdownToHtml("3. 丙\n4. 丁\n"))).toBe(
      "3. 丙\n4. 丁\n",
    );
  });

  it("collapses loose lists into tight lists", () => {
    // 松散列表在编辑器内没有对应结构，保存时收敛为紧凑列表（内容不丢）
    expect(roundtrip("- 项目一\n\n- 项目二\n")).toBe("- 项目一\n- 项目二\n");
  });

  it("writes an empty document as an empty file", () => {
    expect(htmlToMarkdown("<p></p>")).toBe("");
    expect(htmlToMarkdown("")).toBe("");
  });

  it("keeps relative image paths untouched", () => {
    expect(
      htmlToMarkdown('<p><img src="../images/a.png" alt="流程图"></p>'),
    ).toBe("![流程图](../images/a.png)\n");
  });

  it("treats legacy html documents as html and new documents as markdown", () => {
    expect(isLegacyHtmlContent("<h1>旧正文</h1><p>内容</p>")).toBe(true);
    expect(isLegacyHtmlContent("# 新正文\n\n内容\n")).toBe(false);
    expect(documentToEditorHtml("<h1>旧正文</h1>")).toBe("<h1>旧正文</h1>");
    expect(documentToEditorHtml("# 新正文\n")).toContain("<h1>新正文</h1>");
    expect(documentToEditorHtml("   ")).toBe("");
  });

  it("keeps aligned and indented blocks as inline html", () => {
    const centered = '<p style="text-align: center">居中段落</p>';
    const aligned = htmlToMarkdown(centered);
    expect(aligned).toContain('style="text-align: center"');
    expect(roundtrip(aligned)).toBe(aligned);

    const indented = '<p data-indent="2">缩进段落</p>';
    const indentMarkdown = htmlToMarkdown(indented);
    expect(indentMarkdown).toContain('data-indent="2"');
    expect(roundtrip(indentMarkdown)).toBe(indentMarkdown);

    const both =
      '<h2 style="text-align: right" data-indent="1">右对齐标题</h2>';
    const bothMarkdown = htmlToMarkdown(both);
    expect(bothMarkdown).toContain('style="text-align: right"');
    expect(bothMarkdown).toContain('data-indent="1"');
    expect(roundtrip(bothMarkdown)).toBe(bothMarkdown);
  });

  it("keeps styles inside list items", () => {
    const markdown = htmlToMarkdown(
      '<ul><li><p style="text-align: center">列表项</p></li></ul>',
    );
    expect(markdown).toBe('- <span data-block="center">列表项</span>\n');
    expect(roundtrip(markdown)).toBe(markdown);

    const indented = htmlToMarkdown(
      '<ul><li><p data-indent="2">缩进列表项</p></li></ul>',
    );
    expect(indented).toBe('- <span data-block="i2">缩进列表项</span>\n');
    expect(roundtrip(indented)).toBe(indented);
  });

  it("keeps styles inside task list items", () => {
    const markdown = htmlToMarkdown(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">' +
        '<label><input type="checkbox" checked><span></span></label>' +
        '<div><p style="text-align: right" data-indent="1">已完成</p></div></li></ul>',
    );
    expect(markdown).toBe('- [x] <span data-block="right:i1">已完成</span>\n');
    const html = markdownToHtml(markdown);
    expect(html).toContain('data-type="taskItem"');
    expect(html).toContain('style="text-align: right"');
    expect(html).toContain('data-indent="1"');
    expect(html).not.toContain("data-block");
    expect(html.match(/<p/g)?.length).toBe(1);
    expect(roundtrip(markdown)).toBe(markdown);
  });

  it("keeps list nesting and siblings alongside a styled item", () => {
    const markdown =
      '- <span data-block="center">父项</span>\n  - 子项\n- 另一项\n';
    const html = markdownToHtml(markdown);
    expect(html).toContain('<li><p style="text-align: center">父项</p>');
    expect(html.indexOf("父项")).toBeLessThan(html.indexOf("子项"));
    expect(roundtrip(markdown)).toBe(markdown);
  });

  it("does not mistake styled blocks at the start for legacy html", () => {
    expect(
      isLegacyHtmlContent('<p style="text-align: center">居中</p>\n\n- 列表\n'),
    ).toBe(false);
    expect(
      isLegacyHtmlContent('<p style="text-align: center">居中</p>\n\n正文\n'),
    ).toBe(false);
    expect(
      isLegacyHtmlContent('<h2 data-indent="1">标题</h2>\n\n**重点**\n'),
    ).toBe(false);
  });
});

describe("markdown paste detection", () => {
  it("detects documents with explicit markdown structure", () => {
    expect(looksLikeMarkdown("# 标题1\n## 标题2")).toBe(true);
    expect(looksLikeMarkdown("- 项目一\n- 项目二")).toBe(true);
    expect(looksLikeMarkdown("1. 第一步\n2. 第二步")).toBe(true);
    expect(looksLikeMarkdown("> 引用文本")).toBe(true);
    expect(looksLikeMarkdown("```ts\nconst a = 1;\n```")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
    expect(looksLikeMarkdown("说明见 [文档](https://example.com)。")).toBe(
      true,
    );
    expect(looksLikeMarkdown("这是 **重点** 内容")).toBe(true);
    expect(looksLikeMarkdown("图片 ![图](../images/a.png)")).toBe(true);
  });

  it("leaves ordinary prose and technical names alone", () => {
    expect(looksLikeMarkdown("这是一段普通的中文说明，没有格式。")).toBe(false);
    expect(looksLikeMarkdown("使用 C# 编写服务，编号为 A#1。")).toBe(false);
    expect(looksLikeMarkdown("配置项 snake_case_name 保持原样。")).toBe(false);
    expect(looksLikeMarkdown("my__file__name.ts")).toBe(false);
    expect(looksLikeMarkdown("数组[0](索引)的写法。")).toBe(false);
    expect(looksLikeMarkdown("   ")).toBe(false);
  });
});
