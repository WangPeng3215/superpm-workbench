# superPM workbench 基础框架设计

日期：2026-10-13。范围：阶段一的基础工程与需求主链路，不代表阶段一全部交付。

## 设计输入

以根目录《superPM workbench 开发文档（阶段一）》V0.1 为需求参考。原文中的建议与待确认事项按本设计收敛；原始文档保留不改动。用户本次目标是先搭框架，之后逐步实现各业务模块。

## 方案比较

1. **推荐：npm workspace + Vue 3 + Fastify + SQLite + Drizzle。** 前后端与共享契约分别组织，可独立构建；业务规则集中于服务层，未来 MCP 可直接复用。
2. 单一 src 目录组织前后端：目录较少，但需额外防止服务端依赖进入前端构建。与方案一业务分层一致。
3. 纯前端原型：启动简单，但无法验证本地持久化、迁移和真实业务接口，不适合作为后续系统底座。

## 工程结构

```text
apps/
  web/src/
    api/                 # 类型化 HTTP 客户端
    components/          # 应用布局与公共组件
    features/requirements/ # 表格、表单、详情与阶段工作区
    pages/               # 工作台、任务历史、通知、设置
    router/
  server/src/
    api/                 # 路由、校验、统一错误映射
    config/              # 环境变量与本地路径
    db/                  # Drizzle schema、SQLite 初始化
    repositories/        # 数据读写
    services/            # 校验、事务、编号、删除和阶段历史
    storage/             # Workspace 边界
  server/drizzle/        # 可重复执行的版本化迁移
packages/shared/src/     # 枚举、输入 Schema、API 类型
docs/                    # 设计、计划和模块实施路线
data/                    # 运行时 SQLite，版本控制忽略
workspace/               # 本地文件工作区，版本控制忽略
```

依赖方向：Web → HTTP API → Service → Repository → SQLite；未来 MCP → Service。Web 只导入 shared，不导入服务器或数据库代码。应用布局使用 Element Plus，与文档技术栈一致。

用户已确认本设计，并指定 Ease UI（https://github.com/Momingyun/ease-ui）作为前端组件来源。该项目为可复制的单文件组件，不是 npm 发布包。本轮按 MIT 许可证复制需要的按钮、抽屉、空状态组件，保留上游许可证与版本来源；树形表格与校验表单使用 Element Plus，以适应需求层级和业务规则。后续在对应模块接入更多 Ease UI 组件。

## 本轮交付

- Windows 环境可通过根目录 npm 命令安装、启动、检查与构建。
- 默认仅监听 127.0.0.1。开发前端通过 Vite proxy 请求 API；生产后端提供构建后的前端。
- 数据库首次运行自动迁移；重复启动保留已有数据。SQLite 启用外键与 WAL。
- 需求列表、编号或名称搜索、类型/优先级/状态/阶段筛选、基础排序与分页。
- 创建、查看、部分更新和软删除需求。业务编号由服务器分配，创建后不可变。
- 先支持两级主子需求；拒绝以子需求作为父级，拒绝删除存在有效子需求的主需求。
- 需求详情抽屉与四个阶段的工作区骨架。浏览阶段工作区与修改业务当前阶段使用不同动作，后者保存阶段历史。
- 新增、编辑、删除、阶段调整提供成功或失败反馈；保存失败保留输入内容。
- 任务历史、通知页面标明尚未实现。设置页面展示真实数据库及 Workspace 运行信息。
- 需求变更的审计和阶段历史以同一数据库事务保存，避免只保存部分结果。

## 技术选择与初始规则

- ORM：仅 Drizzle，不同时引入 Prisma。
- 数据库驱动：better-sqlite3，适配当前 Node 22 LTS 环境。
- 需求阶段：analysis、design、development、testing；中文标签集中存放 shared。
- 需求状态：not_started、in_progress、blocked、paused、completed、cancelled；独立于阶段。
- 需求类型：feature、improvement、bug、refactor、other；优先级 P0–P3。
- 描述：第一版纯文本输入封装为 Tiptap 兼容 JSON，后续接入编辑器。搜索仅编号/名称匹配，FTS5 留给检索模块。
- 提出日期默认用户本地当天；日期保存 YYYY-MM-DD，系统事件保存 UTC ISO 时间。
- 文件上传、自定义字段配置、表格视图持久化、备份恢复、完整测试闭环、MCP 不在本轮实现。
- 手动备份、任务手动创建、可恢复文件删除作为后续默认建议，在对应模块设计时细化。

## API 与错误

`GET /api/health` 返回服务状态，`GET /api/system` 返回本地运行路径和版本。

`GET /api/requirements` 接受搜索、筛选、排序、分页参数；父级分页时子需求随父级一起返回。`POST /api/requirements` 创建，`GET /api/requirements/:id` 查看，`PATCH /api/requirements/:id` 更新，`DELETE /api/requirements/:id` 软删除。阶段变更通过 PATCH 的 currentStage 字段写入并保存历史；`GET /api/requirements/:id/history` 获取历史。

API 边界使用 Zod 校验，Service 校验关联存在性、两级规则和删除约束。更新只提交允许修改的字段，禁止修改 ID 与业务编号。统一错误格式为 `{ error: { code, message, details? } }`，使用 400/404/409/500 区分错误。数据库错误不直接向用户泄露。

## 验收与验证

1. 类型检查与生产构建通过。
2. 临时真实 SQLite 测试需求 CRUD、不可变编号、状态与阶段分离、两级校验、删除保护和迁移重启持久化。
3. HTTP 集成测试校验非法输入、未知需求、分页筛选和统一错误响应。
4. 前端人工或浏览器验证：创建需求 → 创建子需求 → 打开详情 → 切换工作区 → 修改当前阶段 → 刷新后数据保留。
5. 空数据库不自动写入示例业务需求；开发测试使用隔离数据库，不污染真实工作区。

## 后续顺序

需求视图与富文本 → 文件实体/版本/关联 → 问题、决策、跟进 → 测试用例/执行/复测 → 每日任务 → FTS5 与 Context API → 备份恢复 → MCP 适配层。
