#!/usr/bin/env bash
# superPM 在 Ubuntu / Debian 上的安装与升级脚本（幂等：重复执行即升级）
#
# 用法：
#   sudo bash install-superpm.sh            # 安装或升级
#   sudo PORT=8080 bash install-superpm.sh  # 换端口
#
# 可用环境变量：APP_DIR DATA_DIR SVC_USER REPO BRANCH ENV_FILE PORT
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/superpm}
DATA_DIR=${DATA_DIR:-/var/lib/superpm}
SVC_USER=${SVC_USER:-superpm}
REPO=${REPO:-https://github.com/WangPeng3215/superpm-workbench.git}
BRANCH=${BRANCH:-main}
ENV_FILE=${ENV_FILE:-/etc/superpm/superpm.env}
PORT=${PORT:-3001}
SERVICE=superpm

log() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行（sudo bash $0）"

log "检查 Node.js 版本（项目要求 >=22.12 且 <25）"
NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || die "未安装 Node.js。先执行：
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs"
NODE_BIN=$(readlink -f "$NODE_BIN")
node -e 'const [a,b]=process.versions.node.split(".").map(Number);
process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || die "当前 Node $(node -v) 过低，需要 >=22.12。升级：https://deb.nodesource.com/setup_22.x"
node -e 'process.exit(Number(process.versions.node.split(".")[0])<25?0:1)' \
  || die "当前 Node $(node -v) 过高，项目要求 <25，请安装 Node 22 LTS。"
echo "Node $(node -v)  OK"

log "准备服务账号与目录"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
  echo "已创建系统账号 $SVC_USER（无登录 shell）"
fi
mkdir -p "$APP_DIR" "$DATA_DIR"
# 先归位属主：后续 git / npm 都以服务账号执行，root 拥有的目录会写不进去
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR" "$DATA_DIR"

log "获取源码"
if [ -d "$APP_DIR/.git" ]; then
  runuser -u "$SVC_USER" -- env HOME="$DATA_DIR" \
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
elif [ -z "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
  runuser -u "$SVC_USER" -- env HOME="$DATA_DIR" \
    git clone --branch "$BRANCH" --depth 1 "$REPO" "$APP_DIR"
else
  die "$APP_DIR 非空且不是 git 仓库，请先清空或改用 APP_DIR=... 指定其它目录"
fi

log "安装依赖并构建（首次约 2-5 分钟）"
runuser -u "$SVC_USER" -- env HOME="$DATA_DIR" \
  bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund && npm run build"

log "写入环境配置 $ENV_FILE"
SEED_PASSWORD=""
mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  SEED_PASSWORD=$(openssl rand -hex 9)
  cat >"$ENV_FILE" <<EOF
# superPM 运行时配置（改动后 systemctl restart $SERVICE 生效）
PORT=$PORT
# 只监听回环，由 Nginx / Caddy 反向代理对外；需要直接对外访问时改成 0.0.0.0
SUPERPM_HOST=127.0.0.1
# 数据根：数据库、工作区文件、备份都在这里
SUPERPM_HOME=$DATA_DIR
# 服务器上没有本机程序可打开，关闭「在文件夹中显示」等能力
SUPERPM_ALLOW_SYSTEM_OPEN=0
# 首次启动创建的 admin 口令（只在数据库里还没有 admin 时生效）
SUPERPM_ADMIN_PASSWORD=$SEED_PASSWORD
EOF
  chown "root:$SVC_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "已生成初始口令（仅本次显示，请立即保存）"
else
  echo "配置已存在，保留原值未覆盖"
fi

log "读取实际监听端口"
# 配置已存在时以文件里的 PORT 为准（重跑时环境变量不会覆盖既有配置）
EFFECTIVE_PORT=$(sed -n 's/^PORT=\([0-9]*\).*/\1/p' "$ENV_FILE" | tail -1)
EFFECTIVE_PORT=${EFFECTIVE_PORT:-$PORT}

log "注册 systemd 服务"
[ -f "$APP_DIR/deploy/superpm.service" ] \
  || die "缺少 $APP_DIR/deploy/superpm.service，代码可能不是最新，请先 git pull 或更新到含该模板的版本"
sed -e "s|__SVC_USER__|$SVC_USER|g" \
    -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$APP_DIR/deploy/superpm.service" >"/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

log "等待服务就绪"
HEALTH=""
for _ in $(seq 1 30); do
  if HEALTH=$(curl -fsS "http://127.0.0.1:$EFFECTIVE_PORT/api/health" 2>/dev/null); then
    echo "健康检查通过：$HEALTH"
    break
  fi
  sleep 1
done
systemctl is-active --quiet "$SERVICE" \
  || die "服务未启动，查看日志：journalctl -u $SERVICE -n 100 --no-pager"
[ -n "$HEALTH" ] \
  || die "服务在运行但 30 秒内健康检查未通过（127.0.0.1:$EFFECTIVE_PORT/api/health），查看日志：journalctl -u $SERVICE -n 100 --no-pager"

if [ -n "$SEED_PASSWORD" ]; then
  ACCOUNT_LINE="初始账号  admin / $SEED_PASSWORD"
else
  ACCOUNT_LINE="账号沿用数据库中已有口令"
fi

cat <<EOF

安装完成
  代码      $APP_DIR
  数据      $DATA_DIR
  配置      $ENV_FILE
  监听      127.0.0.1:$EFFECTIVE_PORT（反向代理指向这里）
  $ACCOUNT_LINE

  下一步    配置 Nginx 或 Caddy 反向代理 + HTTPS，见 docs/deploy-linux.md
  升级      重新执行本脚本即可（git pull + 构建 + 重启）
EOF
