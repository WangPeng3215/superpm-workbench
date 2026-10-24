# superPM Workbench UI Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在不改变业务契约的前提下，建立统一双主题设计系统并重构全局框架和全部现有页面。

**Architecture:** 保留 Vue 3、Element Plus 与 Tiptap，以现有语义 CSS 变量为单一主题来源。将 App 的侧栏和顶栏拆为布局组件，再逐页调整工具栏、工作区和响应式样式；业务状态仍留在原页面和 feature 组件。

**Tech Stack:** Vue 3.5、TypeScript、Vite 7、Element Plus 2.13、Tiptap 3、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-24-workbench-ui-refactor-design.md`

## Global Constraints

- 不新增 Fancy UI、Tailwind、GSAP、Three.js 或其他 UI 依赖。
- 不改变路由、API、SQLite、MCP、文件路径、需求业务规则或 Tiptap 序列化。
- 保留 `App.vue`、`styles.css` 的齿轮可见性修复及 `workbench.spec.ts` 的更新提示断言。
- 不修改 `updates/`，不递增版本，不提交、不推送、不发布。
- 每个阶段执行相关验证；最终必须真实浏览器验证，不只依赖截图或类型检查。

---

### Task 1: 设计 Token 与全局布局组件

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/App.vue`
- Create: `apps/web/src/components/layout/AppSidebar.vue`
- Create: `apps/web/src/components/layout/AppTopbar.vue`
- Test: `tests/e2e/workbench.spec.ts`

**Interfaces:**
- `AppSidebar` consumes `navigation: { path: string; label: string; icon: Component }[]` and emits no business events.
- `AppTopbar` consumes the existing tabs/auth/theme stores and emits `change-password`; route navigation continues through Vue Router.

- [x] **Step 1: 保留并运行导航回归基线**

Run: `npx playwright test -g "workbench tabs|settings shows"`
Expected: 现有选择器对应的页签、路由和设置用例通过；若布局测试因视口变化暴露问题，先记录再修改结构。

- [x] **Step 2: 建立统一 Token 与 Element Plus 映射**

在 `:root` 和 `html.dark` 中保留现有变量名，并增加：

```css
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --control-sm: 28px;
  --control-md: 34px;
  --duration-fast: 120ms;
  --duration-normal: 180ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --sidebar-w: 224px;
  --sidebar-collapsed-w: 64px;
  --app-header-h: 52px;
  --glass-bg: rgb(255 255 255 / 82%);
  --glass-border: rgb(255 255 255 / 72%);
}
```

深色主题覆盖 `--glass-bg` 与 `--glass-border`。将 `--brand` 映射到 `--el-color-primary`，保持 Element Plus 弹层与主应用同步。

- [x] **Step 3: 抽取侧栏与顶栏，保持原有路由和页签接口**

`AppSidebar.vue` 使用现有 `RouterLink` 和 `navigation` 数据，保留 `nav-item`、`router-link-active`、`title`、`aria-label`。`AppTopbar.vue` 复用 `tabsStore`、`pushTab`、`onCloseTab` 行为，保留 `.topbar-tab`、`.tab-label`、`.tab-close` 选择器。`App.vue` 只组合组件并处理密码弹窗。

- [x] **Step 4: 实现玻璃降级、焦点和响应式**

```css
.sidebar,
.topbar {
  background: var(--glass-bg);
  border-color: var(--glass-border);
}
@supports (backdrop-filter: blur(1px)) {
  .sidebar,
  .topbar {
    backdrop-filter: blur(18px) saturate(145%);
  }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

桌面侧栏 224px；1024px 以下 64px；未选中图标使用 `--text-regular`，窄栏 20px，不恢复旧的低对比样式。

- [x] **Step 5: 验证布局阶段**

Run: `npm run typecheck && npx playwright test -g "workbench tabs|settings shows"`
Expected: PASS；真实浏览器检查浅色/深色、1440/1024/560px、齿轮、页签关闭和用户菜单。

### Task 2: 需求列表紧凑工具栏与表格

**Files:**
- Modify: `apps/web/src/pages/RequirementsPage.vue`
- Modify: `apps/web/src/features/requirements/workbench.css`
- Test: `tests/e2e/workbench.spec.ts`

**Interfaces:**
- Consumes existing `filters`, `dateRanges`, `expandedDates`, `applyFilters`, `clearFilters`, `create`, `visibleColumns` from `useEditableTable`.
- Produces no new business API; existing `.editing-row`, `.requirement-no`, `.rich-cell` selectors remain stable.

- [x] **Step 1: 为紧凑工具栏补充行为断言**

保留 `addRequirement()` 使用的「在底部新增一行」流程；增加断言：页面加载后搜索框、类型、状态、优先级和「查询」可见，更多时间条件默认不展开，点击后提出时间以外的日期条件可见。

- [x] **Step 2: 重排筛选模板**

将外层筛选卡片改为 `.requirements-toolbar`，主行包含名称搜索、三个下拉、查询/重置、更多筛选和列设置。日期控件放入现有 `expandedDates` 控制的 `.filter-drawer`，不删除任何 `v-model` 或查询调用。

- [x] **Step 3: 统一表格密度和状态**

```css
.editable-table :deep(th.el-table__cell) {
  height: 38px;
  white-space: nowrap;
}
.editable-table :deep(td.el-table__cell) {
  height: 46px;
  padding: 4px 0;
}
```

仅保留水平分隔和必要固定列边界；行 hover、编辑态、focus-visible 使用 Token。窄屏次要筛选收进展开区，表格横向滚动限制在 `.el-table` 内。

- [x] **Step 4: 验证需求列表业务**

Run: `npx playwright test -g "inline CRUD|rich description|unsaved inline"`
Expected: PASS；真实执行新增、行内编辑、保存、刷新、筛选、列设置和分页。

### Task 3: 需求详情与 Tiptap 工作区

**Files:**
- Modify: `apps/web/src/pages/RequirementDetailPage.vue`
- Modify: `apps/web/src/features/requirements/InlineRichTextEditor.vue`
- Modify: `apps/web/src/features/requirements/DocTabEditor.vue`
- Modify: `apps/web/src/features/requirements/RichTextEditor.vue`
- Test: `tests/e2e/workbench.spec.ts`

**Interfaces:**
- Consumes existing `draft`, `dirty`, `saving`, `save`, `activeTab`, `docTabs` and editor events.
- Adds `propertiesOpen: Ref<boolean>` controlling only the visual property sidebar; no saved data or route schema changes.

- [x] **Step 1: 保留详情与自动保存回归**

Run: `npx playwright test -g "stage workspace"`
Expected: 修改前通过；测试继续定位 `label.field`、「保存修改」、`需求详情/文档管理/问题记录` 和 `文档内容`。

- [x] **Step 2: 重构详情头部和属性侧栏**

头部单行展示编号、名称、阶段、dirty 状态和属性栏开关。`detail-grid` 在 `propertiesOpen=false` 时使用单列；开关为带 `aria-label`、`aria-expanded` 的按钮，不改变表单字段或保存逻辑。

- [x] **Step 3: 统一编辑器材质和工具栏**

编辑器容器使用 `--bg-surface`，工具栏 40–44px，按钮 28–32px，正文行高 1.7；激活、hover、focus、disabled 均使用 Token。不得给 `.tiptap` 添加透明或玻璃背景，不改变图片上传和 Markdown 转换。

- [x] **Step 4: 验证详情、文档与问题**

Run: `npm run typecheck && npx playwright test -g "stage workspace"`
Expected: PASS；真实编辑需求、打开需求记忆、自动保存、刷新重开、创建并解决问题，检查深浅色和窄屏堆叠。

### Task 4: 文档、问题、设置、规划页与登录统一

**Files:**
- Modify: `apps/web/src/features/requirements/RequirementDocManager.vue`
- Modify: `apps/web/src/features/requirements/RequirementIssuesPanel.vue`
- Modify: `apps/web/src/pages/SettingsPage.vue`
- Modify: `apps/web/src/pages/PlannedPage.vue`
- Modify: `apps/web/src/pages/LoginPage.vue`
- Modify: `apps/web/src/components/ease-ui/login/themes/ClassicTheme.vue`
- Modify: `apps/web/src/components/ease-ui/login/themes/DarkTheme.vue`
- Modify: `apps/web/src/styles.css`
- Test: `tests/e2e/workbench.spec.ts`

**Interfaces:**
- All existing component props, emits, API calls, upload inputs, editor labels and route behavior remain unchanged.
- Settings uses local `activeSection: Ref<"storage" | "updates" | "modules">` for view switching only.

- [x] **Step 1: 为设置分类和现有更新入口写断言**

进入 `/settings` 后「本地存储」「版本与更新」「功能模块」分类可见；点击「版本与更新」显示 `section.update-panel`，并继续断言当前版本、「检查更新」和「未检测到发布安装布局」。

- [x] **Step 2: 统一文档与问题工作区**

文档目录、文件行、工具栏和预览使用一致高度与边框，不修改上传、最终版和系统打开处理。问题标题、元信息、描述、解决方案、附件按上下结构排列；保留 `.issue-row`、`.meta-field--status`、`.rich-document` 和自动保存事件。

- [x] **Step 3: 重构设置、规划页和登录**

设置使用 `.settings-layout`、`.settings-nav`、`.settings-content`，三个已有功能块保持原组件和加载逻辑。登录只调整模板外观和共享 Token，保留 `handleLogin`、错误提示、loading 和站内回跳校验。

- [x] **Step 4: 验证页面回归**

Run: `npm run typecheck && npx playwright test`
Expected: 36 个现有端到端测试及新增断言全部通过；浏览器验证上传、最终版、外部打开入口、设置切换、登录失败与成功。

### Task 5: 全量质量验证与清理

**Files:**
- Modify only files with verified formatting or regression issues from Tasks 1–4.
- Test: `tests/e2e/workbench.spec.ts`

- [x] **Step 1: 运行静态检查与单元测试**

Run: `npm run typecheck && npm test`
Expected: typecheck 0 error；现有 214 个单元/集成测试及新增测试全部通过。

- [x] **Step 2: 运行构建和完整浏览器回归**

Run: `npm run build && npx playwright test`
Expected: Web/Server 构建成功，Playwright 全部通过且无 pageerror。

- [x] **Step 3: 真实视觉与交互验收**

在 1440、1024、768、560、375px 检查浅色和深色；验证键盘导航、页签关闭、焦点、减少动态效果、长文本、空状态、加载和错误状态。真实复制粘贴 Markdown 与图片，保存后刷新重新打开；不得用合成事件代替最终验收。

- [x] **Step 4: 检查变更边界**

Run: `git status --short && git diff --stat`
Expected: 仅计划内前端、测试和设计/计划文档变化；`updates/` 保持原有未跟踪状态且未被修改。不提交、不打标签、不发布。
