# superPM workbench 现状审计（阶段 0）

- 审计日期：2026-10-15
- 审计方式：只读检查实际代码，未修改任何业务代码、数据库或用户文件
- 对应开发文档：《superPM workbench 产出物与过程问题管理改造开发文档》V1.0

> 本文是阶段 0 的历史快照，仅记录当时的代码状态，不代表当前实现。文中提到的
> `RequirementAnalysisPanel.vue`、`MarkdownEditor.vue` 等组件已在后续迭代中删除，
> 现行结构与能力请以根目录 `README.md` 和实际代码为准。

## 1. 技术栈与启动方式

| 层     | 实现                                                  | 说明                                                                         |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| 前端   | Vue 3 + TypeScript + Vite + Element Plus + Tiptap 3.x | `apps/web`，路由 vue-router，状态为组件内 ref（无 Pinia/Redux）              |
| 后端   | Fastify + better-sqlite3（同步 API）                  | `apps/server`，单进程本地服务，`createApp(options)` 可注入 db/workspace 路径 |
| 共享   | zod schema + TS 类型                                  | `packages/shared`，前后端共用枚举与校验                                      |
| 包管理 | npm workspaces                                        | `apps/*` + `packages/*`                                                      |

启动：`npm run dev`（concurrently 同时起 server 3001 与 web 5173）；生产 `npm run build` + `npm run start`（server 静态托管 `apps/web/dist`，SPA fallback 已实现）。

## 2. 数据库访问层与迁移机制

- **访问层**：无 ORM 查询构建器参与运行时；服务层直接写 SQL（`db.prepare(...).run/all/get`）。`apps/server/src/db/schema.ts` 存在 drizzle-orm 表定义但仅作类型参考，未在运行时使用。
- **迁移机制**：自研迁移器 `src/db/migrate.ts`。
  - 目录：`apps/server/drizzle/`，文件名 `NNNN_name.sql`，按序号排序执行。
  - 记录表：`schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT)`，已应用版本跳过，天然幂等。
  - 每个迁移在事务中执行（执行失败即整体回滚）。
  - `SCHEMA_VERSION` 常量当前为 **4**（需随迁移手工同步）。
  - 另有 CLI 入口 `migrate-cli.ts`（`npm run db:migrate`）。
- **连接与事务**：`app.ts` 中 `new Database(path)` 创建的实例同时用于迁移和运行时（同一连接贯穿生命周期）。`migrate()` 内执行 `PRAGMA foreign_keys=ON / busy_timeout=5000 / journal_mode=WAL`，因此**运行时外键约束生效**。业务事务使用 `db.transaction()` 同步事务。

## 3. 现有表结构（0001–0004 迁移结果）

| 表                       | 用途                                          | 主键                  | 软删除                   | 关键外键/索引                                      |
| ------------------------ | --------------------------------------------- | --------------------- | ------------------------ | -------------------------------------------------- |
| `requirements`           | 需求主表                                      | INTEGER AUTOINCREMENT | `deleted_at`（非空即删） | `parent_id` 自引用；`parent_idx`                   |
| `requirement_history`    | 阶段流转历史                                  | INTEGER               | 无                       | `requirement_id → requirements(id)`                |
| `requirement_audit`      | 操作审计                                      | INTEGER               | 无                       | 同上                                               |
| `requirement_workspaces` | 旧阶段工作台（JSON content + version 乐观锁） | requirement_id（1:1） | 无                       | 同上                                               |
| `requirement_files`      | 产出物文件索引                                | INTEGER               | 无                       | 同上；`scope_idx(requirement_id, phase, category)` |
| `schema_migrations`      | 迁移记录                                      | version               | —                        | —                                                  |

约定（已全项目统一）：

- 主键一律 `INTEGER PRIMARY KEY AUTOINCREMENT`。
- 日期 `YYYY-MM-DD` TEXT；时间戳 ISO 8601 TEXT；无 SQLite 原生日期类型。
- 枚举值 TEXT 存储，合法值定义在 `packages/shared`（zod 校验）。
- 阶段枚举：`stages = ["analysis", "design", "development", "testing", "online"]`。

`requirement_files` 现有列：`id, requirement_id, phase, category, name(展示名), file_name(落盘 UUID 物理名), kind('file'|'link'), link_url, is_final, created_at, updated_at`。

## 4. 资源根目录与文件路径规则

- 资源根目录：`workspace/`（环境变量 `SUPERPM_WORKSPACE_DIR` 可覆盖；数据库 `SUPERPM_DATA_DIR`），见 `src/config/index.ts`。
- 落盘路径：`{root}/requirements/{requirementId}/{phase}/{category中文目录}/{uuid.ext}`。**路径不落库**，由 phase+category+file_name 推导。
- 安全措施（`requirement-files.ts`）：逐级目录符号链接检查 + `realpath` 越界校验、`wx` 标志防覆盖、5MB 上限、扩展名/MIME 白名单映射、图片魔数校验（stage-workspace.ts）。
- 条目形态：`kind='file'`（UUID 落盘）与 `kind='link'`（仅索引，不落盘）均已实现。
- 图片（富文本插图）独立体系：`{root}/requirements/{id}/images/{uuid.ext}`，**无索引表**，URL 直接内嵌 HTML。

## 5. 前端页面与状态管理

- 需求详情页 `RequirementDetailPage.vue`：返回链接 + 顶部标题卡（编号/标题/操作 + 横向步骤时间线）+ 双 tab（需求详情 / 需求进展）。
  - 详情 tab：左侧富文本描述编辑器（占满卡片）+ 右侧表单。
  - 进展 tab：`RequirementAnalysisPanel.vue`（左侧编辑器 + 右侧文件 tab 列表）。当前仅 analysis 阶段有完整面板；design/development/testing/online 共用占位（阶段切换仅改变查看视角，无各阶段专属 UI）。
- API 层：`apps/web/src/api/*.ts` 薄封装 fetch；类型来自 `@superpm/shared`。

## 6. 测试体系

| 类型      | 框架       | 位置                 | 命令                               | 现状                                                               |
| --------- | ---------- | -------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| 单元/集成 | vitest     | `apps/server/tests/` | `npm test`                         | 19 条（需求 CRUD、文件服务、图片、事务回滚等），真实 SQLite 临时库 |
| E2E       | Playwright | `tests/e2e/`         | `npm run test:e2e`（先 build web） | 11 条（analysis-files.spec.ts），走 e2e-server + dist              |

类型检查：`npm run typecheck`（三 workspace 全跑）。

## 7. 与本方案的差异清单

### 7.1 可复用（不改）

| 模块          | 复用点                                                                            |
| ------------- | --------------------------------------------------------------------------------- |
| 需求主表/服务 | Asset、Issue 均挂 `requirements.id`，编号唯一性已由 UNIQUE 约束保证               |
| 迁移器        | `migrate.ts` 完全满足「可追踪、幂等、事务化」要求，无需新机制                     |
| 路径安全      | `directory()/path()` 的逐级 realpath 校验可直接抽出复用为 `resolveAssetPath` 基础 |
| 校验/错误体系 | zod + `DomainError` + 统一 `{error:{code,message}}` 响应结构                      |
| 测试基建      | createApp 注入临时库/workspace 的测试模式可平移                                   |

### 7.2 可扩展（演进，不重建）

| 现有                | 差距                                                                                                                                                                              | 建议方向                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requirement_files` | 缺 `description`、`resource_type=text`、`storage_type`、`relative_path`（现路径推导不落库）、完整 `status`（现有 is_final 仅二值，方案要求 draft/final/archived/missing）、软删除 | 在阶段 1 决策：**扩展本表演进为 Asset**（符合「优先扩展」原则，且上批新增的 kind/link_url 已是 Asset 半成品）vs 新建 assets 表再迁移。倾向扩展本表 |
| `is_final`          | 与方案 `status` 冲突                                                                                                                                                              | is_final 语义 ≈ status='final' 的布尔投影；扩展时可保留列（兼容现有 UI/e2e），由服务层双向同步，或迁移转换——阶段 1 定                              |
| 分类清单            | 方案默认分类（analysis_record/mind_map/flowchart/…）与现有 9 分类（record/designLink/uiAssets/uiIssues/devIssues/testIssues 等）不一致                                            | 阶段 1 合并映射：现有 key 已覆盖方案多数语义，缺失的 mind_map/flowchart/design_note 等按方案补入 `stageFileCategories`                             |
| 步骤命名            | 方案用 `requirement_analysis/ui_design/...`，现有枚举为 `analysis/design/...` 且已入库                                                                                            | **沿用现有枚举**，不引入第二套命名（文档允许按现状调整）                                                                                           |

### 7.3 需新增

| 项                                  | 说明                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `issues` 表                         | 方案 4.3；`step_type` 限定 design/development/testing；状态机 open/in_progress/resolved/closed |
| `issue_activities` 表               | 方案 4.4；追加式历史，事务内与 Issue 同写                                                      |
| `issue_assets` 关联表               | 方案 4.5；去重约束、不级联删除文件                                                             |
| Asset/Issue 业务服务层              | 现有逻辑混在 RequirementFileService；按方案 7.1/7.2 拆出独立服务方法集                         |
| `resolveAssetPath` 统一路径解析服务 | 从现有 directory()/path() 抽取                                                                 |
| 文本资源能力                        | resource_type=text + text_content（小型文本，替代「问题伪装成 md 文件」的旧路径）              |

### 7.4 不应改动

- `requirements`/`requirement_history`/`requirement_audit` 表结构与现有服务对外行为。
- 现有 `requirement_workspaces`（旧工作台）表与接口：UI 已移除但仍在服务，本改造不动，待阶段 9 评估迁移。
- 图片体系（B 体系）：继续无索引内嵌 URL，本次不合并（记录为已知债务）。
- 前端框架/路由/组件库。

## 8. 旧数据与存量文件盘点

- 磁盘存量：`workspace/requirements/` 下已有多个需求目录（analysis 分类子目录 + images）；需求 1 另有旧工作台产物 `analysis/analysis.md`、`analysis/prd.md`。
- 数据库存量：requirement_files 已有索引行（kind=file/link 混合）；requirement_workspaces 至少 1 行（需求 1，content JSON 内含 testing 问题数组——**这是现存唯一的"问题"数据形态**，迁移时需评估是否转换为新 issues 表）。
- 所有存量文件路径均可由现有推导规则定位；若 Asset 改为落库 relative_path，需一次性回填（可从推导规则计算，无歧义）。

## 9. 风险列表

1. **requirement_files 演进 vs 新表**：扩展现有表改动面小但会让该表承担 Asset 全语义（表名与语义渐偏离）；新表干净但需要数据迁移 + 双写兼容期。→ 阶段 1 核心决策点，建议扩展并接受表名不变。
2. **is_final → status 迁移**：现网数据 is_final=1 需映射为 status='final'，0 映射为 'draft'；前端面板与 e2e（11 条）依赖 isFinal 字段，需兼容层。
3. **路径落库回填**：若引入 relative_path 列，存量行回填依赖「phase/category/file_name 推导」规则，推导已验证可靠，但需在迁移中校验文件真实存在性（不存在的标 missing，不删行）。
4. **旧 workspaces 问题数据**：需求 1 的 testing 问题数组若不迁移则新 UI 看不到历史问题；迁移转换需在阶段 9 明确范围（建议：仅当用户确认后转换，默认保留原样只读）。
5. **e2e 基线**：改造期间 `analysis-files.spec.ts` 11 条是回归底线，任何 Asset 演进必须保持其通过（必要时更新断言而非删除用例）。
6. **SCHEMA_VERSION 手工同步**：迁移器按文件序号执行，但 /api/system 的 SCHEMA_VERSION 是手工常量，忘改会导致版本显示不一致（无功能损害，但需纳入检查清单）。
7. **图片无索引**：富文本插图不在 Asset 体系内，Asset 软删除/missing 检测无法覆盖；接受为本期边界并记录。

## 10. 后续阶段文件范围预告

- 阶段 1（文档）：`docs/data-model.md`、`docs/migration-plan.md`（不动代码）。
- 阶段 2（迁移）：`apps/server/drizzle/0005_*.sql`（预计 assets 扩展列 + issues/issue_activities/issue_assets 三表 + 索引）、`schema.ts` 类型参考、migrate 相关单测。
- 阶段 3（Asset 服务）：`apps/server/src/services/`（新增 asset 服务或改造 requirement-files.ts）、`packages/shared`（schema/类型）、服务端测试。
- 阶段 4–5（Issue 服务/关联）：新增 `issues.ts` 服务 + 测试。
- 阶段 6–8（UI）：`RequirementDetailPage.vue`、`RequirementAnalysisPanel.vue`、新增进展页阶段面板组件。
- 阶段 9–10：迁移校验脚本/文档、`docs/mcp-contract.md`。

## 11. 审计结论

现有架构与本方案高度兼容：迁移机制、路径安全、校验/错误体系、测试基建均可直接复用；主要工作在**将 requirement_files 演进为完整 Asset 模型**与**新增 Issue/Activity/关联三表及服务**，均为增量改造，无破坏性前提。建议按「先扩展现有表、沿用现有枚举命名、兼容层保护 isFinal 消费方」的路线推进，细节在阶段 1 文档中确认。
