# 对镜 · API 契约 v1.0

> 本文档是前后端并行开发的唯一契约。任何字段变更必须先改本文档。
> 基础路径：`/api`　内容类型：`application/json; charset=utf-8`

---

## 0. 通用约定

### 0.1 认证

- 登录成功后服务端下发 **httpOnly Cookie**：`dj_token`（JWT，7 天过期）
- Cookie 属性：`HttpOnly; SameSite=Lax; Path=/`，HTTPS 下额外 `Secure`
- 同时返回 `token` 字段在响应体，便于非浏览器客户端使用 `Authorization: Bearer <token>`
- 需要登录的接口未认证时返回 `401`

### 0.2 错误格式

统一使用 FastAPI 默认结构：

```json
{ "detail": "错误说明（中文）" }
```

常用状态码：`400` 参数错误 · `401` 未登录 · `403` 无权限 · `404` 不存在 · `409` 冲突 · `429` 限流

### 0.3 时间格式

- 所有时间戳为 **ISO 8601 UTC** 字符串：`2026-09-26T14:30:00Z`
- 所有「日期」为本地时区（Asia/Shanghai）的 `YYYY-MM-DD`
- 前端负责转成本地展示；服务端负责「今天」的判定

### 0.4 枚举值总表

| 枚举 | 取值 |
|---|---|
| `weakness.status` | `ai_candidate` · `observing` · `improving` · `archived` |
| `weakness.domain` | `work` · `relationship` · `emotion` · `decision` · `expression` · `health` · `other` |
| `weakness.source` | `ai` · `user` |
| `loop.status` | `draft` · `active` · `needs_revision` · `paused` · `archived` |
| `loop_log.result` | `hold`（撑住） · `break`（破功） · `not_triggered`（未触发） |
| `loop_log.source` | `debate` · `event_card` · `manual` |
| `advantage.status` | `pending` · `confirmed` · `archived` · `removed` |
| `principle.status` | `candidate` · `active` · `archived` · `ignored` |
| `principle.confidence` | `high` · `medium` · `low` |
| `principle.source_type` | `loop_rate` · `debate_conclusion` · `manual` · `ai_alternative` |
| `event_card.result` | `hold` · `break` · `not_triggered` · `unsure` |
| `observation.type` | `weakness` · `advantage` |
| `observation.status` | `pending` · `accepted` · `ignored` · `expired` |
| `debate.status` | `active` · `paused` · `finished` · `abandoned` |

### 0.5 核心对象

```jsonc
// User
{ "id": 1, "username": "alice", "nickname": "爱丽丝", "created_at": "..." }

// WeaknessCard
{
  "id": 12, "name": "被追问时防御性重复", "description": "...",
  "domains": ["work", "expression"], "status": "observing",
  "confidence": 3, "source": "ai", "source_id": 8,
  "trigger_count_30d": 6, "hold_count_30d": 4,
  "hold_rate_30d": 67,          // null = 还没有触发记录，不是 0%
  "hold_rate_7d": 80,           // 本周；null = 本周无数据
  "hold_rate_prev_7d": 50,      // 上周；null = 上周无数据
  "trend_delta": 30,            // 本周 - 上周；任一为 null 时本字段为 null
  "plan_count": 1, "drill_count": 3,
  "days_since_created": 12, "created_at": "...", "archived_at": null,
  "delete_after": null
}

// Loop（回环）
{
  "id": 5, "weakness_id": 12, "weakness_name": "被追问时防御性重复",
  "trigger_scene": "开会被追问进度", "body_signal": "心跳加快、想反驳",
  "action_plan": "先说“这点我还没想清楚”，再补事实",
  "status": "active",
  "linked_advantages": [{ "id": 3, "name": "临场反应快" }],
  "linked_principles": [{ "id": 7, "content": "先承认，再补充" }],
  "trigger_count_30d": 6, "hold_count_30d": 4, "hold_rate_30d": 67,
  "created_at": "...", "updated_at": "..."
}

// LoopLog
{ "id": 31, "loop_id": 5, "weakness_id": 12, "date": "2026-09-26",
  "result": "hold", "note": "这次先承认了", "source": "event_card",
  "source_id": 9, "created_at": "..." }

// EventCard
{ "id": 9, "content": "开会时被追问，我先承认没想清楚",
  "linked_loops": [{ "id": 5, "trigger_scene": "开会被追问进度" }],
  "result": "hold", "analyzed": true, "pending_confirm": false,
  "created_at": "..." }

// Advantage
{ "id": 3, "name": "临场反应快", "source": "ai", "source_id": 8,
  "verified": false, "status": "pending", "created_at": "...", "archived_at": null }

// Principle
{ "id": 7, "content": "先承认，再补充", "source_type": "loop_rate",
  "source_id": 5, "status": "candidate", "confidence": "high",
  "pinned": false, "linked_loop_ids": [5],
  "linked_loops": [{ "id": 5, "trigger_scene": "开会被追问进度" }],
  "created_at": "...", "updated_at": "..." }

// Observation（AI 观察）
{ "id": 8, "type": "weakness", "content": "被追问时容易防御性重复",
  "source_type": "debate", "source_id": 2, "status": "pending",
  "first_seen_at": null, "created_at": "...", "expires_at": null }

// DebateRoom
{ "id": 2, "topic": "该不该在会议上直接反驳领导",
  "stance": "应该直接反驳", "status": "active",
  "max_rounds": 6, "current_round": 2,
  "source_type": "manual", "source_id": null,
  "is_owner": true, "participant_count": 1,
  "loop_id": 5, "weakness_id": 12,
  "created_at": "...", "finished_at": null }

// DebateMessage
{ "id": 40, "room_id": 2, "role": "ai" | "user" | "system",
  "user_id": 1, "nickname": "爱丽丝", "content": "...",
  "round": 2, "seq": 40, "created_at": "..." }

// ReviewCard（复盘卡片）
{
  "room_id": 2,
  "good":     { "title": "做得好",     "content": "..." },
  "notice":   { "title": "值得注意",   "content": "..." },
  "next_time":{ "title": "如果再来一次", "content": "..." },
  "observations": [
    { "id": 8, "type": "weakness", "content": "..." },
    { "id": 9, "type": "advantage", "content": "..." }
  ],
  "alternative_action": "下次被追问时，先重复对方问题再回答",
  "generated_at": "..."
}
```

---

## 1. 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 邀请码注册 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 当前用户 |
| GET | `/api/auth/invite` | 我的邀请码与链接 |
| POST | `/api/auth/invite/rotate` | 重置邀请码 |

**POST /api/auth/register**

```jsonc
// 请求
{ "username": "alice", "password": "至少8位", "nickname": "爱丽丝", "invite_code": "AB12CD34" }
// 响应 200
{ "user": { "id": 1, "username": "alice", "nickname": "爱丽丝", "created_at": "..." }, "token": "..." }
```
> 邀请码无效 → `400 {"detail":"邀请码无效"}`；用户名已存在 → `409`。
> 首个注册用户自动成为管理员并生成初始邀请码；服务端同时通过环境变量 `BOOTSTRAP_INVITE_CODE` 支持固定邀请码。

**GET /api/auth/invite** → `{ "code": "AB12CD34", "link": "https://host/join/AB12CD34", "used_count": 3 }`

---

## 2. 状态栏

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status-bar` | 首页四块数据 |
| POST | `/api/daily-state` | 写入当日精力/心情 |

**GET /api/status-bar** → 200

```jsonc
{
  "date": "2026-09-26", "weekday": "周六",
  "energy": 72,                  // null 表示未填，前端不显示
  "mood": "calm",                // null 表示未填
  "streak_days": 12,
  "today_loops": [               // 最多 2 条，按 hold_rate 升序（最该练的在前）
    { "loop_id": 5, "title": "被追问时先承认没想清楚",
      "weakness_id": 12, "hold_rate_30d": 67, "trigger_count_30d": 6 }
  ],
  "observations": [              // AI 观察候选，最多 1 条
    { "id": 8, "type": "weakness", "content": "被追问时容易防御性重复",
      "created_at": "..." }
  ]
}
```

**POST /api/daily-state** → 200

```jsonc
// 请求：两项均可选，可只传一个
{ "energy": 72, "mood": "calm" }
// 响应
{ "date": "2026-09-26", "energy": 72, "mood": "calm" }
```
> `energy` 范围 0–100，越界 → `400`。`mood` ∈ `great|good|calm|low|bad`。

---

## 3. 辩论房

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/debates` | 列表，`?status=active,paused`（逗号分隔多值） |
| POST | `/api/debates` | 新建辩论 |
| GET | `/api/debates/{id}` | 详情（含消息） |
| POST | `/api/debates/{id}/messages` | 用户发言 |
| GET | `/api/debates/{id}/stream` | **SSE** 流式获取 AI 回复 |
| POST | `/api/debates/{id}/finish` | 结束并生成复盘卡片 |
| POST | `/api/debates/{id}/abandon-round` | 这轮我放弃 |
| POST | `/api/debates/{id}/invite` | 生成邀请链接 |
| POST | `/api/debates/join/{invite_token}` | 凭链接加入 |

**POST /api/debates**

```jsonc
// 请求（topic 与 scene 至少给一个）
{
  "topic": "该不该在会议上直接反驳领导",   // 可空
  "stance": "应该直接反驳",
  "scene": "",               // 用户描述的场景，由 AI 转成辩题（对应方案 3.1 的 P0）
  "source_type": "manual",   // manual | weakness | event_card | ai
  "source_id": null,          // weakness_id 或 event_card_id
  "loop_id": null             // 关联回环时，AI 会制造触发场景（不告知用户）
}
// 响应 201
{ "room": { /* DebateRoom */ }, "first_message": { /* DebateMessage, role=ai */ } }
```

**辩题来源优先级**（对应方案 3.1 的 P0–P3）：

1. 直接给 `topic` —— 用户自己出题
2. 给 `scene` —— 用户只说「今天开会我又被怼了」，由 AI 转成可辩的题目
3. 给 `loop_id` / `weakness_id` —— 系统据此构造场景再生成辩题

三者都没有 → `400 请提供辩题、场景描述（scene），或关联一个回环`。
> 回合数由 AI 依据复杂度决定，落在 4–8，写入 `max_rounds`。

**POST /api/debates/{id}/messages**

```jsonc
{ "content": "我认为应该直接反驳，因为……" }   // ≤ 300 字，超出 → 400
// 响应 201
{ "message": { /* DebateMessage, role=user */ }, "round": 2, "is_last_round": false }
```

**GET /api/debates/{id}/stream?after_seq=40** — SSE

```
event: token
data: {"delta": "我"}

event: token
data: {"delta": "理解"}

event: message
data: {"message": { /* 完整 AI DebateMessage，已落库 */ }}

event: done
data: {"round": 2, "is_last_round": false}
```

- 断开即停止生成，但已落库消息保留
- 错误时：`event: error` / `data: {"detail": "..."}`
- 前端用 `EventSource` 需要 Cookie 认证（同源自动携带）

**POST /api/debates/{id}/finish** → 200 `{ "review": { /* ReviewCard */ } }`
> 生成复盘卡片，并按「每场最多 1 优势 + 1 弱点 + 1 替代动作」写入 `ai_observation`。
> 观察只在结束后产生，辩论中不产生。

**POST /api/debates/{id}/abandon-round** → 200

```jsonc
{ "round": 3, "message": { /* 本次写入的「（这轮我放弃）」用户消息 */ }, "is_last_round": false }
```
> 返回的是**用户侧**那条放弃消息，不是 AI 回应。
> 标准用法：拿到响应后照常打开 `GET /api/debates/{id}/stream`，让 AI 接住这一轮。
> 该信号计入观察数据（作为「回避」），但**不计入**弱点触发次数。

---

## 4. 弱点与回环

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/weaknesses` | 列表，`?status=` 可多值逗号分隔 |
| POST | `/api/weaknesses` | 用户自建 |
| GET | `/api/weaknesses/{id}` | 详情（含回环列表） |
| PATCH | `/api/weaknesses/{id}` | 改名/描述/领域/置信度/状态 |
| POST | `/api/weaknesses/{id}/archive` | 移入垃圾桶（60 天倒计时） |
| POST | `/api/weaknesses/{id}/restore` | 恢复为 `observing`，触发计数保留 |
| POST | `/api/weaknesses/{id}/loops` | 新建回环 |
| GET | `/api/loops` | **全部回环**，`?status=active,needs_revision`、`?weakness_id=` 可选 |
| PATCH | `/api/loops/{id}` | 改回环 |
| POST | `/api/loops/{id}/logs` | 写演练日志 |
| GET | `/api/loops/{id}/logs` | 日志列表 |

**GET /api/weaknesses?status=ai_candidate,observing,improving**

```jsonc
{ "groups": {
    "ai_candidate": [ /* WeaknessCard */ ],
    "observing":    [ /* WeaknessCard */ ],
    "improving":    [ /* WeaknessCard */ ],
    "archived":     [ /* WeaknessCard */ ]
  },
  "total": 9 }
```

**POST /api/weaknesses**

```jsonc
{ "name": "被追问时防御性重复", "description": "...",
  "domains": ["work"], "confidence": 3 }
```
> `name`、`description`、`domains` 必填；`confidence` 默认 3。

**POST /api/weaknesses/{id}/loops**

```jsonc
// 表单入口
{ "mode": "form", "trigger_scene": "...", "body_signal": "...",
  "action_plan": "...", "activate": true,
  "linked_advantage_ids": [3], "linked_principle_ids": [7] }
```
```jsonc
// 对话式入口（三步）
{ "mode": "dialog", "step": "scene", "content": "开会被追问时" }
// → { "step": "signal",  "question": "当时身体有什么感觉？" }
// 第二步 step=signal  → 回问 "下次遇到类似情况，你想怎么做？"
// 第三步 step=plan    → { "loop": { /* Loop, status=draft */ },
//                          "confirm_question": "好，这就是你的预案。要现在启用吗？" }
```
> 第三步后调用 `PATCH /api/loops/{id}` 把 `status` 改为 `active` 即启用。

**POST /api/loops/{id}/logs**

```jsonc
{ "result": "hold", "note": "这次先承认了", "source": "manual",
  "source_id": null, "date": "2026-09-26" }
```
> **约束**：所有经验变动必须写 `loop_log`，不直接改弱点状态。
> 写入后服务端重算近 30 天撑住率；若 `hold_rate ≥ 80% 且 trigger_count ≥ 5`，
> 响应中返回 `{ "suggest_downgrade": true }` 提示用户确认（**不自动降级**）。
> 若 `result=break`，回环自动进入 `needs_revision`，并返回 `{ "alternative_action": "..." }`。

---

## 5. 事件卡

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/event-cards` | 列表，`?limit=&offset=` |
| POST | `/api/event-cards` | 记录一笔 |
| POST | `/api/event-cards/analyze` | 手动触发 AI 扫描 |

**POST /api/event-cards**

```jsonc
// 完整模式
{ "content": "开会时被追问，我先承认没想清楚",
  "linked_loop_ids": [5], "result": "hold" }
// 极简模式：只写一句，AI 自动判断关联与结果
{ "content": "开会时被追问，我先承认没想清楚" }
// 响应 201
{ "card": { /* EventCard */ },
  "auto_linked": true,        // 是否由 AI 自动关联
  "pending_confirm": false,   // true 表示 AI 不确定，标记待确认
  "created_logs": [ { /* LoopLog */ } ] }
```
> 有 `linked_loop_ids` + `result` 时立即写 `loop_log`；
> 极简模式进 `ai_queue`，夜间批量判定（也可手动触发）。

**POST /api/event-cards/analyze** → 200

```jsonc
{ "scanned": 7, "cards_analyzed": 3, "pending_confirm": 2,
  "candidates": [ { "id": 8, "type": "weakness", "content": "..." } ] }
```

> `cards_analyzed` 是本次完成 AI 判定的卡片数；`pending_confirm` 是其中
> AI 拿不准、被标为「待确认」的数量。
> 生成的弱点候选进 `ai_observation`，24 小时（从首次看到算）不确认则消失。

---

## 6. 优势库

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/advantages` | 列表，`?status=pending,confirmed`（逗号分隔多值） |
| POST | `/api/advantages/{id}/confirm` | 确认 |
| POST | `/api/advantages/{id}/remove` | 移除（AI 不再重复入库同一标签） |
| POST | `/api/advantages/{id}/restore` | 恢复 |

> 入库由 AI 观察自动完成，**不弹窗、不打断**；只有 `confirmed` 的优势才在回环预案中被推荐；
> `pending` 超 30 天自动归档。

---

## 7. 原则库

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/principles` | 列表，`?status=` |
| POST | `/api/principles` | 手动新建 |
| POST | `/api/principles/{id}/confirm` | 候选 → 启用 |
| POST | `/api/principles/{id}/ignore` | 忽略（留痕，AI 不再重复推） |
| POST | `/api/principles/{id}/archive` | 归档 |
| POST | `/api/principles/{id}/restore` | 恢复 |
| PATCH | `/api/principles/{id}` | 改内容/置顶/关联回环 |

```jsonc
// PATCH 请求
{ "content": "先承认，再补充", "pinned": true, "linked_loop_ids": [5, 8] }
```
> 候选不消失、不设 24 小时限制；一条原则可关联多个回环；不进状态栏。

---

## 8. AI 观察

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/observations` | 待处理候选，`?status=pending` |
| POST | `/api/observations/{id}/accept` | 加入 → 建弱点卡 / 优势入库 |
| POST | `/api/observations/{id}/ignore` | 忽略 |

**POST /api/observations/{id}/accept** → 200

```jsonc
{ "created": { "kind": "weakness", "id": 12 } }   // 或 { "kind": "advantage", "id": 3 }
```
> **24 小时规则从「首次看到」算**：`GET /api/observations` 会把返回条目的
> `first_seen_at` 置为当前时间（仅首次），并据此计算 `expires_at`。
> 一旦某条被返回过，24 小时后未处理即转为 `expired`，不再出现在首页。

---

## 9. 归档 / 垃圾桶

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/archive` | 汇总：弱点(60天) / 优势 / 原则 |
| POST | `/api/archive/purge` | 手动清理过期弱点（管理员） |

| 对象 | 归档规则 | 恢复 |
|---|---|---|
| 弱点 | 拖垃圾桶 → `archived`，60 天倒计时，过期物理删除 | 恢复为 `observing`，触发计数保留 |
| 优势 | 待确认 30 天超时归档 | 可恢复 |
| 原则 | 手动归档 | 可恢复 |
| AI 观察候选 | 24 小时（从首次看到算） | **不恢复** |
| 事件卡 | 永久保留 | — |

---

## 10. SSE 与前端对接细则

- `EventSource` 同源自动带 Cookie；跨域部署需 `withCredentials` + 服务端 `CORS allow_credentials`
- 心跳：服务端每 15s 发送 `event: ping`，防止 Nginx 断连
- 前端断线重连使用 `after_seq` 参数续传，已落库消息不重复推送
- Nginx 侧必须对本路径关闭缓冲：`proxy_buffering off; proxy_read_timeout 600s;`

---

## 11. 限流

| 接口 | 限制 |
|---|---|
| 辩论房发言 `POST /api/debates/{id}/messages` | 每用户每分钟 10 次 → `429` |
| 登录 `POST /api/auth/login` | 每 IP 每分钟 10 次，连续失败 5 次锁 15 分钟 |
| AI 相关 POST（复盘/扫描/辩题生成） | 每用户每分钟 6 次 |

---

## 12. AI 路由规则（后端内部，前端不可见）

| 任务 | 模型 | 执行时机 |
|---|---|---|
| 辩论房对话 | DeepSeek（`deepseek-flash`） | 实时 SSE |
| 复盘卡片 | MiMo | 立即 |
| 辩题生成 | MiMo | 立即 |
| 事件卡扫描 | MiMo | 延迟到夜间队列 |
| 回环对话 | MiMo | 立即 |
| 弱点/优势候选 | MiMo | 扫描后立即 |

Provider 由 `AI_PROVIDER` 环境变量决定：`mock`（默认） / `deepseek` / `mimo` / `hybrid`（按上表真实分流）。

---

## 13. 响应外层结构（v1.1 补充）

v1.0 只约定了路径与对象字段，没有约定列表接口的外层包装。实现完成后在此补全，
**以本节为准**，前端按此对接不需要再猜。

| 接口 | 外层结构 |
|---|---|
| `GET /api/debates` | `{ "rooms": [DebateRoom], "total": n }` |
| `GET /api/debates/{id}` | `{ "room": DebateRoom, "messages": [DebateMessage], "review"?: ReviewCard }`（`review` 仅发起人可见） |
| `GET /api/weaknesses` | `{ "groups": { "ai_candidate": [], "observing": [], "improving": [], "archived": [] }, "total": n }` |
| `GET /api/weaknesses/{id}` | `{ "weakness": WeaknessCard, "loops": [Loop], "suggest_downgrade": bool, "suggest_archive": bool }` |
| `POST /api/weaknesses` | `{ "weakness": WeaknessCard }` |
| `PATCH /api/weaknesses/{id}` | `{ "weakness": WeaknessCard }` |
| `POST /api/weaknesses/{id}/archive` | `{ "weakness": WeaknessCard, "note": "..." }` |
| `POST /api/weaknesses/{id}/restore` | `{ "weakness": WeaknessCard }` |
| `POST /api/weaknesses/{id}/loops` | `{ "loop": Loop }`（对话式为 `{ step, question, ... }` / `{ step:"confirm", loop, confirm_question }`） |
| `PATCH /api/loops/{id}` | `{ "loop": Loop }` |
| `GET /api/loops` | `{ "loops": [Loop], "total": n }` |
| `GET /api/loops/{id}/logs` | `{ "logs": [LoopLog], "hold_rate_30d": n, "trigger_count_30d": n, "hold_count_30d": n }` |
| `GET /api/event-cards` | `{ "cards": [EventCard], "total": n }` |
| `GET /api/advantages` | `{ "advantages": [Advantage], "total": n, "pending_count": n }` |
| `GET /api/principles` | `{ "principles": [Principle], "total": n, "candidate_count": n }` |
| `GET /api/observations` | `{ "observations": [Observation], "total": n }` |
| `GET /api/archive` | `{ "weaknesses": [], "advantages": [], "principles": [], "records": [], "rules": {...} }` |

### 13.1 `POST /api/loops/{id}/logs` 的响应

这个接口是唯一改变经验数据的入口，返回体里带了三类**必须由前端呈现**的信息：

```jsonc
{
  "log": { /* LoopLog */ },
  "hold_rate_30d": 80,
  "trigger_count_30d": 5,
  "loop_status": "needs_revision",

  // 仅当撑住率 ≥ 80% 且触发 ≥ 5 时出现
  "suggest_downgrade": true,
  "reason": "近 30 天撑住率 80%，触发 5 次，已达降级标准",
  "hint": "确认后将移入暂存区，可在垃圾桶恢复",

  // 仅当 result=break 时出现
  "needs_revision": true,
  "alternative_action": "下次被追问时，先重复一遍对方的问题，再开口回答"
}
```

> **前端注意**：`suggest_downgrade` 只是建议。**降级必须由用户点确认后调用
> `POST /api/weaknesses/{id}/archive`**，任何自动调用都违反产品约束第 8 条。

### 13.2 `POST /api/debates/{id}/invite` 的响应

```jsonc
{
  "invite_token": "xxxxxxxx",
  "link": "https://host/debate/join/xxxxxxxx",
  "participant_count": 1,
  "max_participants": 4
}
```

> 字段名是 `invite_token` 而非 `token`——响应里另有含义完全不同的认证 token，
> 同名会造成混淆。

### 13.3 时间字段约定

所有时间戳均为 **带时区的 ISO 8601 UTC 字符串**（`2026-09-26T14:30:00Z`）。
服务端在类型层保证读写都是 UTC，客户端可以放心用 `new Date(...)` 直接解析。
所有「日期」字段（`loop_log.date`、`event_card` 的展示日期）按 **Asia/Shanghai** 判定。

---

## 14. v1.1 变更记录

实现阶段新增或调整的内容，均已同步到上文：

| 变更 | 原因 |
|---|---|
| 新增 `POST /api/debates/{id}/pause`、`/resume` | 方案 3.1 要求「用户可暂停查资料，回来继续」，v1.0 漏了对应端点 |
| 新增 `POST /api/debates/{id}/review/dismiss-observations` | 方案 3.1 要求「用户可关闭本轮观察，关闭后不产生弱点/优势数据」 |
| `POST /api/debates/{id}/invite` 返回 `invite_token` | 原 v1.0 未定义；与认证 token 区分 |
| `advantage.status` 增加 `removed` | 方案 3.5 要求「移除后 AI 不再重复入库同一标签」，需留痕 |
| `principle.status` 增加 `ignored` | 方案 3.6 要求「忽略留痕，AI 不再重复推同一原则」 |
| WeaknessCard 用 `drill_count` + `plan_count` 取代 `loop_count` | 便签角标要显示「演练 3 · 预案 1」，需要的是演练次数而非回环数 |
| 新增第 13 节响应外层结构 | v1.0 缺列表包装约定，前端只能猜 |
| 注册接口额外返回 `is_first_user`、`invite_code` | 便于前端引导首个用户 |

### 14.1 查询参数 `status` 与 `status_filter`

v1.0 文档把列表接口的筛选参数写作 `?status=`，而早期实现读的是 `?status_filter=`。
参数名写错**不会报错**，只会返回全部数据——这类缺陷在页面上极难发现。

现已统一处理：**后端两种参数名都接受**，`status` 优先。新代码请一律使用 `status`。

涉及的接口：`/api/debates`、`/api/weaknesses`、`/api/advantages`、`/api/principles`、
`/api/observations`。

### 14.2 邀请链接的路由约定

`POST /api/debates/{id}/invite` 返回的 `link` 形如：

```
https://your-domain.com/debate/join/{invite_token}
```

前端**必须**存在路由 `/debate/join/:token`（组件 `DebateJoinPage`），
它在挂载时调用 `POST /api/debates/join/{token}` 并跳转到房间。

> 这是一个真实踩过的坑：后端生成 `/debate/join/{token}`，而前端只有注册用的
> `/join/:code`，两者路径不同，邀请链接点开直接 404，整条多人辩论链路是断的。
> 改动其中一侧时务必同步另一侧。

被邀请者需要登录：未登录时先跳登录页，登录后自动回到该地址继续加入。


---

## 15. 冷启动迭代（v1.2）

### 15.1 `hold_rate` 为 `null` 的含义（重要）

**`hold_rate_30d` / `hold_rate_7d` / `hold_rate_prev_7d` 都可能是 `null`。**

| 值 | 含义 | 前端应显示 |
|---|---|---|
| `null` | **还没有触发记录**（新回环，或只记过「未触发」） | `--` 或「还没有记录」，中性色 |
| `0` | 真的每次都破功 | `0%`，砖红 `--rate-low` |

**这两者绝不能渲染成同一个东西。** 刚建好回环、一次都没练过的用户
看到「0%」，会以为自己一直在失败。

配套字段：`trigger_count_30d`（= 0 时说明无数据）、`hold_rate_prev_7d`。
「未触发」的记录不进分母，所以只记过「未触发」时仍然算无数据。

### 15.2 趋势字段

`trend_delta = hold_rate_7d - hold_rate_prev_7d`，**任一周为 `null` 时本字段为 `null`**，
此时前端**不显示**趋势——显示「↑ 0%」会制造「在原地踏步」的错觉。

### 15.3 预约辩论提醒与推送

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/push/config` | `{ available, public_key, presets:[{key,label}] }`（无需登录） |
| GET | `/api/push/status` | `{ available, subscribed, device_count }` |
| POST | `/api/push/subscribe` | `{ endpoint, keys:{p256dh,auth} }` |
| POST | `/api/push/unsubscribe` | `{ endpoint }` |
| POST | `/api/push/test` | 给自己发一条测试推送；无设备时 409 |
| GET | `/api/debates/{id}/reminder` | 读取当前预约 |
| POST | `/api/debates/{id}/reminder` | `{ preset }` 或 `{ remind_at }`，可选 `note` |
| DELETE | `/api/debates/{id}/reminder` | 取消预约 |

**预设**（推荐用预设，让用户在手机上挑日期时间是给「预约」增加摩擦）：

| key | 含义 |
|---|---|
| `in_30min` | 30 分钟后 |
| `in_1h` | 1 小时后 |
| `tonight_8` | 今晚 20:00（已过则顺延到明天） |
| `tomorrow_8` | 明晚 20:00 |
| `tomorrow_9am` | 明天 09:00 |

`POST` 响应：`{ reminder, device_count, will_notify }`。

> **`will_notify=false` 时前端必须明确提示**（例如「已记下，但还没开启通知」）。
> 让用户以为约好了却收不到，比不支持推送更糟。

限制：提醒时间必须晚于现在、且不超过 30 天。同一场辩论只保留一条待发提醒。

**推送 payload**：`{ title, body, url, tag, renotify }`。
Service Worker 通过 `push` 事件接收，`notificationclick` 打开 `url`。

### 15.4 账号数据

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/account/export` | 导出全部数据为 JSON（带 `Content-Disposition`） |
| GET | `/api/account/deletion` | `{ requested, requested_at }` |
| POST | `/api/account/deletion` | 提交注销申请 |
| DELETE | `/api/account/deletion` | 撤销申请 |

> 导出**不包含** `password_hash`。
> 注销是**申请标记 + 人工确认**，不是即时物理删除；申请期间账号仍可正常使用，
> 但推送订阅会被撤销。
