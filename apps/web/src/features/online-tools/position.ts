export interface ToolboxPoint {
  x: number;
  y: number;
}

export const toolboxButtonSize = 58;
export const toolboxPositionKey = "superpm.toolbox.position.v1";
const positionVersion = 1;
const edge = 8;
const defaultRightGap = 28;

function viewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

export function defaultToolboxPosition(): ToolboxPoint {
  const { width, height } = viewport();
  return clampToolboxPosition({
    x: width - toolboxButtonSize - defaultRightGap,
    y: Math.round(height * 0.62),
  });
}

export function clampToolboxPosition(point: ToolboxPoint): ToolboxPoint {
  const { width, height } = viewport();
  const maxX = Math.max(edge, width - toolboxButtonSize - edge);
  const maxY = Math.max(edge, height - toolboxButtonSize - edge);
  return {
    x: Math.min(maxX, Math.max(edge, Math.round(point.x))),
    y: Math.min(maxY, Math.max(edge, Math.round(point.y))),
  };
}

export function loadToolboxPosition(): ToolboxPoint {
  try {
    const raw = window.localStorage.getItem(toolboxPositionKey);
    if (!raw) return defaultToolboxPosition();
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      x?: unknown;
      y?: unknown;
    };
    if (
      parsed.version !== positionVersion ||
      typeof parsed.x !== "number" ||
      typeof parsed.y !== "number" ||
      !Number.isFinite(parsed.x) ||
      !Number.isFinite(parsed.y)
    )
      return defaultToolboxPosition();
    return clampToolboxPosition({ x: parsed.x, y: parsed.y });
  } catch {
    return defaultToolboxPosition();
  }
}

export function saveToolboxPosition(point: ToolboxPoint) {
  try {
    window.localStorage.setItem(
      toolboxPositionKey,
      JSON.stringify({ version: positionVersion, x: point.x, y: point.y }),
    );
  } catch {
    // 本地存储不可用时保持当前会话内的位置，不影响工具使用
  }
}
