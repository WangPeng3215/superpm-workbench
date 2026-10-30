# AGENTS.md

本文件是 superPM 仓库的跨项目入口规则，只负责路由、边界和红线，不复制各项目细则。

## 项目与规则来源

- superPM 主应用：`apps/`、`packages/`、`tests/`、`docs/`、`scripts/`。
- 原型项目：默认 `workspace/prototype-workbench/`，可由 `SUPERPM_PROTOTYPE_DIR` 覆盖；独立 Vue 3 + TypeScript + Vite 本地项目。本地缺失或目录为空时从公共模板仓库 Clone 初始化，已有项目只复用、不覆盖。个人原型不做 Git 版本管理，也不提交到公共模板仓库。
- 主入口 Skill：`.agents/skills/superpm/SKILL.md`。Qoder 会自动发现；其他 harness 直接读取该文件作为主路由。
- 原型规则源头：`<prototypeRoot>/AGENTS.md` 和 `<prototypeRoot>/.agents/skills/prototype-management/SKILL.md`，其中 `<prototypeRoot>` 为 `SUPERPM_PROTOTYPE_DIR` 解析后的实际路径。
- 仓库根与原型根的 `CLAUDE.md`、`GEMINI.md`、`.cursor/rules`、`.github/copilot-instructions.md` 只是其他 harness 的薄指针，不是规则源头。

## 开始前

1. 先判断任务类型：superPM 业务 / 原型 / 本地服务 / MCP / 发布更新。
2. 原型任务必须先读上面的原型规则，再读目标需求的 `requirement.json` 和现有页面；需求 ID 或归属不明时停下询问。
3. 只修改目标范围内的文件，不静默扩大改动。

## 红线

- 不删除、移动、重建、覆盖 `<prototypeRoot>`，不修改已有项目的配置、页面或依赖，除非当前对话明确授权；初始化只允许在缺失或空目录执行。
- 不在仓库根执行 `git clean -fdx` 或任何会清除未跟踪 `workspace/` 的命令。
- 不在原型项目内提交、推送、创建分支、打标签或发起 PR；不向公共模板仓库推送个人原型、个人组件或本地配置。
- 不对公共模板仓库执行自动 Pull、自动合并或自动升级；V1.0 升级需单独设计并取得明确授权。
- 不执行 `npm run deploy`、不覆盖 PinMe 域名，除非当前对话明确授权。
- 数据根迁移、备份恢复会整体复制或替换 `workspace/`；未获明确授权不得执行，执行前先单独备份原型目录。
- 不把本地服务暴露到公网，不输出令牌原文。
- 不提交、推送、打标签、发布 Release，除非用户在当前对话明确要求。

## 本地服务

- 双击或在终端执行 `Start-All.cmd` 启动 superPM 与原型；`Stop-All.cmd` 停止两者。
- 只操作一个项目：`.agents/skills/superpm/scripts/start-services.ps1 -Target superpm|prototype`；检查用 `check-services.ps1 -Target all`。
- 原型缺失或为空时，启动脚本会从 `SUPERPM_PROTOTYPE_REPOSITORY` 配置的公共模板 Clone 并安装依赖；已有项目只校验复用，不 Pull、不重置。单独初始化用 `prototype-init.ps1`。
- 端口、健康检查、日志、独立停止与故障处理见 `.agents/skills/superpm/references/service-management.md`。

## 发布与更新

- 发布构建只包含 `apps/server/dist`、`apps/server/drizzle`、`apps/web/dist`，不包含 `workspace/`。
- 原型初始化与模板升级都是单独授权操作，不属于 superPM 版本更新流程。
- 发布、更新、合并、推送需单独授权。

## 规则优先级

用户当前对话的明确指令 > 目标项目自身的 `AGENTS.md` 与 Skill > 本文件 > 一般文档。冲突时先说明，不静默扩大改动范围。
