# 贡献指南

面向**要改这个仓库代码的人**。只想跑起来看看的话看 [README](README.md)。

---

## 开发环境

```bash
python3.12 -m venv venv
./venv/bin/pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env          # 不填任何 Key 也能跑，AI_PROVIDER=mock
./venv/bin/uvicorn app.main:app --reload --port 3000
```

前端：

```bash
cd web && npm install && npm run dev    # :5173，/api 已代理到 3000
```

## 测试

```bash
./venv/bin/python -m pytest
```

**全程使用 Mock Provider，不联网、不花钱。** 279 项测试。

## 提交钩子（每个克隆启用一次）

```bash
git config core.hooksPath .githooks
```

钩子会扫描暂存区，挡住 `.env`、疑似 API Key、运行时产物三类误提交。

---

## 标 ★ 的文件

系统里最容易写错、**且写错后会静默损害用户数据**的逻辑集中在这些文件里。
改动前请先读文件头的注释——那里通常记着「为什么不能按直觉写」：

```
app/ai/prompts.py           缓存前缀组装（顺序不可变）+ prompt 版本管理
app/ai/router.py            路由决策表 + JSON 解析（刻意不做 Mock 兜底）
app/ai/structured.py        结构化输出：schema 校验 + 失败重试一次
app/services/loops.py       撑住率、演练日志、降级判定
app/services/observations.py 24 小时从「首次看到」算
app/services/ai_metrics.py  调用用量/延迟/缓存命中/成本
app/services/ai_queue.py    真队列：认领 / 执行 / 重试 / 回收 / 积压可见
evals/checks.py             评测规则层
deploy/nginx.conf           SSE 必须关 proxy_buffering
docs/API.md                 前后端契约（改字段先改这里）
web/src/styles/tokens.css   配色方案的全部 CSS 变量
```

完整的目录树见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

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

## 改 AI 行为之前

**先跑一遍评测，别凭感觉改 prompt。**

```bash
python -m evals.run --mode rules                                     # 免费，秒级
REVIEW_PROMPT_VERSION=v1|v2|v2.1 python -m evals.run --mode judge     # 需要 Key
```

`evals/README.md` 里有完整的用法和一次真实的迭代记录——
包括**改动带来了什么代价**，那部分比收益更值得先看。

改了复盘 prompt 记得升版本号（`REVIEW_PROMPT_VERSION`），
否则 `ai_call_log` 里分不清哪条观察是哪个版本产的。
