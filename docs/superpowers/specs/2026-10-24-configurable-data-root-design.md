# 可配置数据根设计

## 目标

允许用户在系统设置中指定 superPM Workbench 的数据保存位置。切换时若当前数据根已有数据库、工作区文件、配置或备份，则先停止服务，完整复制并校验后再切换配置指针、自动重启。旧数据默认保留，由用户决定是否删除。

## 已确认决策

- 切换完成后旧数据默认保留，重启后弹窗让用户选择保留或删除。
- 迁移范围：数据库、工作区、配置 `.env`、备份；不迁移日志、更新缓存和运行时状态。
- 用户选择父目录，允许父目录非空；应用在其中创建 `superPM` 子目录。
- 确认后自动停止服务、迁移并重启，不需要用户手动操作命令行。
- 配置指针存放在用户 AppData 配置目录，而不是数据目录。

## 范围与非目标

本设计包含数据根解析、配置指针、目录校验、迁移助手、旧数据清理、设置界面、API、发布兼容与测试。

不包含：

- 自动定时同步、云盘同步或多副本。
- 按模块拆分数据库和工作区路径。
- 服务运行中热迁移。
- 迁移日志、更新缓存和运行时状态。
- 自动删除旧数据。
- 通用的更新器自升级机制；见「发布与兼容」中的一次性 bootstrap。
- 数据加密或多实例共享同一数据根。

## 术语

- **数据根（home）**：存放 `data/`、`workspace/`、`.env`、`backups/`、`logs/`、`updates/`、`runtime/` 的根目录。
- **配置目录**：存放配置指针、迁移任务与进度、迁移日志的稳定目录，默认 `%APPDATA%\superPM`。
- **配置指针**：配置文件 `config.json` 中的 `home` 字段，是用户指定数据根的唯一持久记录。
- **迁移助手**：发布包 `install/bin/move-home.mjs`，独立进程完成停服、复制、校验、切换和重启。

## 数据根解析

### 优先级

1. 显式设置的 `SUPERPM_HOME` 环境变量。
2. 配置指针中的 `home`。
3. 平台默认目录：
   - Windows：`%LOCALAPPDATA%\superPM`
   - macOS：`~/Library/Application Support/superPM`
   - Linux：`$XDG_DATA_HOME/superPM` 或 `~/.local/share/superpm`

开发仓库（非发布包）未显式设置 `SUPERPM_HOME` 时继续使用仓库根，不读取配置指针。

### 单一实现

新增 `packages/shared/src/data-root.ts`，提供：

```ts
interface DataRootResolution {
  home: string;
  source: "env" | "config" | "default" | "development";
  configDir: string;
  configPath: string;
  markerPath: string;
  warning?: string;
}

function resolveDataRoot(env?: NodeJS.ProcessEnv): DataRootResolution;
function resolveConfigDir(env?: NodeJS.ProcessEnv): string;
```

- 服务端、MCP、备份 CLI 直接引用该模块。
- 启动器、更新器、迁移助手通过 esbuild 打包该模块，发布包内不保留运行时依赖。
- 服务端读取启动器写入的 `SUPERPM_HOME_SOURCE` 区分来源；直接启动且已有 `SUPERPM_HOME` 时视为 `env`。
- 更新器命令行 `--home` 优先级最高，其次配置指针，再次平台默认。

### 配置目录

- Windows：`%APPDATA%\superPM`
- macOS：`~/Library/Application Support/superPM`
- Linux：`$XDG_CONFIG_HOME/superPM` 或 `~/.config/superpm`
- 测试和便携场景可用 `SUPERPM_CONFIG_DIR` 覆盖。

### 启动保护

- 来源为 `config` 时，数据根必须存在；不存在直接报错，不自动创建空目录。错误信息包含配置路径和不可用目录，提示检查移动硬盘或网络盘连接。
- 来源为 `config` 时，数据根必须包含数据库或 `.superpm-home.json` 标记；两者都没有时拒绝初始化，避免磁盘挂载为空目录后静默新建空库。
- `config.json` 解析失败或版本高于当前支持版本时，先读取 `config.json.bak`；备份也不可用则明确报错，不静默回退默认目录。
- 来源为 `default` 或 `env` 时保持现有创建行为。
- 启动器遇到数据根不可用时退出码非 0；`SuperPM.cmd` 在非 0 退出时暂停，避免窗口直接消失。
- 文档提供恢复路径：目标盘长期不可用时，关闭应用后把 `config.json` 改名，启动器会回到默认数据根；若旧数据已删除，需要先恢复原盘或从备份恢复。

## 配置指针

路径：`<配置目录>/config.json`

```json
{
  "schemaVersion": 1,
  "home": "D:\\data\\superPM",
  "previousHome": "C:\\Users\\user\\AppData\\Local\\superPM",
  "updatedAt": "2026-10-24T08:30:00.000Z"
}
```

写入规则：

- 只有迁移助手写入，服务端和界面不直接修改。
- 临时文件写入后原子 rename；写入前把旧文件复制为 `config.json.bak`。
- `previousHome` 仅用于排查和回滚提示，不作为解析依据。
- `schemaVersion` 高于应用支持版本时拒绝解析，避免旧版本误用新格式。

数据根标记：`<home>/.superpm-home.json`

```json
{
  "schemaVersion": 1,
  "home": "D:\\data\\superPM",
  "movedFrom": "C:\\Users\\user\\AppData\\Local\\superPM",
  "jobId": "20261024-083000-abc123",
  "createdAt": "2026-10-24T08:30:00.000Z"
}
```

旧数据根标记：`<oldHome>/.superpm-moved.json`，记录 `to`、`jobId`、`movedAt`，供清理接口校验。

## 目标目录与校验

### 目标路径

- 用户选择父目录。父目录本身名称不区分大小写等于 `superPM` 时，目标就是该目录；否则目标为 `<父目录>/superPM`。
- 父目录必须存在且是目录；父目录允许非空。
- 目标必须不存在或为空；已存在且非空时拒绝，绝不覆盖。
- 目标存在但为空时，只在切换阶段删除该空目录后 rename 暂存目录；删除失败则中止。

### 校验项

- 路径必须为绝对路径。
- 拒绝 UNC 路径、盘符根目录、文件系统根目录和 `\\?\` 路径。
- 目标不能等于当前数据根，不能位于当前数据根内部，也不能包含当前数据根。
- 目标不能位于安装目录内部，安装目录也不能位于目标内部。
- 目标不能位于配置目录内部。
- 目标路径长度超过 200 个字符时拒绝，避免工作区深层文件触发 Windows 路径上限。
- 目标或其最近存在的上级目录必须可写，并执行一次临时文件写入探测。
- 可用空间必须不少于迁移内容总量 × 1.15 + 256MB。
- 当前生效的 `SUPERPM_DATA_DIR`、`SUPERPM_WORKSPACE_DIR` 若为绝对路径则拒绝迁移，并提示变量名；相对路径允许，但解析结果必须在当前数据根内。
- 数据目录与工作区目录不能互相包含。
- 源数据库存在时执行一次只读完整性检查；数据库损坏时拒绝迁移，完整性问题交由现有备份/恢复流程处理。
- 源数据库缺失但工作区存在文件时拒绝迁移，提示数据不完整，避免复制文件却丢失关联关系。
- 源数据库和工作区都没有内容时允许只切换配置指针：不复制数据库和工作区，不产生待清理记录；`.env` 与备份仍按范围复制。
- 网络映射盘允许选择，但返回警告：迁移后需要保持该盘连接；连接不可用时应用会拒绝以空目录启动。

### 迁移内容与空间计算

- 数据库：源数据库文件的一致性备份结果。
- 数据目录中的其他文件。
- 工作区全部条目，保留相对路径、类型和大小；符号链接只复制链接本身，不跟随。
- `.env`。
- `backups/`。
- 不包含 `logs/`、`updates/`、`runtime/`。

空间计算使用上述内容的文件总量；数据库大小按当前文件与 WAL 估算，最终以复制校验结果为准。

## 迁移助手

### 文件与启动

- 源文件：`scripts/install/move-home.mjs`
- 发布位置：`install/bin/move-home.mjs`
- 构建方式：esbuild 打包为 ESM，目标 Node 22；`better-sqlite3` 保持 external，通过 `createRequire(join(installRoot, "app", "package.json"))` 从程序目录解析。
- 启动方式：服务端写任务文件和操作锁后，用发布包自带 Node 以 detached 方式启动，参数为 `--job <任务文件>`。
- 迁移日志：`<配置目录>/logs/move-home-YYYY-MM-DD.log`。
- 进度文件：`<配置目录>/move-home.json`。

任务文件：`<配置目录>/move-home-job.json`

```json
{
  "schemaVersion": 1,
  "jobId": "20261024-083000-abc123",
  "fromHome": "C:\\Users\\user\\AppData\\Local\\superPM",
  "toHome": "D:\\data\\superPM",
  "installRoot": "C:\\Program Files\\superPM",
  "requestedBy": 1,
  "createdAt": "2026-10-24T08:30:00.000Z"
}
```

### 流程

1. 读取并校验任务文件：`fromHome` 必须等于当前解析结果，`toHome` 必须通过重新校验，`installRoot` 必须包含 `app/` 和 `bin/`。
2. 确认没有活跃更新锁、没有其他迁移任务；检查 MCP 注册表，拒绝活跃 MCP 进程。
3. 写操作锁 `<配置目录>/operation.lock`，包含 `kind: "move"`、`jobId`、`pid`、`startedAt`；开始心跳。
4. 重新校验来源与目标，记录源文件清单、总字节数和数据库快照。
5. 等待 500ms 让创建任务的 HTTP 响应返回，再调用当前服务 `/api/shutdown`，使用 `runtime/server.json` 中的停止令牌。等待 15 秒；未退出则结束进程树并记录原因。
6. 在目标任务所在卷创建暂存目录 `.superPM-staging-<jobId>`，确保 rename 不发生跨卷复制。
7. 复制数据库：打开源数据库执行 `backup()` 到暂存目录；随后复制数据目录中的其他文件，排除数据库、`-wal`、`-shm`。
8. 复制工作区、`.env` 和 `backups/`，按文件与字节更新进度，最多每 200ms 写一次进度文件。
9. 校验：
   - 目标数据库 `integrity_check` 为 `ok`。
   - 表清单与各表行数与源快照一致。
   - schema 版本一致。
   - 工作区相对路径、类型、大小清单与源一致。
   - `.env` 与备份文件清单一致。
   - 目标剩余空间仍满足最低要求。
10. 在暂存目录写入 `.superpm-home.json`。
11. 如果目标存在且为空，删除该空目录；rename 暂存目录到目标。
12. 在旧数据根写入 `.superpm-moved.json`。
13. 原子写入 `config.json`，保留旧配置为 `.bak`。
14. 通过发布包启动器启动新服务，等待 `/api/health` 就绪；从新数据根 `runtime/server.json` 确认服务已写入状态，并校验版本、schema 与数据根。
15. 写完成状态，设置 `cleanup: "pending"`（仅当确实迁移了数据库或工作区内容），释放操作锁。
16. 服务启动后读取进度文件完成状态；若进程在写完成状态前退出，启动时按当前数据根与目标标记做一次状态收敛。

### 操作锁

`<配置目录>/operation.lock` 被以下进程检查：

- 启动器：存在活跃迁移锁时拒绝启动；迁移助手为重启而启动的实例通过 `SUPERPM_MOVE_RESTART_JOB` 匹配 `jobId` 放行。
- 更新器：存在活跃迁移锁时拒绝更新。
- MCP：存在活跃迁移锁时拒绝连接。
- 迁移 API：存在活跃迁移锁或更新锁时拒绝新任务。
- 锁包含 PID 与心跳时间；PID 已退出时立即视为陈旧锁并清理。PID 无法判断或心跳超过 30 分钟时，才按现有更新锁策略超时清理。清理必须写入日志。
- 服务端启动时若发现进度为 `running` 但没有活跃操作锁，按当前数据根与目标标记收敛为失败或完成状态。

### 进度状态

```json
{
  "schemaVersion": 1,
  "jobId": "20261024-083000-abc123",
  "status": "running",
  "phase": "copying",
  "fromHome": "C:\\Users\\user\\AppData\\Local\\superPM",
  "toHome": "D:\\data\\superPM",
  "progress": {
    "copiedBytes": 15728640,
    "totalBytes": 52428800,
    "copiedFiles": 120,
    "totalFiles": 380
  },
  "startedAt": "2026-10-24T08:30:00.000Z",
  "updatedAt": "2026-10-24T08:30:12.000Z",
  "cleanup": "none"
}
```

- `phase`：`preparing`、`stopping`、`copying`、`verifying`、`switching`、`restarting`、`completed`、`failed`。
- `status`：`running`、`completed`、`failed`。
- `cleanup`：`none`、`pending`、`kept`、`deleted`。
- 失败时增加 `error: { message, phase, rollback: "restored-old" | "not-needed" | "failed" }`。
- 进度文件损坏或缺失时，界面回退为“正在重启/状态未知”，不阻断服务启动。

## 失败与回滚

- 切换配置前失败：旧配置不变，清理暂存目录，重启旧服务，状态标记失败。
- 写配置前失败：旧服务仍可启动；助手负责恢复，失败则提示手动启动。
- rename 目标失败：清理暂存目录，保持旧配置，重启旧服务。
- 写配置失败：目标目录保留，旧配置不变，重启旧服务，报告目标路径供排查。
- 启动新服务失败：停止新进程，恢复旧配置，重启旧服务；已复制的新目录保留，不删除，报告路径。
- 旧服务恢复失败：状态标记严重失败，保留配置与数据，日志写明手动恢复命令。
- 任何阶段都不删除源数据。
- 所有失败都写入迁移日志，包含阶段、错误链（含 `cause`）和已执行的回滚动作。

## 旧数据清理

- 成功后旧数据默认保留。
- 待清理记录存放在 `move-home.json`，包含 `oldHome`、`managedPaths`（相对路径）、`jobId`、`movedAt`。
- 重启后由前端统一弹出一次提示，无论当前在哪个页面；设置页同时保留待处理提示。
- 「保留旧数据」只清除待处理状态，不删除任何文件。
- 「删除旧数据」需要二次危险确认，仅删除记录的 `data` 目录、`workspace` 目录、`backups/` 和 `.env`。
- 不删除旧数据根本身，不删除 `logs/`、`updates/`、`runtime/` 和 `.superpm-moved.json`。
- 删除接口校验：
  - `jobId` 与待处理记录一致。
  - `oldHome` 与记录一致，且不是当前数据根。
  - 旧数据根标记存在，`to` 等于当前数据根，`jobId` 一致。
  - 旧数据根不是安装目录，不是盘符根或文件系统根，不是当前数据根的父级。
  - 每个待删除路径必须是记录中的安全相对路径，解析后位于旧数据根内。
- 删除时逐层 `lstat` 检查，遇到符号链接或 junction 只删除链接本身，绝不跟随到链接目标。
- 部分删除失败时保留待处理状态，返回已删除与失败路径，允许重试。
- 界面提示：若有其他旧版本程序仍指向旧数据根，删除后该程序将无法使用原数据。

## API

所有接口沿用现有认证中间件，仅本机服务可访问。

### `GET /api/system`

在现有字段上增加：

```ts
{
  homePath: string;
  homeSource: "env" | "config" | "default" | "development";
  dataRootEditable: boolean;
  dataRootLockedReason?: "environment" | "development" | "not-packaged" | "config-unwritable";
  moveInProgress: boolean;
  pendingOldData?: {
    jobId: string;
    oldHome: string;
    movedAt: string;
    managedPaths: string[];
  };
}
```

### `POST /api/system/home/pick`

- Windows：服务端调用固定的 PowerShell `FolderBrowserDialog` 脚本，返回所选目录；不拼接用户输入到脚本。
- 其他平台或 PowerShell 不可用时返回明确错误，界面保留手动输入能力。
- 超时 5 分钟；用户取消返回 `{ path: null }`。

### `POST /api/system/home/validate`

请求：

```json
{ "parent": "D:\\data" }
```

响应 `200`：

```ts
{
  targetHome: string;
  exists: boolean;
  empty: boolean;
  writable: boolean;
  freeBytes: number;
  requiredBytes: number;
  sourceBytes: number;
  databaseExists: boolean;
  databaseRows?: number;
  workspaceFiles: number;
  warnings: string[];
  blockedReasons: string[];
}
```

用户输入不合法时返回原因，不抛 500；服务端在启动迁移前重新校验。

### `POST /api/system/home/move`

请求：

```json
{ "parent": "D:\\data", "confirmTarget": "D:\\data\\superPM" }
```

响应 `202`：

```json
{ "status": "started", "jobId": "...", "targetHome": "D:\\data\\superPM" }
```

错误码：

- `HOME_MOVE_NOT_AVAILABLE`：开发环境、非发布包、环境变量指定数据根或配置目录不可写。
- `HOME_MOVE_INVALID`：目录校验失败，返回 `blockedReasons`。
- `HOME_MOVE_BUSY`：更新、迁移或活跃 MCP 阻止。
- `HOME_MOVE_SPAWN_FAILED`：助手启动失败；服务端删除任务文件并释放操作锁。
- `HOME_MOVE_STATE_FAILED`：任务文件或操作锁写入失败。

### `GET /api/system/home/move`

返回当前或最近一次任务状态：

```ts
{
  status: "idle" | "running" | "completed" | "failed";
  jobId?: string;
  phase?: string;
  fromHome?: string;
  toHome?: string;
  progress?: {
    copiedBytes: number;
    totalBytes: number;
    copiedFiles: number;
    totalFiles: number;
  };
  startedAt?: string;
  updatedAt?: string;
  error?: { message: string; phase: string; rollback: string };
  cleanup?: "none" | "pending" | "kept" | "deleted";
}
```

### `POST /api/system/home/cleanup`

请求：

```json
{ "action": "keep", "jobId": "...", "oldHome": "..." }
```

或：

```json
{ "action": "delete", "jobId": "...", "oldHome": "...", "confirm": true }
```

响应：

```ts
{
  action: "keep" | "delete";
  deletedPaths?: string[];
  failedPaths?: string[];
  error?: string;
}
```

## 界面

### 本地存储

- 显示当前数据根、来源（配置文件 / 环境变量 / 默认目录 / 开发环境）、数据库位置、工作区位置。
- 「在资源管理器中打开」打开当前数据根。
- 「修改保存位置」在可编辑时可用；不可编辑时显示具体原因。
- 存在待清理记录时显示横幅和「处理旧数据」入口。
- 迁移进行中显示进度入口；刷新页面后可恢复。

### 修改保存位置弹窗

- 绝对路径输入框和「浏览…」按钮；Windows 使用原生目录选择，其他平台提示手动输入。
- 实时或点击「检查」后调用校验接口，展示最终目标路径、来源数据量、所需空间、可用空间、数据库与工作区数量。
- 阻断原因逐条显示；有警告时仍需用户确认。
- 明确说明：服务会停止并重启，迁移期间请不要关闭窗口或断开目标磁盘；旧数据会保留。
- 校验通过且用户确认后才可点击「开始迁移」。

### 迁移进度

- 展示阶段、字节进度、文件数量、已经过时间。
- 停服与重启阶段显示“服务正在重启”，轮询失败按退避重试，不显示错误弹窗。
- 完成后重新加载系统信息并关闭。
- 失败时展示错误、回滚结果和目标目录保留位置；提供关闭与重试入口。

### 旧数据处理弹窗

- 展示新数据根、旧数据根和将删除的路径。
- 默认操作「保留旧数据」。
- 「删除旧数据」使用危险按钮，二次确认；提示不可恢复以及旧版本程序影响。
- 处理后更新设置页状态。

### 可访问性

- 路径文本可换行或省略并提供完整值提示。
- 所有按钮有可读名称，键盘可完成选择、校验、确认和取消。
- 进行中状态不只依赖颜色，提供文字与进度值。
- 窄屏下弹窗不横向溢出。

## 安全边界

- 迁移和清理只操作已解析、已校验的数据根与记录中的相对路径。
- 不使用用户输入拼接 shell 命令；目录选择脚本固定。
- 清理接口必须同时匹配 `jobId`、`oldHome`、当前数据根和旧目录标记。
- 迁移助手不读取数据根以外的业务文件，不通过 `..`、符号链接或 junction 绕过根目录限制。
- 服务端仍只绑定 `127.0.0.1`，不因该功能暴露到公网。
- 不记录 `.env` 内容、令牌或数据库查询数据到迁移日志。

## 发布与兼容

### 更新器版本

- 启动器、更新器和迁移助手都需要新增配置指针与操作锁逻辑，因此更新器版本从 `1.0.0` 升到 `1.1.0`。
- `install.json`、发布清单 `minUpdaterVersion`、诊断接口返回的更新器版本同步为 `1.1.0`。
- 0.4.0 清单设置 `minUpdaterVersion: "1.1.0"`。

### 0.3.3 → 0.4.0 一次性 bootstrap

- 0.3.3 自带的更新器 1.0.0 只接受仅含 `app/` 的增量包，无法替换 `bin/`，因此不能用于升级到 0.4.0。
- 0.3.3 应用内检查 0.4.0 时会因最低更新器版本不足而拒绝安装，这是预期行为。
- 0.4.0 使用完整安装包升级：关闭应用后，将完整包解压到新目录，或覆盖原安装目录；数据根不变，数据不受影响。
- 若解压到新目录，需要把 MCP 客户端配置中的启动路径改到新安装目录；否则旧 MCP 程序不会读取新配置指针。
- 升级到 0.4.0 后，后续版本恢复应用内增量更新。
- 发布说明和 `docs/install-update.md` 必须写明这步 bootstrap。

### 版本

- 本次为功能迭代，正式发布时从 `0.3.3` 升到 `0.4.0`；实施阶段保持当前版本，准备发布时再定版。
- 若同时包含数据库迁移，必须遵循现有备份、升级前快照和失败恢复流程。

## 测试与验收

### 单元测试

- 数据根解析：环境变量、配置指针、默认目录优先级；`SUPERPM_HOME_SOURCE` 映射；开发环境不读配置指针。
- 配置目录：各平台路径、`SUPERPM_CONFIG_DIR` 覆盖。
- 配置指针：合法读写、缺失、损坏、版本过高、`.bak` 回退、原子写入。
- 启动保护：配置数据根不存在、空目录无标记、有数据库无标记、默认目录正常创建。
- 目标校验：子目录规则、非空目录、嵌套关系、UNC、根目录、长度、可写、空间、绝对路径覆盖、数据/工作区重叠、数据库缺失但工作区有文件。
- 迁移助手：复制范围、数据库备份、工作区清单、校验失败、rename 失败、配置写入失败、启动失败回滚、进度写入。
- 旧数据清理：正常删除、保留、jobId 不匹配、标记不匹配、路径越界、符号链接、部分失败。
- 操作锁：启动器拒绝、更新器拒绝、MCP 拒绝、restart 放行、陈旧锁清理。

### 集成与发布演练

- 临时目录内用真实 SQLite 与工作区执行完整迁移，断言数据、文件、配置、标记和状态。
- 注入失败点，验证旧配置恢复、旧服务重启、目标保留和日志。
- 新增 `scripts/release/rehearse-move-home.mjs`：构建 0.4.0 发布包，安装到临时目录，创建示例数据，执行应用内迁移，验证重启后数据根、数据库、工作区、备份和更新器版本。
- 演练从默认目录迁移到另一临时目录，再执行一次反向迁移，覆盖 `previousHome`、清理和再次迁移。
- 演练 0.3.3 → 0.4.0：确认应用内更新被最低更新器版本拒绝，完整包覆盖安装后数据根和业务数据不变。

### 前端与真实交互

- Playwright 覆盖设置页展示、不可编辑原因、校验错误、迁移弹窗、进度恢复、失败提示、保留/删除弹窗；开发环境通过网络拦截模拟服务端响应，真实迁移由发布包演练覆盖。
- 真实安装包中手动验证 Windows 原生目录选择、手动路径输入、真实重启、数据与文档打开、保留与删除旧数据。
- 不直接修改数据库代替界面操作；不以合成事件替代目录选择和确认交互。

### 全量验证

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npx playwright test`
- 发布包迁移演练
- 真实浏览器验收

## 文档

- `docs/install-update.md`：数据根说明、修改保存位置、迁移流程、旧数据处理、0.4.0 bootstrap、故障排查（磁盘未连接、权限、空间不足、日志位置）。
- `docs/deployment-update-strategy.md`：配置指针、操作锁、迁移助手、更新器 1.1.0 与 `minUpdaterVersion`。
- `README.md`：更新数据根默认值和修改入口，不展开实现细节。
- 发布说明：0.4.0 需要完整包升级一次，之后恢复应用内更新。

## 已知限制

- 目标盘断开、权限变化或防病毒软件占用文件会导致迁移失败；失败回滚保证源数据不变。
- 网络映射盘的稳定性不受应用控制；启动保护只避免空目录误初始化，不能保证网络盘始终可用。
- 迁移耗时与数据量成正比；备份和大量文档会明显增加复制时间。
- 原生目录选择仅在 Windows 实现；其他平台使用手动绝对路径。
- 清理旧数据不会删除日志、更新缓存和运行时状态，旧目录可能仍残留少量文件。
