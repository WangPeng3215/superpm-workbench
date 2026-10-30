---
name: superpm
description: superPM Workbench 使用入口。用于了解 superPM 的产品能力与 MCP 工具能力，并在本机安装版中启动、停止和确认服务状态。
---

# superPM Workbench 使用入口

本 Skill 面向已部署的 Release 安装版，只覆盖三件事：superPM 能做什么、MCP 能做什么、如何启动服务。

## 何时使用

- 需要了解 superPM 的产品能力、数据位置或更新方式。
- 需要了解或使用 superPM 的 MCP 工具。
- 需要启动、停止或确认本机 superPM 是否在运行。

不适用于修改 superPM 源码（`apps/`、`packages/`、`tests/`）；源码开发按仓库 `AGENTS.md`、`README.md` 与 `docs/` 执行。

## superPM 能做什么

- 需求管理：新增、查看、编辑与软删除；两级主子需求；编号/名称搜索，类型、优先级、状态与阶段筛选；阶段工作区与变更历史。
- 需求文档知识库：多层级文件夹、Markdown 文件与外部链接；支持本地上传、最终版标记、外部修改刷新；Markdown 应用内编辑，图片页内预览，其他文件用系统默认程序打开。
- 问题跟踪：问题、活动记录与文件关联。
- 每日任务：按日计划与拖拽排序、关联需求、计划时段、状态筛选、月度日历；单活动计时、自动结束、工时校正与每日工作总结。
- 会议记录：按类型与标题检索，关联多个需求；正文支持文本颜色、高亮与可跳转的需求引用。
- 便签：卡片内编辑与自动保存，搜索、置顶、筛选、归档、删除，可转为每日任务。
- 工具箱：维护常用工具的名称、地址、图标与分类；全局悬浮入口可拖动，快捷弹窗按收藏搜索并打开。
- 富文本：需求描述、需求文档与会议正文共用 Tiptap 编辑器，支持颜色、高亮、需求引用、表格与文本对齐/缩进。
- 本地数据：SQLite 数据库与 `workspace/` 文件目录，数据根可配置；更新在应用内完成，升级前自动备份，失败可回滚。

MCP 提供需求、问题、文档、会议与便签的只读查询，以及默认关闭的受控写入。

## 启动与停止（安装版）

### 找到安装目录

安装目录同时包含 `SuperPM.cmd`、`Stop.cmd`、`runtime/node.exe`、`app/apps/server/dist/mcp/stdio.js`、`install.json`。

不知道路径时先询问用户；也可只读取用户提供的 MCP 客户端配置中 `superpm` 条目的 `command` / `args` 推断。不要扫描磁盘，不要读取同一文件中的其他凭据。

### 命令

```powershell
SuperPM.cmd                       # 启动，默认 http://127.0.0.1:3001
SuperPM.cmd --version
SuperPM.cmd --home
Stop.cmd                          # 优雅停止
Stop.cmd -Home D:\data\superPM    # 显式指定数据根
Stop.cmd -Force                   # 优雅停止失败时强制结束
```

- 服务只监听本机，浏览器打开 `http://127.0.0.1:3001`；打开页面先登录。
- 不要用 `taskkill` 或其他通用进程工具代替 `Stop.cmd`。
- 应用更新在「系统设置 → 版本与更新」；更新后重启 MCP 客户端以加载新工具。

### 数据根

优先级：`SUPERPM_HOME` 环境变量 > `%APPDATA%\superPM\config.json` 指针 > 默认 `%LOCALAPPDATA%\superPM`。

数据根包含 `data/`（SQLite）、`workspace/`（需求文件、图片、产出物）、`logs/`、`backups/`、`runtime/`、`updates/` 与可选 `.env`。查看当前数据根用 `SuperPM.cmd --home`。

## MCP 能力

- 独立 stdio 进程，与 HTTP 服务共用数据根，不监听端口；由 AI 客户端拉起。
- 默认 16 个只读工具：`system.info` + 需求、问题、文档、会议、便签的只读查询。
- 设置 `SUPERPM_MCP_WRITE=1` 并重启后为 32 个：`system.info` + 15 只读 + 12 受确认写 + 3 低风险自动写 + `write.prepare`。
- 受确认写：问题更新/评论/关联、会议创建/更新/删除、便签创建/更新/归档/删除/转任务。先调用 `write.prepare` 取得 5 分钟有效、一次性、绑定参数的令牌，再用同一份参数执行。
- 自动写：需求记忆更新、白名单文本文件创建与更新。不需要令牌，但仍需写开关、幂等键、路径/格式校验与审计；更新已有文件必须带 `expectedVersion`。
- 写入默认关闭，模型不能自行开启；正式写入必须获得用户明确授权。
- 工具是否真的可用，以实际 MCP 客户端调用 `system.info` 或工具列表为准，不要凭仓库或文档假定已连接。
- 工具分组与完整入参、返回、错误码见 `references/mcp-guide.md` 与 `docs/mcp.md`。

## 原型任务

原型不属于本 Skill 范围。涉及原型时，先读 `<prototypeRoot>/AGENTS.md` 与 `<prototypeRoot>/.agents/skills/prototype-management/SKILL.md`，再读目标需求的 `requirement.json`；本 Skill 不初始化、不启停、不修改原型。

## 安全边界

- superPM 服务是唯一业务入口：不直接读写 SQLite，不绕过服务修改 `workspace/` 文件。
- 不访问需求根目录之外的文件，不使用 `..`、绝对路径或符号链接绕过限制。
- 不开放通用 SQL、任意文件写入、删除或移动能力。
- 不把本地服务暴露到公网；服务只监听本机。
- 不输出或复制 `runtime/server.json` 的 `shutdownToken`、MCP 客户端配置中的令牌或其他凭据。
- 不未经用户明确授权创建正式问题或修改正式数据。

## 参考索引

| 文件                        | 内容                                             |
| --------------------------- | ------------------------------------------------ |
| `references/install-mode.md` | 安装目录识别、数据根、启停、MCP 配置与安全边界   |
| `references/mcp-guide.md`    | MCP 工具分组、写入分级、授权与安全边界           |
| `docs/mcp.md`               | 完整 MCP 工具契约、参数、返回与错误码            |

独立 Skill 包（Release 资产 `superpm-skill-<version>.zip`）包含本文件、`references/`、`docs/mcp.md` 与 `INSTALL.txt`，不包含源码、开发脚本或安装包。
