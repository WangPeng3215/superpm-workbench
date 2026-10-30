# 安装版使用

本文件用于从 GitHub Release 完整包解压部署的 superPM Workbench。

## 识别安装目录

安装目录同时具备以下文件（缺一不可）：

- `SuperPM.cmd`、`Stop.cmd`
- `runtime\node.exe`
- `app\apps\server\dist\mcp\stdio.js`
- `install.json`

不知道路径时先询问用户，或只读取用户提供的 MCP 客户端配置中 `superpm` 条目的 `command` / `args` 推断；不要读取同一文件中的其他凭据，不要猜测路径，也不要扫描整个磁盘。

## 数据根

数据与程序分离，更新只替换 `app/`：

- 优先级：`SUPERPM_HOME` 环境变量 > `%APPDATA%\superPM\config.json` 指针 > 默认 `%LOCALAPPDATA%\superPM`。
- 数据根包含 `data/`（SQLite）、`workspace/`（需求文件、图片、产出物）、`logs/`、`backups/`、`runtime/`、`updates/` 与可选 `.env`。
- 查看当前版本与数据根：

```powershell
SuperPM.cmd --version
SuperPM.cmd --home
```

## 启动与停止

```powershell
SuperPM.cmd                                  # 启动，默认 http://127.0.0.1:3001
Stop.cmd                                     # 优雅停止
Stop.cmd -Home D:\data\superPM               # 显式指定数据根
Stop.cmd -Force                              # 优雅停止失败时强制结束
```

- 服务只监听本机，打开页面先登录。
- 应用更新在「系统设置 → 版本与更新」；更新器会先备份数据根，失败自动回滚。
- 更新后重启 MCP 客户端，使其加载新版本工具。
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
- 默认只注册 16 个只读工具；写入默认关闭，只有 `SUPERPM_MCP_WRITE=1` 时才注册 32 个（12 个受确认写 + 3 个低风险自动写）。
- 工具能力与安全边界见 `references/mcp-guide.md`，完整契约见 `docs/mcp.md`。

## 安全边界

- 不把本地服务暴露到公网；服务只监听本机。
- 不输出或复制 `runtime/server.json` 中的 `shutdownToken`、MCP 客户端配置中的令牌或其他凭据。
- 不直接读写 SQLite，不绕过服务修改 `workspace/` 文件。
- 不读取需求根目录之外的文件，不使用任意 SQL 或通用文件工具绕过业务边界。
- 不执行数据根迁移、备份恢复或删除数据，除非用户在当前对话中明确要求并确认备份。
