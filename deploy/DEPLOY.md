# 对镜 · 部署手册

目标环境：阿里云轻量应用服务器 **2vCPU / 2GB / 40G SSD**，Ubuntu 22.04 LTS。

> **Swap 是必须的。** 2G 内存在 `npm run build` 或 AI 复盘生成峰值时很容易被 OOM Killer 干掉，
> 方案 7.1 已明确要求开 1–2GB Swap。第 1 步不做完，后面出问题不要怀疑代码。

---

## 0. 一键部署（推荐）

`deploy/` 下有三个脚本，把下面 1–8 节的步骤全部自动化了，且**幂等可重跑**。
除非你要手工调整某项，否则不需要照着后面几节敲命令。

| 脚本 | 在哪运行 | 作用 |
|---|---|---|
| `deploy/push.sh` | **开发机** | 本地构建前端 → 上传 dist → 让服务器更新代码并重启 |
| `deploy/server-setup.sh` | **服务器**（root） | Swap、依赖、用户、代码、venv、.env、systemd、Nginx、备份 cron |
| `deploy/enable-https.sh` | **服务器**（root） | 备案通过后签发证书、切 HTTPS、打开 COOKIE_SECURE |

### 首次部署

```bash
# 1) 开发机：把公钥加到服务器的 ~/.ssh/authorized_keys
#    （阿里云控制台也支持「绑定密钥对」，更省事）

# 2) 开发机：一条命令跑完
HOST=你的服务器IP USER_=root bash deploy/push.sh
```

`push.sh` 会在本地构建前端再上传 —— 这样 2G 的服务器**完全不用跑 npm install**，
绕开了最容易 OOM 的那一步。

### 备案通过后加 HTTPS

```bash
# 服务器上
bash /opt/duijing/deploy/enable-https.sh 你的域名
```

它会检查域名解析是否已指向本机（不对就提前报错，不会让你白等 certbot 超时），
然后签发证书、切到完整 Nginx 配置、把 `COOKIE_SECURE` 改成 `true`。

### 日常更新

```bash
# 开发机
HOST=你的服务器IP USER_=root SKIP_BUILD=1 bash deploy/push.sh   # 只更新后端
HOST=你的服务器IP USER_=root bash deploy/push.sh                # 前后端一起更新
```

---

## 1. 系统准备

```bash
apt update && apt upgrade -y

# Swap（1–2GB）。已经有的跳过。
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 降低 swap 倾向，只在内存真不够时才用
sysctl -w vm.swappiness=10
echo 'vm.swappiness=10' >> /etc/sysctl.conf

# 时区（状态栏的「今天」依赖它）
timedatectl set-timezone Asia/Shanghai

# 依赖
apt install -y python3.12 python3.12-venv python3-pip nginx git curl sqlite3
```

## 2. 拉代码

```bash
useradd -r -m -d /opt/duijing -s /bin/bash app

git clone https://gitee.com/heihei-666/qingyu-diary.git /opt/duijing
chown -R app:app /opt/duijing
```

## 3. 后端

```bash
cd /opt/duijing
sudo -u app python3.12 -m venv venv
sudo -u app ./venv/bin/pip install -r requirements.txt
```

## 4. 配置环境变量

```bash
sudo -u app cp .env.example .env
sudo -u app python3 -c "import secrets;print(secrets.token_urlsafe(48))"   # 复制输出
sudo -u app nano .env
```

**必须改的几项：**

| 变量 | 值 | 说明 |
|---|---|---|
| `JWT_SECRET` | 上一步生成的随机串 | 不填会每次重启生成新的，用户全部掉线 |
| `ENV` | `prod` | |
| `COOKIE_SECURE` | `true` | 走 HTTPS，必须开 |
| `CORS_ORIGINS` | `https://your-domain.com` | 不要用 `*` |
| `AI_PROVIDER` | `hybrid` | 辩论房走 DeepSeek，其余走 MiMo |
| `DEEPSEEK_API_KEY` | 你的 Key | |
| `MIMO_API_KEY` | 你的 Key | |

> 没有 Key 就保持 `AI_PROVIDER=mock`，全链路照样能跑，只是 AI 内容是模拟的。

```bash
chmod 600 /opt/duijing/.env
chown app:app /opt/duijing/.env
```

## 5. 前端构建

**在本地或 CI 构建后上传 `dist/`**，不要在小内存服务器上跑 `npm install`
（Vite + React 的依赖树在 2G 机器上极易 OOM）。

```bash
# 本地
cd web
npm ci
npm run build
# 产物在 web/dist，上传到服务器
rsync -avz --delete web/dist/ root@your-server:/var/www/duijing/dist/
```

若坚持在服务器上构建：

```bash
cd /opt/duijing/web
npm ci --no-audit --no-fund
npm run build
mkdir -p /var/www/duijing
cp -r dist /var/www/duijing/
```

## 6. systemd

```bash
cp /opt/duijing/deploy/duijing.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now duijing
systemctl status duijing

# 看日志
journalctl -u duijing -f
```

## 7. Nginx + HTTPS

```bash
cp /opt/duijing/deploy/nginx.conf /etc/nginx/sites-available/duijing
# 把 your-domain.com 全部替换成你的域名
sed -i 's/your-domain.com/你的域名/g' /etc/nginx/sites-available/duijing

ln -s /etc/nginx/sites-available/duijing /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# 证书
apt install -y certbot python3-certbot-nginx
certbot --nginx -d 你的域名
```

## 8. 验证

```bash
# 健康检查
curl -s https://你的域名/api/health | python3 -m json.tool

# 期望看到 ai.mode = hybrid，database = ok，status = ok
```

浏览器打开域名 → 注册第一个账号（**首个用户自动成为管理员，不需要邀请码**）
→ 进「资产 → 设置」拿到自己的邀请码 → 拉人。

**SSE 必须验证**：开一场辩论，发一句话，确认 AI 回复是逐字出现的而不是卡几秒后整段蹦出来。
如果是一次性出现，说明 Nginx 的 `proxy_buffering off` 没生效。

---

## 日常运维

```bash
# 备份（方案 7.8）。SQLite 的 .backup 是在线安全备份，不会锁库。
mkdir -p /var/backups/duijing
sqlite3 /opt/duijing/data/duijing.db ".backup /var/backups/duijing/duijing-$(date +%F).db"
find /var/backups/duijing -name '*.db' -mtime +30 -delete

# 挂 crontab
crontab -e
0 3 * * * sqlite3 /opt/duijing/data/duijing.db ".backup /var/backups/duijing/duijing-$(date +\%F).db" && find /var/backups/duijing -name '*.db' -mtime +30 -delete

# 更新
cd /opt/duijing
git pull
sudo -u app ./venv/bin/pip install -r requirements.txt
systemctl restart duijing
```

## 监控阈值（方案 7.7）

| 指标 | 阈值 | 处理 |
|---|---|---|
| 内存使用率 | 80% | 检查是否有慢查询；确认 `MemoryMax=600M` 生效 |
| CPU 持续 | 70% 超过 5 分钟 | 多半是 AI 任务堆积，看 `journalctl -u duijing` |
| 磁盘使用率 | 80% | 清理 `/var/backups/duijing` 和 `data/*.db-wal` |
| SSE 连接数 | 100 | 单 worker 上限，超了再考虑加 worker |

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 登录后立刻掉线 | `COOKIE_SECURE=true` 但没走 HTTPS | 上证书，或临时改 `false` |
| SSE 一次性返回 | Nginx 缓冲未关闭 | 检查 `location ~ ^/api/debates/\d+/stream$` 段 |
| 定时任务不跑 | `ENABLE_SCHEDULER=false` | 或看日志里 scheduler 启动行 |
| 首次注册要求邀请码 | 库里已有用户 | 正常行为；用管理员账号进设置页拿邀请码 |
| `database is locked` | 写并发过高 | WAL 已开；检查是否有外部进程直连 db 文件 |

---

## 9. 部署排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `git clone` 报 "destination path already exists and is not an empty directory" | 用户家目录被建成了 `/opt/duijing`（`useradd -m -d` 的副作用） | 脚本已用 `useradd -r -M` 规避；若你手工建过用户，`userdel -r app` 后重跑脚本 |
| 首次访问显示 Nginx 默认页 | `sites-enabled/default` 还在 | 脚本会删；手工确认 `rm -f /etc/nginx/sites-enabled/default && systemctl reload nginx` |
| 页面 404、但 `/api/health` 正常 | 前端产物没上传 | 在开发机执行 `deploy/push.sh` |
| 能打开页面但登录后立刻掉线 | `COOKIE_SECURE=true` 却没走 HTTPS | 备案通过前保持 `false`；上 HTTPS 后用 `enable-https.sh` 自动改 |
| SSE 卡几秒后整段蹦出 | Nginx 缓冲未关闭 | 检查 `location ~ ^/api/debates/[0-9]+/stream$` 段里的 `proxy_buffering off` |
| certbot 报 `Timeout during connect` | 域名没解析到本机，或 80 端口未放行 | 确认 DNS 的 A 记录，以及阿里云控制台的**防火墙/安全组**已放行 80、443 |
| 备案未通过时域名打不开 | 大陆地域的服务器对未备案域名的 80/443 会被阻断 | 这是政策限制，不是配置问题。先用 IP 访问，备案通过后再上域名 |
| `database is locked` | 有外部进程直连了 db 文件 | 确认没有别的工具在写 `data/duijing.db`；WAL 已默认开启 |

> **阿里云安全组是最常见的坑**：轻量应用服务器默认只放行了 22 和部分端口，
> 必须去控制台「防火墙」里手动放行 **80** 和 **443**，否则本机 `curl 127.0.0.1` 正常、
> 外网却完全连不上，很容易误判成应用没起来。
