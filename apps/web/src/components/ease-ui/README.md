# Ease UI 来源

上游：https://github.com/Momingyun/ease-ui

固定版本：`819e686c0e98a692d16bd0e7557c5fe359c493c9`（2026-10-13 获取）。按照上游推荐的单组件复制方式集成 `xly-button`、`xly-drawer`、`xly-empty`；不引入展示站、其他业务组件或上游项目的全部依赖。

## 本地修订

- `xly-timeline`（`index.vue`、`timeline-item.vue`）：自同一版本追加集成，用于「需求进展」的阶段条（`direction="horizontal"` 横向排列）。
  - `timeline-item.vue` 依赖上游内部组件 `xly-icon`（并提供 `icon` 属性）：改为 Element Plus 图标 `Check` / `Close` / `Loading`，并移除不可用的 `icon` prop。
  - 横向布局：连接线几何按「节点居中」重绘（`left: calc(50% + 14px); right: calc(-50% + 14px)`），使线段正好从一个节点连到下一个节点；进行中状态的连接线在横向时改为从左到右的渐变；最后一项多余的连接线由样式隐藏。
  - 删除上游未被使用的 `reverse`、`customClass`、`itemCount`、`isLastItem` 等死代码。
- 其余四个组件目前与上游一致。

MIT 许可原文保存在同目录 LICENSE。后续本地修订应记录在此文件。

应用表单与树形表格使用 Element Plus；Ease UI 是实际使用的界面组件来源，不作为 npm 依赖安装。
