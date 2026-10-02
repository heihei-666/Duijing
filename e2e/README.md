# 对镜 · 端到端验收脚本

用无头 Chromium 在**真实站点**上跑验收，覆盖单元测试覆盖不到的东西：
真实渲染、真实 SSE 流、真实移动端视口、真实缓存行为。

所有结论都记在 `docs/验收清单-*.md` 和 `docs/方案对照表.md` 里，脚本是可复现那些结论的工具。

## 为什么脚本在仓库里、凭据不在

这些脚本曾经写死过邀请码、服务器 IP 和 SSH 私钥路径，只能放在仓库外，
结果就是结论可查、过程不可复现。现在环境相关的值全部走环境变量
（见 `config.mjs`），脚本本身**不含任何秘密**，所以可以正大光明地入库。

## 准备

```bash
cd e2e
npm install                      # 装 playwright
npx playwright install chromium  # 装浏览器（首次，约 150MB）
```

在容器/CI 里跑需要 `--no-sandbox`，`CHROME_ARGS` 里已经带上了。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DJ_INVITE` | 注册类脚本必填 | 注册邀请码。站长登录 → 资产页可见 |
| `DJ_BASE` | 否 | 被测站点，默认 `https://duijing.xyz` |
| `DJ_TEST_PASSWORD` | 否 | 一次性测试账号的口令，默认 `E2eTest12345` |
| `DJ_USER` / `DJ_PASSWORD` | 否 | 已登录态脚本用，不设则跳过登录 |
| `DJ_SSH` | `wrapup.mjs` 必填 | SSH 命令，用来直连数据库复刻房间状态 |
| `DJ_DB` | 否 | 服务器上 SQLite 路径，默认 `/opt/duijing/data/duijing.db` |
| `DJ_SHOTS` / `DJ_OUT` | 否 | 截图与结果 JSON 的输出目录 |

`DJ_SSH` 示例（**不要把真实私钥路径提交到仓库**）：

```bash
export DJ_SSH="ssh -i /path/to/key -o StrictHostKeyChecking=no admin@<服务器IP>"
```

## 脚本清单

| 脚本 | 验什么 | 结论记在 |
|---|---|---|
| `accept.mjs` | 冷启动验收：无痕注册 → 首页两个主按钮 ≤3s 可点 → 即兴辩论 → 记一笔事件卡 | `docs/验收清单-冷启动迭代.md` |
| `fresh.mjs` | 新账号首页「这是你的第一站」空态，以及建了回环/事件卡后主按钮重新出现 | `docs/验收清单-冷启动迭代.md` |
| `gaps.mjs` | 方案缺口验收：四来源分段、宽屏黑板拖拽、弱点详情、资产归档、窄屏不破 | `docs/方案对照表.md` 第十节 |
| `wrapup.mjs` | 辩满计划轮数后「结束并复盘」够不够得着（视口内、刷新仍在、点了真出复盘） | `docs/方案对照表.md` 第十一节 |
| `overflow-probe.mjs` | 指定页面有没有横向溢出，并列出越界元素 | —— |
| `probe.mjs` / `inspect.mjs` | 临时排查用：列出页面所有按钮、文本、是否有 dialog | —— |

## 用法

```bash
DJ_INVITE=XXXXXXX node e2e/accept.mjs
DJ_INVITE=XXXXXXX DJ_SSH="$DJ_SSH" node e2e/wrapup.mjs
node e2e/overflow-probe.mjs /debates/2
node e2e/overflow-probe.mjs /weaknesses --width 1280 --height 900
```

## ⚠️ 跑完必须清理测试账号

注册类脚本会**在你的生产库里建真实账号和真实辩论房**。跑完要删干净，
否则会污染真实数据（首页统计、弱点墙、辩论列表都会被影响）。

删除时注意两点：

1. **只删测试账号，绝不碰 `user_id=1`**（站长的真实账号）。
2. SQLite 的外键级联不总是生效，删完要单独清孤儿行：

```sql
DELETE FROM debate_message      WHERE room_id NOT IN (SELECT id FROM debate_room);
DELETE FROM debate_review       WHERE room_id NOT IN (SELECT id FROM debate_room);
DELETE FROM debate_participant  WHERE room_id NOT IN (SELECT id FROM debate_room);
DELETE FROM weakness_loop       WHERE weakness_id NOT IN (SELECT id FROM weakness_card);
```

`wrapup.mjs` 会在生产库里**复刻一份**房间里已有的辩题和消息（照搬 `room_id=2`），
所以清理时别忘了它建的那个房间。

## 域名被拦截时

大陆节点的域名未备案会被阿里云拦截（`Non-compliance ICP Filing`），
届时所有脚本都会连不上。判断方法见 `deploy/DEPLOY.md` §10.5：
服务器本身正常（`curl 127.0.0.1` 通、`systemctl status duijing` 是 active），
但域名访问被重置 —— 那就是备案问题，不是代码问题。
