# 安装、更新与回滚

面向使用发布包部署的 Windows x64 环境。开发环境运行方式见根目录 `README.md`。

## 1. 安装包结构

```text
superpm-workbench-<version>-win-x64/
  SuperPM.cmd              启动入口
  Update.cmd               更新入口
  bin/launcher.mjs         稳定启动器
  bin/updater.mjs          独立更新器
  runtime/node.exe         自带 Node 22 运行时
  runtime/LICENSE          Node 许可证
  app/                     可替换程序目录（不保存用户数据）
  install.json             安装版本、schema 与更新器版本
  README.txt
```

`app/` 是更新器唯一替换的目录。数据库、工作区、日志和备份均在独立数据根中，不随程序更新变化。

## 2. 首次安装

1. 解压完整安装包到当前用户可写的目录，例如 `D:\Apps\superPM`。不要放进需要管理员权限才能写入的目录，否则更新无法替换 `app/`。
2. 双击 `SuperPM.cmd`。启动器直接使用 `runtime\node.exe`，不依赖系统 Node。
3. 打开 <http://127.0.0.1:3001>，默认账号 `admin`，密码 `admin123`，首次登录后立即修改。
4. 停止服务：在启动窗口按 `Ctrl+C`。

数据根默认位于 `%LOCALAPPDATA%\superPM`：

```text
data/          SQLite 数据库
workspace/     需求文件、图片与产出物
logs/          server-*.log、mcp.log、migration.log、update.log
backups/       备份
runtime/       server.json、mcp/、update.lock
updates/       清单缓存、更新包暂存、update-progress.json 与 last-update.json
.env           可选的端口与数据目录配置
```

设置 `SUPERPM_HOME` 可改用其他数据根。安装目录内的旧 `data/`、`workspace/` 与 `.env` 会在首次启动时复制到数据根，校验后落位；旧文件保留不删除。

常用检查：

```powershell
SuperPM.cmd --version
SuperPM.cmd --home
```

## 3. 端口与配置

环境变量优先级高于数据根 `.env`，数据根 `.env` 高于安装目录 `.env`：

```dotenv
PORT=3001
SUPERPM_WORKSPACE_DIR=workspace
SUPERPM_DATA_DIR=data
# 可选：覆盖版本清单地址，仅允许 HTTPS 且主机在内置允许列表内
SUPERPM_UPDATE_MANIFEST_URL=https://github.com/WangPeng3215/superpm-workbench/releases/latest/download/update-manifest.json
```

更新器在服务已停止时同样读取上述 `.env` 的 `PORT`，并在更新后用同一端口启动新版本。`SUPERPM_UPDATE_MANIFEST_URL` 只影响应用内「检查更新」使用的清单，独立更新器仍以 `--manifest` 参数或内置地址为准。

## 4. MCP 配置

MCP 与 HTTP 服务共用数据根，由客户端以 stdio 拉起：

```json
{
  "command": "D:\\Apps\\superPM\\runtime\\node.exe",
  "args": ["D:\\Apps\\superPM\\app\\apps\\server\\dist\\mcp\\stdio.js"],
  "env": {
    "SUPERPM_MCP_WRITE": "0"
  }
}
```

自定义数据根时额外设置 `SUPERPM_HOME`。默认只开放只读工具；写入能力与安全边界见 [`mcp.md`](mcp.md)。

## 5. 更新

发布版优先使用应用内更新：登录后进入「系统设置 → 版本与更新」。安装包内仍保留 `Update.cmd`，用于页面不可用或需要离线更新的场景。

### 应用内更新

1. 点击「检查更新」。服务端读取版本清单，校验产品、平台、schema 与最低更新器版本，并把有效清单缓存到数据根 `updates/available-manifest.json`。
2. 发现新版本时展示版本号、发布日期、更新包大小与更新说明。检测到存活的 MCP 进程时列出进程并默认阻止安装，可显式选择强制更新。
3. 确认后，服务端把更新包下载到 `updates/downloads/<版本>/update.zip`，页面显示下载百分比；下载完成即校验大小与 SHA-256，失败会删除文件并保留当前版本。
4. 校验通过后生成 `updates/install-manifest.json`，其中更新包地址指向本地文件，再以独立进程启动 `bin/updater.mjs`。执行器停止服务、创建更新锁、备份数据、替换 `app/`、执行迁移并重启验证；失败自动回滚。
5. 页面持续轮询 `/api/update/status`。服务重启会短暂断开，页面自动重连；更新成功后自动刷新。执行器把阶段进度写入 `updates/update-progress.json`，各阶段包括 `prepare`、`download`、`verify`、`backup`、`swap`、`migrate`、`restart`、`health` 与 `done`。

应用内更新仅在发布安装包中可用；开发环境可以检查清单，但安装会提示改用 `Update.cmd`。版本清单地址可用 `SUPERPM_UPDATE_MANIFEST_URL` 覆盖，仅允许 HTTPS 且主机在内置允许列表内。

从 0.2.0 使用增量包升级到 0.3.0 时，`bin/updater.mjs` 仍是旧版（增量包只替换 `app/`），不会写入阶段进度；页面会回退到 `updates/last-update.json` 和版本检测。需要完整阶段进度时，请使用 0.3.0 完整安装包重新安装一次。

### 命令行更新（备用）

```powershell
Update.cmd --manifest https://github.com/WangPeng3215/superpm-workbench/releases/latest/download/update-manifest.json
```

常用参数：

| 参数                    | 作用                                  |
| ----------------------- | ------------------------------------- |
| `--json`                | 结果以 JSON 输出，过程日志写入 stderr |
| `--force`               | MCP 或服务超过 15 秒未退出时强制结束  |
| `--no-restart`          | 替换与迁移后不启动服务                |
| `--home <目录>`         | 覆盖数据根                            |
| `--install-root <目录>` | 覆盖安装目录                          |

更新器会先把自身复制到系统临时目录再执行，避免替换 `app/` 时被当前进程占用。执行流程：

1. 读取并校验清单：产品名、平台、版本只能升高、schema 不允许降级、最低更新器版本、更新包 SHA-256 与大小。
2. 写入更新锁；MCP 心跳发现锁后自行关闭；请求 HTTP 服务优雅退出。
3. 等待 MCP 退出，默认 15 秒；超时需显式 `--force`，否则中止更新。
4. 下载更新包到数据根 `updates/`，校验摘要与大小，安全解压并检查包内版本与 schema。
5. 通过备份工具创建 `pre-update` 备份（数据库、工作区、数据根 `.env`）。
6. 将 `app/` 改名为 `app.previous`，换入新程序；执行数据库迁移。
7. 启动新版本并轮询健康检查，核对 PID、版本、schema 与数据库状态；通过后释放更新锁。

每个阶段都会更新 `updates/update-progress.json`；应用内页面据此展示进度，页面刷新后仍可恢复状态。更新源仅允许 HTTPS，且主机必须在更新器内置允许列表中（GitHub 与 GitHub Release 资源域名）。本地清单与本地更新包只用于离线演练，不改变线上校验规则。

### 更新结果

结果写入 `updates/last-update.json`，同时追加到 `logs/update.log`。

| 状态              | 含义                                       | 服务状态                                   |
| ----------------- | ------------------------------------------ | ------------------------------------------ |
| `updated`         | 新版本已完成替换、迁移与健康检查           | 新版本运行中（`--no-restart` 时保持停止）  |
| `failed`          | 替换前失败（下载、摘要、解包、备份等）     | 未指定 `--no-restart` 时旧版本自动恢复运行 |
| `rolled-back`     | 替换或迁移后失败，已恢复旧程序与更新前数据 | 未指定 `--no-restart` 时旧版本自动恢复运行 |
| `rollback-failed` | 回滚本身失败，更新锁保留                   | 需手动处理                                 |

`failed` 与 `rolled-back` 都会保留更新前备份。`rolled-back` 还会把更新失败时产生的工作区改名保留为 `workspace.update-failed-<时间戳>`，避免覆盖现场。

### 强制更新

服务或 MCP 未在 15 秒内退出时，加 `--force` 会强制结束相关进程。已知影响：

- 正在执行的 MCP 调用会失败，需要重试。
- 未提交事务丢失；已提交数据由更新前备份兜底。
- 客户端可能需要重连或重启才能恢复 MCP 工具列表。

## 6. 回滚与手动恢复

正常升级失败时更新器自动回滚。需要手动回退到上一版本时：

1. 停止 HTTP 服务与所有 MCP 客户端，确认 `runtime\server.json` 已消失。
2. 在安装目录中把当前 `app` 改名为 `app.failed`，把 `app.previous` 改名为 `app`。
3. 在数据根运行对应版本的备份工具恢复 `pre-update` 备份：

```powershell
D:\Apps\superPM\runtime\node.exe D:\Apps\superPM\app\apps\server\dist\backup-cli.js list
D:\Apps\superPM\runtime\node.exe D:\Apps\superPM\app\apps\server\dist\backup-cli.js verify <备份ID>
D:\Apps\superPM\runtime\node.exe D:\Apps\superPM\app\apps\server\dist\backup-cli.js restore <备份ID>
```

4. 双击 `SuperPM.cmd` 启动旧版本，确认页面与业务数据正常。
5. 仅在确认无更新进程仍在使用后删除 `runtime\update.lock`；不要删除 `last-update.json`、失败工作区或备份，便于定位原因。

若 `app.previous` 已被后续成功更新清理，只能重新解压上一正式版本的完整安装包；用户数据仍在数据根，不受影响。

## 7. 发布流程（维护者）

1. 确认测试通过：`npm run typecheck`、`npm test`、`npm run build`。
2. 按版本管理规范提升根 `package.json` 与各工作区包版本，确认 Git 标签、清单版本和安装包版本一致。
3. 提交并打标签，例如 `v0.2.0`，推送标签。`.github/workflows/release.yml` 会在 Windows runner 上重新测试、构建完整包与增量包、执行安装冒烟测试并创建 GitHub Release。
4. 产物包含：

```text
release/superpm-workbench-<version>-win-x64.zip
release/superpm-workbench-<version>-update-win-x64.zip
release/update-manifest.json
```

离线或本地发布可手动执行：

```powershell
node scripts/release/build-release.mjs --version 0.2.0 --notes "本次更新说明"
```

冒烟测试会解压完整包、使用自带运行时启动服务、检查健康状态与运行时状态、运行 MCP、验证更新锁拒绝、创建并校验备份、优雅停止服务。任一环节失败时构建失败，产物不应发布。

### 升级演练

发布前用真实包执行升级、摘要篡改与阶段故障注入：

```powershell
node scripts/release/rehearse-update.mjs `
  --from release/0.2.0/superpm-workbench-0.2.0-win-x64.zip `
  --manifest release/0.3.0/update-manifest.json
```

默认覆盖 `happy,digest,download,verify,backup,swap,migrate,health`。每个场景都会验证业务数据与工作区文件在升级或回滚后保持完整，失败场景还要求旧版本自动恢复运行、更新锁释放。脚本同时校验 `updates/update-progress.json` 与 `/api/update/status` 的阶段进度；如果源安装包自带的更新器不支持进度文件，则跳过进度断言，只验证兼容升级、`last-update.json` 与回滚结果。

## 8. 已知边界

- 更新包尚未做数字签名；SHA-256 与 HTTPS 只能防传输损坏和错误来源，不能替代发布者签名。签名校验在后续阶段评估。
- 更新器不支持自升级。清单中的 `minUpdaterVersion` 高于本地更新器时，必须重新下载完整安装包。
- 发布源使用 GitHub Release；无自建更新服务器。
- 应用内更新仅在发布安装包中可用；开发环境使用 `Update.cmd` 或完整安装包。服务重启期间页面会短暂离线，更新结果以 `updates/last-update.json` 和新版本号为准。
