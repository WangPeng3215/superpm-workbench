# superPM 基础工程 Implementation Plan

> **For agentic workers:** 在当前会话依序执行。用户已确认方案并授权推送到 WangPeng3215/superpm-workbench。任务共享 API 契约，按依赖顺序实施。

**Goal:** 交付可运行、有 SQLite 持久化和真实需求 CRUD 的本地工作台基础框架。

**Architecture:** npm workspaces 分离 web、server、shared。HTTP 调用业务服务；服务层负责事务与规则，Repository 负责 Drizzle 数据访问。

**Tech Stack:** Vue 3、Element Plus、Ease UI 单文件组件、Vite、Fastify、Zod、SQLite、Drizzle、Vitest。

## 任务 1：工程配置与共享契约

- [x] 初始化 Git 并绑定用户远程，不覆盖远程既有历史。
- [x] 创建 package.json、tsconfig、Vite/Vitest 配置、.gitignore 和 .env.example。
- [x] 创建 packages/shared/src/index.ts：状态、阶段、类型、优先级、日期校验、需求输入/列表 Schema、需求及历史返回类型。
- [x] 安装依赖，下载固定 SHA 的 Ease UI button/drawer/empty 组件与 MIT LICENSE；记录来源。

## 任务 2：后端真实持久化主链路

- [x] 先写服务端集成测试，以 Fastify inject 与临时 SQLite 验证编号、部分更新、阶段历史、软删除、主子限制、筛选分页、重启与输入错误。
- [x] 创建 Drizzle schema、连接、版本化 SQL 迁移。数据库开启 foreign_keys、WAL；应用事务内写需求和历史。
- [x] 创建 Repository、Service、API、配置与服务入口；编号稳定且软删除后不复用，限制两级和有子级的主需求删除。
- [x] 统一 Zod/API 错误；默认 loopback 监听。Workspace 当前仅提供相对路径校验入口。
- [x] `npm test` 集成测试通过。

## 任务 3：前端工作台与四阶段骨架

- [x] 创建 Vue 入口、布局、路由和中文 Element Plus 配置。
- [x] 创建类型化 API 客户端，统一请求与错误处理。
- [x] 创建需求列表、表单、详情组件；数据来自 API，不自动生成示例业务数据。
- [x] 列表实现两级父子、搜索、筛选、排序、分页；筛选结果保留父级结构。
- [x] 表单提交禁用重复提交；保存失败保留输入；未保存关闭确认。
- [x] 详情浏览四阶段工作区，不自动修改当前阶段；独立推进按钮写 API，并展示阶段历史。
- [x] 创建设置页与任务历史/通知骨架，明确模块实施边界。

## 任务 4：验证、文档和交付

- [x] 类型检查、集成测试、生产构建通过。
- [x] 浏览器验收验证主/子需求 CRUD、阶段切换、刷新持久化和未保存保护；测试数据库隔离。
- [x] README 记录运行、路径配置、API、实现边界与后续路线。
- [x] 编写 CI 配置模板，包含安装、类型检查、测试、构建和浏览器验收。当前 OAuth 凭证缺少 `workflow` scope，GitHub 拒绝工作流上传，模板暂存 `docs/ci/ci.yml`，尚未启用自动 CI。
- [x] 审阅改动，排除运行数据、node_modules 与凭证。用户已授权创建首个提交并正常推送 `main`，交付时比对本地与远程提交。

最近验证：类型检查通过，集成测试 13/13，浏览器验收 3/3，双端生产构建通过，依赖审计 0 漏洞。生产构建隔离启动验证健康接口、SPA 深链接、空数据库与配置路径；已关闭测试进程并清理临时数据。
