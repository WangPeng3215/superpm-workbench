/**
 * 外部粘贴去色。
 *
 * 从网页、Word 或其它应用复制的文本常自带 `color` / `background-color`，
 * 粘进来后颜色被写死在正文里，切换深色/浅色主题时文字不再跟随主题。
 * 这里只剥离颜色相关的样式与属性，保留加粗、列表、表格、对齐等结构。
 *
 * 编辑器内部复制不处理：ProseMirror 序列化剪贴板内容时会在根元素写入
 * `data-pm-slice`，据此区分来源，避免复制自己设置过颜色的段落时丢色。
 */
const COLOR_STYLE_PROPERTIES = [
  "color",
  "background",
  "background-color",
  "background-image",
];

export function stripPastedColors(html: string): string {
  if (!html || html.includes("data-pm-slice")) return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const element of parsed.body.querySelectorAll<HTMLElement>("[style]")) {
    for (const property of COLOR_STYLE_PROPERTIES)
      element.style.removeProperty(property);
    const style = element.getAttribute("style");
    if (style?.trim()) element.setAttribute("style", style);
    else element.removeAttribute("style");
  }
  // <font color> 与 bgcolor 属性同样是颜色来源
  for (const element of parsed.body.querySelectorAll<HTMLElement>(
    "font[color], [bgcolor]",
  )) {
    element.removeAttribute("color");
    element.removeAttribute("bgcolor");
  }
  // 网页片段里的 <style> 会让颜色规则重新生效
  for (const element of Array.from(parsed.body.querySelectorAll("style")))
    element.remove();
  return parsed.body.innerHTML;
}
