# 对镜

[![CI](https://github.com/heihei-666/Duijing/actions/workflows/ci.yml/badge.svg)](https://github.com/heihei-666/Duijing/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.12](https://img.shields.io/badge/Python-3.12-3776AB.svg)](https://www.python.org/)
[![React 18](https://img.shields.io/badge/React-18-61DAFB.svg)](https://react.dev/)

> 用 AI 辩论房照见自己，用弱点回环改善自己。

<!-- 截图：把图放进 docs/screenshots/ 后，取消下面的注释（建议 4 张：首页 / 辩论房 / 复盘卡片 / 弱点墙）
![对镜首页](docs/screenshots/01-home.png)
-->

## 这是什么

一个个人成长工作台。和其他「AI 聊天 + 打卡」类应用的区别在于它有一条**闭合的数据流**：

```text
AI 辩论房 → 观察弱点/优势 → 用户确认 → 建回环 → 演练 → 撑住率达标 → 原则沉淀
                ↑                                    ↓
            事件卡记录 ←──────── 日常实战 ────────→ 破功修订
```

**AI 不是主角，观察才是。** 你在辩论房里和 AI 就一个真实议题对辩，
AI 全程记录你的论证结构、情绪与防御、互动策略、语言习惯，
**但辩论过程中一个字都不说**——结束后才给一张复盘卡片和最多两条观察。
观察以「候选」身份进入弱点墙，**要你确认才算数**。

它解决的是「我知道自己有问题，但说不清是什么问题」——
把模糊的自我感觉，变成一条可跟踪、可演练、可验证的具体弱点。

## 功能

| 模块 | 说明 |
|---|---|
| **AI 辩论房** | 回合制 4–8 轮，SSE 流式；AI 兼辩手与观察者，观察只在结束后给 |
| **弱点墙** | 四区：AI 候选 / 观察中 / 改善中 / 暂存；便签视觉区分状态 |
| **回环** | 弱点的 SOP。对话式或表单启动；撑住率 = 近 30 天撑住 / 触发 |
| **事件卡** | 一句话记录实战；支持完整模式与极简模式 |
| **优势库** | AI 观察自动入库 → 待确认 → 确认；移除留痕，不重复入库 |
| **原则库** | 撑住率达标生成候选；可关联多回环；忽略留痕 |
| **状态栏** | 首页四块：日期+精力+连续天数 / 今天练什么 / AI 昨天观察到 / 两个入口 |
| **垃圾桶** | 弱点 60 天倒计时；优势/原则可恢复；观察候选不恢复 |

## 快速开始

**不需要任何 API Key。** `AI_PROVIDER=mock` 下全链路可完整跑通，
结构化任务照样输出合法 JSON，业务代码走的是同一条路径。

```bash
git clone https://gitee.com/heihei-666/dui-jing.git && cd dui-jing
python3.12 -m venv venv
./venv/bin/pip install -r requirements.txt
cp .env.example .env
./venv/bin/uvicorn app.main:app --reload --port 3000
```

打开 http://127.0.0.1:3000/docs 看 Swagger。
**第一个注册的账号自动成为管理员，不需要邀请码。**

前端（可选，后端已能独立运行）：

```bash
cd web && npm install && npm run dev    # :5173，/api 已代理到 3000
```

<details>
<summary>中文 Windows 用户注意</summary>

`pip install -r requirements.txt` 在**中文 Windows** 上曾经会直接报
`UnicodeDecodeError: 'gbk' codec can't decode ...`——原因是 pip < 25
读 requirements 文件时不先试 UTF-8，而是用系统 locale（cp936），而文件里有中文注释。

**现已修复**：两个 requirements 文件的第一行都加了 PEP 263 声明。
如果你用的是很老的 pip 且仍然报这个错，升级即可：`python -m pip install -U pip`。
`tests/test_portability.py` 会守住这条声明不被误删。

</details>

## 技术栈

**前端** React 18 + Vite + TypeScript + Tailwind CSS + Zustand + PWA + SSE
**后端** Python 3.12 + FastAPI + SQLAlchemy 2.0 (async) + SQLite(WAL) + APScheduler
**AI** DeepSeek（辩论，深度推理）+ MiMo（复盘/辩题/扫描，结构化短输出），可插拔
**部署** 阿里云 2C2G + Nginx + systemd，Docker 镜像已通过 CI 构建验证

## 文档

| 文档 | 内容 |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、测试、**10 条不可协商的开发约束**、哪些文件不能凭直觉改 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 核心闭环、目录结构、数据库（19 张表）、规模取舍 |
| [docs/CONFIG.md](docs/CONFIG.md) | AI Provider 配置、**失败不降级的设计理由**、成本控制 |
| [docs/SECURITY.md](docs/SECURITY.md) | 密钥三层防护、泄露应急 |
| [docs/API.md](docs/API.md) | 前后端契约（改字段先改这里） |
| [deploy/DEPLOY.md](deploy/DEPLOY.md) | 完整部署手册 |

## 部署

```bash
# Docker
docker build -t duijing .
docker run -p 3000:7860 -e PORT=7860 -e AI_PROVIDER=mock duijing
```

直接部署到服务器见 [deploy/DEPLOY.md](deploy/DEPLOY.md)。
**上线前必做**：开 2G Swap、设 `COOKIE_SECURE=true`、`CORS_ORIGINS` 填真实域名、
`JWT_SECRET` 用随机值。

> `duijing.xyz` 未备案，**国内直连会在 TLS 的 SNI 阶段被重置**
> （实测：钉住 IP 只改 SNI 就 `ECONNRESET`；换端口也绕不过，因为拦截看的是 SNI）。
> 要做给国内看的演示站就得放境外平台，并且**务必**
> `AI_PROVIDER=mock`（别把真实额度烧在公开站点上）+ 挂持久卷 + 放录屏截图。

## 评测集

`tests/` 测的是**管道**，`evals/` 测的是**模型输出质量**——
回答「改了 prompt，怎么知道是变好了还是变坏了」。两层结构：

| 层 | 跑什么 | 花钱 | 在哪跑 |
|---|---|---|---|
| **规则校验** | 观察上限、废话黑名单、长度、复盘块非空、是否落在对应层 | **免费** | **CI 每次提交** |
| **LLM-as-judge** | 具体性 / 有无依据 / 可执行性 / 是不是废话 | 几毛钱 | 手动 |

judge 用 DeepSeek 当裁判，被测的观察提取走 MiMo——**换源是为了避免同一个模型给自己打分**。

一套 30 条 golden set，prompt 迭代三版的实际结果：

| 指标 | v1 | v2 | **v2.1** | 总变化 |
|---|---|---|---|---|
| 具体性（5 分制） | 3.26 | 3.86 | **4.22** | **+29%** |
| 可执行性（5 分制） | 2.40 | 2.92 | **3.27** | **+36%** |
| 判为废话 | 13 条 | 6 条 | **2 条** | **−85%** |
| **跨用例重复的观察** | 3 类 | 2 类 | **0 类** | **套模板消失** |
| 成本 / 轮 | 0.069 元 | 0.085 元 | 0.090 元 | +29.5% |

最有价值的一条经验写在 `evals/README.md` 里：**v2 让三个质量分全涨了，
却让复盘卡片的「如果再来一次」变成空白栏——那个回归只有规则层抓得到。**
只看 judge 的分数会得出「v2 全面变好」，那是错的。

```bash
python -m evals.run --mode rules      # 免费，秒级
python -m evals.run --mode judge      # 需要 Key
```

## 工程化

| 项 | 状态 |
|---|---|
| CI | **5 个作业**：Ubuntu 后端测试 + **Windows 中文编码专项** + 前端类型检查/构建 + 镜像构建 + **评测集规则校验** |
| 测试 | **279 项**，全程 Mock，不联网不花钱 |
| 密钥防线 | `.gitignore` + `.githooks/pre-commit` + `tests/test_secrets_hygiene.py`（三层） |
| 可观测性 | 每次模型调用的 token / 缓存命中 / 成本 / 延迟落 `ai_call_log`；`GET /api/admin/ai-stats` |
| 任务队列 | 认领 / 执行 / 重试 / 回收，积压可见（不是「假队列」） |

> 为什么有 Windows 作业：有两个真实缺陷只在非 UTF-8 的 Windows 上出现
> （见 `tests/test_portability.py`），只在 Linux 跑测试永远发现不了。

## 许可

[MIT](LICENSE)
