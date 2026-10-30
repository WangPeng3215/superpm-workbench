# 原型任务集成

本文件说明主入口 Skill 如何把原型任务交给 `prototype-workbench` 的既有规范。主 Skill 不复制、不改写原型规范，避免两份规则漂移。

## 1. 项目位置与身份

- 默认路径：`workspace/prototype-workbench/`；可由 `SUPERPM_PROTOTYPE_DIR`（环境变量或仓库根 `.env`）覆盖。仓库内路径只允许放在 `workspace/` 下。
- 来源：本地缺失或目录为空时，从 `SUPERPM_PROTOTYPE_REPOSITORY` 配置的公共模板仓库初始化；本地保留 `TEMPLATE_VERSION` 与 `prototype.config.json` 记录模板来源和初始化时间。
- 身份：superPM 的单一原型 Hub，Vue 3 + TypeScript + Vite 的独立本地项目。
- 不连接 superPM 数据库，不调用后端接口，只使用本地 Mock 数据。
- 个人原型不做 Git 版本管理，不建立版本号、标签、变更日志或版本目录；模板 Clone 产生的 `.git` 仅用于来源识别，不用于提交个人资产。
- 一个需求对应 `src/prototypes/REQ-XXXX 需求名称/` 一个目录。

## 2. 初始化与模板边界

以下初始化入口只在**源码仓库**可用；Release 安装版不包含仓库脚本，只读取已有原型目录，不创建、不 Clone、不覆盖。

初始化入口：

```powershell
# 随启动自动初始化（缺失或空目录时）
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/superpm/scripts/start-services.ps1 -Target prototype

# 单独初始化或诊断
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/superpm/scripts/prototype-init.ps1
```

行为：

- 目标不存在或为空：检查 Git 与仓库地址，Clone 公共模板，校验项目完整性，写入本地 `prototype.config.json`，按 `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` 使用对应包管理器安装依赖。
- 目标已存在且完整：直接复用，不重新 Clone、不 Pull、不重置、不覆盖；缺少依赖时提示安装命令。
- 目标非空但不是 prototype-workbench：停止并提示路径冲突，不自动清理或重建。
- Clone 后校验失败、依赖安装失败：保留项目与日志，输出诊断，不自动删除或重试。
- `SUPERPM_PROTOTYPE_AUTO_CLONE=0` 可禁用缺失时的自动 Clone；`SUPERPM_PROTOTYPE_AUTO_INSTALL=0` 可禁用首次 Clone 后的依赖安装。
- V1.0 不自动 Pull、不自动升级模板。未来升级必须单独设计，包含版本对比、差异清单、备份、用户确认和恢复方案。
- 个人需求原型、个人组件和本地配置始终留在本地；公共模板仓库只分发框架，不接收个人资产。

## 3. 强制读取顺序

从父仓库根目录工作时，原型项目自己的 `.agents/skills` 不会被自动发现。处理任何原型任务前，必须按顺序读取（`<prototypeRoot>` 为 `SUPERPM_PROTOTYPE_DIR` 解析后的实际路径，默认 `workspace/prototype-workbench`）：

1. `<prototypeRoot>/AGENTS.md`
2. `<prototypeRoot>/.agents/skills/prototype-management/SKILL.md`
3. 该 Skill 的 `references/` 中与任务相关的文件，不要一次加载全部
4. 目标需求的 `requirement.json` 与现有页面

读完再动手。不得凭主 Skill 的记忆替代上述文件。

原型根已提供 `CLAUDE.md`、`GEMINI.md`、`.cursor/rules/prototype.mdc`、`.github/copilot-instructions.md` 作为薄指针，只指向上述规则，不复制细则；其他 harness 直接打开原型目录时可读取对应入口。Qoder 从父仓库根打开时仍依赖主 Skill 显式读取。

## 4. 任务闸门

开始前必须确认：

- 原型项目存在且状态为 `Valid`；缺失或空目录先执行初始化，`Incomplete` / `Conflict` 停止并报告，不得覆盖或重建。
- superPM 需求 ID（`REQ-XXXX`）与需求名称。
- 本次目标和只修改哪些页面/组件。
- 需求状态：`draft` / `in-progress` / `in-review` / `accepted` / `archived`。

没有需求 ID 或归属不明时，停下来询问用户。不得创建无归属页面，也不得在 `src/prototypes/` 根目录放页面。

## 5. 允许与禁止

允许：

- 本地缺失或目录为空时，通过 `prototype-init.ps1` 或 `start-services.ps1 -Target prototype` 从配置的公共模板 Clone 初始化。
- 在已有 `REQ-XXXX 需求名称/` 目录内新增或修改页面、专属组件、`requirement.json`。
- 复用 `src/components/` 公共组件与现有设计 Token。
- 运行原型项目的 `npm run dev`、`npm run build`、`npm run preview`。
- 按既有规范在真实浏览器验收，并报告构建、交互、窄屏与控制台结果。

禁止：

- 覆盖、重置或清理已存在的原型项目：不重新 Clone 到非空目录，不执行 `git reset --hard`、`git clean -fd`、`git clean -fdx`。
- 在原型项目内提交、推送、创建分支、打标签或发起 PR；不得把个人原型、个人组件或本地配置推送到公共模板仓库。
- 对公共模板仓库执行自动 Pull、自动合并或自动升级；V1.0 升级必须单独授权设计。
- 未经当前对话明确授权执行 `npm run deploy` 或覆盖 PinMe 固定域名。
- 未经明确授权删除、重命名、移动已有原型目录或页面。
- 修改其他需求的原型；跨需求复用必须先提升为公共组件。
- 引入 Vue Router、状态管理、新组件库或新依赖，除非用户明确要求。
- 编辑 `dist/`、关闭类型检查、通过删除页面让构建通过。
- 修改原型项目的 `vite.config.ts` 来迁就启动端口；端口冲突由主 Skill 的 CLI 参数解决。
- 直接修改 superPM 数据库、文件或审计数据；MCP 回写必须另获授权。

## 6. 与 superPM 主项目的隔离

`<prototypeRoot>` 默认为仓库根 `workspace/prototype-workbench`，也可配置到仓库外；无论在哪，它都不是 superPM 的业务数据：

- superPM 的需求工作区扫描只处理 `workspace/requirements/` 下的需求目录；原型项目不参与文档索引、需求记忆或数据库记录。
- 发布构建只暂存 `apps/server/dist`、`apps/server/drizzle`、`apps/web/dist`，不包含 `workspace/`；原型项目不会进入安装包或增量更新包。
- 根 `npm install`、`npm run build`、`npm test`、`npm run typecheck` 不处理原型项目；原型依赖与构建在其目录内独立完成。
- 不得把原型页面作为 superPM 前端页面发布，也不得把原型项目复制进 `apps/web/`。
- 默认路径在 `workspace/` 内时，删除或重置 `workspace/` 会同时删除原型项目。禁止在仓库根执行 `git clean -fdx`、`git clean -fd` 或任何会清除未跟踪 `workspace/` 的命令。
- superPM 更新、回滚和数据迁移只允许操作应用文件与明确的数据根；不得自动重建、覆盖或删除原型项目。
- 数据根迁移、备份与恢复以整个 `workspace/` 为单位，会复制、移走或替换默认路径下的原型目录。执行前必须获得用户明确授权，并先单独备份 `<prototypeRoot>`；恢复后要核对原型是否仍在原路径。
- 原型项目初始化与升级都属于单独授权操作，不属于 superPM 版本更新流程。

## 7. 启动与验证

- 启动：使用主 Skill 的 `start-services.ps1 -Target prototype`；默认 `http://localhost:5199`。缺失或空目录时先自动初始化，已有项目只校验复用。
- 初始化只新增 `prototype.config.json` 与 `node_modules`；不修改已有源码、`vite.config.ts`、端口或依赖声明。
- 端口通过 `npm run dev -- --port <port> --strictPort` 传入，不修改原型项目配置。
- 构建验证：在 `<prototypeRoot>` 内执行 `npm run build`。
- 浏览器验证：打开页面、检查导航高亮、主要交互、空/加载/错误态、900px 与 680px 布局、控制台无报错。
- 无法真实验证时明确说明，不得声称通过。

## 8. 汇报与发布

完成原型任务后按既定格式汇报：

```text
需求：REQ-XXXX 需求名称
改动：文件列表
行为：用户可见变化
验证：构建 + 浏览器 + 控制台结果
风险：未覆盖场景、待确认事项
发布：未发布
```

只有用户在当前对话中明确说“发布/部署/上传”时，才可讨论 PinMe 发布。发布成功并验证链接后，才可讨论 MCP 回写；回写还需要用户单独授权。

## 9. 验收与归档

- 用户验收后，将 `requirement.json.status` 改为 `accepted`。
- 在「系统设置」中关闭该需求全部页面，保留代码、组件和元数据。
- 不删除已验收需求；需要修改时把状态改回 `in-progress` 并重新打开页面。
- 不做个人原型版本管理：不建版本目录、不写变更日志、不打标签。
- 不在原型项目 Git 中提交或推送个人资产；模板 `.git` 仅用于来源识别，公共模板仓库保持只读。
- 不自动 Pull 或升级模板；需要升级时单独设计并取得用户授权。
