# MCP 接入前架构审查

| 项目 | 内容 |
| --- | --- |
| 对应需求 | REQ-0029 superPM MCP开发 |
| 阶段 | M0：接入前架构审查 |
| 审查日期 | 2026-10-22 |
| 代码基线 | `main` @ `69c4eb5`，审查时工作区无未提交改动 |
| Schema 版本 | 11 |
| 运行环境 | Node v22.22.0 / npm 10.9.4 / Windows |
| 本阶段边界 | 只读审查；未修改业务代码、未安装新依赖、未创建 MCP Server |

**证据标记**

- **【事实】**：有代码、配置、测试或命令输出直接依据。
- **【推测】**：基于现状的判断，接入前应通过实际调用验证。
- **【待确认】**：需要产品、架构或使用方式上的决策，不能由实现者单方面假定。

---

## 0. 结论摘要

1. **【事实】现有业务层具备复用基础。** 需求、问题、知识库文件、目录路径安全都已收敛到独立服务，路由层基本只做参数解析与转发；README 也明确“REST 与未来 MCP 都通过 Core Service 访问事实数据”（`README.md:70`）。
2. **【事实】MCP 目前只有内部契约与网关，没有协议 Server。** `packages/shared/src/mcp-contract.ts` 声明了 13 个工具，`apps/server/src/services/mcp-gateway.ts` 提供执行器；但 `app.ts` 没有注册任何 MCP 入口，`mcp-gateway` 只在测试中被引用。项目依赖中也没有 `@modelcontextprotocol/sdk`。README 将 MCP 列为未实现能力（`README.md:45`）。
3. **【事实】当前 MCP 文件工具选错了事实模型。** 契约中的 `asset.*` 转发到 `RequirementFileService`（旧 `requirement_files` 表），而当前 UI 的“文档管理”、问题关联和需求记忆使用的是 `ArtifactService`（`artifact_nodes` / `artifact_links`）。两套模型并存，且主键都从 1 开始，存在“把旧资产 ID 当新知识库节点 ID 使用”的现实风险。
4. **【事实】规划中的两个只读能力尚不存在：** `get_requirement_memory`（需求记忆）与 `get_requirement_progress`（需求推进进度）都不在现有 13 个工具中。需求记忆可由知识库服务补齐；进度目前没有独立模型或服务，需要先定义。
5. **【事实】现有只读接口并非全部无副作用。** `ArtifactService.listNodes()` 会执行 `lightCheck()` 写索引；`ensureMemory()` 在部分场景会懒初始化目录与文件。MCP 只读工具若直接复用，会违反“查询不修改数据”的验收标准。
6. **【事实】写入所需的授权、确认、审计尚不具备。** 现有认证是面向浏览器的 Cookie 会话，只存在于 Fastify Hook；问题活动中的操作者被硬编码为 `local-user`，需求审计只覆盖需求增删改，没有 MCP 调用来源、确认记录或通用写入审计。
7. **【建议】M1 可以进入，但只做“骨架 + 服务容器 + stdio 传输”。** M2 前必须先解决文件模型对齐、需求作用域校验、只读副作用、结果规模限制、记忆/进度两个能力；M3 前必须补齐写入授权、确认与审计。M1 不需要修改任何业务规则。

**阶段门禁**

| 阶段 | 是否可开始 | 前置条件 |
| --- | --- | --- |
| M1 基础骨架 | 审查确认后可以 | 确认本审查结论；确定 SDK 与 stdio 方案 |
| M2 只读工具 | 需先完成 5 项最小改造 | 文件模型对齐、作用域校验、只读无副作用、分页/截断、记忆与进度能力 |
| M3 受控写入 | 需先完成授权设计 | 写入开关、确认机制、操作者上下文、审计表/审计写入 |

---

## 1. 项目现状

### 1.1 技术栈

| 层 | 现状 | 证据 |
| --- | --- | --- |
| 前端 | Vue 3.5 + Element Plus 2.13 + Vite 7 + Vue Router + TipTap，单页应用 | `apps/web/package.json:11-26` |
| 后端 | Fastify 5.6 + Zod 3.25 + Drizzle ORM 0.45 + better-sqlite3 12.4 + tsup，ESM | `apps/server/package.json:6-21` |
| 数据库 | SQLite 单文件，WAL、外键、`busy_timeout=5000`，迁移版本 11 | `apps/server/src/db/migrate.ts:14-25` |
| 文件存储 | 工作区目录 + SQLite 元数据索引；磁盘是文件存在性的依据 | `README.md:86-96`、`apps/server/src/db/schema.ts:166-203` |
| 共享契约 | `packages/shared` 提供枚举、Zod Schema、类型；前后端共用 | `packages/shared/src/index.ts:1-142` |
| MCP SDK | **未安装**；`npm ls @modelcontextprotocol/sdk` 为空 | 2026-10-22 命令输出 |

### 1.2 启动方式与服务边界

- **【事实】** 开发模式由 `concurrently` 同时启动 API 与 Vite：API 监听 `127.0.0.1:3001`，前端 `127.0.0.1:5173`，Vite 代理 `/api`（`README.md:9-14`、`package.json:13-22`）。
- **【事实】** 生产模式由 Fastify 单服务提供 `apps/web/dist` 与 API；入口 `createApp({ serveWeb: true })`，只监听本机 `127.0.0.1`（`apps/server/src/index.ts:2-23`、`apps/server/src/app.ts:694-713`）。
- **【事实】** 服务关闭由 `onClose` 关闭 SQLite 连接，进程信号触发 `app.close()`（`apps/server/src/app.ts:119`、`apps/server/src/index.ts:8-18`）。
- **【事实】** 数据库与工作区路径来自 `.env` / 环境变量，默认 `data/superpm.sqlite` 与 `workspace/`；路径相对项目根目录解析（`apps/server/src/config/index.ts:17-39`）。

### 1.3 前后端通信与认证

- **【事实】** 前端通过 `fetch('/api' + path)` 调用 REST JSON；统一从 `{ error: { code, message } }` 解析错误；401 会跳转登录页（`apps/web/src/api/client.ts:12-54`）。
- **【事实】** 除 `/api/health`、`/api/system`、`/api/auth/login` 与旧版图片原始读取外，所有 `/api/*` 都要求有效会话 Cookie（`apps/server/src/app.ts:151-174`）。
- **【事实】** 会话是 HMAC-SHA256 签名的 `httpOnly` Cookie，有效期 7 天；密码用 scrypt 派生，签名密钥保存在 `app_meta`（`apps/server/src/services/auth.ts:11-59`、`apps/server/src/services/auth.ts:144-167`）。
- **【事实】** 当前认证是“单用户本地登录”，没有按工具、按操作或按调用方的细粒度权限模型，也没有二次确认机制。
- **【风险提示】** `/api/system` 是公开端点，且返回 `databasePath`、`workspacePath` 绝对路径（`apps/server/src/app.ts:152-156`、`apps/server/src/app.ts:175-179`）。这不影响 MCP 的 stdio 方案，但说明现有 HTTP 层已经存在“向未认证调用者暴露系统路径”的行为；MCP 不应复用该接口，后续也建议收敛。

### 1.4 测试基线

- **【事实】** 单元/集成测试使用 Vitest，真实临时 SQLite 与临时工作区；已有 `mcp-gateway.test.ts`、`issues.test.ts`、`artifacts.test.ts`、`requirement-directory.test.ts`、`workspace.test.ts` 等。
- **【事实】** 浏览器测试使用 Playwright；`scripts/e2e-server.ts` 以 `serveWeb: true` 启动隔离服务（`scripts/e2e-server.ts:6-13`），因此 E2E 前需要构建前端。
- **【事实】** 本轮 M0 未改动代码，未重新运行测试；基线以最近一次通过的完整测试为准。

---

## 2. 核心业务结构

### 2.1 需求模型

- **【事实】** `requirements` 表保存需求编号、名称、类型、优先级、描述/HTML、状态、当前阶段、父需求、六类日期、软删除标记（`apps/server/src/db/schema.ts:13-45`）。
- **【事实】** 需求支持两级：`RequirementService.checkParent()` 限制父需求必须为主需求，且存在子需求的主需求不能删除（`apps/server/src/services/requirements.ts:61-95`）。
- **【事实】** 需求编号由仓储层取当前最大 ID 后生成 `REQ-0001` 形式，并依赖唯一约束（`apps/server/src/repositories/requirements.ts:55-76`）。
- **【事实】** 状态与阶段相互独立；阶段变更写入 `requirement_history`，需求增删改写入 `requirement_audit`（`apps/server/src/services/requirements.ts:40-69`、`apps/server/src/db/schema.ts:47-67`、`apps/server/src/repositories/requirements.ts:179-200`）。
- **【事实】** 需求列表具备搜索、筛选、排序、分页，`pageSize` 上限 100（`packages/shared/src/index.ts:101-142`、`apps/server/src/repositories/requirements.ts:99-178`）。

### 2.2 问题模型

- **【事实】** `issues` 表保存所属需求、产生阶段、标题、类型、状态、解决方案、解决时间、软删除标记（`apps/server/src/db/schema.ts:80-104`）。
- **【事实】** 问题正文自迁移 0009 起以工作区 `issues/{id}.md` 为唯一权威存储，数据库 `description` / `description_html` 仅存量兼容（`apps/server/src/services/issues.ts:113-122`、`packages/shared/src/index.ts:463-479`）。
- **【事实】** 问题活动是追加式历史：评论、解决方案、状态变更、系统记录；`actor_type` 支持 `user/ai/system`，但服务层当前固定写入 `local-user`（`apps/server/src/db/schema.ts:106-135`、`apps/server/src/services/issues.ts:111`、`apps/server/src/services/issues.ts:229-310`）。
- **【事实】** 问题与产出物的关联已切换到 `issue_artifact_links`，`assetId` 指向 `artifact_nodes.id`；关联时校验节点与问题同属一个需求，重复关联返回 `CONFLICT`（`apps/server/src/services/issues.ts:328-405`、`apps/server/src/db/schema.ts:137-164`）。
- **【事实】** 问题的跨需求读取、更新、删除、关联都有测试覆盖（`apps/server/tests/issues.test.ts:468-487`、`apps/server/tests/issues.test.ts:601-615`）。

### 2.3 文件/产出物：两套模型并存（关键发现）

| 模型 | 表/服务 | 使用者 | 特征 |
| --- | --- | --- | --- |
| 旧资产模型 | `requirement_files` / `RequirementFileService` | 旧“需求进展”文件区、当前 MCP 契约的 `asset.*` | 按 `phase + category` 组织，支持 `file/link/text`、`isFinal/status`，文件落在 `files/` |
| 知识库模型 | `artifact_nodes` + `artifact_links` / `ArtifactService` | 当前 UI“文档管理”、问题关联、需求记忆 | 文件夹树，磁盘为事实来源，支持外部修改检测、图片相对路径、系统资源保护 |

- **【事实】** 迁移 0007 明确写明“旧 `requirement_files` 体系保留不动”（`apps/server/drizzle/0007_artifacts.sql:1-2`）。
- **【事实】** 当前 UI 的文档管理、图片上传、需求记忆、问题关联都调用知识库 API（`apps/web/src/api/artifacts.ts:12-143`、`apps/web/src/features/requirements/RequirementDocManager.vue:193-575`、`apps/web/src/features/requirements/RequirementIssuesPanel.vue:766`）。
- **【事实】** 现有 MCP 契约的 `asset.list/get/create/updateStatus` 全部指向旧 `RequirementFileService`（`apps/server/src/services/mcp-gateway.ts:120-160`、`apps/server/src/services/mcp-gateway.ts:115-118`）。
- **【风险】** 两个表的主键都从 1 自增。模型若把 `asset.list` 返回的 `requirement_files.id` 用作 `issue.linkAsset` 的 `assetId`，可能关联到同需求下另一个 `artifact_nodes` 节点，造成“看起来成功、实际关联错文件”。这不是理论风险，而是当前契约的直接组合路径。

### 2.4 需求进度模型（待定义）

- **【事实】** 当前没有 `progress` 表、`ProgressService` 或独立进度 API。
- **【事实】** 可用的进度信息分散在：
  - `requirements.status` 与 `requirements.currentStage`；
  - `requirement_history`（阶段变更）；
  - `issues` 的状态计数；
  - `artifact_nodes` / `artifact_links` 的产出物结构；
  - `requirement_directories` 的目录初始化状态。
- **【事实】** `requirement_workspaces` 保存过一份阶段工作区 JSON，`StageWorkspaceService` 仍注册了 `/api/requirements/:id/workspace` 路由（`apps/server/src/services/stage-workspace.ts:20-77`、`apps/server/src/app.ts:464-495`）；但当前 Web 组件没有调用 `requirementApi.workspace/saveWorkspace`，只保留了 API 客户端方法（`apps/web/src/api/requirements.ts:37-43`）。这部分是历史能力，不能直接当作“需求进度”的权威模型。
- **【事实】** 当前详情页固定页签为“需求详情 / 文档管理 / 问题记录”，没有独立“需求进展”页签（`apps/web/src/pages/RequirementDetailPage.vue:60-66`、`apps/web/src/pages/RequirementDetailPage.vue:484-502`）。
- **【待确认】** `get_requirement_progress` 应返回哪些字段、以什么粒度表达“进度”，需要产品确认。建议第一版只做只读组合，不新建进度表。

### 2.5 相关服务与接口

| 服务 | 职责 | 主要入口 |
| --- | --- | --- |
| `RequirementService` | 需求 CRUD、父子关系、阶段历史、审计 | `/api/requirements*` |
| `IssueService` | 问题 CRUD、正文 md、活动、产出物关联 | `/api/requirements/:id/issues*` |
| `ArtifactService` | 知识库目录/文件/链接、需求记忆、图片、索引刷新 | `/api/requirements/:id/artifacts*`、`/api/artifacts/nodes*` |
| `RequirementFileService` | 旧资产模型（阶段/分类/确认版） | `/api/requirements/:id/files*` |
| `RequirementDirectoryResolver` | 需求物理根目录、路径安全、初始化/修复 | 被上述服务共用 |
| `StageWorkspaceService` | 旧阶段工作区 JSON 与图片 | `/api/requirements/:id/workspace`、`/images` |
| `AuthService` | 登录、会话签名、改密 | `/api/auth/*` |

- **【事实】** 服务在 `createApp()` 内联构造，数据库连接也由 `createApp()` 持有并在 `onClose` 关闭（`apps/server/src/app.ts:68-119`）。MCP 进程如果直接复制这段构造逻辑，会产生第二套装配代码。
- **【事实】** 路由层负责参数解析、Zod 校验与错误映射；业务规则基本在服务层（`apps/server/src/app.ts:120-149`、`apps/server/src/app.ts:221-693`）。

---

## 3. 业务逻辑复用情况

### 3.1 已统一服务化的逻辑

- **【事实】** 需求业务规则、编号、父子校验、阶段历史与审计在 `RequirementService` / `RequirementsRepository`。
- **【事实】** 问题正文落盘、状态流转、解决方案守卫、活动记录、产出物关联在 `IssueService`。
- **【事实】** 知识库文件/目录/链接、系统资源保护、图片引用检查、外部修改检测在 `ArtifactService`。
- **【事实】** 物理根目录解析、可读目录命名、越界/符号链接校验、初始化与修复在 `RequirementDirectoryResolver`，并被多个服务共用（`apps/server/src/app.ts:89-114`）。
- **【事实】** 外部链接协议白名单在共享层 `isSafeExternalUrl()`，并在旧资产与新知识库两个服务中分别执行（`packages/shared/src/index.ts:555-558`、`apps/server/src/services/requirement-files.ts:207-213`、`apps/server/src/services/artifacts.ts:889-896`）。

### 3.2 仍在路由层 / UI 层 / 未服务化的逻辑

- **【事实】** 认证与授权在 Fastify `onRequest` Hook，不在业务服务内；MCP 若走 stdio，不能复用它，需要单独定义本地信任边界。
- **【事实】** 操作者身份在 `IssueService` 中硬编码为 `local-user`；需求审计只记录 action/payload，没有调用来源（`apps/server/src/services/issues.ts:111`、`apps/server/src/repositories/requirements.ts:190-200`）。
- **【事实】** 错误映射在 `app.ts` 的 `setErrorHandler`；MCP 需要自己的错误映射，不能把 Fastify 的错误响应直接复用。
- **【事实】** 列表分页只在需求列表实现；问题列表与知识库目录列表返回全部结果（`apps/server/src/services/issues.ts:139-174`、`apps/server/src/services/artifacts.ts:215-258`）。
- **【事实】** 需求进度没有服务，只有分散字段。
- **【事实】** 旧 `StageWorkspaceService` 仍在装配和路由中，但 Web 已不使用，属于待清理/待确认的历史能力。

### 3.3 需要的最小服务化

以下改造都应只增加薄封装或组合，不重写业务规则：

1. **服务容器（M1）**：把 `createApp()` 中的数据库打开、迁移、服务构造提取为可复用的 `createServiceContainer()`；HTTP 与 MCP 共用同一装配，数据库生命周期由容器管理。这样 MCP 不会复制 `RequirementService` / `ArtifactService` 的构造顺序与路径配置。
2. **需求作用域的 artifact 门面（M2）**：`ArtifactService` 的方法目前只接收 `nodeId`，不接收 `requirementId`（如 `getNodeDetails`、`readText`、`raw`、`saveText`）。MCP 必须新增 `getNode(requirementId, nodeId)` / `readText(requirementId, nodeId)` 之类的门面，先校验节点属于该需求，再调用原方法。不能把这段 SQL 写进 MCP 网关。
3. **只读需求记忆（M2）**：`ensureMemory()` 会在未初始化时创建目录和模板文件（`apps/server/src/services/artifacts.ts:970-1052`）。MCP 需要一个不初始化、只读取的 `readMemory(requirementId)`：存在则返回内容，缺失则返回 `NOT_FOUND`/`missing` 状态，不产生副作用。
4. **只读目录列表（M2）**：`listNodes()` 会调用 `lightCheck()`，可能写 `artifact_nodes.status`、补登记磁盘新文件（`apps/server/src/services/artifacts.ts:215-258`、`apps/server/src/services/artifacts.ts:1479-1577`）。MCP 需要 `listNodes(..., { sync: false })` 或单独的只读查询方法。
5. **进度组合服务（M2）**：新增只读 `RequirementProgressService`，组合 `RequirementService.get/history`、`IssueService.list` 的计数、`ArtifactService` 的只读统计与目录状态；不新增进度表，不复制状态规则。
6. **分页/截断（M2）**：问题列表增加 `limit` / `page` 或至少 `limit`；知识库列表按目录返回并限制单次数量；文本内容按最大字符数截断并返回 `truncated` 标记。需求列表已有分页，可直接复用。
7. **操作者与审计上下文（M3）**：给写服务增加可选的 `actor: { type, name, source }`，写入 `issue_activities.actor_type/actor_name` 和审计记录；不要在服务内部继续硬编码 `local-user`。

### 3.4 重复实现风险

| 风险 | 说明 | 规避 |
| --- | --- | --- |
| 两套文件逻辑 | MCP 若继续用 `RequirementFileService`，会与 UI 的知识库数据完全分叉 | M2 前把对外工具切到 `ArtifactService`，旧 `asset.*` 不再对外暴露 |
| 两套进度逻辑 | 若在 MCP 网关内直接查库拼进度，会绕过需求服务且难以与 UI 对齐 | 新增只读组合服务，网关只转发 |
| 两套路径规则 | 若 MCP 自己拼路径或接受相对路径，会绕过 `RequirementDirectoryResolver` | MCP 只接受 `requirementId` + `nodeId`/`assetId`，不接受文件路径 |
| 两套错误结构 | Fastify 错误响应与 MCP 工具错误格式不同 | 在 MCP 边界统一映射；业务服务继续抛 `DomainError` |

---

## 4. 文件安全现状

### 4.1 需求根目录如何确定

- **【事实】** 需求 ID 映射到 `requirement_directories.relative_path`，默认形如 `requirements/REQ-0001 名称`；映射由 `RequirementDirectoryResolver.ensureMapping()` 生成，目录名由需求编号 + 名称清洗而来（`apps/server/src/services/requirement-directory.ts:76-115`、`packages/shared/src/index.ts:836-848`）。
- **【事实】** 关联依据始终是需求 ID，不依赖目录名；目录名变化不会改变 ID 关联（`apps/server/drizzle/0010_requirement_directories.sql:1-10`）。
- **【事实】** 新需求创建后由 `createApp()` 调用 `directories.initialize()` 初始化默认目录与 `需求记忆.md`；初始化失败不阻断建需，但会记录失败阶段（`apps/server/src/app.ts:221-233`、`apps/server/src/services/requirement-directory.ts:236-272`）。

### 4.2 相对路径如何解析

`RequirementDirectoryResolver.resolve()` 的校验顺序（`apps/server/src/services/requirement-directory.ts:152-181`）：

1. 取工作区根目录 `realpath`；
2. 以需求映射的相对根目录为起点；
3. 对传入的相对路径按 `/` 分段，拒绝空段、`.`、`..`；
4. 逐段 `join`，已存在的段检查 `lstat` 是否为符号链接；
5. 对每一段做 `realpath`，再用 `path.relative(rootAbs, resolved)` 判断是否以 `..` 开头或为绝对路径；
6. 越界或符号链接抛 `INVALID_PATH`。

- **【事实】** 知识库服务所有落盘操作都经 `resolvePath()` 委托给该解析器（`apps/server/src/services/artifacts.ts:1067-1077`）。
- **【事实】** 名称校验拒绝 `/`、`\`、Windows 保留字符、控制字符、连续点、首尾点/空格（`packages/shared/src/index.ts:631-639`）。
- **【事实】** 测试覆盖 `../escape`、`a/b`、`.`、`..`、非法字符、跨需求父目录，并验证不会在工作区外创建文件（`apps/server/tests/artifacts.test.ts:145-161`）。

### 4.3 是否限制跨需求访问

- **【事实】** 问题服务在读取/更新/删除问题、关联产出物时校验 `requirement_id` 或节点所属需求（`apps/server/src/services/issues.ts:424-431`、`apps/server/src/services/issues.ts:351-367`）。
- **【事实】** 知识库创建/移动/重命名时校验父节点属于同一需求（`apps/server/src/services/artifacts.ts:1093-1105`）。
- **【事实】** 但 `ArtifactService` 的 `getNodeDetails`、`readText`、`raw`、`saveText`、`renameNode`、`moveNode`、`deleteNode` 都只接收 `nodeId`，没有显式的 `requirementId` 参数（`apps/server/src/services/artifacts.ts:260-274`、`apps/server/src/services/artifacts.ts:499-560`、`apps/server/src/services/artifacts.ts:336-494`）。在单用户本地 HTTP 场景下由路由与登录态兜底；MCP 若直接暴露这些方法，必须在外层增加需求归属校验。
- **【结论】** 现有 HTTP 层面的跨需求访问有约束；MCP 不能假设“传了 nodeId 就一定属于当前需求”，这是 M2 的最小安全改造点。

### 4.4 系统级文件是否受到保护

- **【事实】** `需求记忆.md` 与 `images/` 是系统级资源；`ArtifactService.assertMutable()` 在重命名、移动、删除前检查，直接抛 `CONFLICT`（`apps/server/src/services/artifacts.ts:1316-1327`）。
- **【事实】** `isProtectedArtifactPath()` 只匹配根目录的这两个路径（`packages/shared/src/index.ts:849-855`）。
- **【事实】** 测试覆盖：记忆文件可编辑但不可删除/重命名/移动；`images` 目录不可删除/重命名/移动（`apps/server/tests/requirement-directory.test.ts:203-244`、`apps/server/tests/requirement-directory.test.ts:277-303`）。
- **【事实】** 普通目录可自由改名、移动、删除；删除非空目录需要显式 `recursive`（`apps/server/src/services/artifacts.ts:445-494`）。

### 4.5 图片引用与删除逻辑

- **【事实】** 图片上传写入需求根目录 `images/`，按文件头识别 PNG/JPEG/GIF/WebP，同名追加 `-1`、`-2` 后缀，不静默覆盖（`apps/server/src/services/artifacts.ts:566-645`）。
- **【事实】** Markdown 中保存相对当前文档目录的路径；图片读取以文档目录为基准反解，并限制在需求根目录内（`apps/server/src/services/artifacts.ts:673-699`）。
- **【事实】** 删除图片前扫描知识库文本文件、问题描述 md 与问题解决方案，若仍被引用则拒绝删除并提示来源（`apps/server/src/services/artifacts.ts:1150-1158`、`apps/server/src/services/artifacts.ts:1264-1314`）。
- **【事实】** 文档移动/重命名后会自动改写指向 `images/` 的相对引用；无法可靠还原的引用保持原样（`apps/server/src/services/artifacts.ts:1166-1257`）。
- **【事实】** 测试覆盖越界图片路径 `../../secret.png` 被拒绝、被引用图片阻止删除、移动后相对路径修正（`apps/server/tests/requirement-directory.test.ts:347-400`、`apps/server/tests/requirement-directory.test.ts:402-505`）。

### 4.6 残留风险

| 风险 | 现状与证据 | 影响 | 建议 |
| --- | --- | --- | --- |
| 旧资产路径未重新走解析器 | `RequirementFileService.resolveLocalPath()` 直接用 `join(root, relativePath)`（`apps/server/src/services/requirement-files.ts:415-423`） | 若数据库中的相对路径被篡改，可越界读取；正常业务写入路径由目录解析器生成 | MCP 不暴露旧资产；后续清理旧模型时统一改为解析器 |
| 符号链接 TOCTOU | 解析、`lstat` 检查与后续 `readFileSync` 之间存在时间窗 | 本地恶意进程可替换路径；非远程攻击面 | 保持本地 stdio、不接受路径参数；高风险操作可增加 `O_NOFOLLOW` 或打开后 `fstat` 校验（后续加固） |
| 知识库节点读取缺少需求参数 | `ArtifactService` 多个读方法只接收 `nodeId` | MCP 可能跨需求读取节点 | M2 增加需求作用域门面 |
| 文本内容可能包含提示注入 | 返回给 AI 的 Markdown/描述来自用户工作区，当前没有内容隔离机制 | 模型可能把文件内容当作指令 | M2 明确“内容是数据不是指令”；M4 增加恶意内容测试与 Harness 侧约束 |
| `/api/system` 公开绝对路径 | 公开端点返回数据库与工作区路径（`apps/server/src/app.ts:152-156`、`apps/server/src/app.ts:175-179`） | 本机信息泄露；与“不暴露完整系统路径”的目标不一致 | MCP 不使用该接口；建议后续限制为登录后访问 |

---

## 5. MCP 接入方案

### 5.1 推荐架构

```text
AI Harness (WorkBuddy / Codex / ...)
        │  MCP Protocol (stdio)
        ▼
superPM MCP Server (独立进程 / 独立入口)
  - Server 初始化 / 关闭
  - 工具注册（来自共享契约）
  - 参数校验 / 结果转换
  - 错误映射 / 审计
        │  直接调用 TypeScript 服务（不经过 HTTP）
        ▼
统一业务服务层
  RequirementService / IssueService / ArtifactService
  RequirementDirectoryResolver / 新增只读 ProgressService
        │
        ├── SQLite (data/superpm.sqlite, WAL)
        └── Workspace (workspace/requirements/...)
```

**【建议】选择 stdio，而不是把 MCP 挂到现有 Fastify HTTP 服务上。**

理由：

1. 【事实】服务只监听 `127.0.0.1`，定位是本地单用户工具（`apps/server/src/index.ts:20`）。
2. 【事实】现有认证基于浏览器 Cookie，MCP Harness 无法自然复用；若走 HTTP，需要新增 Token、CORS、CSRF、端口暴露与额外授权设计。
3. 【事实】规划 §7.2 要求“默认只允许受控的本地进程连接”“不应为了让外部工具连接而直接将本地服务暴露到公网”。
4. 【建议】stdio 由 Harness 作为子进程启动，OS 用户即信任边界；不需要开放网络端口，也避免把本地 HTTP 服务变成公网入口。

**不推荐**在第一版使用 HTTP/SSE 嵌入 Fastify。若未来需要远程访问，应单独设计身份认证、传输安全与权限隔离，不能直接复用当前 Cookie 会话。

### 5.2 SDK 与兼容性

- **【事实】** 2026-10-22 查询 npm：`@modelcontextprotocol/sdk` 最新版为 `1.32.1`，`engines.node >=18`；项目要求 Node `>=22.12 <25`，当前 Node v22.22.0，满足要求。
- **【事实】** 项目是 ESM（根 `package.json` 的 `"type": "module"`，`tsconfig` 使用 `module: ESNext`），SDK 为 ESM 包，构建链路兼容（`package.json:5-22`、`tsconfig.base.json:1-13`）。
- **【事实】** 当前项目没有安装 SDK；`npm ls @modelcontextprotocol/sdk` 为空。
- **【建议】** M1 使用官方 TypeScript SDK 的 stdio Server Transport；具体 API 以安装时的官方文档为准，不照搬旧版本示例。参考：
  - MCP 官方文档：<https://modelcontextprotocol.io/>
  - TypeScript SDK：<https://ts.sdk.modelcontextprotocol.io/>
  - 工具规范：<https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/server/tools.mdx>
- **【待确认】** 目标 Harness（WorkBuddy、Codex）对 MCP 协议版本、stdio 启动方式、工具名称字符集的支持情况，需要在 M1 用真实 Harness 做连通性验证。

### 5.3 MCP Server 位置与构建

**推荐位置：`apps/server` 内新增独立入口，而不是新建一个完整 workspace 包。**

建议文件：

```text
apps/server/src/mcp/
  server.ts        # 创建 MCP Server、注册工具、错误映射
  stdio.ts         # stdio 入口：加载配置、创建服务容器、连接 transport、处理退出
apps/server/src/services/
  container.ts     # 从 createApp 提取的服务容器（M1 最小重构）
```

构建与脚本建议：

- 在 `apps/server/package.json` 增加独立的 `mcp` 脚本，指向 `dist/mcp/stdio.js`；
- 在 `tsup` 构建中增加 MCP 入口（多 entry），或单独构建；
- MCP 入口**不得**启动 Fastify，也不得占用 3001 端口；
- 日志一律写 `stderr`，**stdout 只能输出 MCP 协议消息**，否则 Harness 会解析失败；
- 进程退出时关闭 SQLite 连接；异常不得让进程静默退出。

选择 `apps/server` 内的理由：服务、类型、配置、迁移都在同一包内，避免跨包复制依赖与路径；独立进程仍能与 UI 隔离。若后续需要严格隔离，再拆为独立 workspace 包，不影响本阶段架构。

### 5.4 工具注册与错误处理

- **【事实】** 现有 `mcpToolContracts` 已经是“名称 + 描述 + kind + input schema + allowedErrors + idempotency”的注册表（`packages/shared/src/mcp-contract.ts:309-420`）。
- **【事实】** `buildMcpTools()` 按契约建立执行器，readonly 直接转发，mutating 包幂等键（`apps/server/src/services/mcp-gateway.ts:115-175`）。
- **【建议】** M1/M2 继续以契约为唯一事实来源：MCP Server 遍历契约生成工具定义，不手工维护第二份工具清单；执行统一走 `McpGateway.call()`，网关只做校验、转发、错误结构化。
- **【建议】** 工具定义增加 MCP 注解（只读/破坏性/幂等提示），让 Harness 能在界面上区分只读与写入；注解只是提示，真正的权限仍由服务端控制。

**错误映射建议**

| 业务错误（`DomainError.code`） | MCP 工具结果 | 说明 |
| --- | --- | --- |
| `VALIDATION_ERROR` / ZodError | `INVALID_ARGUMENT` | 参数或业务校验失败；返回字段级信息，不回传堆栈 |
| `NOT_FOUND` | `NOT_FOUND` | 需求、问题、文件不存在或不属于当前需求 |
| `FORBIDDEN` | `PERMISSION_DENIED` | 未授权写入或功能未开启 |
| `CONFLICT` / `FILE_CONFLICT` | `CONFLICT` | 重复关联、版本冲突、同名冲突 |
| `INVALID_PATH` | `PATH_NOT_ALLOWED` | 路径越界或符号链接；MCP 不应接受路径参数，此类错误应极少出现 |
| `WORKSPACE_INIT_FAILED` | `INTERNAL_ERROR` | 目录初始化失败；日志记录细节，模型只看到通用提示 |
| 未预期异常 | `INTERNAL_ERROR` | 不把堆栈、SQL、绝对路径返回给模型；详情写 stderr |

- **【建议】** 未知工具、协议级参数错误使用 MCP 协议错误；可恢复的业务错误使用工具结果 `isError: true` + 稳定错误码，便于模型自行纠正。
- **【事实】** 现有网关对 `ZodError` / `DomainError` 返回 `{ error: { code, message } }`，但未处理未预期异常（会原样上抛）（`apps/server/src/services/mcp-gateway.ts:175-198`）。M1 必须在 Server 边界统一兜底。

### 5.5 业务服务复用方案

| 能力 | M2 推荐实现 | 关键改造 |
| --- | --- | --- |
| 需求列表/详情 | `RequirementService.list/get` | 复用现有分页；`get` 目前只接受 ID，规划要求支持编号，可增加 `requirementNo` 查询或明确只支持 ID |
| 需求记忆 | 新增 `ArtifactService.readMemory(requirementId)` | 不触发 `ensureMemory()` 初始化；只读 |
| 需求进度 | 新增只读 `RequirementProgressService` | 组合需求字段、阶段历史、问题计数、产出物统计；不新增表 |
| 问题列表/详情/活动 | `IssueService.list/detail` | 增加结果上限/分页；保留跨需求校验 |
| 文件/目录列表 | `ArtifactService` 只读列表 | 增加 `sync: false`；按 `parentId` 浏览，限制单次数量 |
| 文件内容读取 | 新增 `ArtifactService.readText(requirementId, nodeId)` | 先校验节点归属；仅文本类型返回正文，二进制返回元数据 |
| 文件元数据/搜索 | `ArtifactService.listNodes` / `searchNodes` | 只读模式；返回相对路径，不返回绝对路径 |

**对外工具取舍建议**

- **M2 不暴露旧 `asset.*`**：把对外工具改为知识库语义（如 `artifact.list` / `artifact.get` / `artifact.search`），或在内部把 `asset.*` 重新实现为 `ArtifactService` 的薄封装并改名。当前尚未对外发布，没有兼容负担，建议直接修正。
- **保留 `issue.linkAsset` 的 `assetId` 语义**：它已经指向 `artifact_nodes.id`，与知识库一致；文档中明确“asset = artifact node”。
- **M2 不提供二进制内容**：`artifact.get` 对图片/PDF 只返回元数据（名称、MIME、大小、相对路径、状态），不返回 base64 或绝对路径；文本类 Markdown/TXT 返回截断后的正文。
- **M2 工具清单建议**（9 个只读）：
  1. `requirement.list`
  2. `requirement.get`
  3. `requirement.memory.get`
  4. `requirement.progress.get`
  5. `issue.list`
  6. `issue.get`
  7. `issue.activities`
  8. `artifact.list`（含目录浏览与名称搜索）
  9. `artifact.get`（元数据 + 文本正文）
- **【待确认】** 是否保留 `asset.*` 名称、是否把 `issue.activities` 合并进 `issue.get`、是否增加 `artifact.tree`，可在 M1 前定稿；不影响 M1 骨架。

### 5.6 写入（M3）建议

M3 不应直接开放全部写工具。建议分两批：

**第一批（低风险、边界清晰）**

- `issue.update`：继续保留“保存 solution”与“置为 resolved”分两步的网关守卫（`apps/server/src/services/mcp-gateway.ts:131-150`）。
- `issue.comment`：追加评论，保留活动记录。
- `issue.linkAsset` / `issue.unlinkAsset`：只改变关联关系，不删除文件本体。
- `artifact.updateText`（若确认需要）：仅允许更新已有文本文件，沿用 `saveText()` 的外部修改冲突保护（`apps/server/src/services/artifacts.ts:513-542`）。

**第二批（需更强确认，建议延后）**

- `requirement.create` / `requirement.update`：涉及编号生成、状态流转、父子关系，风险较高；且多进程并发生成编号需要额外验证。
- `issue.create`：与当前契约“没有 issue.create”冲突，见待确认事项。
- `artifact.create`（新建文本文件/文件夹/链接）、二进制上传、删除/移动/重命名。
- `requirement.memory.update`：需求记忆是系统级资源，内容可编辑，但必须有明确授权与审计。

**写入安全前提**

1. **默认关闭写入**：MCP Server 启动时默认只注册只读工具；通过显式配置（如 `SUPERPM_MCP_WRITE=1`）才注册写工具。
2. **确认机制**：建议采用服务端两步确认（`prepare` 返回带 TTL 的确认令牌，`confirm` 携带令牌执行），令牌绑定工具名 + 参数哈希；不完全依赖模型自觉。也可结合 MCP Elicitation，但需先确认 Harness 支持。
3. **操作者上下文**：写入时传入 `actorType: "ai"`、`actorName`（Harness 名称）与来源；问题活动不再固定 `local-user`。
4. **审计**：记录工具名、需求 ID、目标对象 ID、参数哈希、结果、确认令牌 ID、时间；不记录密码、令牌、完整文件内容或绝对路径。可新增追加式 `mcp_audit` 表，或扩展 `requirement_audit` 的 action/payload；建议新增独立表，避免污染现有需求审计语义。
5. **幂等**：现有内存幂等 Map 只适合单进程、无重启场景（`apps/server/src/services/mcp-gateway.ts:56-90`）。M3 若要求重启后仍幂等，需要持久化幂等键或至少明确“重启后同键会重新执行”的限制。

---

## 6. 风险与待确认事项

### 6.1 风险清单

| 编号 | 现状与证据 | 风险 | 建议 | 是否阻塞 |
| --- | --- | --- | --- | --- |
| R1 | MCP `asset.*` 指向旧 `requirement_files`，UI 使用 `artifact_nodes`（`mcp-gateway.ts:120-160`、`artifacts.ts:194-198`） | 工具返回空数据或与 UI 不一致；旧/新 ID 混用可能关联错文件 | M2 前把对外文件工具切到 `ArtifactService`，旧 `asset.*` 不对外暴露 | **阻塞 M2** |
| R2 | 现有契约没有需求记忆、需求进度工具（`mcp-contract.ts:23-44`、`309-420`） | 无法满足 M2 规划的核心上下文能力 | 增加 `readMemory` 与只读 `ProgressService`，不新建进度表 | **阻塞 M2** |
| R3 | `ArtifactService.listNodes()`/`ensureMemory()` 会写索引或初始化（`artifacts.ts:215-258`、`970-1052`） | 只读工具产生副作用，违反 M2 验收 | 增加 `sync:false` 与不初始化的 `readMemory` | **阻塞 M2** |
| R4 | `ArtifactService` 多个方法只接收 `nodeId`（`artifacts.ts:260-274`、`499-560`） | MCP 可能读取其他需求的节点 | 增加 `requirementId` 作用域门面，统一校验归属 | **阻塞 M2** |
| R5 | 问题列表无分页、知识库目录一次返回全部（`issues.ts:139-174`、`artifacts.ts:215-258`） | 数据量大时返回超限，模型上下文被淹没 | 增加 `limit`/目录浏览/文本截断，默认 50、上限 200 | **阻塞 M2**（可实现后放行） |
| R6 | 认证只在 Fastify Hook；操作者硬编码 `local-user`；无确认与通用审计（`app.ts:151-174`、`issues.ts:111`） | 写入无法证明“谁在什么授权下改了什么” | M3 前增加写入开关、确认令牌、actor 上下文、审计表 | **阻塞 M3** |
| R7 | 当前契约明确没有 `issue.create`，规划 §4.2/§M5 又要求授权后创建问题（`mcp-contract.ts:37-44`） | 需求目标与现有安全边界冲突 | 默认保持不提供；如要提供，必须等确认+审计落地后单独评审 | **阻塞 M3（需决策）** |
| R8 | 现有 `mcp-gateway` 对未预期异常原样上抛（`mcp-gateway.ts:175-198`） | MCP 进程可能异常退出或把堆栈暴露给 Harness | M1 在 Server 边界统一捕获、记录 stderr、返回通用错误 | 阻塞 M1（实现项） |
| R9 | stdio 与 Fastify 共用 stdout/日志习惯 | 日志写入 stdout 会破坏 MCP 协议 | M1 强制 MCP 日志走 stderr，增加连通性测试 | 阻塞 M1（实现项） |
| R10 | UI 与 MCP 可能同时写 SQLite；迁移在启动时执行（`migrate.ts:22-53`） | `SQLITE_BUSY`、迁移竞争、写入冲突 | 复用 WAL + `busy_timeout`；MCP 启动也执行幂等迁移；写入串行化/重试并映射为 `CONFLICT` | 不阻塞 M1；阻塞 M3 前验证 |
| R11 | `/api/system` 公开返回绝对路径（`app.ts:152-156`、`175-179`） | 本机信息泄露，与“不暴露系统路径”原则不一致 | MCP 不使用；建议后续限制 | 不阻塞 MCP；建议修复 |
| R12 | 文件内容是用户可控 Markdown，可能含提示注入（`issues.ts:407-410`、`artifacts.ts:499-510`） | 模型可能把文档内容当作指令 | M2 在结果中明确内容边界；M4 增加恶意内容测试 | 不阻塞 M1/M2；M4 必须覆盖 |
| R13 | 旧 `requirement_files` 的 `resolveLocalPath` 直接 `join`（`requirement-files.ts:415-423`） | 数据库被篡改时可越界 | MCP 不暴露旧模型；后续清理 | 不阻塞（MCP 不使用） |
| R14 | 需求编号按当前最大 ID 生成（`repositories/requirements.ts:55-76`） | 多进程并发创建可能撞唯一约束 | M3 创建需求前做并发测试/重试；M2 不涉及 | 不阻塞 M2；M3 关注 |
| R15 | 旧 `StageWorkspaceService` 仍在装配与路由，但 Web 不再使用（`stage-workspace.ts:20-77`、`app.ts:464-495`） | “进度”语义混淆，后续可能误用旧 JSON | 明确进度以需求字段 + 历史 + 问题/产出物为准；旧接口标记 legacy | 不阻塞 M1；影响 M2 进度设计 |

### 6.2 待确认事项

1. **【待确认】“需求进度”的定义。** 建议第一版返回：需求基本信息、`status`、`currentStage`、阶段历史、问题状态计数、产出物目录统计、目录初始化状态；不读取旧 `requirement_workspaces`。是否满足产品预期？
2. **【待确认】文件工具是否彻底切换到知识库模型。** 建议 M2 对外使用 `artifact.*`，不再暴露旧 `asset.*`；旧 `requirement_files` 仅保留给历史数据/后续清理。是否同意？
3. **【待确认】需求记忆读取是否允许懒初始化。** 建议 MCP 只读不初始化，缺失时返回 `NOT_FOUND` 或 `missing`；UI 仍保留懒初始化。是否接受？
4. **【待确认】`issue.create` 是否开放。** 当前契约出于安全考虑明确不提供；规划 M5 又描述“用户明确授权后创建正式问题”。建议 M3 暂不开放，等确认与审计机制验证后再单独评审。
5. **【待确认】写入授权方式。** 采用服务端两步确认令牌，还是依赖 Harness 的 Elicitation？建议两者都支持：服务端令牌是强制底线，Elicitation 只作为交互体验。
6. **【待确认】审计落点。** 新增 `mcp_audit` 表，还是扩展 `requirement_audit`？建议新增独立表，保留调用来源、工具名、目标对象、参数哈希、结果与确认令牌 ID。
7. **【待确认】工具命名。** 现有契约使用 `requirement.list` 这种点号命名；规划使用 `list_requirements` 这种下划线命名。MCP 客户端通常都能接受字符串名称，但某些 Harness 可能做名称规范化；建议在 M1 用目标 Harness 验证后统一，不要同时维护两套别名。
8. **【待确认】M2 是否读取二进制文件。** 建议 M2 只返回元数据，不返回 base64；如确需读取图片/PDF，应设计受控的资源访问方式，而不是把大块二进制塞进工具结果。
9. **【待确认】是否开放需求创建/更新。** 规划第二阶段包含 `create_requirement` / `update_requirement`，当前契约没有。建议 M3 先不开放，优先验证问题与文件写入。
10. **【待确认】目标 Harness 清单与启动方式。** 需要确认 WorkBuddy、Codex 各自如何配置 stdio Server、是否支持工具注解与 Elicitation，以便 M1 做真实连通性测试。

---

## 7. 分阶段实施建议

### M1：MCP 基础骨架（建议范围）

**目标**：建立可运行、可调试、与 UI 隔离的 stdio MCP Server，不实现业务写工具。

**范围**

1. 引入官方 TypeScript SDK（M1 才安装依赖）。
2. 从 `createApp()` 提取 `createServiceContainer()`：打开数据库、执行迁移、构造服务；HTTP 与 MCP 共用。该重构不改变任何业务规则与接口行为。
3. 新增 `apps/server/src/mcp/server.ts` 与 `stdio.ts`；使用 stdio transport；日志走 stderr。
4. 注册一个最小只读工具（如 `system.info`：版本、schemaVersion、能力开关；**不返回绝对路径、不返回数据库路径**），用于连通性验证。
5. 实现 Server 初始化、关闭、异常兜底；MCP 进程退出时关闭 SQLite。
6. 编写启动/调试说明（Harness 配置示例、环境变量、日志位置）。

**依赖**

- 本审查确认；
- 目标 Harness 的 stdio 配置方式；
- SDK 版本与 Node 22 兼容性验证（已确认 SDK 1.32.1 `engines >=18`，仍需实际安装验证）。

**验收标准**

- MCP Client 能成功连接并列出工具；
- 工具调用返回结构化结果；
- 未预期异常不会导致进程退出；错误不包含堆栈/绝对路径；
- stdout 无日志污染；
- 服务可正常关闭，SQLite 连接释放；
- 原有 UI、REST API、测试不受影响。

### M2：只读查询工具（建议范围）

**目标**：让外部 AI 获取需求、记忆、问题、产出物、进度上下文，且严格只读。

**范围**

1. 文件工具切换到 `ArtifactService`；新增需求作用域门面；旧 `asset.*` 不对外暴露。
2. 新增 `requirement.memory.get`（不初始化）与 `requirement.progress.get`（只读组合）。
3. `issue.list` 增加分页/上限；`artifact.list` 按目录浏览并限制数量；文本内容截断。
4. 所有只读工具使用 `sync:false` 路径，不写索引、不初始化目录、不改状态。
5. 工具级测试 + Harness 实际调用记录。

**依赖**

- M1 完成；
- R1–R5 关闭；
- “需求进度”字段确认。

**验收标准**

- 返回结果与 UI 展示一致（需求、问题、文档、记忆）；
- 跨需求节点读取返回 `NOT_FOUND`；
- 只读工具调用前后数据库业务数据与索引无变化；
- 不存在绝对路径、堆栈、密钥泄露；
- 大量数据可通过目录浏览、分页、截断控制返回规模；
- 文件不存在、节点不存在、参数错误返回可理解错误。

### M3：受控写入（建议范围）

**目标**：在明确授权、可追溯审计的前提下开放低风险写入。

**范围（建议第一批）**

- `issue.update`（保留 solution/status 两步守卫）；
- `issue.comment`；
- `issue.linkAsset` / `issue.unlinkAsset`；
- 视确认结果决定是否加入 `artifact.updateText`。

**暂不开放**

- `requirement.create/update`；
- `issue.create`（除非完成专项确认）；
- 文件删除/移动/重命名、二进制上传、旧资产写入。

**依赖**

- M2 完成；
- 写入开关、确认令牌、actor 上下文、审计表落地；
- SQLite 并发写入验证。

**验收标准**

- 默认配置下写工具不可见/不可调用；
- 未授权、无确认令牌、令牌过期、参数哈希不匹配均被拒绝；
- 参数不合法不产生部分写入；
- 重复调用不产生重复记录；
- UI 能查询到写入结果与操作者/来源；
- 错误不泄露敏感信息。

### M4–M6

- **M4**：按规划执行非法参数、路径穿越、符号链接、无授权写入、重复提交、数据库/文件系统异常、敏感信息泄露、提示注入等安全测试。
- **M5**：按“需求分析 / 问题跟进 / 产出物管理”三个场景做真实 Harness 试运行；重点验证“AI 建议”与“正式写入”分离。
- **M6**：补齐工具清单、参数/返回说明、安装配置、权限与安全说明、自动化测试说明、版本兼容性说明。

---

## 8. M0 验收对照

| 验收项 | 本报告情况 |
| --- | --- |
| 关键结论能对应真实代码/实现 | 各节均给出文件与行号；文件模型、路径安全、认证、网关均有直接证据 |
| 区分已确认事实、合理推测、待确认事项 | 使用【事实】【推测】【待确认】标记；风险表与待确认清单单列 |
| 给出最小可行接入方案 | M1 服务容器 + stdio 骨架；M2 只读工具；M3 受控写入 |
| 列明接入前必须解决的问题 | R1–R9 为 M1/M2/M3 门禁；R10–R15 为后续/验证项 |
| 提交审查文档后等待用户确认 | 本文件提交后暂停，不进入 M1、不创建 MCP Server、不修改业务代码 |

---

**本阶段未执行的事项（按要求）**

- 未修改任何业务代码、配置、数据库或工作区文件；
- 未安装 `@modelcontextprotocol/sdk` 或其他新依赖；
- 未创建 MCP Server、未注册 MCP 路由、未改动 UI；
- 未删除或迁移任何用户数据。
