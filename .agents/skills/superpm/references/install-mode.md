# 安装版模式

本文件用于**从 GitHub Release 完整包解压部署**的 superPM Workbench，不是源码仓库。源码仓库模式请回到 `SKILL.md` 的路由表，并使用仓库内 `scripts/`。

## 识别安装目录

安装目录同时具备以下文件（缺一不可）：

- `SuperPM.cmd`、`Stop.cmd`
- `runtime\node.exe`
- `app\apps\server\dist\mcp\stdio.js`
- `install.json`

如果当前上下文只有 Skill 包而没有安装目录，先向用户询问安装路径，或只读取用户提供的 MCP 客户端配置中 `superpm` 条目的 `command` / `args` 推断；不要读取同一文件中的其他凭据，不要猜测路径，也不要扫描整个磁盘。

安装版没有 `apps/`、`scripts/`、`docs/` 源码布局，不要执行本 Skill 在源码仓库中使用的 PowerShell 脚本。

## 数据根

数据与程序分离，更新只替换 `app/`：

- 优先级：`SUPERPM_HOME` 环境变量 > `%APPDATA%\superPM\config.json` 指针 > 默认 `%LOCALAPPDATA%\superPM`。
- 数据根包含 `data/`（SQLite）、`workspace/`（需求文件、图片、产出物）、`logs/`、`backups/`、`runtime/`、`updates/` 与可选 `.env`。
- 查看当前版本与数据根：

```powershell
SuperPM.cmd --version
SuperPM.cmd --home
```

## 启动、停止与更新

```powershell
SuperPM.cmd                                  # 启动，默认 http://127.0.0.1:3001
Stop.cmd                                     # 优雅停止
Stop.cmd -Home D:\data\superPM               # 显式指定数据根
Stop.cmd -Force                              # 优雅停止失败时强制结束
Update.cmd --manifest <更新清单地址>          # 命令行更新
```

- 应用内更新在「系统设置 → 版本与更新」；更新器会先备份数据根，失败自动回滚。
- 停止脚本不会结束已连接的 MCP 客户端；更新或迁移前先关闭这些客户端。
- 不要用 `taskkill` 或其他通用进程工具代替 `Stop.cmd`。

## MCP 配置

MCP 由客户端以 stdio 拉起，与 HTTP 服务共用数据根：

```json
{
  "command": "D:\\Apps\\superPM\\runtime\\node.exe",
  "args": ["D:\\Apps\\superPM\\app\\apps\\server\\dist\\mcp\\stdio.js"],
  "env": {
    "SUPERPM_MCP_WRITE": "0"
  }
}
```

- 自定义数据根时在 `env` 增加 `SUPERPM_HOME`。
- 默认只注册 16 个只读工具；写入默认关闭，只有 `SUPERPM_MCP_WRITE=1` 时注册 32 个（12 个受确认写 + 3 个低风险自动写）。
- 应用更新后重启 MCP 客户端，使其加载新版本工具。
- 工具参数、返回与错误码以 Skill 包内 `docs/mcp.md` 为准。

## 需求与文档管理规则

- superPM 服务是唯一业务入口。不得直接读写 SQLite、不得绕过服务修改 `workspace/` 文件。
- 新建需求、创建正式问题只能由用户在界面中操作；AI 不得未经明确授权创建正式问题或修改正式数据。
- 受确认写先调用 `write.prepare` 获取一次性令牌；低风险自动写仍需幂等键、路径/格式白名单与审计。
- 读取优先使用 MCP 工具与页面展示的数据；不要凭记忆描述工具契约。

## 原型项目

原型项目是独立的本地 Vue 项目，不属于安装版，也不由安装版创建或管理：

- 有原型目录时，先读 `<prototypeRoot>/AGENTS.md` 与 `<prototypeRoot>/.agents/skills/prototype-management/SKILL.md`，再读目标需求的 `requirement.json` 与现有页面。
- 安装版不提供原型自动初始化；不要 Clone、Pull、重置或覆盖原型目录。
- 不要向公共模板仓库提交个人原型、组件或本地配置。

## 安全边界

- 不把本地服务暴露到公网；服务只监听本机。
- 不输出或复制 `runtime/server.json` 中的 `shutdownToken`、MCP 客户端配置中的令牌或其他凭据。
- 不读取需求根目录之外的文件，不使用任意 SQL 或通用文件工具绕过业务边界。
- 不执行数据根迁移、备份恢复或删除数据，除非用户在当前对话中明确要求并确认备份。

## 文档位置

独立 Skill 包内附带：

- `SKILL.md`：主入口与路由。
- `references/`：本文件、MCP 指南、原型集成与任务路由。
- `docs/mcp.md`：完整 MCP 工具契约。
- `docs/install-update.md`：安装、停止、更新与回滚。
- `docs/deployment-update-strategy.md`：更新机制设计。

源码仓库中的 `scripts/` 不随 Skill 包分发；开发、调试与原型初始化请在 Git 仓库中进行。
