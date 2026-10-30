# GEMINI.md

本仓库的统一规则入口是 `AGENTS.md`；superPM 使用入口（能力概览、MCP、安装版启停）是 `.agents/skills/superpm/SKILL.md`。

开始任何任务前必须先读这两处。涉及原型项目时（默认 `workspace/prototype-workbench/`，实际以 `SUPERPM_PROTOTYPE_DIR` 解析结果为准），还必须读：

1. `<prototypeRoot>/AGENTS.md`
2. `<prototypeRoot>/.agents/skills/prototype-management/SKILL.md`
3. 该 Skill 的 `references/` 中与任务相关的文件
4. 目标需求的 `requirement.json` 和现有页面

不要绕过上述规则直接修改原型；已有原型项目只校验复用，不 Pull、不覆盖、不重建；不向公共模板仓库提交或推送个人资产；不发布 PinMe、不执行未授权的提交、推送或发布。
