import type { OptimizationPointStatus } from "@superpm/shared";

// 状态标签配色：待评估偏冷、评估中为主色蓝、暂缓琥珀、不采纳红、已转换绿
export const optimizationStatusTone: Record<OptimizationPointStatus, string> = {
  pending: "tone-slate",
  evaluating: "tone-blue",
  postponed: "tone-amber",
  rejected: "tone-red",
  converted: "tone-green",
};

const pad = (value: number) => String(value).padStart(2, "0");

/** 发现时间/更新时间：列表只显示日期，详情显示到分钟 */
export function formatPointDate(value: string, withTime = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime
    ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : day;
}
