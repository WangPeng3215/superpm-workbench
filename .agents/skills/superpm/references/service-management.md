# 本地服务管理

本文件描述 superPM 与 prototype-workbench 在当前仓库中的真实启动方式、端口、健康检查、停止路径和隔离边界。脚本实现以此为准；文档中的端口是经当前配置核对后的默认值，不是不可变的硬编码。

## 1. 真实拓扑

| 项目                  | 开发命令                                        | 默认地址                                    | 说明                                                       |
| --------------------- | ----------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| superPM API           | `npm run dev -w @superpm/server`（由根 `npm run dev` 启动） | `http://127.0.0.1:3001`                     | Fastify，仅回环监听；`/api/health` 公开                     |
| superPM Web           | `npm run dev -w @superpm/web`（由根 `npm run dev` 启动）    | `http://127.0.0.1:5173`                     | Vite，`strictPort: true`，`/api` 代理到 127.0.0.1:3001      |
| prototype-workbench   | `npm run dev -- --port 5199 --strictPort`       | `http://localhost:5199`                     | Vite 8；默认端口与 superPM Web 冲突，故由 CLI 覆盖          |
| superPM 生产/安装态   | `npm start` 或安装目录 `SuperPM.cmd`            | `http://127.0.0.1:3001`                     | 单服务同时提供 API 与构建后的前端；由安装版脚本停止         |

根 `start.ps1` 是现有启动入口：校验 Node 版本、缺少 `node_modules` 时安装依赖，然后前台运行 `npm run dev`（开发态）或 `npm run build` + `npm start`（`-Prod`）。本 Skill 的开发态启动脚本复用它，不复制启动逻辑。

根 `npm run dev` 使用 `concurrently -k`。当 server 子进程退出时，concurrently 会结束另一个 web 子进程，这是开发态停止后 Web 端口随之释放的依据。

## 2. 端口解析

脚本按真实配置解析，不假设示例端口：

- superPM API：进程环境 `PORT` > 仓库根 `.env` 的 `PORT` > `3001`。
- superPM Web：读取 `apps/web/vite.config.ts` 的 `server.port` > `5173`；`strictPort` 为真时端口被占用直接失败。
- superPM Web 代理：读取 Vite 配置中的 `/api` 目标，用于检查代理端口是否与 API 端口一致。当前代理固定为 `3001`，若修改 API 端口必须同步该配置，否则前端请求会失败。
- prototype-workbench：`-PrototypePort` 参数 > Skill 状态文件记录 > `5199`。脚本通过 `npm run dev -- --port <端口> --strictPort` 传入覆盖，不修改 `<prototypeRoot>/vite.config.ts`。
- prototype-workbench 路径：`prototype-init.ps1 -PrototypePath` > 环境变量或仓库根 `.env` 的 `SUPERPM_PROTOTYPE_DIR` > `workspace/prototype-workbench`。仓库内路径只允许在 `workspace/` 下，也允许使用仓库外的独立绝对路径；启停与检查脚本统一按 `SUPERPM_PROTOTYPE_DIR` 解析。
- 原型 Vite 默认绑定 `localhost`，在当前 Windows 环境解析为 IPv6 `::1`。检查脚本优先访问 `http://localhost:<端口>`，不要只用 `127.0.0.1` 判断。

修改端口时必须保证：

- superPM API 与 Web 代理端口一致。
- 原型端口不与 superPM Web（默认 5173）或其他服务冲突。
- 不为绕过端口冲突而修改原型项目的 `vite.config.ts`；用 CLI 参数或 Skill 参数解决。

## 3. 健康检查

### superPM

- `GET http://127.0.0.1:<apiPort>/api/health`，无需登录。
- 成功返回 `status`、`version`、`schemaVersion`、`database`、`pid`。
- `status=ok` 且 `database=ok` 视为健康；`degraded` 或 HTTP 503 视为异常。
- Web 健康检查为 `GET http://127.0.0.1:<webPort>/` 返回 2xx/3xx，并确认监听进程属于本仓库 Vite。
- 运行态由服务端写入数据根的 `runtime/server.json`（开发态默认仓库根 `runtime/server.json`），包含 `pid`、`port`、`startedAt`、`version`、`schemaVersion`、`shutdownToken`。该文件是停止 superPM 的权威凭据；`shutdownToken` 只能用于本机停止请求，不得打印、复制或写入其他文件。

### prototype-workbench

- `GET http://localhost:<port>/` 返回 2xx，页面包含 `Prototype Workbench` 与 `<div id="app">`。
- 监听进程命令行必须包含该项目的绝对路径与 `vite`。当前实际命令行形如：
  `node ...\workspace\prototype-workbench\node_modules\...\vite.js --port 5199 --strictPort`。
- 页面与进程身份任一不匹配，都按“未知实例”处理，不启动也不停止。

## 4. Skill 状态与日志

- 状态目录：仓库根 `runtime/skill/`，已在 `.gitignore` 的 `/runtime/` 范围内，不会进入 Git。
- 状态文件：`superpm.json`、`prototype.json`，记录服务名、端口、启动 PID、开始时间、日志路径和状态；不记录任何令牌。
- 日志目录：`runtime/skill/logs/`，按时间戳保存 stdout 与 stderr；启动失败时先看这里。
- 状态文件是辅助信息，不是健康事实。检查与停止始终以端口、HTTP 和进程身份为准；状态过期时应清理，不得据此杀死进程。

## 5. 启动行为

统一入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/superpm/scripts/start-services.ps1 -Target all
```

根目录 `Start-All.cmd` / `Stop-All.cmd` 是同一脚本的双击包装，固定 `-Target all`；设置 `SUPERPM_NO_PAUSE=1` 可跳过结束时的暂停，便于脚本调用。

`-Target` 可取 `all`、`superpm`、`prototype`；默认 `all`。启动顺序为 superPM 后 prototype，两者相互独立，一个失败不会自动停止另一个；脚本最终汇总并返回非零退出码。

### superPM

- 若 API 健康且 Web 可访问：直接复用，不重启、不写业务数据。
- 若只有一个在运行：报告“部分运行”，不自动补启，也不杀进程；先停止再整体启动。
- 两者都不在运行且端口空闲：后台启动仓库根 `start.ps1`，等待 API 与 Web 健康，默认超时 180 秒（`-TimeoutSeconds` 可调）。
- `start.ps1` 可能因缺少依赖执行 `npm install`；这是现有启动行为。Node 版本不符合根 `package.json` 的 `engines` 时会失败。
- 启动失败时保留日志与已启动进程，报告下一步停止命令，不自动清理。

### prototype-workbench

- 项目状态为 `Missing` / `Empty`：检查 `SUPERPM_PROTOTYPE_AUTO_CLONE`、仓库地址与 Git，Clone 公共模板，校验完整性，写入本地 `prototype.config.json`；`SUPERPM_PROTOTYPE_AUTO_INSTALL` 为真时按锁文件安装依赖。初始化失败保留目录与日志，不自动删除或重试。
- 项目状态为 `Incomplete` / `Conflict`：直接失败并报告缺失项或冲突原因，不覆盖、不重建、不清理已有文件。
- 项目有效但缺少 `node_modules`：失败并提示在 `<prototypeRoot>` 内执行 `npm ci` / `npm install`；启动脚本不擅自改写已有项目依赖。
- 若端口页面与进程身份都匹配：复用。
- 端口被其他进程占用：直接失败并报告占用 PID，不杀进程、不换端口。
- 端口空闲：在原型项目目录后台执行 `npm run dev -- --port <port> --strictPort`，等待页面可访问。
- 不修改已有项目的 `vite.config.ts`、`package.json`、页面或源码；初始化只新增 `prototype.config.json` 与 `node_modules`。

## 6. 检查行为

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/superpm/scripts/check-services.ps1 -Target all
```

只读操作，不启动、不停止、不写状态。输出每个服务的状态、地址、端口、PID 与关键版本信息；`-Json` 输出机器可读结果。全部目标健康时退出码为 0，否则为 1。

检查项：

- superPM：API 健康、Web 可访问、`runtime/server.json` 与健康 PID 是否一致、Web 代理端口是否与 API 一致。
- prototype：页面可访问、端口监听 PID、监听进程命令行是否属于原型项目；额外报告项目路径、项目状态（`valid` / `missing` / `empty` / `incomplete` / `conflict` / `invalid`）、模板版本与依赖状态。检查只读，不触发初始化。
- 状态文件存在但服务已停止时，标记为过期，不视为运行中。

## 7. 停止行为

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/superpm/scripts/stop-services.ps1 -Target all
```

`-Target` 可取 `all`、`superpm`、`prototype`。停止是显式操作；脚本不会在检查或启动失败时自动调用。根目录 `Stop-All.cmd` 等价于 `-Target all`。

### superPM

1. 读取数据根 `runtime/server.json`，核对健康接口返回的 `pid` 与记录一致。
2. 复用现有 `scripts/install/Stop.ps1 -Home <数据根>` 执行优雅停止：该脚本会检查更新锁与迁移锁，然后携带 `x-superpm-shutdown-token` 本机 `POST /api/shutdown`；请求必须带 `Content-Type: application/json` 和 JSON 请求体（如 `{}`），否则 Fastify 返回 HTTP 415。服务端返回 202 后关闭 Fastify、移除 `server.json` 并退出。
3. 等待 API 与 Web 下线。根 `npm run dev` 的 `concurrently -k` 应在 server 退出后结束 Web。
4. 若 Web 仍在运行，确认监听进程命令行包含本仓库路径与 `vite` 后才结束该进程树。
5. 优雅停止失败或超时才考虑 `-Force`：仍需确认 PID 命令行属于本仓库 server，再结束进程树；不得按进程名批量结束。
6. 健康 PID 与 `server.json` 不一致、或实例不是本仓库开发态时，默认拒绝并说明原因。安装版请使用安装目录 `Stop.cmd` / `Stop.ps1`，它会按安装数据根与更新锁执行。

### prototype-workbench

1. 解析端口，找到监听 PID。
2. 校验页面标识与进程命令行均属于原型项目；不匹配则拒绝。
3. 优先结束 Skill 记录的启动进程树；记录不存在或已退出时，结束监听进程树。
4. 等待端口释放，清理 `runtime/skill/prototype.json`。
5. 不按 `node` 进程名批量结束，不影响 superPM 或其他 Vite 项目。

## 8. 与安装版、更新器的边界

- 本 Skill 的启停脚本面向仓库开发态；安装版目录包含 `SuperPM.cmd`、`Stop.cmd`、`Stop.ps1`、`Update.cmd`、`runtime/` 与可替换的 `app/`，其数据根可能是 `%LOCALAPPDATA%\superPM`、配置指针或 `SUPERPM_HOME`，不能假定为仓库根。
- 本 Skill 的开发态停止复用仓库内 `scripts/install/Stop.ps1`（安装包中的同一脚本），只传入开发数据根；安装版仍使用安装目录的 `Stop.cmd` / `Stop.ps1`。更新锁、MCP 注册与运行状态判断继续由安装脚本负责，本 Skill 不重复实现。
- 开发态设置 `SUPERPM_HOME` 时，`runtime/server.json` 位于该数据根下；脚本会按 `SUPERPM_HOME`（进程环境优先，其次 `.env`）解析。若仍找不到状态文件，停止脚本会拒绝并提示确认数据根。
- 不修改发布脚本、更新器、schema 或业务服务来实现本 Skill 的服务管理。

## 9. 更新与数据隔离

- 发布构建只暂存 `apps/server/dist`、`apps/server/drizzle`、`apps/web/dist` 等应用产物，不包含 `workspace/`；默认路径下的 `workspace/prototype-workbench` 不会进入安装包或增量包。
- `workspace/`、`data/`、`runtime/`、`release/` 均在 `.gitignore` 中。个人原型不做 Git 版本管理，也不应提交到公共模板仓库；但 `git clean -fdx` 会删除未跟踪的 `workspace/`，因此禁止在仓库根使用该命令。
- 根 `npm install` 只处理根 workspaces（`apps/*`、`packages/*`），不会安装或改写嵌套原型项目的依赖；原型依赖由它自己的 `package.json` / 锁文件管理，初始化时由 Skill 按锁文件安装。
- 根 `npm run build`、`npm test`、`npm run typecheck` 不包含原型项目；原型构建在其目录内单独执行。
- superPM 更新、回滚、数据迁移只允许操作应用文件与明确的数据根，不得删除、重建或覆盖原型项目；原型初始化与模板升级也不属于 superPM 更新流程。

## 10. 常见问题

| 现象                                         | 原因与处理                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| 原型 5199 在 `127.0.0.1` 打不开               | Vite 绑定 `localhost`（IPv6 `::1`）；用 `http://localhost:5199` 检查        |
| 原型启动报端口占用                           | 5199 已被其他进程使用；换 `-PrototypePort`，不要杀未知进程                  |
| superPM Web 启动失败                         | 5173 被占用且 `strictPort: true`；先确认占用者，再停止本仓库旧实例          |
| `/api/health` 正常但页面请求 404/502         | Web 代理端口与 API 端口不一致；核对 `.env` 的 `PORT` 与 Vite 代理配置       |
| 停止 superPM 提示 PID 不一致                 | 健康实例与 `server.json` 不匹配，可能是旧实例或多数据根；先检查再决定       |
| 停止提示找不到 `server.json`                 | 安装版、`SUPERPM_HOME` 或配置指针数据根；改用安装版停止脚本                 |
| 启动超时                                     | 查看 `runtime/skill/logs/`；确认 Node 版本、依赖、端口与数据库迁移是否正常  |
| 原型启动报“初始化失败”                       | 查看 `runtime/skill/logs/prototype-init-*.log`，按退出码判断：Git 缺失、仓库不可达、路径冲突、Clone 或依赖安装失败 |
| 原型目录非空但提示冲突                       | 该目录不是 prototype-workbench；换 `SUPERPM_PROTOTYPE_DIR` 或手动处理，不要删除未知文件 |
| 原型缺少 `node_modules`                      | 在 `<prototypeRoot>` 内手动执行 `npm ci` / `npm install`；首次自动 Clone 后默认已自动安装 |
| 原型需要固定使用其他仓库或路径               | 在仓库根 `.env` 设置 `SUPERPM_PROTOTYPE_REPOSITORY` / `SUPERPM_PROTOTYPE_DIR`，重启启动脚本 |
