import type { Component } from "vue";
import {
  ApiOutlined,
  ApartmentOutlined,
  CloudOutlined,
  CodeOutlined,
  CompassOutlined,
  DeploymentUnitOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  TableOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from "@ant-design/icons-vue";
import type { OnlineToolCategory, OnlineToolIconKey } from "@superpm/shared";
import { decorative } from "../../components/decorativeIcon";

// 图标只按内置 key 渲染，不接受用户上传的 SVG/HTML。
export const onlineToolIcons: Record<OnlineToolIconKey, Component> = {
  tool: decorative(ToolOutlined),
  diagram: decorative(ApartmentOutlined),
  mindmap: decorative(DeploymentUnitOutlined),
  document: decorative(FileTextOutlined),
  markdown: decorative(EditOutlined),
  table: decorative(TableOutlined),
  code: decorative(CodeOutlined),
  api: decorative(ApiOutlined),
  thunder: decorative(ThunderboltOutlined),
  cloud: decorative(CloudOutlined),
  experiment: decorative(ExperimentOutlined),
  compass: decorative(CompassOutlined),
};

export const categoryDefaultIcon: Record<
  OnlineToolCategory,
  OnlineToolIconKey
> = {
  diagram: "diagram",
  mindmap: "mindmap",
  document: "document",
  productivity: "thunder",
  other: "tool",
};

export const categoryTone: Record<OnlineToolCategory, string> = {
  diagram: "tone-blue",
  mindmap: "tone-purple",
  document: "tone-teal",
  productivity: "tone-amber",
  other: "tone-slate",
};

export function onlineToolIcon(
  icon: string | null,
  category: OnlineToolCategory,
): Component {
  const key = (icon ?? categoryDefaultIcon[category]) as OnlineToolIconKey;
  return onlineToolIcons[key] ?? onlineToolIcons.tool;
}
