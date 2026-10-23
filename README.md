# superPM workbench

本地优先的需求管理工作台。当前是阶段一的基础框架与需求主链路，可在 Windows 本机运行。完整阶段一功能按模块逐步建设。

## 运行

需要 Node.js 22 LTS（>=22.12）和 npm。推荐当前项目验证过的 Node 22；SQLite 驱动在安装时下载预编译包，需联网。

```powershell
npm install
npm run dev
```

浏览器打开 http://127.0.0.1:5173，API 监听 http://127.0.0.1:3001。开发时前端代理 `/api`。首次启动自动建立数据库与迁移，不写入示例需求。

生产模式在单个服务中提供前端和 API：

```powershell
npm run build
npm start
```

打开 http://127.0.0.1:3001。使用 Ctrl+C 停止服务。

## 登录与账号

- 打开任意页面会先进入登录页（`/login`，复用 ease-ui 浅色/深色主题，跟随系统与顶栏主题切换）。
- 默认账号：`admin`，默认密码：`admin123`（首次登录后请在右上角用户菜单中修改密码）。
- 会话使用 HMAC 签名 Token 写入 httpOnly Cookie，7 天有效；退出登录或 401 会回到登录页。
- 密码使用 node crypto scrypt 派生密钥存储；签名密钥首次启动随机生成并保存在数据库 `app_meta` 表中，重启后登录态不失效。

## 当前能力

- 需求新增、查看、编辑和软删除；业务编号不可修改、不会复用。
- 两级主子需求；主需求存在有效子需求时禁止删除。
- 编号/名称搜索，类型、优先级、状态与阶段筛选，基础排序、主需求分页。
- 详情抽屉与四阶段工作区骨架。浏览阶段不修改业务数据，“设为当前阶段”才保存并记录历史。
- 状态与阶段独立；关键变更和阶段历史通过数据库事务保存。
- 未保存关闭和页面离开保护，API 失败提示，真实存储路径查看。
- 需求文档知识库：多层级文件夹、Markdown 文件、外部链接，磁盘为唯一事实来源，支持外部修改刷新。
- 需求问题跟踪：问题、活动记录与文件关联。
- 需求物理目录自动初始化：可读目录名（`REQ-xxxx 名称`）、默认目录与系统级资源、失败可重试。
- 前后端共享契约、真实 SQLite 集成测试、浏览器验收和 GitHub Actions CI 流水线。

未实现：测试闭环、任务历史、通知、自定义字段、表格视图持久化、FTS5、备份恢复。MCP 提供只读查询与默认关闭的受控写入（问题更新、评论、产出物关联），详见 `docs/mcp.md`。软删除数据目前保留在数据库中，回收站界面随后建设。

描述字段使用 Tiptap 兼容 JSON；需求文档以 Markdown 落盘，图片写入需求根目录 `images/` 并以相对路径引用。

## 工程结构

```text
apps/web/src/
  api/                       HTTP 客户端
  components/ease-ui/         Ease UI 实际复制组件与 MIT 许可
  features/requirements/     需求业务逻辑与详情工作区
  pages/                     工作台、任务/通知骨架、设置
  router/                    页面导航
apps/server/src/
  config/                    根目录配置与 .env
  db/                        Drizzle 模型与迁移入口
  repositories/              SQLite 读写
  services/                  事务、编号、父子关系等业务规则
  mcp/                       stdio MCP Server 与工具注册
  storage/                   Workspace 相对路径校验边界
apps/server/drizzle/         版本化 SQL 迁移
packages/shared/src/         枚举、Zod Schema、类型
tests/e2e/                  浏览器操作验收
docs/superpowers/            本轮设计与执行计划
```

REST 与 MCP 都通过 Core Service 访问事实数据，不直接拼接 SQL 或任意读写本地路径。现阶段以需求模块为可执行参考，其他模块逐次增加 schema、repository、service、API 和页面。

UI 基于 Vue 3 + Element Plus，并按用户指定集成 [Ease UI](https://github.com/Momingyun/ease-ui) 的按钮、抽屉、空状态单文件组件。上游来源、固定提交与 MIT 许可见 `apps/web/src/components/ease-ui/`。

## 数据位置

默认 `data/superpm.sqlite` 和 `workspace/`，均不进入 Git。复制 `.env.example` 为 `.env` 后可设置：

```dotenv
PORT=3001
SUPERPM_DATA_DIR=./data
SUPERPM_WORKSPACE_DIR=./workspace
```

路径相对于项目根目录；变更后重启服务。开发端口代理固定为 3001，若修改 API 端口需同步 `apps/web/vite.config.ts`。

需求分析正文来自工作区文件，不是数据库正文记录。`requirement_files` 表只保存所属需求、分类、文件名、确认状态等元数据；默认分析记录位于需求根目录的 `analysis/分析记录/analysis-record.md`，上传文件按分类保存并使用独立的实际文件名。

需求根目录使用「需求编号 + 空格 + 需求名称」的可读命名（如 `workspace/requirements/REQ-0001 名称/`），映射关系保存在 `requirement_directories` 表，关联依据始终是需求 ID。根目录下自动初始化 `需求记忆.md`、`images/`、`需求分析/`、`PRD/`、`原型图/`、`资料/`。存量数字目录（`requirements/<需求 ID>/`）在首次解析时被整体收养改名，`requirement_files` 中的相对路径随之改写。

`需求记忆.md` 与 `images/` 是系统级资源：后端统一校验，任何入口都不能删除、重命名或移动；被文档引用的图片同样阻止删除。普通默认目录可自由改名、移动、删除。普通刷新不会重建用户主动删除的目录，只有显式「修复默认结构」才补建。

在「需求进展 → 需求分析」右侧点击 Markdown 文件名，即可在左侧回显并编辑该文件。修改自动保存回当前文件；切换前等待保存完成，保存失败保留草稿并支持重试。图片、PDF 等文件仍使用「预览」。编辑器保持所见即所得：磁盘上保存的是原生 Markdown，读取时转成编辑器 HTML，保存时再序列化回 Markdown；标题、列表、任务列表、表格、代码块、引用、删除线与图片相对路径都能原样还原，仅打开文件不会改写原文。早期以 HTML 保存的正文在首次编辑后即改写为 Markdown。

Markdown 中插入的图片真实写入当前需求根目录的 `images/`，正文保存相对当前文档所在目录的路径（根目录文档为 `images/x.png`，子目录文档为 `../images/x.png`）。同名图片自动追加安全后缀，不会覆盖已有图片。

数据库启用外键、WAL，启动自动执行 `apps/server/drizzle/*.sql` 中未应用迁移。也可运行 `npm run db:migrate`。新迁移应新增版本文件，避免修改已经应用的迁移。

## MCP（stdio）

M3 提供独立 stdio MCP Server，M4 完成安全攻击用例与敏感端点收敛，M5 使用 Qoder Desktop 作为真实 MCP Client 完成三个只读场景与两条经授权的受控写入，M6 补齐逐工具参数/返回说明、安装配置、权限与安全、自动化测试与版本兼容性文档；与 HTTP 服务共用服务容器，不监听端口：

```powershell
npm run build -w @superpm/server
npm run mcp -w @superpm/server
```

默认只注册 9 个业务只读工具（`requirement.*`、`issue.*`、`artifact.*`）与 `system.info`；显式设置 `SUPERPM_MCP_WRITE=1` 后，额外开放 4 个受控写入工具与 `write.prepare`。写入必须先取得 5 分钟有效、一次性、绑定参数与幂等键的确认令牌，调用来源记为 `mcp:<客户端名>` 并写入 `mcp_audit`。需求创建、问题创建、文件写入/删除、SQL 与任意路径能力仍不开放。M4 安全用例覆盖非法参数、SQL/提示注入、路径穿越、符号链接、敏感信息泄露、数据库/文件系统异常与未授权写入。运行环境、Harness 配置、逐工具入参与返回、错误码、自动化测试与版本兼容性见 `docs/mcp.md`。

## 检查

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

集成与浏览器测试各使用临时 SQLite 和 Workspace，与默认业务数据隔离。浏览器验收需先构建前端；`npm run test:e2e` 会自动构建并启动隔离服务。

CI 流水线位于 `.github/workflows/ci.yml`（与模板 `docs/ci/ci.yml` 一致），在 Windows runner 上执行安装、类型检查、单元测试、构建与 Playwright 浏览器验收。推送含 workflows 目录改动的提交需要 GitHub 凭证具备 `workflow` scope，缺失时整个提交会被远端拒收；可用 `gh auth refresh --hostname github.com -s workflow` 补齐。

## 版本管理

版本号格式为 `MAJOR.MINOR.PATCH`。定级依据是**一次正式发布相对上一正式版本的整体最高变更级别**，不按单个提交计算；每次发布只升一位，低位归零。

| 级别    | 适用变更                                       | 示例    |
| ------- | ---------------------------------------------- | ------- |
| `0.0.x` | 小幅修改：页面、文案、样式、现有功能内的小修   | `0.1.1` |
| `0.x.0` | 功能迭代：新功能、重构、数据库结构调整         | `0.2.0` |
| `x.0.0` | 重大版本：重要模块、大批量更新、重大架构调整或里程碑 | `1.0.0` |

- 主版本谨慎升级，普通功能迭代不触发。
- 数据库结构调整不自动触发主版本，但必须提供迁移方案，升级前备份、迁移失败可恢复。
- 同一版本号只对应一个正式产物，已发布版本不可覆盖；需要修复时用新版本号重新发布。
- 正式发布需打 Git 标签（如 `v0.2.0`），Git 标签、应用内版本号、发布包版本号三者一致，并记录版本号、日期、变更内容与升级说明。
- 日常开发提交不修改版本号；只在准备正式发布时确定最终版本号。

版本号以根 `package.json` 的 `version` 字段为准，发布时同步 `apps/server`、`apps/web`、`packages/shared` 与部署包。本规范自下一个正式版本起执行。

## API

| 接口                                              | 用途                                     |
| ------------------------------------------------- | ---------------------------------------- |
| GET `/api/health`                                 | 服务状态                                 |
| GET `/api/system`                                 | 运行路径与模块状态（需登录）             |
| GET `/api/requirements`                           | 搜索/筛选/排序/分页，返回主需求及子需求  |
| POST `/api/requirements`                          | 创建需求                                 |
| GET `/api/requirements/:id`                       | 查看需求                                 |
| PATCH `/api/requirements/:id`                     | 部分更新需求，允许跳过/退回阶段          |
| DELETE `/api/requirements/:id`                    | 软删除需求                               |
| GET `/api/requirements/:id/history`               | 阶段变更历史                             |
| GET `/api/requirements/:id/artifacts`             | 需求文档目录列表（按父目录或全需求搜索） |
| POST `/api/requirements/:id/artifacts/folders`    | 新建文件夹                               |
| POST `/api/requirements/:id/artifacts/files`      | 新建文件                                 |
| POST `/api/requirements/:id/artifacts/links`      | 新建外部链接                             |
| POST `/api/requirements/:id/artifacts/refresh`    | 扫描磁盘并同步索引                       |
| PUT `/api/artifacts/nodes/:nodeId/content`        | 保存文档内容                             |
| POST `/api/artifacts/nodes/:nodeId/open`          | 系统默认可打开目录；`?reveal=1` 定位文件 |
| POST `/api/requirements/:id/artifacts/images`     | 上传图片到需求 `images/`，返回相对路径   |
| GET `/api/requirements/:id/artifacts/image`       | 按文档相对路径读取图片                   |
| GET `/api/requirements/:id/memory`                | 读取需求记忆（懒初始化）                 |
| GET `/api/requirements/:id/directory`             | 需求物理目录与初始化状态                 |
| POST `/api/requirements/:id/directory/initialize` | 幂等初始化默认目录与系统级资源           |
| POST `/api/requirements/:id/directory/repair`     | 显式补建缺失的默认结构                   |

输入字段与枚举见 `packages/shared/src/index.ts`。分页总数按主需求计算；子需求匹配筛选时携带父需求作为上下文。统一错误响应 `{ error: { code, message, details? } }`。

## 后续实施顺序

需求视图与富文本 → 文件实体/版本/关联 → 问题、决策、跟进 → 测试用例/执行/复测 → 每日任务 → FTS5 与 Context API → 备份恢复 → MCP 只读业务工具（M2，已完成）→ MCP 受控写入（M3，已完成）→ MCP 安全测试（M4，已完成）→ MCP 真实 Harness 试运行（M5，已完成）→ MCP 文档收尾（M6，已完成）。

需求参考保留在根目录开发文档；当前明确的两级需求、Drizzle 选型与交付边界见 `docs/superpowers/specs/2026-10-13-foundation-design.md`。
