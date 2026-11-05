export interface ToolboxPoint {
  x: number;
  y: number;
}

export type ToolboxPlacement =
  | ({ mode: "float" } & ToolboxPoint)
  | { mode: "docked"; side: "left" | "right"; y: number };

export const toolboxButtonSize = 58;
export const toolboxDockWidth = 30;
export const toolboxDockHeight = 64;
export const toolboxPositionKey = "superpm.toolbox.position.v1";
const positionVersion = 2;
const dockThreshold = 48;
const edge = 8;
const defaultRightGap = 28;

function viewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function clampToolboxPoint(point: ToolboxPoint): ToolboxPoint {
  const { width, height } = viewport();
  const maxX = Math.max(edge, width - toolboxButtonSize - edge);
  const maxY = Math.max(edge, height - toolboxButtonSize - edge);
  return {
    x: Math.min(maxX, Math.max(edge, Math.round(point.x))),
    y: Math.min(maxY, Math.max(edge, Math.round(point.y))),
  };
}

export function defaultToolboxPlacement(): ToolboxPlacement {
  const { width, height } = viewport();
  return {
    mode: "float",
    ...clampToolboxPoint({
      x: width - toolboxButtonSize - defaultRightGap,
      y: Math.round(height * 0.62),
    }),
  };
}

export function clampToolboxPlacement(
  placement: ToolboxPlacement,
): ToolboxPlacement {
  if (placement.mode === "float")
    return { mode: "float", ...clampToolboxPoint(placement) };
  const { height } = viewport();
  const maxY = Math.max(edge, height - toolboxDockHeight - edge);
  return {
    mode: "docked",
    side: placement.side,
    y: Math.min(maxY, Math.max(edge, Math.round(placement.y))),
  };
}

export function resolveToolboxPlacement(point: ToolboxPoint): ToolboxPlacement {
  const { width } = viewport();
  const clamped = clampToolboxPoint(point);
  const centerX = clamped.x + toolboxButtonSize / 2;
  if (centerX <= dockThreshold || width - centerX <= dockThreshold) {
    return clampToolboxPlacement({
      mode: "docked",
      side: centerX <= dockThreshold ? "left" : "right",
      y: clamped.y + toolboxButtonSize / 2 - toolboxDockHeight / 2,
    });
  }
  return { mode: "float", ...clamped };
}

export function toolboxButtonRect(placement: ToolboxPlacement) {
  if (placement.mode === "float")
    return {
      x: placement.x,
      y: placement.y,
      width: toolboxButtonSize,
      height: toolboxButtonSize,
    };
  const { width } = viewport();
  return {
    x: placement.side === "left" ? 0 : Math.max(0, width - toolboxDockWidth),
    y: placement.y,
    width: toolboxDockWidth,
    height: toolboxDockHeight,
  };
}

export function loadToolboxPlacement(): ToolboxPlacement {
  try {
    const raw = window.localStorage.getItem(toolboxPositionKey);
    if (!raw) return defaultToolboxPlacement();
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      mode?: unknown;
      side?: unknown;
      x?: unknown;
      y?: unknown;
    };
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y) &&
      (parsed.version === 1 ||
        (parsed.version === positionVersion && parsed.mode === "float"))
    )
      return clampToolboxPlacement({
        mode: "float",
        x: parsed.x,
        y: parsed.y,
      });
    if (
      parsed.version === positionVersion &&
      parsed.mode === "docked" &&
      (parsed.side === "left" || parsed.side === "right") &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y)
    )
      return clampToolboxPlacement({
        mode: "docked",
        side: parsed.side,
        y: parsed.y,
      });
    return defaultToolboxPlacement();
  } catch {
    return defaultToolboxPlacement();
  }
}

export function saveToolboxPlacement(placement: ToolboxPlacement) {
  try {
    const value =
      placement.mode === "float"
        ? {
            version: positionVersion,
            mode: placement.mode,
            x: placement.x,
            y: placement.y,
          }
        : {
            version: positionVersion,
            mode: placement.mode,
            side: placement.side,
            y: placement.y,
          };
    window.localStorage.setItem(toolboxPositionKey, JSON.stringify(value));
  } catch {
    // 本地存储不可用时保持当前会话内的位置，不影响工具使用
  }
}
