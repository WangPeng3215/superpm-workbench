// 文档图片地址转换（文档 §12.4）：磁盘与 Markdown 中保存「相对文档目录」的路径，
// 浏览器预览需要可访问的接口地址，因此编辑前后做一次双向转换，保存内容始终是相对路径。
const ABSOLUTE_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

/** 是否为相对文档目录的图片路径（非协议、非绝对路径、非内联数据） */
export function isRelativeImagePath(src: string): boolean {
  return Boolean(src) && !ABSOLUTE_PATTERN.test(src);
}

// Markdown 解析器会把中文与空格转成百分号编码，落盘与磁盘比对需要原始文件名；
// 只做一次安全解码，非法编码（如 %ZZ）保持原样，避免抛错中断预览。
function decodePath(src: string) {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

function apiUrl(
  requirementId: number,
  relativePath: string,
  nodeId?: number | null,
) {
  const params = new URLSearchParams({ path: decodePath(relativePath) });
  if (nodeId) params.set("nodeId", String(nodeId));
  return `/api/requirements/${requirementId}/artifacts/image?${params.toString()}`;
}

/** 单张图片的预览地址：相对路径 → 可访问的接口地址（已是绝对地址时原样返回） */
export function imageDisplayUrl(
  requirementId: number,
  src: string,
  nodeId?: number | null,
) {
  return isRelativeImagePath(src) ? apiUrl(requirementId, src, nodeId) : src;
}

function replaceImageSources(html: string, transform: (src: string) => string) {
  return html.replace(
    /(<img\b[^>]*?\bsrc=")([^"]*)(")/gi,
    (_match, head, src, tail) => `${head}${transform(src)}${tail}`,
  );
}

/** 存入编辑器前：相对路径 → 可访问的接口地址，便于在浏览器中直接预览 */
export function toDisplayHtml(
  html: string,
  requirementId: number,
  nodeId?: number | null,
) {
  if (!html) return html;
  return replaceImageSources(html, (src) =>
    imageDisplayUrl(requirementId, src, nodeId),
  );
}

/** 保存前：接口地址 → 相对文档目录的路径（编辑器内部其它地址原样保留） */
export function toStoredHtml(html: string, requirementId: number) {
  if (!html) return html;
  const prefix = `/api/requirements/${requirementId}/artifacts/image?`;
  return replaceImageSources(html, (src) => {
    if (!src.startsWith(prefix)) return src;
    const query = new URLSearchParams(src.slice(prefix.length));
    const path = query.get("path");
    return path ?? src;
  });
}
