#!/usr/bin/env bash
#
# 对镜 · 发布脚本（在开发机上执行）
#
# 做三件事：
#   1. 本地构建前端（2G 的服务器上跑 npm install 很容易被 OOM 干掉，所以在这里构建）
#   2. 把 dist 传到服务器
#   3. 让服务器更新代码并重启
#
# 用法：
#   HOST=1.2.3.4 USER=root bash deploy/push.sh
#   DOMAIN=example.com HOST=1.2.3.4 USER=root bash deploy/push.sh   # 首次部署
#
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-${USER_:-root}}"
SSH_PORT="${SSH_PORT:-22}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/duijing_deploy}"
DOMAIN="${DOMAIN:-}"
APP_DIR="${APP_DIR:-/opt/duijing}"
WEB_ROOT="${WEB_ROOT:-/var/www/duijing/dist}"
SKIP_BUILD="${SKIP_BUILD:-0}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[✗]\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$HOST" ] || die "缺少 HOST。用法：HOST=1.2.3.4 USER_=root bash deploy/push.sh"
[ -f "$SSH_KEY" ] || die "找不到私钥 $SSH_KEY"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-i "$SSH_KEY" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
REMOTE="$SSH_USER@$HOST"

log "测试 SSH 连接 $REMOTE:$SSH_PORT"
ssh "${SSH_OPTS[@]}" "$REMOTE" 'echo "  已连接：$(hostname) / $(id -un)"' \
  || die "SSH 连接失败。确认公钥已加到服务器的 ~/.ssh/authorized_keys"

# ─────────────────────────────────────────────────────────────
# 1. 构建前端
# ─────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" != "1" ]; then
  log "构建前端"
  BUILD_DIR="${BUILD_DIR:-/tmp/duijing-build}"
  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR"
  # 从 git archive 导出，确保产物对应的是已提交的代码，而不是工作区的临时改动
  git -C "$REPO_ROOT" archive --format=tar HEAD web | tar -x -C "$BUILD_DIR"

  if [ ! -d "$BUILD_DIR/web/node_modules" ]; then
    # 复用已有依赖树，避免重复下载几百 MB
    CACHE="${NODE_MODULES_CACHE:-/root/build/dj-web-b/node_modules}"
    if [ -d "$CACHE" ]; then
      log "复用依赖缓存 $CACHE"
      cp -r "$CACHE" "$BUILD_DIR/web/node_modules"
    else
      log "安装前端依赖（较慢）"
      (cd "$BUILD_DIR/web" && npm install --no-audit --no-fund)
    fi
  fi

  (cd "$BUILD_DIR/web" && npx tsc --noEmit && npm run build)
  DIST="$BUILD_DIR/web/dist"
  [ -f "$DIST/index.html" ] || die "构建产物异常：找不到 $DIST/index.html"
  log "构建完成：$(du -sh "$DIST" | cut -f1)"
else
  DIST="$REPO_ROOT/web/dist"
  [ -d "$DIST" ] || die "SKIP_BUILD=1 但 $DIST 不存在"
fi

# ─────────────────────────────────────────────────────────────
# 2. 上传前端产物
# ─────────────────────────────────────────────────────────────
log "上传前端产物到 $WEB_ROOT"
ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$WEB_ROOT'"
rsync -az --delete -e "ssh -i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=accept-new" \
  "$DIST/" "$REMOTE:$WEB_ROOT/"
ssh "${SSH_OPTS[@]}" "$REMOTE" "chown -R www-data:www-data /var/www/duijing 2>/dev/null || true"
log "上传完成"

# ─────────────────────────────────────────────────────────────
# 3. 服务器侧更新代码并重启
# ─────────────────────────────────────────────────────────────
log "更新服务器代码"
ssh "${SSH_OPTS[@]}" "$REMOTE" "DOMAIN='$DOMAIN' APP_DIR='$APP_DIR' WEB_ROOT='$WEB_ROOT' bash $APP_DIR/deploy/server-setup.sh"

echo
printf '\033[1;32m═══ 发布完成 ═══\033[0m\n'
if [ -n "$DOMAIN" ]; then
  echo "  https://$DOMAIN"
else
  echo "  http://$HOST"
fi
