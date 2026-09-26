# 对镜 · Phase 1–2 验收清单

> 对应《新方案》第八章排期的 Phase 1（地基）与 Phase 2（核心引擎）。
> 每条都可以实际执行验证，不是「已完成」的自我声明。

---

## 一、怎么跑起来

```bash
# 后端
python3.12 -m venv venv
./venv/bin/pip install -r requirements.txt
cp .env.example .env          # 开发环境不用填任何 Key
./venv/bin/uvicorn app.main:app --reload --port 3000

# 前端（另开一个终端）
cd web && npm install && npm run dev     # http://localhost:5173
```

打开 http://127.0.0.1:3000/docs 可以看到全部 50 个接口的 Swagger 文档。

---

## 二、Phase 1 验收项

### 1. 项目脚手架

| 项 | 怎么验 | 期望 |
|---|---|---|
| 后端可启动 | 执行上面的 uvicorn 命令 | 日志出现「对镜 v1.0.0 启动完成」与「定时任务已启动」 |
| 前端可启动 | `npm run dev` | 5173 端口可访问，`/api` 自动代理到 3000 |
| 数据库自动建表 | 首次启动后看 `data/duijing.db` | 文件存在，含 16 张表 |
| WAL 生效 | `sqlite3 data/duijing.db "PRAGMA journal_mode;"` | 返回 `wal` |
| 健康检查 | `curl localhost:3000/api/health` | `status: ok`，`ai.mode: mock`，`ai.degraded: false` |

### 2. 用户认证

| 项 | 怎么验 | 期望 |
|---|---|---|
| 首个用户免邀请码 | 全新数据库下注册第一个账号 | 成功，响应 `is_first_user: true` |
| 之后必须凭邀请码 | 再注册一个账号，不带 `invite_code` | `400 需要邀请码才能注册` |
| 错误邀请码被拒 | 带一个乱码邀请码 | `400 邀请码无效` |
| 正确邀请码通过 | 用第一个账号的邀请码 | 成功创建 |
| 邀请计数 | 第一个账号 `GET /api/auth/invite` | `used_count` 反映已邀请人数 |
| 邀请码重置 | `POST /api/auth/invite/rotate` | 返回新码，旧码立即失效 |
| httpOnly Cookie | 登录后看浏览器 Cookie | 有 `dj_token`，`HttpOnly` 打勾，JS 读不到 |
| 登录失败锁定 | 同一 IP 连续输错 5 次密码 | 第 6 次返回 429 并提示等待 |
| 账号枚举防护 | 用不存在的用户名登录 | 与密码错误返回**同样**的「用户名或密码错误」 |
| 未登录被拦 | 无 Cookie 访问 `/api/status-bar` | `401 未登录` |

### 3. 基础 UI 框架

| 项 | 怎么验 | 期望 |
|---|---|---|
| 4 Tab 导航 | 登录后看底部 | 首页 / 辩论 / 弱点 / 资产 |
| 未登录重定向 | 退出登录后访问 `/weaknesses` | 跳到 `/login?from=...`，登录后回到原页 |
| 配色令牌 | 看页面底色 | 暖灰 `#F7F6F3`，不是纯白 |
| 状态栏只有两个彩色元素 | 看首页 | 只有连续天数火苗色 + 辩论按钮，其余中性色 |
| 精力可跳过 | 不填精力看首页 | 不显示精力数字（不是显示 0） |

---

## 三、Phase 2 验收项

### 1. AI 路由层与缓存前缀

| 项 | 怎么验 | 期望 |
|---|---|---|
| Mock 全链路可跑 | 不填任何 Key 走完一场辩论 | 开场、发言、回复、复盘全部有输出 |
| 路由规则正确 | `pytest tests/test_ai_layer.py -k Routing` | 辩论房 → DeepSeek，其余 → MiMo |
| 缺 Key 自动降级 | 设 `AI_PROVIDER=hybrid` 但清空 Key | `/api/health` 的 `ai.degraded: true`，接口仍正常返回 |
| 缓存前缀稳定 | `pytest -k CachePrefix` | 同输入两次拼接结果逐字节相同 |
| 弱点摘要按 ID 排序 | `pytest -k sorted_by_id` | 打乱输入顺序，输出不变 |

### 2. 辩论房

| 项 | 怎么验 | 期望 |
|---|---|---|
| 新建辩论 | `POST /api/debates` 只传 `topic` | 返回房间 + AI 开场白 |
| 回合数 4–8 | 看响应的 `max_rounds` | 落在 4–8 之间 |
| **SSE 逐字输出** | 发言后观察前端 | AI 回复**一个字一个字出现**，不是卡几秒后整段蹦出 |
| 每轮 300 字上限 | 发一条超过 300 字的发言 | `400 每轮发言不超过 300 字` |
| 这轮我放弃 | 点「这轮我放弃」 | AI 简短回应；该信号计入观察，**不计入**弱点触发次数 |
| 暂停/继续 | 点暂停后再发言 | `409`，恢复后可继续 |
| 结束并复盘 | 点「结束并复盘」 | 返回复盘卡片 |
| 多人邀请 | 发起人点邀请 | 返回 `invite_token` 与链接；最多 4 人 |
| 受邀者看不到发起人数据 | 用受邀账号打开同一房间 | 响应中**没有** `loop_id` / `weakness_id` / `review` |
| 断线续传 | `GET /api/debates/{id}/stream` 中断后重连 | 用 `after_seq` 不会重复推送已落库消息 |
| 连接不泄漏 | 中途离开页面 | 服务端日志无持续输出，前端 `EventSource` 已 close |

### 3. 复盘卡片与 AI 观察

| 项 | 怎么验 | 期望 |
|---|---|---|
| 三块内容 | 看复盘卡片 | 做得好 / 值得注意 / 如果再来一次，三块三色 |
| **观察数量上限** | 连做几场辩论 | 每场最多 1 优势 + 1 弱点，绝不多给 |
| 观察不在辩论中打断 | 辩论过程中看界面 | 全程没有任何观察或评价出现 |
| 记录太少不给观察 | 只说一句话就结束 | 复盘仍生成，但**不产出**观察（不编造） |
| 加入观察 | 点「加入」 | 弱点 → 建卡进「观察中」；优势 → 入库标记「待确认」 |
| 关闭本轮观察 | 点「关闭本轮观察」 | 本场观察全部作废，不再出现在首页 |
| **24 小时从首次看到算** | 生成观察后先不打开首页，等一会儿再打开 | 只有打开首页那一刻 `first_seen_at` 才被写入，`expires_at` = 它 + 24h |
| 首页最多 1 条 | 看首页 AI 观察块 | 最多显示 1 条 |

---

## 四、测试套件

```bash
./venv/bin/pip install -r requirements-dev.txt
./venv/bin/python -m pytest -v
```

**当前结果：77 passed**（全程 Mock，不联网、不花钱）。

覆盖的关键约束：

| 测试类 | 锁住的规则 |
|---|---|
| `TestLoopLogIsSourceOfTruth` | 所有经验变动必须写 loop_log；未触发不进分母；破功 → 待修订 |
| `TestNoAutoDowngrade` | 降级只提示不执行；PATCH 不能绕过归档接口 |
| `TestPrivacy` | 弱点数据默认私密，他人读不到 |
| `TestObservations` | 观察数量上限、24 小时从首次看到算 |
| `TestAdvantages` | 待确认不自动确认；移除后不重复入库 |
| `TestPrinciples` | 一条原则可关联多回环；忽略留痕 |
| `TestStatusBar` | 连续天数口径；精力可跳过；今天练什么最多 2 条；**破功的回环仍显示** |
| `TestCachePrefix` | 前缀逐字节稳定、按 ID 排序 |
| `TestRouting` | 路由决策表不可更改 |
| `TestRateLimiter` | 限流与登录锁定（API 测试放宽了阈值，这里单独守住） |
| `TestDebateEntry` | 只给 scene 也要能生成辩题；`status` 与 `status_filter` 等价 |
| `TestDebateMultiUser` | 受邀者看不到发起人的弱点/回环/观察；外人 403；暂停后禁止发言 |
| `TestLoopListing` | 全局回环列表（消除 N+1）；按弱点与状态筛选；跨用户隔离 |

---

## 五、开发过程中发现并修复的真实缺陷

这几条值得单独看——它们都是**测试或冒烟跑出来的**，不是评审看出来的：

| # | 缺陷 | 危害 | 修法 |
|---|---|---|---|
| 1 | SQLite 读回的 datetime 是 naive，与 aware 的 `now_utc()` 比较抛 `TypeError` | 「AI 观察列表」在 `expires_at` 首次被写入后**必然 500**。危险在于条件触发：在此之前所有测试都是绿的 | 新增 `UTCDateTime` 类型，在类型层保证读写都是 UTC，29 个时间列全部改用它 |
| 2 | Cookie 与 Bearer 同时存在时 Cookie 抢先 | 调用方明确传了 A 的身份，服务端却按 B 处理 —— 多账号场景直接越权读写 | `extract_token` 改为显式凭证优先 |
| 3 | 归档/恢复接口返回的 `drill_count` 恒为 0 | 接口在说谎：数据没丢，但前端拿到的统计字段是错的 | 统一走 `weakness_payload()` 组装，杜绝漏传统计参数 |
| 4 | 破功后回环进入 `needs_revision`，就从「今天练什么」消失 | 破功恰恰是最该被看见的时刻，首页却告诉用户「没什么可练的」 | 首页纳入 `needs_revision`；暂停的仍然排除 |
| 5 | 容器缺系统 tzdata，`ZoneInfo("Asia/Shanghai")` 直接抛异常 | 服务在 slim 镜像/容器里根本起不来 | 依赖中加入 PyPI `tzdata` 作为兜底 |
| 6 | 列表接口的参数名不一致：契约与前端用 `status`，后端读 `status_filter` | 筛选**静默失效**——不报错，只是返回全部数据，页面上极难发现 | 后端两种参数名都接受；契约写入 14.1 节 |
| 7 | 后端生成的邀请链接是 `/debate/join/{token}`，前端只有注册用的 `/join/:code` | 邀请链接点开直接 404，**整条多人辩论链路是断的** | 新增 `/debate/join/:token` 路由与落地页 |
| 8 | 只传 `scene` 时后端返回 400，而契约说「topic 可空，由 AI 生成」 | 用户最自然的输入方式（「今天开会我又被怼了」）被挡回去 | 请求体新增 `scene` 字段并接入辩题生成优先级 |
| 9 | `client.ts` 里 20 多处返回类型与后端实际结构不符（少了一层信封） | 运行时靠适配层绕开了，但错类型会持续误导后续开发 | 由专项任务统一修正（见下表） |
| 10 | 原则库关联回环缺全局列表接口，前端只能拉弱点再逐个拉详情 | 20 个弱点 = 21 次请求，实打实的 N+1 | 新增 `GET /api/loops`，一次拿到全部回环含所属弱点名 |

---

## 六、与方案文档的偏差（需你确认）

这些是我在实现中**主动做的决定**，方案文档没写或写得有歧义：

| # | 偏差 | 理由 |
|---|---|---|
| 1 | 新增 2 张表：`debate_participant`、`debate_review` | 文档列了 14 张（其 `archive` 对应实现里的 `archive_record`），但多人辩论的权限判定与复盘卡片持久化缺表。已在 README 中标注 `[新增]` |
| 2 | 新增 2 个列：`ai_observation.first_seen_at`、`debate_message.abandoned` | 前者是「24 小时从首次看到算」这条规则本身要求的；后者用于区分「放弃本轮」与普通发言，靠内容匹配太脆弱 |
| 3 | 回合数用确定性启发式而非问模型 | 方案说「AI 根据辩题复杂度决定」。启发式保证 Mock 与真实模型行为一致，且不会因模型偶发输出非法轮次而破坏房间状态。接真实模型后可改为在辩题生成时一并询问，接口不变 |
| 4 | 事件卡极简模式：保存时做零成本本地匹配，AI 判定进夜间队列 | 方案 3.4 说「保存后 AI 自动判断」，5.4 说「不实时扫描，进队列」。两者兼顾：立刻给关联建议，判定错峰 |
| 5 | 辩论房结论 → 原则候选，用的是复盘卡片的「如果再来一次」 | 方案 3.6 把「辩论房结论」列为原则来源但没定义「结论」是哪个字段 |
| 6 | `advantage.status` 增加 `removed`、`principle.status` 增加 `ignored` | 「移除后不再重复入库」「忽略留痕」都需要状态位，否则做不到 |
| 7 | 应用图标为程序生成的「镜」图形 | 方案未提供图标资源；已按配色方案的 `--primary` 生成 4 个尺寸的 PNG |

---

## 七、Phase 1–2 未包含的内容（后续阶段）

- Phase 3：弱点墙的黑板拖拽（Web 端）、对话式回环的完整打磨
- Phase 4：事件卡扫描的夜间批处理调优、优势/原则库的完整交互
- Phase 5：垃圾桶 UI、通知策略（方案 3.9 默认关闭）、PWA 安装引导
- Phase 6：阿里云实际部署（配置已就绪，见 `deploy/DEPLOY.md`）
- 深色模式（方案明确标 P1 后置）
- 真实 AI 联调（当前为 Mock，填入 Key 并设 `AI_PROVIDER=hybrid` 即可切换）

---

## 八、已知问题与后续待办

### 8.1 前端类型声明仍不完整（不阻塞运行，但会误导后续开发）

`src/api/types.ts` 已修正 25 处主要错误，但仍有以下**次级不符**未处理。
它们当前**不影响运行**——`features/debate/api.ts`、`features/weakness/api.ts`、
`features/assets/api.ts` 三个适配层绕过了 `client.ts` 的类型化方法，
直接走 `apiRequest` 并自带正确类型。但**新写的代码若直接使用 `client.ts`，会被这些类型误导**。

| # | 位置 | 问题 |
|---|---|---|
| 1 | `weaknessApi.get` | 声明 `WeaknessCard & {loops}`，实为 `{weakness, loops, suggest_downgrade, suggest_archive}` |
| 2 | `eventCardApi.analyze` | 声明含 `updated_cards`，该字段不存在；实为 `cards_analyzed` / `pending_confirm` |
| 3 | `WeaknessCard` | `loop_count` 是幽灵字段（后端从不返回）；缺 `drill_count`、`days_until_delete` |
| 4 | `AdvantageStatus` | 缺 `'removed'` |
| 5 | `PrincipleStatus` | 缺 `'ignored'` |
| 6 | `ReviewCard` | 缺 `observations_dismissed` |
| 7 | `DebateRoom` | 缺 `weakness_name` |
| 8 | `LoopLogCreateResponse` | 缺 `hold_rate_30d` / `trigger_count_30d` / `loop_status` / `reason` / `hint` / `needs_revision` |
| 9 | `LoopLogListResponse` | 缺 `hold_rate_30d` / `trigger_count_30d` / `hold_count_30d` |
| 10 | `LoopDialogQuestionResponse` | 缺对话式前两步的 `trigger_scene` / `body_signal` |
| 11 | `DebateFinishResponse` | 缺 `principle_candidate`（幂等分支还有 `already_generated`） |
| 12 | `LoopLog.note` | 声明 `string \| null`，实际恒为字符串 |
| 13 | `EventCard` | 缺 `linked_loop_ids` |
| 14 | 4 个列表响应 | 缺聚合字段（`total` / `pending_count` / `candidate_count` / `records` / `rules`）——只是不完整，不是错误 |
| 15 | 两个适配层头注释 | 已过时（`features/debate/api.ts` 第 1、4 条与 `features/weakness/api.ts` 第 1 条）——注释问题，非代码问题 |

**建议**：与「把三个适配层合并回 `client.ts` / `types.ts`」合并成一个任务一起做，
否则改两次。

### 8.2 功能遗留（按模块）

| 模块 | 遗留项 |
|---|---|
| 辩论房 | 辩题来源 P1/P2（从弱点回环、事件卡场景生成辩题）未接——后端已支持 `loop_id`/`weakness_id`/`source_id` |
| 辩论房 | 多人辩论缺「被邀请者进房后的昵称区分」之外的参与者管理（当前只展示人数） |
| 原则库 | 「关联回环」目前靠逐个拉弱点详情拼数据（最多 20 个弱点）。后端已补 `GET /api/loops`，前端尚未切过去 |
| 垃圾桶 | 只做了弱点恢复；优势 `removed` 与原则 `ignored` 的恢复入口未做（服务端 `/restore` 已就绪） |
| 回环 | 表单式新建未做「引用优势/原则」多选（payload 的 `linked_advantage_ids` / `linked_principle_ids` 已支持） |
| 事件卡 | 历史列表只取最近 50 张，未分页（服务端支持 `limit` / `offset`） |
| 弱点墙 | 分区折叠状态不持久化，刷新回默认 |
| 弱点 | 无「删除弱点」——只有归档（与方案 3.8 一致，属于设计而非缺陷） |
| 全局 | 深色模式（方案明确标 P1 后置）；ESLint / Prettier 未配置 |
| 部署 | 阿里云实际部署（配置已就绪，见 `deploy/DEPLOY.md`） |
| AI | 真实 Key 联调。当前全程 Mock，填 Key 并设 `AI_PROVIDER=hybrid` 即切换 |

### 8.3 环境注意

本开发容器有两个坑，**换到正常机器都不会出现**，但会让人误判：

1. **`os.cpus().length === 0`** —— 会让 workbox 的 terser worker 池为 0，
   前端构建卡死在生成 Service Worker 那一步。`web/vite.config.ts` 已自动降级
   （仅 SW 不压缩，体积 +2KB，缓存行为一致）。不要删掉那段判断。
2. **缺系统 tzdata** —— `zoneinfo.ZoneInfo("Asia/Shanghai")` 直接抛异常，服务起不来。
   已在 `requirements.txt` 加入 PyPI `tzdata` 兜底；正常 Ubuntu 上不会用到。

3. `/sdcard` 是 Android FUSE 文件系统：在本目录下直接 `npm install` 极慢，
   且 `chmod` 不生效（不支持 UNIX 权限位）。前端构建建议在原生文件系统上做。

---

## 九、真实模型联调记录

Mock 能验证业务逻辑，但**验证不了 Prompt 与模型的契合度**。接入真实 Key 后跑了一轮，
发现 4 个 Mock 永远测不出的问题。这一节记录它们，避免以后重蹈。

**实测环境**：`AI_PROVIDER=hybrid`，DeepSeek `deepseek-flash` + MiMo `mimo-v2.6-flash`。
两个模型名都经过 `/v1/models` 接口核实存在。

### 9.1 发现并修复的问题

| # | 问题 | 现象 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | **思考模式吃光 token 预算** | 复盘卡片返回空文本，却消耗了 700 输出 token；HTTP 200、无异常 | 两个模型**都默认开启思考模式**且 effort=high，`reasoning_content` 与 `content` **共用同一个 max_tokens 预算** | 结构化短输出任务全部 `thinking:{type:disabled}`；只有辩论房保留思考 |
| 2 | **顶层 `enable_thinking:false` 无效** | 以为关了思考，实测推理照常进行 | 该参数不被识别，官方开关是 `thinking.type` | 改用官方参数；已加测试断言不能写成 `enable_thinking` |
| 3 | **辩论人格污染复盘调用** | 复盘接口返回一段**辩词**，JSON 永远解析失败 | `build_stable_system()` 里含「你是辩论对手」的固定 Prompt，被我一起传给了复盘，模型在两条冲突的 system 消息里选了辩论 | 拆出 `build_context_blocks()`（只要用户档案，不含人格）；复盘合成单条 system |
| 4 | **用户发言被重复发送** | 同一句话在上下文里出现两次 | `history` 从库里取的全量消息**已包含**刚发的那条，`build_debate_messages` 又追加了一次 | 构造上下文前剔除重复的 latest |

另外顺手收紧了两处**「沉默造假」**（与 Mock 无关，但同类问题）：

- 复盘 JSON 解析失败时，原本会填入「你完整走完了这场辩论」这类通用鼓励语。
  这会让用户以为 AI 真的观察了他，而且假观察会一路污染弱点库。
  现在改为**显式报错 502**，前端提示重试。
- 辩论流为空时（实测遇到过一次「HTTP 200 但流是空的」瞬时故障），
  原本会存一句「（这一轮我没有更多要说的。）」。辩论文本是复盘与 AI 观察的唯一依据，
  造假会一路污染下去。现在改为发 `error` 事件且**不落库**。
- 同时移除了「真实模型失败就静默换成 Mock 内容」的兜底——
  那会把模拟观察当成 AI 的真实判断写进弱点库。

### 9.2 修复后的真实模型验证结果

完整跑通「注册 → 场景转辩题 → 两轮 SSE 辩论 → 复盘 → 观察入库 → 建回环 → 演练」：

```
② 辩题: 被当众追问进度，该当场回应还是事后补救  (5轮)     ← MiMo 生成
③ 第 1 轮：159 个流式块    第 2 轮：142 个流式块          ← DeepSeek 流式
④ 复盘卡片：
   做得好      : 能坚持立场并提出「错了就立刻纠正」的担当回应
   值得注意    : 面对具体场景追问时用「效率高就够了」回避，未接依赖方确认的场景
   替代动作    : 先给出具体第一句回答（如「X点前给准信」），再论证…
   观察 2 条（上限2）: [weakness] 场景回避  [advantage] 立场坚定
   原则候选    : 先正面回答场景问题，再论证当场回应的边界与条件
⑤ 弱点 #1 → 回环 #1 → hold/hold/break → 撑住率 67%，回环自动进入待修订 + 替代动作
⑥ 全程降级/错误计数 = 0     模型调用: deepseek 3 次, mimo 3 次
```

**能够佐证 Prompt 有效**的两点（不只是「跑通了」）：

- DeepSeek 抓到了用户在偷换问题，并明确指出：
  「你回答的是『发现错了该怎么办』，而不是『该不该当场下判断』」——
  这正是 `FIXED_SYSTEM_PROMPT` 里「论证结构：是否偷换概念」要求它观察的东西。
- MiMo 产出的观察是**具体的**（「场景回避」「立场坚定」），不是「你表现不错」这类废话。

### 9.3 成本实测

单次完整流程（1 场辩论 + 1 张复盘）实测用量：

| 项目 | 用量 | 说明 |
|---|---|---|
| DeepSeek 辩论 3 次调用 | 推理约 400-500 tok/次，正文约 250 tok/次 | 思考模式保留 |
| MiMo 结构化 3 次调用 | 推理 0 tok（已关闭），输出 185-700 tok | 关闭思考后不再浪费推理费 |

按方案 5.5 的单价估算，单场辩论成本约 **0.02–0.03 元**，与文档预估一致。

### 9.4 仍未验证的部分

- **弱网与超时**：容器网络出过 1 次 >120s 读取超时，已把 `AI_TIMEOUT_SECONDS` 放宽到 180。
  真实部署后的网络质量需要再观察。
- **多人辩论**：真实模型下只验证了单人流程，多人（最多 4 人）未做真实联调。
- **长对话**：只跑了 2 轮，未验证接近 8 轮上限时的上下文长度与成本。
- **定时任务**：事件卡夜间扫描、观察 24 小时过期等任务用 Mock 验证过逻辑，
  未等真实模型的夜间批次跑完。
