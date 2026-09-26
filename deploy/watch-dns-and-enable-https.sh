#!/usr/bin/env bash
#
# 对镜 · DNS 守望 → 自动启用 HTTPS
#
#   bash watch-dns-and-enable-https.sh
#
# 为什么需要它：新注册的域名，注册局把 NS 委派发布到顶级域 zone 可能需要
# 几小时到 48 小时。在它生效之前，Let's Encrypt 的校验必然失败
# （ACME 服务器也要靠公共 DNS 找到你的机器）。
#
# 与其让人隔一会儿手动试一次，不如挂个定时任务自动等：
# 每 5 分钟检查一次，两个域名都通过**公共解析器**指向本机后，
# 自动执行 enable-https.sh，成功就把自己从 cron 里摘掉。
#
# 日志：/var/log/duijing-https.log
#
set -uo pipefail

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

DOMAIN="${DOMAIN:-duijing.xyz}"
APP_DIR="${APP_DIR:-/opt/duijing}"
FLAG="$APP_DIR/data/.https-enabled"
LOG="/var/log/duijing-https.log"
CRON_FILE="/etc/cron.d/duijing-https-watch"
DNS_CHECK_SERVER="${DNS_CHECK_SERVER:-223.5.5.5}"

mkdir -p "$(dirname "$FLAG")"
touch "$LOG"

{
  echo "──────────────────────────────────────────────"
  echo "[$(date '+%F %T')] 检查 $DOMAIN 的 DNS 生效情况"

  if [ -f "$FLAG" ]; then
    echo "  已启用过 HTTPS（$FLAG 存在），移除自身定时任务"
    rm -f "$CRON_FILE"
    exit 0
  fi

  PUBLIC_IP="$(get_public_ip || echo '')"
  if [ -z "$PUBLIC_IP" ]; then
    echo "  所有 IP 回显服务都不可达，稍后重试"
    exit 0
  fi

  # 两个域名都必须通过公共解析器指向本机，缺一不可：
  # certbot 会同时为裸域和 www 申请证书，任一解析不对都会整体失败。
  for host in "$DOMAIN" "www.$DOMAIN"; do
    # 优先用 dig 指定公共 DNS，避免服务器本地解析器缓存误导判断
    if command -v dig >/dev/null 2>&1; then
      RESOLVED="$(dig +short A "$host" "@$DNS_CHECK_SERVER" 2>/dev/null | head -1)"
    else
      RESOLVED="$(getent hosts "$host" | awk '{print $1}' | head -1)"
    fi

    if [ "$RESOLVED" != "$PUBLIC_IP" ]; then
      echo "  $host 尚未生效（当前解析：${RESOLVED:-无}，期望：$PUBLIC_IP），等待下次检查"
      exit 0
    fi
    echo "  $host → $RESOLVED ✅"
  done

  echo "  两个域名均已生效，开始签发证书"
  if bash "$APP_DIR/deploy/enable-https.sh" "$DOMAIN"; then
    touch "$FLAG"
    rm -f "$CRON_FILE"
    echo "  ✅ HTTPS 已启用，定时任务已自动移除"
  else
    echo "  ❌ 签发失败，保留定时任务，5 分钟后重试"
    echo "     （certbot 有频率限制：同一域名每周最多 5 次失败，不要改成更短的间隔）"
  fi
} >> "$LOG" 2>&1
