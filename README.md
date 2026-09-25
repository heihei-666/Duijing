---
title: 对镜
emoji: 🪞
colorFrom: gray
colorTo: blue
sdk: docker
pinned: false
---

# 对镜

> 用 AI 辩论房照见自己，用弱点回环改善自己。

个人成长工作台。系统只做三件事：**帮用户发现弱点**（AI 辩论房 + 事件卡扫描）、
**帮用户改善弱点**（回环 + 演练 + 撑住率）、**帮用户沉淀经验**（优势库 + 原则库）。

---

## 核心闭环

```text
AI 辩论房 → 观察弱点/优势 → 用户确认 → 建回环 → 演练 → 撑住率达标 → 原则沉淀
                ↑                                    ↓
            事件卡记录 ←──────── 日常实战 ────────→ 破功修订
```

## 功能模块

| 模块 | 说明 |
|---|---|
| **AI 辩论房** | 回合制 4–8 轮，SSE 流式；AI 兼辩手与观察者；观察只在结束后给 |
| **弱点墙** | 四区：AI 候选 / 观察中 / 改善中 / 暂存；便签视觉区分状态 |
| **回环** | 弱点的 SOP。对话式或表单启动；撑住率 = 近 30 天撑住 / 触发 |
| **事件卡** | 一句话记录实战；支持完整模式与极简模式 |
| **优势库** | AI 观察自动入库 → 待确认 → 确认；移除留痕，不重复入库 |
| **原则库** | 撑住率达标生成候选；可关联多回环；忽略留痕 |
| **状态栏** | 首页四块：日期+精力+连续天数 / 今天练什么 / AI 昨天观察到 / 两个入口 |
| **垃圾桶** | 弱点 60 天倒计时；优势/原则可恢复；观察候选不恢复 |

---

## 技术栈

**前端**：React 18 + Vite + TypeScript + Tailwind CSS 3.4 + Zustand + React Router + PWA + SSE
**后端**：Python 3.12 + FastAPI + Uvicorn + SQLAlchemy 2.0 (async) + SQLite(WAL) + APScheduler
**AI**：DeepSeek（辩论，深度推理）+ MiMo（复盘/辩题/扫描，结构化短输出）
**部署**：阿里云 2C2G + Nginx + systemd

## 目录结构

```
.
├── app/                    # 后端
│   ├── main.py             # FastAPI 入口
│   ├── config.py           # 全部配置走环境变量
│   ├── db.py               # SQLite + WAL，PRAGMA 按方案配置
│   ├── models.py           # 16 张表
│   ├── security.py         # bcrypt + JWT
│   ├── deps.py             # httpOnly Cookie 认证
│   ├── utils.py            # 时区、撑住率、邀请码
│   ├── ai/                 # AI 可插拔层
│   │   ├── base.py         #   Provider 协议
│   │   ├── providers.py    #   DeepSeek / MiMo（OpenAI 兼容）
│   │   ├── mock.py         #   Mock：无 Key 也能跑通全链路
│   │   ├── prompts.py      #   ★ 缓存前缀组装（顺序不可变）
│   │   └── router.py       #   ★ 路由决策表 + JSON 解析
│   ├── services/           # 业务逻辑
│   │   ├── loops.py        #   ★ 撑住率、演练日志、降级判定
│   │   ├── status.py       #   状态栏与连续天数
│   │   ├── debate.py       #   辩论房编排
│   │   ├── observations.py #   ★ 24 小时从「首次看到」算
│   │   ├── event_cards.py  #   事件卡匹配与扫描
│   │   └── scheduler.py    #   夜间定时任务
│   └── api/                # 路由层
├── web/                    # 前端（React + Vite）
│   └── src/styles/tokens.css   # ★ 配色方案的全部 CSS 变量
├── deploy/                 # 部署
│   ├── DEPLOY.md           #   完整部署手册
│   ├── nginx.conf          #   ★ SSE 必须关 proxy_buffering
│   └── duijing.service     #   systemd + MemoryMax
├── docs/
│   ├── API.md              # ★ 前后端契约（改字段先改这里）
│   ├── 新方案.txt           #   产品方案
│   └── 配色方案.txt         #   设计规范
└── tests/                  # 测试
```

标 ★ 的文件集中了系统里最容易写错、且写错后会静默损害用户数据的逻辑，
改动前请先读文件头的注释。

---

## 快速开始

### 1. 后端

```bash
python3.12 -m venv venv
./venv/bin/pip install -r requirements.txt

cp .env.example .env
# 开发环境可以完全不填 Key，AI_PROVIDER=mock 就能跑通全链路

./venv/bin/uvicorn app.main:app --reload --port 3000
```

打开 http://127.0.0.1:3000/docs 看自动生成的 Swagger 文档。

### 2. 前端

```bash
cd web
npm install
npm run dev        # http://localhost:5173，/api 已代理到 3000
```

### 3. 首个用户

**第一个注册的账号自动成为管理员，不需要邀请码。**
之后所有人必须凭邀请码注册——邀请码在「资产 → 设置」里查看。

### 4. 测试

```bash
./venv/bin/pip install -r requirements-dev.txt
./venv/bin/python -m pytest
```

测试全程使用 Mock Provider，不联网、不花钱。

---

## 配置 AI

默认 `AI_PROVIDER=mock`：**不联网、不需要 Key，全链路可以完整跑通和演示**，
AI 内容由规则生成，结构化任务同样输出合法 JSON，因此业务代码走的是同一条路径。

接入真实模型只改环境变量：

```bash
AI_PROVIDER=hybrid              # 按方案 5.3 分流（推荐）
DEEPSEEK_API_KEY=sk-xxx         # 辩论房
MIMO_API_KEY=xxx                # 复盘 / 辩题 / 扫描 / 回环对话
```

| Provider | 行为 |
|---|---|
| `mock` | 全部走 Mock |
| `deepseek` | 全部走 DeepSeek |
| `mimo` | 全部走 MiMo |
| `hybrid` | 辩论房走 DeepSeek，其余走 MiMo |

> Key 没配或调用失败时**自动降级到 Mock 并打警告日志**，
> 不会让用户看到 500。降级状态可在 `GET /api/health` 的 `ai.degraded` 看到。

### 成本控制

Prompt 按「固定系统 Prompt → 弱点库摘要 → 优势库摘要 → 回环描述 → 可变内容」分层，
前四块在同一场辩论内**逐字节稳定**，从而命中缓存前缀。
弱点库摘要按 ID 排序——这是硬性要求，任何排序不稳定都会让缓存命中率归零。

---

## 开发约束

以下 10 条来自产品方案第九章，是**不可协商**的。改代码前请确认没有违反：

1. **不新增模块** —— 功能必须在既有模块清单内
2. **不改 AI 路由规则** —— 辩论房走 DeepSeek，其余走 MiMo
3. **缓存前缀必须从第一个字符开始一致** —— 弱点库摘要按 ID 排序
4. **弱点数据默认私密** —— 任何分享都是用户主动动作
5. **AI 观察每场最多 1 优势 + 1 弱点 + 1 替代动作** —— 不许多给
6. **状态栏只做轻操作** —— 不能写日记、建原则、开辩论
7. **所有经验变动必须写 loop_log** —— 不直接改弱点状态
8. **回环降级必须用户确认** —— 绝不自动降级
9. **AI 观察候选 24 小时** —— 从首次看到算，不是从生成算
10. **通知默认关闭** —— 唯一例外是用户主动预约的辩论提醒

这些约束都有对应的测试用例（`tests/test_core_rules.py`、`tests/test_ai_layer.py`）。

---

## 数据库

SQLite + WAL，PRAGMA 按方案 4.4：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA cache_size   = -8000;
PRAGMA busy_timeout = 5000;
```

共 16 张表。方案文档列了 14 张（其中 `archive` 对应这里的 `archive_record`），
另有 2 张是实现必需但文档未列的：

| 表 | 为什么必须有 |
|---|---|
| `debate_participant` | 多人辩论最多 4 人，且被邀请者看不到发起人数据——没有关系表无法做权限判定 |
| `debate_review` | 复盘卡片不持久化的话，刷新页面即丢失 |

另有 2 处列级补充：`ai_observation.first_seen_at`（24 小时从首次看到算，规则要求此列）、
`debate_message.abandoned`（「这轮我放弃」需与普通发言区分，不能靠内容匹配）。

---

## 部署

见 [`deploy/DEPLOY.md`](deploy/DEPLOY.md)。

**上线前必做**：开 2G Swap（否则构建和 AI 峰值会被 OOM Killer 干掉）、
设 `COOKIE_SECURE=true`、`CORS_ORIGINS` 填真实域名、`JWT_SECRET` 用随机值。
