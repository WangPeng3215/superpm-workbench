# 在 Ubuntu 服务器上部署 superPM

适用于自有 VPS / 内网服务器。项目是单端口 Node 服务（Fastify 同时提供 API 与前端产物），
由 systemd 守护，Nginx 或 Caddy 反向代理对外。

## 1. 前提

| 项目    | 要求                                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 系统    | Ubuntu 22.04 / 24.04（Debian 12 同样适用）                                                                                                                                   |
| 规格    | 1 核 2 GB 内存 / 2 GB 磁盘起步（`node_modules` 约 300 MB，构建时内存峰值约 1 GB）。**1 GB 内存**的实例也能跑，但要先加 4 GB swap 并确认 `vm.swappiness` 不为 0，见 §2 的说明 |
| Node.js | `>=22.12.0 <25`，推荐 22 LTS                                                                                                                                                 |
| 域名    | 可选；用 IP 直接访问就跳过 HTTPS 一节                                                                                                                                        |

**为什么只能源码部署**：Release 里的安装包只提供 `win32-x64`（`SuperPM.cmd` 启动器 + 内置更新器），
没有 Linux 包。Linux 上从源码构建即可，功能完整，但**没有内置更新器**（见 §9）。

## 2. 一键安装（推荐）

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git curl

# 安装 superPM
curl -fsSLO https://raw.githubusercontent.com/WangPeng3215/superpm-workbench/main/scripts/linux/install-superpm.sh
sudo bash install-superpm.sh
```

> **国内网络如果卡在下载脚本**（`raw.githubusercontent.com` 常年不通或极慢），改用 git 拿脚本，
> 仓库本身的 `https://github.com/...` 通常可通、而且更快：
>
> ```bash
> sudo git clone --depth 1 https://github.com/WangPeng3215/superpm-workbench.git /tmp/superpm-src
> sudo bash /tmp/superpm-src/scripts/linux/install-superpm.sh
> ```
>
> 服务器访问 GitHub 本身不稳定时，安装脚本内部的 `git clone` 也会失败。可以先把源码放到
> 目标目录再跑脚本（脚本对已有仓库只做 `git pull`），或给 `git` 配国内镜像。

### 1 GB 内存的实例：先修 swap

`vite build` 峰值约 1 GB，1 GB 内存的实例会直接 OOM，而且默认的阿里云镜像把
`vm.swappiness` 设成了 `0`——swap 完全不会被使用，内存一满就杀进程（连云助手客户端都会被杀掉，
表现为实例"活着但连不上"）。上大内存机型之前，先这样做：

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 关键：让内核真的愿意换页
sudo sysctl -w vm.swappiness=60
echo 'vm.swappiness=60' | sudo tee /etc/sysctl.d/99-superpm.conf
```

之后构建可以用 `--minify false` 进一步压峰值（产物大一些，但 Nginx 开 gzip 后差别不大）。

脚本结束会打印初始账号口令，只显示这一次。它做的事：

1. 校验 Node 版本，不满足直接报错退出；
2. 创建无登录权限的系统账号 `superpm`；
3. 拉取源码到 `/opt/superpm`，`npm ci` + `npm run build`；
4. 首次运行时生成 `/etc/superpm/superpm.env`（含随机初始口令），之后不再覆盖；
5. 安装并启动 `superpm.service`，最后轮询 `/api/health` 确认就绪。

可覆盖的变量：

```bash
sudo PORT=8080 APP_DIR=/srv/superpm DATA_DIR=/srv/superpm-data bash install-superpm.sh
```

安装后的目录分布：

| 路径                                  | 内容                                                    |
| ------------------------------------- | ------------------------------------------------------- |
| `/opt/superpm`                        | 代码与构建产物（可随时删除重建）                        |
| `/var/lib/superpm`                    | 数据根：`data/superpm.sqlite`、`workspace/`、`backups/` |
| `/etc/superpm/superpm.env`            | 运行时配置（`640 root:superpm`）                        |
| `/etc/systemd/system/superpm.service` | 服务单元                                                |

## 3. 手动部署（等价步骤）

想自己控制每一步时按下面执行。假定代码放 `/opt/superpm`、数据放 `/var/lib/superpm`。

```bash
sudo useradd --system --create-home --home-dir /var/lib/superpm --shell /usr/sbin/nologin superpm
sudo git clone https://github.com/WangPeng3215/superpm-workbench.git /opt/superpm
sudo chown -R superpm:superpm /opt/superpm /var/lib/superpm

sudo -u superpm env HOME=/var/lib/superpm bash -c \
  'cd /opt/superpm && npm ci --no-audit --no-fund && npm run build'
```

配置文件 `/etc/superpm/superpm.env`：

```ini
PORT=3001
# 只监听回环，由反向代理对外；要直接暴露端口就改 0.0.0.0
SUPERPM_HOST=127.0.0.1
# 数据根：数据库、工作区文件、备份都在这里
SUPERPM_HOME=/var/lib/superpm
# 服务器上没有本机程序可打开，关闭「在文件夹中显示」
SUPERPM_ALLOW_SYSTEM_OPEN=0
# 首启创建的 admin 口令，仅在数据库里还没有 admin 时生效
SUPERPM_ADMIN_PASSWORD=换成你自己的强口令
```

```bash
sudo chown root:superpm /etc/superpm/superpm.env
sudo chmod 640 /etc/superpm/superpm.env
```

服务单元：把 `deploy/superpm.service` 里的 `__SVC_USER__` / `__APP_DIR__` / `__ENV_FILE__` /
`__NODE_BIN__` 替换成实际值（`__NODE_BIN__` 用 `readlink -f $(command -v node)`），
复制到 `/etc/systemd/system/superpm.service`，然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now superpm
systemctl status superpm --no-pager
```

### 环境变量一览

| 变量                         | 默认                     | 说明                                                                      |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `PORT`                       | `3001`                   | HTTP 端口                                                                 |
| `SUPERPM_HOST`               | `127.0.0.1`              | 监听地址。**故意不读通用 `HOST`**，避免被平台注入后把本机服务暴露到局域网 |
| `SUPERPM_HOME`               | `~/.local/share/superpm` | 数据根；不设则随服务用户家目录走，建议显式指定                            |
| `SUPERPM_DATA_DIR`           | `data`                   | 数据库子目录（相对数据根或绝对路径）                                      |
| `SUPERPM_WORKSPACE_DIR`      | `workspace`              | 工作区子目录                                                              |
| `SUPERPM_WEB_DIR`            | `apps/web/dist`          | 前端产物目录，前后端分开部署时才需要                                      |
| `SUPERPM_ALLOW_SYSTEM_OPEN`  | 开启                     | 设为 `0` 关闭「用本机程序打开/在文件夹中显示」                            |
| `SUPERPM_ADMIN_PASSWORD`     | `admin123`               | 首启口令，**少于 6 位会拒绝启动**                                         |
| `SUPERPM_ALLOW_REGISTRATION` | `on`                     | 设为 `off` 关闭自助注册：登录页隐藏注册入口，注册接口返回 403             |

## 4. 反向代理与 HTTPS

### Caddy（推荐，证书自动申请）

```bash
sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`：

```
pm.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

```bash
sudo systemctl reload caddy
```

Caddy 默认不限制请求体大小，附件上限 50 MB 由应用自己校验，无需额外配置。

### Nginx + certbot

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/superpm`：

```nginx
server {
    listen 80;
    server_name pm.example.com;

    # 附件上传上限 50 MB，留一点余量
    client_max_body_size 60m;

    # 前端产物是未压缩的 JS/CSS，开 gzip 后首屏传输约从 2.7 MB 降到 570 KB
    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 富文本与文件接口有长请求，放宽读超时
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/superpm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d pm.example.com
```

## 5. 防火墙

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

`3001` 不要对外开放：`SUPERPM_HOST=127.0.0.1` 时它本来就只监听回环，反代在同一台机器上即可。

## 6. 首次登录

打开 `https://pm.example.com`，用 `admin` + 初始口令登录，然后**立刻**
点右上角账户菜单（头像 + 显示名）→「修改密码」。

`SUPERPM_ADMIN_PASSWORD` 只在数据库里还没有 `admin` 时生效；之后改口令请走界面，
改环境变量不会覆盖已有账号。

### 多用户与数据隔离

本版本起支持自助注册与按账号隔离数据，同一台服务器可以给多个人用：

- 每个账号登录后是一套空工作台；需求、问题、产出物、每日任务、会议、便签、优化点、工具箱
  都按归属账号过滤，拿别人的 ID 直接打接口会返回 404。
- `admin` 是超管（顶栏显示「超管」标识），能看到全部账号的数据；旧版本升级上来的历史数据
  在迁移 0020 中归属 `admin`。
- **公网服务器建议二选一**：要么把注册关掉（`SUPERPM_ALLOW_REGISTRATION=off`，账号由你创建），
  要么接受任何访问者都能注册一个自己的隔离空间。
- 账号停用：数据库里 `UPDATE users SET status='disabled' WHERE username='…'`，
  该账号无法登录，已登录的会话在下一次请求即失效。
- 升级到本版本无需手工执行 SQL：服务启动时自动应用迁移 0020（`schemaVersion` 从 19 变 20）。
  详见 [`docs/multi-user.md`](multi-user.md)。

## 7. 日常运维

```bash
systemctl status superpm            # 状态
systemctl restart superpm           # 重启（改过 env 文件后需要）
journalctl -u superpm -f            # 实时日志
journalctl -u superpm -n 200 --no-pager
curl -fsS http://127.0.0.1:3001/api/health   # 健康检查，无需登录
```

健康检查返回 `{"status":"ok","version":"1.1.0","schemaVersion":20,...}`。可用它做监控探针。

## 8. 备份与恢复

应用自带备份工具，产出的备份在数据根的 `backups/` 下：

```bash
sudo -u superpm bash -c 'cd /opt/superpm && \
  node apps/server/dist/backup-cli.js create --reason nightly'

sudo -u superpm bash -c 'cd /opt/superpm && node apps/server/dist/backup-cli.js list'
sudo -u superpm bash -c 'cd /opt/superpm && node apps/server/dist/backup-cli.js verify <ID>'
```

恢复到某个备份**必须先停服务**（工具会检测并拒绝运行中的恢复）：

```bash
sudo systemctl stop superpm
sudo -u superpm bash -c 'cd /opt/superpm && node apps/server/dist/backup-cli.js restore <ID>'
sudo systemctl start superpm
```

习惯用 tar 也行（服务运行时 SQLite 有 WAL，建议先停服务）：

```bash
sudo systemctl stop superpm
sudo tar czf /var/backups/superpm-$(date +%F).tar.gz -C /var/lib superpm
sudo systemctl start superpm
```

定时备份用 root 的 crontab：

```cron
0 3 * * * systemctl stop superpm && tar czf /var/backups/superpm-$(date +\%F).tar.gz -C /var/lib superpm && systemctl start superpm
```

### 从已有安装迁移数据

推荐直接搬数据根：停服务 → 把旧机器的 `data/`、`workspace/`、`.env` 拷到 `/var/lib/superpm/`
→ 改属主 → 启动。启动时会按 `schemaVersion` 自动跑迁移。

另一条路是让应用自己迁移：把旧数据根里的 `data/superpm.sqlite` 与 `workspace/` 放到代码目录
`/opt/superpm/` 下，**在首次启动前**完成，应用会把它们搬进 `SUPERPM_HOME` 并在
`logs/migration.log` 里留痕（源文件保留不删）。如果目标数据根已经有数据库，这一步会被跳过，
需要先清空 `/var/lib/superpm/data` 再启动。

## 9. 升级

```bash
sudo bash install-superpm.sh
```

脚本会 `git pull` → `npm ci` → `npm run build` → 重启服务，`/etc/superpm/superpm.env` 原样保留。

**Linux 上不要用界面里的应用内更新**：更新清单只有 `win32-x64` 产物，点「检查更新」会提示平台不匹配，
强行下载也装不上。升级统一走上面的脚本。

## 10. 排错

| 现象                                                           | 排查方向                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `service failed`，日志 `SUPERPM_ADMIN_PASSWORD 至少 6 位字符`  | 首启口令配得太短，改 env 文件后重启                                                           |
| 启动即退出，日志 `EACCES` / `SQLITE_CANTOPEN`                  | 数据根属主不对：`sudo chown -R superpm:superpm /var/lib/superpm`                              |
| 日志 `另一个进程正在执行数据迁移（锁文件：…/.migration.lock）` | 上次启动在迁移中被中断。确认没有实例在跑后删掉该锁文件再启动（锁超过 1 小时会自动失效）       |
| `npm ci` 卡在 `better-sqlite3` 编译                            | 预编译包缺失时回落到源码编译：`sudo apt-get install -y build-essential python3`               |
| 502 Bad Gateway                                                | 反代端口与 `PORT` 不一致；或服务没起来（`systemctl status superpm`）                          |
| 打开页面白屏 / 静态资源 404                                    | 前端未构建：确认 `apps/web/dist/index.html` 存在，重跑 `npm run build`                        |
| 登录一直 401                                                   | 反代没有透传 `Cookie`/`Host`，对照 §4 的配置块                                                |
| 附件上传失败（大文件）                                         | Nginx 的 `client_max_body_size` 还是默认 1 MB                                                 |
| `npm run build` 卡在 `transforming...` 后整机失联 / 连不上     | 内存不足触发 OOM：确认 swap 已挂载且 `vm.swappiness` 不是 `0`（见 §2），再试 `--minify false` |
| 构建后首屏加载慢                                               | Nginx 没开 gzip，2.7 MB 的 JS 在裸传                                                          |

## 11. 与 Windows 安装包的差异

| 能力                                  | Windows 安装包             | Linux 源码部署                                                                                       |
| ------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| 启动/停止                             | `SuperPM.cmd` / `Stop.cmd` | `systemctl start/stop superpm`                                                                       |
| 应用内更新                            | 支持（增量包）             | 不支持，用 §9 的脚本                                                                                 |
| 数据根                                | `%LOCALAPPDATA%\superPM`   | `SUPERPM_HOME`（推荐 `/var/lib/superpm`）                                                            |
| 「在文件夹中显示」/「用本机程序打开」 | 可用                       | 无意义，已在 env 中关闭                                                                              |
| MCP 服务                              | 本机 stdio，随客户端调用   | `node apps/server/dist/mcp/stdio.js`，需要跑在**能用同一份数据**的机器上；远程客户端不能直接连 stdio |

跨平台升级、迁移数据时，只要把整个数据根（`data/`、`workspace/`、`.env`）复制到新位置并指向
`SUPERPM_HOME` 即可；数据库结构版本 `schemaVersion` 会在启动时自动迁移到当前版本。
