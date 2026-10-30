---
name: superpm
description: superPM Workbench 主入口 Skill。用于 superPM 主应用开发、MCP 工具使用、superPM 与 prototype-workbench 双项目本地服务启停检查，以及原型任务转交；先路由到真实项目规范再执行。
---

# superPM Workbench 主入口

## 何时使用

在 `superPMWorkbench` 仓库内处理以下任一任务时使用本 Skill：

- superPM 主应用的需求、后端、前端、数据库、测试、文档或发布。
- 使用或说明 superPM 的 MCP 能力。
- 启动、检查或停止 superPM 开发服务与 prototype-workbench 原型服务。
- 做原型页面任务，需要先找到并加载原型管理规范。
- 需要决定任务由主流程直接完成，还是交给后续的专业 Agent。

仅查询与仓库无关的通用知识时，不需要使用。

## 开始前：先定位任务类型

| 任务类型         | 必读                                                                 | 执行边界                                                       |
| ---------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| superPM 业务开发 | 根 `README.md`、`docs/` 中对应模块文档、真实代码与测试                | 只改 `apps/`、`packages/`、`tests/`、`scripts/`、`docs/` 中相关文件 |
| 原型页面任务     | 实际原型路径下的 `AGENTS.md`（默认 `workspace/prototype-workbench/AGENTS.md`），再读其中的 Skill 与 references | 只改目标需求目录；不修改 superPM 业务与数据                    |
| 本地服务管理     | `references/service-management.md`                                   | 只启停本仓库服务；原型缺失时按配置初始化，不覆盖已有项目       |
| MCP 使用         | `docs/mcp.md` 与 `references/mcp-guide.md`                           | 写入默认关闭；正式写入必须获得用户明确授权                     |
| 发布与更新       | `docs/install-update.md`、`docs/deployment-update-strategy.md`       | 发布/合并/推送需单独授权；更新不得包含或删除原型项目           |
| 专业 Agent 调度  | `references/agent-routing.md`                                        | V1.0 只预留路由契约，不创建或宣称已有专业 Agent                 |

优先级：用户当前对话的明确指令 > 目标项目自身的 `AGENTS.md` 与 Skill > 本 Skill > 一般文档。发生冲突时先说明，不要静默扩大改动范围。

## 本地服务入口

根目录 `Start-All.cmd` / `Stop-All.cmd` 是双击快捷入口，固定操作两个项目。命令行与单项目操作仍使用 `scripts/`，默认后台启动并把日志写入 `runtime/skill/logs/`：

```powershell
# 启动（默认两个项目；可 -Target superpm / prototype）
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/superpm/scripts/start-services.ps1 -Target all

# 检查（只读，不启停）
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/superpm/scripts/check-services.ps1 -Target all

# 停止（按项目独立停止）
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/superpm/scripts/stop-services.ps1 -Target prototype
```

默认地址：

- superPM 开发态：前端 `http://127.0.0.1:5173`，API `http://127.0.0.1:3001/api/health`。
- prototype-workbench：`http://localhost:5199`（通过 CLI 覆盖端口，避免与 superPM 的 5173 冲突）。
- 端口不是写死的配置：脚本会读取 `PORT`、`.env`、Vite 配置；原型端口可用 `-PrototypePort` 覆盖。详见 `references/service-management.md`。

原型项目路径默认 `workspace/prototype-workbench`，可用 `SUPERPM_PROTOTYPE_DIR` 覆盖。本地缺失或目录为空时，启动器按 `SUPERPM_PROTOTYPE_REPOSITORY` 从公共模板 Clone，写入本地 `prototype.config.json`，并按项目锁文件安装依赖；已存在且完整的项目只校验和复用，不 Pull、不重置、不覆盖。也可单独运行 `scripts/prototype-init.ps1`。模板升级不属于 V1.0，必须另行授权和设计。

启动脚本会复用已健康运行的本仓库实例，不会杀掉无关 Node 进程。停止脚本只处理经进程命令行和端口校验属于这两个项目的实例；安装版请使用安装目录的 `Stop.cmd`，不要用本 Skill 的脚本。

## 原型任务闸门

1. 确认 superPM 需求 ID 与本次目标；没有需求 ID 时先停下询问，不创建无归属页面。
2. 确认原型项目存在且完整。缺失或为空时，可运行 `start-services.ps1 -Target prototype` 或 `prototype-init.ps1` 初始化；不完整、路径冲突或初始化失败时停下并给出诊断，不删除目录、不重建、不覆盖。
3. 读取实际原型路径下的 `AGENTS.md`（`SUPERPM_PROTOTYPE_DIR` 解析结果，默认 `workspace/prototype-workbench/AGENTS.md`）。
4. 读 `.agents/skills/prototype-management/SKILL.md`，再按任务读取它的 `references/`，不要凭记忆复述规则。
5. 读目标需求的 `requirement.json` 和现有页面，再动手。
6. 只修改目标需求目录；不删除、移动、重命名已有原型，除非用户明确确认。
7. 完成后运行该项目的 `npm run build`，在真实浏览器验证，并报告“未发布”。
8. 未经当前对话明确授权，不执行 `npm run deploy`，不覆盖 PinMe 域名，不回写 superPM 正式数据。

从父仓库根目录工作时，原型项目自己的 Skill 不会被自动发现，必须显式读取上述文件。仓库根与原型根已提供 `CLAUDE.md`、`GEMINI.md`、`.cursor/rules`、`.github/copilot-instructions.md` 薄指针，供其他 harness 读取；规则源头仍是原型 `AGENTS.md` 与 `prototype-management` Skill。更多边界见 `references/prototype-integration.md`。

## MCP 使用

- superPM 的 MCP 是独立 stdio 进程，不等同于当前会话已连接的 MCP 客户端。不要假定工具一定可用；先通过实际客户端调用 `system.info` 或查看工具列表确认。
- 默认只有 16 个只读工具（`system.info` + 15 个业务只读）。设置 `SUPERPM_MCP_WRITE=1` 重启后才有 32 个；写入分 12 个受确认写和 3 个低风险自动写。
- 12 个受确认写必须先 `write.prepare` 取得一次性令牌；3 个自动写仍需写开关、幂等键、路径/格式校验与审计。
- 模型不能自行开启写开关，也不能绕过业务服务、直接操作 SQLite、使用任意 SQL/文件工具，或访问需求根目录之外的文件。
- 正式问题创建与需求创建仍只能由用户操作；AI 不得未经明确授权创建正式问题或修改正式数据。
- 完整工具参数、返回与错误码以 `docs/mcp.md` 为准；本 Skill 只做路由和边界说明，不复制契约。

## 专业 Agent 与 MCP 调度预留

V1.0 不创建专业 Agent，也不实现复杂编排或 PinMe 自动发布。当前只保留任务路由契约：未来新增 Agent 时，必须声明目标、输入、可写路径、可用工具、验证方式和交接条件，并继续服从本 Skill 的边界。详见 `references/agent-routing.md`。不得声称某个 Agent 或调度器“已实现”。

## 硬约束

- 已存在的原型项目只校验和复用：不删除/移动/重建 `<prototypeRoot>`，不覆盖它的页面、配置或依赖，不把它纳入发布包。初始化只允许发生在目标缺失或为空时。
- 允许从配置的公共模板仓库 Clone；V1.0 不自动 Pull。禁止向模板仓库 Push、Commit、创建远程分支或 PR，禁止把个人原型、组件或本地配置复制进模板仓库。
- 不对已有原型目录执行覆盖式 Clone、`git reset --hard`、`git clean -fd` / `git clean -fdx`，也不因项目异常而自动删除后重建。
- 数据根迁移、备份恢复会整体复制或替换 `workspace/`，默认路径下的原型目录也会被包含；这些是显式高风险操作，未获当前对话明确授权不得执行，执行前必须确认原型的保留方式。
- 不执行 `git clean -fdx` 等可能清除未跟踪 `workspace/` 的命令；个人原型未提交到远程，删除后不可恢复。
- 个人原型不做 Git 版本管理：不建版本目录、标签或变更日志；模板 Clone 产生的 `.git` 只用于来源识别，不用于提交个人原型。
- 不把本地服务暴露到公网；superPM 仅监听 `127.0.0.1`，原型 Vite 仅本机访问。
- 不停止或杀死未通过命令行、端口与健康检查确认身份的进程。
- 不暴露或复制 `~/.claude/settings.json` 中的 `ANTHROPIC_AUTH_TOKEN`、`~/.codex/config.toml` 中的 `experimental_bearer_token`、服务端 `runtime/server.json` 中的 `shutdownToken` 或其他令牌原文。
- 不提交、推送、打标签、发布 Release 或执行 PinMe 部署，除非用户在当前对话中明确要求。

## 参考索引

| 文件                                 | 内容                                                         |
| ------------------------------------ | ------------------------------------------------------------ |
| `references/service-management.md`   | 真实启动拓扑、端口、健康检查、状态文件、启停与故障处理       |
| `references/prototype-integration.md`| 原型规范位置、强制读取顺序、允许与禁止的操作、隔离规则       |
| `references/mcp-guide.md`            | 32 个 MCP 工具分组、写入分级、授权与安全边界、排错           |
| `references/agent-routing.md`        | 任务路由表、未来专业 Agent 与 MCP 调度的预留契约             |
| `scripts/start-services.ps1`         | 统一启动入口，支持 `-Target all/superpm/prototype`           |
| `scripts/prototype-init.ps1`         | 原型项目初始化；仅在缺失/空目录 Clone，已存在项目只校验复用   |
| `scripts/check-services.ps1`         | 只读检查，支持 `-Json` 输出                                  |
| `scripts/stop-services.ps1`          | 独立停止，带进程身份校验                                     |
| `Start-All.cmd` / `Stop-All.cmd`     | 根目录双击快捷入口，固定启停两个项目                         |
