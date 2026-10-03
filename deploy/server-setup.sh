#!/usr/bin/env bash
#
# 对镜 · 服务器初始化脚本（在服务器上以 root 运行）
#
# 幂等：可以反复执行，已完成的步骤会跳过。
# 用法：
#   DOMAIN=example.com bash server-setup.sh
#
# 不带 DOMAIN 时，Nginx 会以 IP 方式提供 HTTP 服务（用于备案审核期间的验证）。
# 备案通过后再执行 deploy/enable-https.sh 即可加上证书。
#
set -euo pipefail

# 取本机公网 IP。
#
# 注意：**不要用 api.ipify.org** —— 实测在国内服务器上完全不可达，
# 会让整个流程静默停在「取不到 IP」。这里按可达性排序，逐个回退。
get_public_ip() {
  local url candidate
  for url in "https://ip.3322.net" "https://ifconfig.me/ip" "https://ipinfo.io/ip" "https://api.ipify.org"; do
    candidate="$(curl -s --max-time 8 "$url" 2>/dev/null \
      | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1)"
    if [ -n "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

DOMAIN="${DOMAIN:-}"
APP_DIR="${APP_DIR:-/opt/duijing}"
APP_USER="${APP_USER:-app}"
WEB_ROOT="${WEB_ROOT:-/var/www/duijing/dist}"
PORT="${PORT:-3000}"
# 注意：对镜的仓库是 dui-jing，**不是** qingyu-diary。
# 2026-10 两个项目曾共用一条 git 历史，后来拆成两个独立仓库；
# 这个默认值当时没跟着改，照着文档部署会拉到青屿日记的代码。
REPO_URL="${REPO_URL:-https://gitee.com/heihei-666/dui-jing.git}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[✗]\033[0m %s\n' "$*" >&2; exit 1; }

# 需要 root 权限。若当前是具备 sudo 的普通用户（如阿里云的 admin/ubuntu），
# 用 `sudo bash $0` 执行即可——本脚本内部大量使用 sudo -u，不要求直接以 root 登录。
[ "$(id -u)" -eq 0 ] || die "需要 root 权限，请用：sudo bash $0"

# ─────────────────────────────────────────────────────────────
# 1. Swap —— 2G 内存的机器必须开，否则 AI 峰值和任何构建都可能被 OOM 干掉
# ─────────────────────────────────────────────────────────────
log "检查 Swap"
if swapon --show | grep -q .; then
  warn "已有 Swap，跳过：$(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
else
  log "创建 ${SWAP_SIZE} Swap"
  fallocate -l "$SWAP_SIZE" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
  log "Swap 已启用"
fi

# ─────────────────────────────────────────────────────────────
# 2. 时区 —— 状态栏的「今天」「连续天数」全部依赖它
# ─────────────────────────────────────────────────────────────
log "设置时区为 Asia/Shanghai"
timedatectl set-timezone Asia/Shanghai 2>/dev/null || ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

# ─────────────────────────────────────────────────────────────
# 3. 依赖
# ─────────────────────────────────────────────────────────────
# ── pip 镜像 ──
#
# 大陆服务器访问 pypi.org 实测要 12 秒（有时直接超时），
# 表现为 `pip install` 报 "Could not find a version that satisfies ...
# (from versions: none)" —— 看起来像包不存在，实际是源太慢。
# 阿里云镜像约 1.6 秒，快 7 倍。
#
# 用 PIP_INDEX_URL 环境变量可以覆盖；设为 "default" 表示不改动。
if [ "${PIP_INDEX_URL:-}" != "default" ]; then
  PIP_INDEX="${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}"
  if [ ! -f /etc/pip.conf ]; then
    log "配置 pip 镜像：$PIP_INDEX"
    cat > /etc/pip.conf <<PIPCONF
[global]
index-url = $PIP_INDEX
trusted-host = $(echo "$PIP_INDEX" | awk -F/ '{print $3}')
timeout = 60
PIPCONF
  fi
fi

log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  python3 python3-venv python3-pip \
  nginx git curl sqlite3 ca-certificates tzdata >/dev/null

PY_BIN="$(command -v python3)"
PY_VER="$($PY_BIN -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
log "Python 版本：$PY_VER ($PY_BIN)"
$PY_BIN -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' \
  || die "需要 Python 3.10 及以上（当前 $PY_VER）。Ubuntu 22.04/24.04 自带版本都满足。"

# ─────────────────────────────────────────────────────────────
# 4. 应用用户与目录
# ─────────────────────────────────────────────────────────────
log "准备应用用户与目录"
# 注意 -M：不要创建家目录。
# 若写成 `useradd -m -d "$APP_DIR"`，家目录会被建成 $APP_DIR（含 .bashrc 等），
# 后面 git clone 就会因为「目标目录非空」直接失败——这是首次部署最容易踩的坑。
# -U 保证创建同名组：systemd 单元里写了 Group=app，没有这个组会启动失败。
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -U -M -s /bin/bash "$APP_USER"

mkdir -p "$WEB_ROOT" /var/backups/duijing
# $APP_DIR 不在这里创建：git clone 要求目标为空目录，
# 它的创建与属主设置放到克隆成功之后。

# ─────────────────────────────────────────────────────────────
# 5. 代码
# ─────────────────────────────────────────────────────────────
STASHED_ENV=""
if [ -d "$APP_DIR/.git" ]; then
  log "更新已有代码"
  # 仓库若由别的用户克隆（比如运维手工预置），git 会以
  # "detected dubious ownership" 拒绝操作。先给应用用户放行该目录。
  sudo -u "$APP_USER" git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  # 用 reset --hard 而不是 pull：服务器上不该有本地改动，
  # 一旦有人手工改过代码，pull 会冲突并把后续更新全部卡死。
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard --quiet origin/main
else
  if [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null || true)" ]; then
    STASH="$APP_DIR.old.$(date +%Y%m%d%H%M%S)"
    warn "$APP_DIR 已存在且非空、又不是 git 仓库，先移到 $STASH"
    # 保住 .env：里面是 JWT_SECRET，丢了会让所有已登录用户掉线
    if [ -f "$APP_DIR/.env" ]; then
      STASHED_ENV="$(mktemp)"
      cp "$APP_DIR/.env" "$STASHED_ENV"
      warn "已暂存原 .env"
    fi
    mv "$APP_DIR" "$STASH"
  fi
  # 目录可能已经存在（比如运维提前建好、属主是登录用户）。
  # git clone 允许克隆进「已存在的空目录」，但要求对它有写权限——
  # 属主不是 app 就会报 Permission denied。
  if [ -d "$APP_DIR" ]; then
    chown "$APP_USER:$APP_USER" "$APP_DIR"
  fi

  log "克隆仓库"
  sudo -u "$APP_USER" git clone --quiet "$REPO_URL" "$APP_DIR"
fi

# 数据目录与属主：放在克隆成功之后，避免污染 clone 目标
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chown -R www-data:www-data /var/www/duijing

if [ -n "$STASHED_ENV" ]; then
  cp "$STASHED_ENV" "$APP_DIR/.env"
  rm -f "$STASHED_ENV"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  log "已恢复原 .env"
fi
log "当前版本：$(sudo -u "$APP_USER" git -C "$APP_DIR" log --oneline -1)"

# ─────────────────────────────────────────────────────────────
# 6. Python 虚拟环境
# ─────────────────────────────────────────────────────────────
log "安装 Python 依赖"
if [ ! -x "$APP_DIR/venv/bin/pip" ]; then
  sudo -u "$APP_USER" "$PY_BIN" -m venv "$APP_DIR/venv"
fi
sudo -u "$APP_USER" "$APP_DIR/venv/bin/pip" install -q --upgrade pip
sudo -u "$APP_USER" "$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
log "依赖安装完成"

# ─────────────────────────────────────────────────────────────
# 7. 环境变量
# ─────────────────────────────────────────────────────────────
if [ -f "$APP_DIR/.env" ]; then
  log ".env 已存在，保留不动（如需修改请手工编辑）"
else
  log "生成 .env"
  JWT_SECRET="$(sudo -u "$APP_USER" "$APP_DIR/venv/bin/python" -c 'import secrets;print(secrets.token_urlsafe(48))')"

  if [ -n "$DOMAIN" ]; then
    CORS="https://$DOMAIN"
  else
    # 备案期间先用 IP 验证；HTTP 下 Cookie 不能带 Secure，否则浏览器不回传
    IP="$(get_public_ip || hostname -I | awk '{print $1}')"
    CORS="http://$IP"
  fi

  cat > "$APP_DIR/.env" <<EOF
APP_NAME=对镜
ENV=prod
DEBUG=false
TZ=Asia/Shanghai

JWT_SECRET=$JWT_SECRET
JWT_EXPIRE_DAYS=7
# 备案通过、上 HTTPS 之后改为 true（enable-https.sh 会自动改）
COOKIE_SECURE=false
COOKIE_DOMAIN=

BOOTSTRAP_INVITE_CODE=
ALLOW_OPEN_REGISTER=false

CORS_ORIGINS=$CORS

# mock = 不联网，全链路可跑（当前）
# hybrid = 辩论房走 DeepSeek，其余走 MiMo（填好 Key 后改成这个）
AI_PROVIDER=mock
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
MIMO_API_KEY=
MIMO_BASE_URL=https://api.xiaomimimo.com/v1
MIMO_MODEL=mimo-v2.6-flash
AI_TIMEOUT_SECONDS=120

DEBATE_RATE_PER_MIN=10
AI_RATE_PER_MIN=6
LOGIN_RATE_PER_MIN=10

WEAKNESS_DELETE_DAYS=60
ADVANTAGE_ARCHIVE_DAYS=30
OBSERVATION_TTL_HOURS=24

DEBATE_MIN_ROUNDS=4
DEBATE_MAX_ROUNDS=8
DEBATE_MESSAGE_MAX_CHARS=300
DEBATE_MAX_PARTICIPANTS=4

ENABLE_SCHEDULER=true
SCAN_CRON_DAY=sun
SCAN_CRON_HOUR=2
EOF

  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  log ".env 已生成（CORS_ORIGINS=$CORS）"
fi

# ─────────────────────────────────────────────────────────────
# 8. systemd
# ─────────────────────────────────────────────────────────────
log "安装 systemd 服务"
install -m 644 "$APP_DIR/deploy/duijing.service" /etc/systemd/system/duijing.service
systemctl daemon-reload
systemctl enable duijing >/dev/null 2>&1 || true
systemctl restart duijing
sleep 2
systemctl is-active --quiet duijing \
  && log "服务已启动" \
  || { warn "服务启动失败，最近日志："; journalctl -u duijing -n 30 --no-pager; die "请检查上面的日志"; }

# ─────────────────────────────────────────────────────────────
# 9. Nginx
# ─────────────────────────────────────────────────────────────
log "配置 Nginx"
if [ -n "$DOMAIN" ]; then
  # 裸域与 www 都要匹配，否则用户输 www.duijing.xyz 会落到默认站点
  SERVER_NAME="$DOMAIN www.$DOMAIN"
else
  SERVER_NAME="_"   # 无域名：接受任意 Host，便于用 IP 访问
fi

# 从仓库里的模板生成，替换占位域名
sed "s/your-domain\.com/$SERVER_NAME/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/duijing

# 未上 HTTPS 时，模板里的 443 server 块会因为证书不存在而让 nginx -t 失败，
# 所以备案期间先用一份只有 80 端口的精简配置。
if [ -z "$DOMAIN" ] || [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  warn "尚未签发证书，使用 HTTP-only 配置（备案通过后运行 enable-https.sh 切换）"
  cat > /etc/nginx/sites-available/duijing <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $SERVER_NAME;

    root $WEB_ROOT;
    index index.html;
    client_max_body_size 20m;

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    location = /sw.js {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files \$uri =404;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # SSE 必须关缓冲，否则辩论房会变成「卡几秒然后整段蹦出」
    location ~ ^/api/debates/[0-9]+/stream\$ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection '';
        proxy_read_timeout 300s;
        proxy_buffering off;
    }

    location ~ /\.(?!well-known) { deny all; }
}
EOF
fi

ln -sf /etc/nginx/sites-available/duijing /etc/nginx/sites-enabled/duijing
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
systemctl enable nginx >/dev/null 2>&1 || true

# ─────────────────────────────────────────────────────────────
# 10. 备份 cron
# ─────────────────────────────────────────────────────────────
log "配置每日数据库备份"
cat > /etc/cron.daily/duijing-backup <<EOF
#!/bin/sh
sqlite3 $APP_DIR/data/duijing.db ".backup /var/backups/duijing/duijing-\$(date +%F).db"
find /var/backups/duijing -name '*.db' -mtime +30 -delete
EOF
chmod +x /etc/cron.daily/duijing-backup

# ─────────────────────────────────────────────────────────────
# 11. 自检
# ─────────────────────────────────────────────────────────────
log "健康检查"
sleep 1
if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  log "后端 API 正常"
  curl -s "http://127.0.0.1:$PORT/api/health" | (command -v python3 >/dev/null && python3 -m json.tool || cat)
else
  die "后端健康检查失败，看 journalctl -u duijing -n 50"
fi

IP="$(get_public_ip || hostname -I | awk '{print $1}')"
echo
printf '\033[1;32m═══ 服务器初始化完成 ═══\033[0m\n'
echo "  访问地址（HTTP）：http://$IP"
if [ -n "$DOMAIN" ]; then
  echo "  域名：$DOMAIN（证书签发后自动启用 HTTPS）"
else
  echo "  域名：未配置 —— 备案通过后运行 bash $APP_DIR/deploy/enable-https.sh $DOMAIN"
fi
echo
echo "  后续常用命令："
echo "    查看日志    journalctl -u duijing -f"
echo "    重启服务    systemctl restart duijing"
echo "    更新版本    bash $APP_DIR/deploy/server-setup.sh"
echo
warn "前端产物尚未上传。若页面 404，请从开发机执行 deploy/push.sh"
