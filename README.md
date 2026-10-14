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

## 当前能力

- 需求新增、查看、编辑和软删除；业务编号不可修改、不会复用。
- 两级主子需求；主需求存在有效子需求时禁止删除。
- 编号/名称搜索，类型、优先级、状态与阶段筛选，基础排序、主需求分页。
- 详情抽屉与四阶段工作区骨架。浏览阶段不修改业务数据，“设为当前阶段”才保存并记录历史。
- 状态与阶段独立；关键变更和阶段历史通过数据库事务保存。
- 未保存关闭和页面离开保护，API 失败提示，真实存储路径查看。
- 前后端共享契约、真实 SQLite 集成测试、浏览器验收和 CI 配置模板。

未实现：问题/决策/跟进、文件与版本、测试闭环、任务历史、通知、自定义字段、表格视图持久化、FTS5、备份恢复、MCP。页面中的工作区与模块状态会明确标识建设范围。软删除数据目前保留在数据库中，回收站界面随后建设。

描述暂用纯文本编辑，数据库保存 Tiptap 兼容 JSON；完整富文本、图片和 Markdown 导入导出在下一步接入。

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
  storage/                   Workspace 相对路径校验边界
apps/server/drizzle/         版本化 SQL 迁移
packages/shared/src/         枚举、Zod Schema、类型
tests/e2e/                  浏览器操作验收
docs/superpowers/            本轮设计与执行计划
```

REST 与未来 MCP 都通过 Core Service 访问事实数据，不直接拼接 SQL 或任意读写本地路径。现阶段以需求模块为可执行参考，其他模块逐次增加 schema、repository、service、API 和页面。

UI 基于 Vue 3 + Element Plus，并按用户指定集成 [Ease UI](https://github.com/Momingyun/ease-ui) 的按钮、抽屉、空状态单文件组件。上游来源、固定提交与 MIT 许可见 `apps/web/src/components/ease-ui/`。

## 数据位置

默认 `data/superpm.sqlite` 和 `workspace/`，均不进入 Git。复制 `.env.example` 为 `.env` 后可设置：

```dotenv
PORT=3001
SUPERPM_DATA_DIR=./data
SUPERPM_WORKSPACE_DIR=./workspace
```

路径相对于项目根目录；变更后重启服务。开发端口代理固定为 3001，若修改 API 端口需同步 `apps/web/vite.config.ts`。

需求分析正文来自工作区文件，不是数据库正文记录。`requirement_files` 表只保存所属需求、分类、文件名、确认状态等元数据；默认分析记录位于 `workspace/requirements/<需求 ID>/analysis/分析记录/analysis-record.md`，上传文件按分类保存并使用独立的实际文件名。

在「需求进展 → 需求分析」右侧点击 Markdown 文件名，即可在左侧回显并编辑该文件。修改自动保存回当前文件；切换前等待保存完成，保存失败保留草稿并支持重试。图片、PDF 等文件仍使用「预览」。现有编辑器为富文本编辑器：Markdown 在读取时转为 HTML，编辑后的正文沿用现有 HTML 保存格式；仅打开文件不会改写原文。

数据库启用外键、WAL，启动自动执行 `apps/server/drizzle/*.sql` 中未应用迁移。也可运行 `npm run db:migrate`。新迁移应新增版本文件，避免修改已经应用的迁移。

## 检查

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

集成与浏览器测试各使用临时 SQLite 和 Workspace，与默认业务数据隔离。浏览器验收需先构建前端；`npm run test:e2e` 会自动构建并启动隔离服务。

CI 模板保存在 `docs/ci/ci.yml`，包含安装、类型检查、测试、构建和浏览器验收。当前 GitHub OAuth 凭证缺少 `workflow` 权限，首版尚未启用自动 CI；授权该权限后，将模板复制到 `.github/workflows/ci.yml` 并提交即可。

## API

| 接口 | 用途 |
| --- | --- |
| GET `/api/health` | 服务状态 |
| GET `/api/system` | 运行路径与模块状态 |
| GET `/api/requirements` | 搜索/筛选/排序/分页，返回主需求及子需求 |
| POST `/api/requirements` | 创建需求 |
| GET `/api/requirements/:id` | 查看需求 |
| PATCH `/api/requirements/:id` | 部分更新需求，允许跳过/退回阶段 |
| DELETE `/api/requirements/:id` | 软删除需求 |
| GET `/api/requirements/:id/history` | 阶段变更历史 |

输入字段与枚举见 `packages/shared/src/index.ts`。分页总数按主需求计算；子需求匹配筛选时携带父需求作为上下文。统一错误响应 `{ error: { code, message, details? } }`。

## 后续实施顺序

需求视图与富文本 → 文件实体/版本/关联 → 问题、决策、跟进 → 测试用例/执行/复测 → 每日任务 → FTS5 与 Context API → 备份恢复 → MCP。

需求参考保留在根目录开发文档；当前明确的两级需求、Drizzle 选型与交付边界见 `docs/superpowers/specs/2026-10-13-foundation-design.md`。
