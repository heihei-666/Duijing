#!/usr/bin/env bash
#
# 对镜 · 启用 HTTPS（在服务器上以 root 运行，备案通过后执行）
#
#   bash /opt/duijing/deploy/enable-https.sh example.com
#
# 做四件事：
#   1. 用 certbot 签发 Let's Encrypt 证书（自动续期）
#   2. 切换到完整版 Nginx 配置（80 跳 443 + HSTS + 安全响应头）
#   3. 把 .env 里的 COOKIE_SECURE 改成 true —— 走 HTTPS 后必须开，
#      否则 Cookie 可以被明文嗅探
#   4. 把 CORS_ORIGINS 改成正式域名
#
set -euo pipefail

DOMAIN="${1:-${DOMAIN:-}}"
APP_DIR="${APP_DIR:-/opt/duijing}"
WEB_ROOT="${WEB_ROOT:-/var/www/duijing/dist}"
PORT="${PORT:-3000}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[✗]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行"
[ -n "$DOMAIN" ] || die "用法：bash $0 你的域名"

# ─────────────────────────────────────────────────────────────
# 0. 前置检查 —— 这两条不满足，certbot 必然失败，提前说清楚
# ─────────────────────────────────────────────────────────────
log "检查域名解析"
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
WWW_RESOLVED="$(getent hosts "www.$DOMAIN" | awk '{print $1}' | head -1 || true)"
PUBLIC_IP="$(curl -s --max-time 8 https://api.ipify.org || true)"
if [ -z "$RESOLVED" ]; then
  die "$DOMAIN 解析不到任何 IP。请先在 DNS 添加 A 记录指向 $PUBLIC_IP"
fi
if [ "$RESOLVED" != "$PUBLIC_IP" ]; then
  die "$DOMAIN 解析到 $RESOLVED，但本机公网 IP 是 $PUBLIC_IP。解析尚未生效或指错了机器"
fi
log "解析正确：$DOMAIN → $RESOLVED"
if [ -z "$WWW_RESOLVED" ]; then
  die "www.$DOMAIN 解析不到 IP。请补一条 A 记录指向 $PUBLIC_IP，或去掉本脚本里的 -d www.$DOMAIN"
fi
log "解析正确：www.$DOMAIN → $WWW_RESOLVED"

if ! curl -sf -o /dev/null --max-time 8 "http://$DOMAIN/.well-known/acme-challenge/" 2>/dev/null; then
  log "提示：80 端口暂时无法从公网访问（备案未通过时是正常的）。certbot 会尝试校验，失败请等备案完成后再跑。"
fi

# ─────────────────────────────────────────────────────────────
# 1. 签发证书
# ─────────────────────────────────────────────────────────────
log "安装 certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq certbot python3-certbot-nginx >/dev/null

log "申请证书（Let's Encrypt）"
# 裸域与 www 一起签，否则访问 www.duijing.xyz 会报证书域名不匹配
CERTBOT_ARGS=(--nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --redirect --keep-until-expiring)
if [ -n "$CERTBOT_EMAIL" ]; then
  CERTBOT_ARGS+=(-m "$CERTBOT_EMAIL")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi
certbot "${CERTBOT_ARGS[@]}"

[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] || die "证书未生成，certbot 输出见上"

# ─────────────────────────────────────────────────────────────
# 2. 切换到完整版 Nginx 配置
# ─────────────────────────────────────────────────────────────
log "切换到 HTTPS 配置"
mkdir -p /var/www/certbot
sed "s/your-domain\.com/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/duijing
ln -sf /etc/nginx/sites-available/duijing /etc/nginx/sites-enabled/duijing
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ─────────────────────────────────────────────────────────────
# 3. .env 切到安全配置
# ─────────────────────────────────────────────────────────────
log "更新 .env"
ENV_FILE="$APP_DIR/.env"
cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%F-%H%M%S)"

sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=true|" "$ENV_FILE"
sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=https://$DOMAIN|" "$ENV_FILE"

# JWT_SECRET 若还是空的，补一个（空值会让每次重启都让所有人掉线）
if grep -q '^JWT_SECRET=$' "$ENV_FILE"; then
  SECRET="$(sudo -u app "$APP_DIR/venv/bin/python" -c 'import secrets;print(secrets.token_urlsafe(48))')"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$SECRET|" "$ENV_FILE"
  log "已补齐 JWT_SECRET"
fi

chown app:app "$ENV_FILE"
chmod 600 "$ENV_FILE"

systemctl restart duijing
sleep 2
systemctl is-active --quiet duijing || { journalctl -u duijing -n 30 --no-pager; die "服务重启失败"; }

# ─────────────────────────────────────────────────────────────
# 4. 验证
# ─────────────────────────────────────────────────────────────
log "验证 HTTPS"
sleep 1
CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/health" || echo 000)"
[ "$CODE" = "200" ] || die "https://$DOMAIN/api/health 返回 $CODE"

WWW_CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://www.$DOMAIN/api/health" || echo 000)"
[ "$WWW_CODE" = "200" ] || die "https://www.$DOMAIN/api/health 返回 $WWW_CODE（证书或 server_name 没覆盖 www）"

echo
printf '\033[1;32m═══ HTTPS 已启用 ═══\033[0m\n'
curl -s "https://$DOMAIN/api/health" | python3 -m json.tool
echo
echo "  站点：https://$DOMAIN"
echo "  证书续期：certbot 已自动配置 systemd timer，可执行 systemctl list-timers | grep certbot 查看"
echo
echo "  提醒：现在 PWA 可以正常安装（Service Worker 需要安全上下文）。"
echo "        手机上打开站点 → 浏览器菜单 → 添加到主屏幕。"
