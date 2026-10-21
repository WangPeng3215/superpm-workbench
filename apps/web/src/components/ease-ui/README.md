# Ease UI 来源

上游：https://github.com/Momingyun/ease-ui

固定版本：`819e686c0e98a692d16bd0e7557c5fe359c493c9`（2026-10-13 获取）。按照上游推荐的单组件复制方式集成；不引入展示站、其他业务组件或上游项目的全部依赖。

## 当前集成的组件

| 组件 | 位置 | 使用处 |
|---|---|---|
| `xly-button` | `xly-button/index.vue` | `pages/RequirementsPage.vue` |
| `xly-empty` | `xly-empty/index.vue` | `pages/RequirementsPage.vue`、`pages/PlannedPage.vue` |
| `login` | `login/index.vue` + `login/themes/*` | `pages/LoginPage.vue` |

## 本地修订

- `login`（`index.vue`、`themes/ClassicTheme.vue`、`themes/DarkTheme.vue`）：集成上游登录视图（`src/views/login`）的浅色「经典蓝」与深色「暗黑科技」两套主题，供 `/login` 登录页使用。
  - 移除上游 7 主题切换器与 Pinia 依赖：浅/深色跟随全局主题状态（`src/theme.ts`，localStorage `superpm-theme` + `html.dark`），并提供悬浮切换按钮。
  - 品牌本地化：logo 换为项目 `public/logo-mark.png`，文案改为 superPM 需求工作台，移除 ICP/公司信息；提示默认账号 admin / admin123。
  - 表单初始为空；`loading`/`error` 由父组件（`src/pages/LoginPage.vue`）传入，提交通过 `submit` 事件上抛。
- `xly-button`、`xly-empty` 与上游一致。

## 已移除

以下组件曾集成，确认无任何引用后已删除；如需恢复可从上述固定版本重新复制：

- `xly-drawer`：最后使用处随「移除需求跟进模块」一并下线。
- `xly-timeline`：曾用于「需求进展」的阶段条，`e707491` 移除该视图后成为孤儿。
- `xly-steps`：从未被业务代码引用。

MIT 许可原文保存在同目录 LICENSE。后续本地修订应记录在此文件。

应用表单与树形表格使用 Element Plus；Ease UI 是实际使用的界面组件来源，不作为 npm 依赖安装。
