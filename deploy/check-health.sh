#!/usr/bin/env bash
#
# 对镜 · 健康检查与告警（方案 7.7）
#
# 由 cron 每 5 分钟执行。四个指标：
#     内存使用率        80%
#     CPU 持续 5 分钟    70%
#     磁盘使用率        80%
#     SSE 连接数        100
#
# 超阈值时：写日志 + 给管理员发一条 Web Push（复用预约提醒那套通路）。
#
# 为什么用「5 分钟负载」而不是瞬时 CPU：方案要求的就是「持续 70% 超过 5 分钟」，
# 瞬时值抖动太大，盯它只会天天误报。/proc/loadavg 的第二个数正好是 5 分钟均值。
#
# 告警有冷却：同一指标 30 分钟内只报一次，否则一旦超阈值就会每 5 分钟响一次，
# 很快就会被无视——那比不告警更糟。
#
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/duijing}"
PORT="${PORT:-3000}"
LOG="${LOG:-/var/log/duijing-health.log}"
STATE_DIR="${STATE_DIR:-/var/lib/duijing}"
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-1800}"

MEM_THRESHOLD="${MEM_THRESHOLD:-80}"
CPU_THRESHOLD="${CPU_THRESHOLD:-70}"
DISK_THRESHOLD="${DISK_THRESHOLD:-80}"
SSE_THRESHOLD="${SSE_THRESHOLD:-100}"

mkdir -p "$STATE_DIR"
touch "$LOG"

alert() {
  local key="$1" title="$2" body="$3"
  local stamp_file="$STATE_DIR/alert-$key"
  local now last

  now="$(date +%s)"
  if [ -f "$stamp_file" ]; then
    last="$(cat "$stamp_file" 2>/dev/null || echo 0)"
    if [ $((now - last)) -lt "$COOLDOWN_SECONDS" ]; then
      echo "[$(date '+%F %T')] $key 仍在告警区间内，冷却中，跳过" >> "$LOG"
      return
    fi
  fi
  echo "$now" > "$stamp_file"

  echo "[$(date '+%F %T')] 告警 $key: $body" >> "$LOG"
  # 推送失败不影响脚本退出码——被监控的服务才是重点
  #
  # cron 以 root 运行，但降权方式不一定有 sudo（精简容器里常常没有）。
  # 依次尝试 sudo → runuser → 直接执行，取第一个可用的。
  local runner=""
  if command -v sudo >/dev/null 2>&1; then
    runner="sudo -u app"
  elif command -v runuser >/dev/null 2>&1; then
    runner="runuser -u app --"
  fi
  # PYTHONPATH 显式指定：`python -m` 靠 CWD 找包，一旦有人从别处调用
  # （或将来改成绝对路径执行）就会报 No module named 'app'。
  # 实测踩过这个坑，加上它就不再依赖调用时的当前目录。
  (cd "$APP_DIR" && PYTHONPATH="$APP_DIR" $runner "$APP_DIR/venv/bin/python" \
    -m app.scripts.notify_admin "$title" "$body") \
    >> "$LOG" 2>&1 || echo "  （推送发送失败，仅记录日志）" >> "$LOG"
}

# ── 1. 内存 ──
MEM_PCT="$(free | awk '/^Mem:/{printf "%d", ($3/$2)*100}')"
if [ "${MEM_PCT:-0}" -ge "$MEM_THRESHOLD" ]; then
  alert mem "对镜 · 内存告警" "内存已用 ${MEM_PCT}%（阈值 ${MEM_THRESHOLD}%），检查是否有连接泄漏"
fi

# ── 2. CPU：5 分钟负载 / 核数 ──
CORES="$(nproc 2>/dev/null || echo 0)"
LOAD5="$(awk '{print $2}' /proc/loadavg 2>/dev/null || echo '')"
if [ -n "$LOAD5" ] && [ "${CORES:-0}" -gt 0 ]; then
  CPU_PCT="$(awk -v l="$LOAD5" -v c="$CORES" 'BEGIN{printf "%d", (l/c)*100}')"
  if [ "${CPU_PCT:-0}" -ge "$CPU_THRESHOLD" ]; then
    alert cpu "对镜 · CPU 告警" "5 分钟负载 ${LOAD5}（${CORES} 核，约 ${CPU_PCT}%），持续偏高"
  fi
else
  # /proc/loadavg 读不到（容器里常见）或核数拿不到时跳过，
  # 而不是用空值参与运算算出一个假的高负载
  echo "[$(date '+%F %T')] 跳过 CPU 检查（读不到 loadavg 或核数）" >> "$LOG"
fi

# ── 3. 磁盘 ──
DISK_PCT="$(df / | awk 'NR==2{gsub("%","",$5); print $5}')"
if [ "${DISK_PCT:-0}" -ge "$DISK_THRESHOLD" ]; then
  alert disk "对镜 · 磁盘告警" "根分区已用 ${DISK_PCT}%（阈值 ${DISK_THRESHOLD}%），清理备份或日志"
fi

# ── 4. SSE 连接数（从应用读，只有它知道）──
HEALTH="$(curl -s --max-time 8 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo '')"
if [ -n "$HEALTH" ]; then
  SSE_ACTIVE="$(printf '%s' "$HEALTH" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('metrics', {}).get('sse_active', 0))
except Exception:
    print(0)
" 2>/dev/null || echo 0)"
  if [ "${SSE_ACTIVE:-0}" -ge "$SSE_THRESHOLD" ]; then
    alert sse "对镜 · SSE 连接告警" "当前 ${SSE_ACTIVE} 个长连接（阈值 ${SSE_THRESHOLD}），检查前端是否泄漏"
  fi

  # 服务本身不健康时也告警——这是最该知道的事
  STATUS="$(printf '%s' "$HEALTH" | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('status','unknown'))
except Exception: print('unparseable')
" 2>/dev/null || echo unparseable)"
  [ "$STATUS" != "ok" ] && alert health "对镜 · 服务异常" "健康检查返回 $STATUS"
else
  alert down "对镜 · 服务不可达" "本机 $PORT 端口无响应，服务可能已停止"
fi

exit 0
