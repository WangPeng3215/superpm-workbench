import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampToolboxPlacement,
  defaultToolboxPlacement,
  loadToolboxPlacement,
  resolveToolboxPlacement,
  saveToolboxPlacement,
  toolboxButtonRect,
  toolboxButtonSize,
  toolboxDockHeight,
  toolboxDockWidth,
  toolboxPositionKey,
} from "../src/features/online-tools/position";

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("window", {
    innerWidth: 1440,
    innerHeight: 1000,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("工具箱悬浮按钮位置", () => {
  it("拖到左边缘时吸附为左侧小竖条", () => {
    const placement = resolveToolboxPlacement({ x: 8, y: 400 });
    expect(placement).toEqual({ mode: "docked", side: "left", y: 397 });
    expect(toolboxButtonRect(placement)).toEqual({
      x: 0,
      y: 397,
      width: toolboxDockWidth,
      height: toolboxDockHeight,
    });
  });

  it("拖到右边缘时吸附为右侧小竖条", () => {
    const placement = resolveToolboxPlacement({ x: 1374, y: 400 });
    expect(placement).toEqual({ mode: "docked", side: "right", y: 397 });
    expect(toolboxButtonRect(placement)).toEqual({
      x: 1410,
      y: 397,
      width: toolboxDockWidth,
      height: toolboxDockHeight,
    });
  });

  it("远离左右边缘时保持完整悬浮按钮", () => {
    const placement = resolveToolboxPlacement({ x: 600, y: 400 });
    expect(placement).toEqual({ mode: "float", x: 600, y: 400 });
    expect(toolboxButtonRect(placement)).toEqual({
      x: 600,
      y: 400,
      width: toolboxButtonSize,
      height: toolboxButtonSize,
    });
  });

  it("窗口缩小时夹取吸附位置并按新宽度计算右侧坐标", () => {
    const placement = clampToolboxPlacement({
      mode: "docked",
      side: "right",
      y: 980,
    });
    expect(placement).toEqual({ mode: "docked", side: "right", y: 928 });
    window.innerWidth = 720;
    expect(toolboxButtonRect(placement).x).toBe(720 - toolboxDockWidth);
  });

  it("旧版 v1 坐标按普通悬浮位置读取", () => {
    values.set(
      toolboxPositionKey,
      JSON.stringify({ version: 1, x: 600, y: 300 }),
    );
    expect(loadToolboxPlacement()).toEqual({ mode: "float", x: 600, y: 300 });
  });

  it("v2 吸附状态保存后可原样恢复", () => {
    saveToolboxPlacement({ mode: "docked", side: "right", y: 400 });
    const raw = JSON.parse(values.get(toolboxPositionKey) ?? "{}");
    expect(raw).toEqual({ version: 2, mode: "docked", side: "right", y: 400 });
    expect(loadToolboxPlacement()).toEqual({
      mode: "docked",
      side: "right",
      y: 400,
    });
  });

  it("非法吸附方向回退到默认悬浮位置", () => {
    values.set(
      toolboxPositionKey,
      JSON.stringify({ version: 2, mode: "docked", side: "top", y: 100 }),
    );
    expect(loadToolboxPlacement()).toEqual(defaultToolboxPlacement());
  });
});
