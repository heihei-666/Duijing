# 架构

## 核心闭环

```text
AI 辩论房 → 观察弱点/优势 → 用户确认 → 建回环 → 演练 → 撑住率达标 → 原则沉淀
                ↑                                    ↓
            事件卡记录 ←──────── 日常实战 ────────→ 破功修订
```

系统只做三件事：**帮用户发现弱点**（AI 辩论房 + 事件卡扫描）、
**帮用户改善弱点**（回环 + 演练 + 撑住率）、**帮用户沉淀经验**（优势库 + 原则库）。

设计上有一条贯穿始终的原则：**人在环中**。AI 只产出候选，
入库要用户确认；回环降级必须用户确认，绝不自动降级。

---

## 目录结构

```
.
├── app/                    # 后端
│   ├── main.py             # FastAPI 入口
│   ├── config.py           # 全部配置走环境变量
│   ├── db.py               # SQLite + WAL，PRAGMA 按方案配置
│   ├── models.py           # 19 张表
│   ├── security.py         # bcrypt + JWT
│   ├── deps.py             # httpOnly Cookie 认证
│   ├── utils.py            # 时区、撑住率、邀请码
│   ├── ai/                 # AI 可插拔层
│   │   ├── base.py         #   Provider 协议
│   │   ├── providers.py    #   DeepSeek / MiMo（OpenAI 兼容）
│   │   ├── structured.py   #   ★ 结构化输出：schema 校验 + 失败重试一次
│   │   ├── mock.py         #   Mock：无 Key 也能跑通全链路
│   │   ├── prompts.py      #   ★ 缓存前缀组装（顺序不可变）+ prompt 版本管理
│   │   └── router.py       #   ★ 路由决策表 + JSON 解析
│   ├── services/           # 业务逻辑
│   │   ├── loops.py        #   ★ 撑住率、演练日志、降级判定
│   │   ├── status.py       #   状态栏与连续天数
│   │   ├── debate.py       #   辩论房编排
│   │   ├── observations.py #   ★ 24 小时从「首次看到」算
│   │   ├── event_cards.py  #   事件卡匹配与扫描
│   │   ├── ai_metrics.py   #   ★ 调用用量/延迟/缓存命中/成本，落 ai_call_log
│   │   ├── ai_queue.py     #   ★ 真队列：认领 / 执行 / 重试 / 回收 / 积压可见
│   │   └── scheduler.py    #   夜间定时任务
│   └── api/                # 路由层（admin.py 提供 /api/admin/ai-stats）
├── web/                    # 前端（React + Vite）
│   └── src/styles/tokens.css   # ★ 配色方案的全部 CSS 变量
├── evals/                  # ★ 评测集（回答「改了 prompt 怎么知道变好了」）
│   ├── checks.py           #   规则层：确定性、免费、进 CI
│   ├── judge.py            #   LLM-as-judge：换源打分，可独立重跑
│   ├── run.py              #   运行器：走和生产一样的链路
│   └── golden/             #   golden set
├── deploy/                 # 部署
│   ├── DEPLOY.md           #   完整部署手册
│   ├── nginx.conf          #   ★ SSE 必须关 proxy_buffering
│   └── duijing.service     #   systemd + MemoryMax
├── docs/
│   ├── API.md              # ★ 前后端契约（改字段先改这里）
│   ├── 新方案.txt           #   产品方案
│   └── 配色方案.txt         #   设计规范
├── Dockerfile              # 两阶段构建（Node 产物 + python-slim）
├── .github/workflows/      # CI：5 个作业，含 Windows 中文编码专项与评测集
└── tests/                  # 279 项测试
```

标 ★ 的文件说明见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

---

## 数据库

SQLite + WAL，PRAGMA 按方案 4.4：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA cache_size   = -8000;
PRAGMA busy_timeout = 5000;
```

共 **19** 张表。方案文档列了 14 张（其中 `archive` 对应这里的 `archive_record`），
另有 5 张是实现必需但文档未列的：

| 表 | 为什么必须有 |
|---|---|
| `debate_participant` | 多人辩论最多 4 人，且被邀请者看不到发起人数据——没有关系表无法做权限判定 |
| `debate_review` | 复盘卡片不持久化的话，刷新页面即丢失 |
| `push_subscription` | 方案 3.9 唯一允许的主动触达（用户主动预约的辩论提醒）需要存 Web Push 订阅 |
| `debate_reminder` | 预约提醒本身要落库，否则重启即丢；也是幂等派发的依据 |
| `ai_call_log` | 每次模型调用的用量/延迟/缓存命中的观测记录，`/api/admin/ai-stats` 的数据源 |

另有 2 处列级补充：`ai_observation.first_seen_at`（24 小时从首次看到算，规则要求此列）、
`debate_message.abandoned`（「这轮我放弃」需与普通发言区分，不能靠内容匹配）。

### 轻量迁移，不用 Alembic

启动时 `_apply_light_migrations()` 只做 `ALTER TABLE ... ADD COLUMN`，
**不做索引、不做删除**。这是刻意的取舍：单人项目里，一个只加列的迁移器
比引入 Alembic 更不容易出事；代价是改列类型或删列必须手工处理。

> 实测验证过：对旧 schema 的库跑新代码，`attempts` / `started_at` 会被补上，
> 且原有数据完整保留。

### 规模取舍

SQLite 单写 + `uvicorn --workers 1`：队列、APScheduler、限流器都假定单进程。
用户量决定这个取舍是划算的（省掉一整套运维），
迁移路径是 Postgres + 把队列外置成独立进程。
