# Cloudflare Tunnel 部署手册

> 目的：**让没有梯子的大陆用户能打开 `www.duijing.xyz`**。
>
> 背景是 `duijing.xyz` 未完成 ICP 备案，而大陆服务器提供商（阿里云）会**在
> TLS 的 SNI 阶段重置**未备案域名的入站连接。实测证据：

```text
DNS 正常          www.duijing.xyz → 47.117.189.125（阿里 DNS 也一致）
HTTP  :80                                   ❌ ECONNRESET
HTTPS :443 + SNI=www.duijing.xyz            ❌ ECONNRESET
HTTPS :443 + SNI=duijing.xyz                ❌ ECONNRESET
HTTPS :443 不带 SNI（直接连 IP）              ✅ 握手成功，证书 CN=duijing.xyz
```

**带 SNI 就断、不带就通** —— 这是基于 SNI 的定向阻断，不是服务器故障。

---

## 为什么隧道能解决

| | 方向 | 阿里云看到什么 |
|---|---|---|
| 代理 A 记录（❌ 无效） | Cloudflare **入站**连源站 443 | 带域名 SNI 的入站连接 → **拦** |
| **Tunnel**（✅ 有效） | 源站**出站**连 Cloudflare | 一条出境长连接，**没有入站 SNI** → **不拦** |

**关键点**：把 DNS 改成 Cloudflare 代理（橙云）**并不能解决**——被拦的那一段
（Cloudflare → 阿里云）仍然带着域名 SNI，仍在入站侧。

**必须是隧道。**

---

## 架构

```text
用户（大陆，无梯子）
   ↓
Cloudflare 边缘（浏览器能正常到达）
   ↓  隧道：源站主动出站建立，HTTP/2 over TCP 443
洛杉矶 LAX  ← 延迟代价在这里（见「已知限制」）
   ↓
阿里云 → cloudflared (127.0.0.1) → nginx:443 → 对镜
```

实测回源证据（nginx access log）：

```text
127.0.0.1 - - [22:23:23] "GET / HTTP/1.1" 200     ← 回源 IP 是 127.0.0.1 = cloudflared
```

**回源 IP 是回环地址**，证明请求走的是隧道，没有从公网直连源站。

---

## 部署步骤

### 前置：域名已托管到 Cloudflare

`duijing.xyz` 的 NS 必须是 Cloudflare 的（在**域名注册商**处改，不是在云解析控制台）：

```text
heather.ns.cloudflare.com
yevgen.ns.cloudflare.com
```

> ⚠️ 阿里云用户注意：改 NS 在「**域名控制台 → 我的域名 → DNS修改**」，
> **不是**「云解析 DNS 控制台」。这两个是不同的地方。

### 第 1 步：服务器安装 cloudflared

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update -qq && sudo apt-get install -y cloudflared
cloudflared --version     # 2026.10.0
```

### 第 2 步：在 Cloudflare 建隧道并安装为服务

控制台：**Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**，
名字 `duijing-aliyun`。拿到 token 后：

```bash
sudo mkdir -p /etc/cloudflared
printf '%s' '<TOKEN>' | sudo tee /etc/cloudflared/token >/dev/null
sudo chmod 600 /etc/cloudflared/token
sudo cloudflared service install "$(sudo cat /etc/cloudflared/token)"
sudo rm -f /etc/cloudflared/token      # 安装后 token 已嵌入 systemd unit
```

### 第 3 步：切换传输协议到 HTTP/2

**默认的 QUIC 在大陆链路上会被干扰** —— 首次接入时日志出现：

```text
WRN Connection terminated error="failed to dial to edge with quic:
    timeout: no recent network activity" connIndex=1
```

预检显示 QUIC 与 HTTP/2 都 PASS，但 QUIC 走 UDP，这类到境外的长连接在国内
容易丢包。**HTTP/2 走 TCP 443，稳定得多。**

用 drop-in 设置（不改官方 unit、不碰 token）：

```bash
sudo mkdir -p /etc/systemd/system/cloudflared.service.d
sudo tee /etc/systemd/system/cloudflared.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment=TUNNEL_TRANSPORT_PROTOCOL=http2
EOF
sudo systemctl daemon-reload && sudo systemctl restart cloudflared
```

验证：`journalctl -u cloudflared | grep protocol=` 应全部是 `http2`。

### 第 4 步：配置 ingress（public hostname）

**推荐用 API**——控制台叫法在版本间变过（"Public Hostname" / "Hostname routes" /
"Published application routes"），而 **"Hostname routes" 那一项其实是私有网络路由**
（它的表单只有 Hostname，没有 Service，且提示需要 Cloudflare One Client），
**点了会配错**。

需要一枚 API Token：`Account → Cloudflare Tunnel → Edit`、`Zone → DNS → Edit`、
`Zone → Zone → Read`。

```bash
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/cfd_tunnel/$TUNNEL/configurations" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"config":{"ingress":[
        {"hostname":"www.duijing.xyz","service":"https://localhost:443",
         "originRequest":{"noTLSVerify":true}},
        {"hostname":"duijing.xyz","service":"https://localhost:443",
         "originRequest":{"noTLSVerify":true}},
        {"service":"http_status:404"}]}}'
```

**`noTLSVerify` 是必需的**：回源走 `https://localhost:443`，用的是 Let's Encrypt
证书，Cloudflare 从隧道那头校验会失败。连接本身在加密隧道内且只走本机回环，
关掉校验没有安全损失。

> ⚠️ **不要**在服务器上写 `/etc/cloudflared/config.yml` 配 ingress ——
> token 式（远程管理）隧道的配置来源是 `source: "cloudflare"`，
> **本地 ingress 会被忽略**。写了只会让人误以为改本地就生效。

### 第 5 步：建指向隧道的 CNAME

**API 配置 ingress 不会自动创建 DNS 记录**，要手工建（控制台方式会自动建）：

```bash
for name in www.duijing.xyz duijing.xyz; do
  curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
    -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"type\":\"CNAME\",\"name\":\"$name\",
         \"content\":\"$TUNNEL.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}"
done
```

> ⚠️ **原来的 A 记录必须删掉**。Cloudflare 导入域名时会带进
> `A → 47.117.189.125`（代理），**A 记录存在时 Cloudflare 不会创建隧道 CNAME，
> 流量继续直连源站、继续被拦**。这是最容易卡住的一步。

### 第 6 步：验证

```bash
# 外网（不带代理）应返回 200 且标题是「对镜」
curl -s https://www.duijing.xyz | grep -o '<title>.*</title>'

# 铁证：nginx 的回源 IP 应该是 127.0.0.1
sudo tail -5 /var/log/nginx/access.log
```

---

## region 调整：**实测结论是「指定不了」**

`cloudflared` 有 `--region`，但它是个**全局参数**（必须放在子命令**前面**），
而且**不是地理 PoP 选择器**：

```bash
cloudflared --region us tunnel run --token <TOKEN>     # ✅ 全局位置
cloudflared tunnel run --region us --token <TOKEN>     # ❌ flag provided but not defined
```

实测四种取值：

| `--region` | 结果 |
|---|---|
| 不指定（默认） | 4 条连接，全部 **LAX**（lax01–lax13） |
| `us` | 4 条连接，**LAX + SJC** |
| `eu` | **0 条连接**（连不上） |
| `hk` / `apac` | **0 条连接**（非法值，静默失败） |

**结论：`us` 是唯一有效的取值，而它就是默认落点。**

隧道边缘是 **anycast + BGP 自动选路**，从阿里云出发被路由到美国西海岸。
**客户端没有强制指定 PoP 的能力** —— 这是 Cloudflare 的设计，不是配置问题。

从服务器实测到 Cloudflare anycast 的 RTT：

```text
104.16.0.1      → 294 ms
198.41.192.27   → 272 ms
198.41.200.23   → 289 ms
```

**270–290ms 的物理往返，绕不过去。** 服务器也没有 IPv6，
所以 `--edge-ip-version 6` 这条路同样不通。

---

## 缓存：**已是最优，无需额外配置**

nginx 对带 hash 的构建产物发了 `immutable` 长缓存：

```nginx
location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

Cloudflare **会读这个头并缓存**。实测：

```text
/assets/index-*.js  第 1 次: cf-cache-status=MISS
                    第 2 次: cf-cache-status=HIT  (age=4)     ✅ 命中边缘缓存

/                    cf-cache-status=DYNAMIC   cache-control: no-cache, no-store  ✅
/api/health          cf-cache-status=DYNAMIC                                     ✅
```

**首页和 API 保持 DYNAMIC 是正确的** —— HTML 必须每次回源（产物名带 hash，
HTML 是唯一知道该加载哪个 bundle 的地方），API 更不该缓存。

所以**不需要 Cache Rule**。真正省不掉的延迟是 **API 调用**（每次约 900ms）。

---

## 日常运维

```bash
# 状态
systemctl status cloudflared
curl -s http://127.0.0.1:20241/ready
# → {"status":200,"readyConnections":4,...}   4 条才算健康

# 日志
journalctl -u cloudflared -f
journalctl -u cloudflared | grep "Registered tunnel connection" | tail -4

# 重启（改配置后用）
sudo systemctl restart cloudflared
```

**判断隧道是否在真正转发**：看 nginx 的 access log 里回源 IP 是不是 `127.0.0.1`。
只看「服务 active」不够——那只能说明 cloudflared 起来了，不代表流量走它。

---

## 回退

```bash
sudo systemctl stop cloudflared && sudo systemctl disable cloudflared
```

然后在 Cloudflare DNS 里把两条 CNAME 换回指向 `47.117.189.125` 的 A 记录。

**回退成本极低**：隧道是**额外加的一条入口**，
nginx / 证书 / 应用代码 / 现有 systemd 服务**一行都没改**。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **延迟约 900ms** | 两次跨境（用户→Cloudflare→LAX→回阿里云）。API 调用每次约 1 秒，首屏 3–5 秒 |
| **region 不可调** | 见上，anycast 决定 |
| **合规性质未变** | 隧道藏住了「有人在访问」，但**没改变「大陆服务器未备案提供 Web 服务」**这个事实。阿里云的服务条款仍然适用 |
| **微信/QQ 拦截** | 与备案是两回事。需要走微信的「网站管理员认证」流程（在站点根目录放一个校验文件） |
| **校验文件会被部署清掉** | `rsync --delete` 会清空 `dist`。**该文件已放入 `web/public/`，构建时自动带上** |

### 长期方案

隧道解决的是「现在能用」，不是「长期最优」。**根本解法是让源站离用户更近**：

| 方案 | 延迟 | 说明 |
|---|---|---|
| **源站搬香港** | 30–60ms | **推荐**。境外服务器不需要 ICP 备案，而且**那时连隧道都不需要了**——域名直接解析过去，一次跨境，架构更简单 |
| 完成 ICP 备案 | 最好 | 大陆速度最优，但周期 7–20 工作日，期间站点要关停 |

**把隧道当作临时方案，而不是长期架构** —— 它的价值是「保留现有的阿里云服务器」，
如果首要目标是速度，这个前提本身就不成立。

---

## 本次部署的实际参数

```text
Zone ID       ff8b07e07956bee9d8b862e46365e314
Account ID    745b1b4a45a1f101d648636407aebb9b
Tunnel ID     4e3a79b4-bd72-4318-9d3b-4233baf88832
CNAME 目标    4e3a79b4-bd72-4318-9d3b-4233baf88832.cfargotunnel.com
Ingress       www.duijing.xyz + duijing.xyz → https://localhost:443 (noTLSVerify)
协议          HTTP/2 (TCP 443)，非默认的 QUIC
```
