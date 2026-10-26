// 阶段枚举被 index 与 mcp-contract 共用，单独成文件避免循环导入导致运行时取值为空
export const stages = [
  "analysis",
  "design",
  "development",
  "testing",
  "online",
] as const;
export type Stage = (typeof stages)[number];
