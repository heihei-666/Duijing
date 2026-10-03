# syntax=docker/dockerfile:1
#
# 对镜 · 生产镜像
#
# 两个阶段：先用 Node 构建前端产物，再把产物与后端一起塞进 python-slim。
# 这样运行镜像里没有 node_modules，也没有构建工具链。
#
# 【为什么有这个文件】
# 1. 容器化本身有价值：CI 里能验证镜像可构建，换任何主机都能一致地跑起来。
# 2. 国内直连 duijing.xyz 会在 TLS 的 SNI 阶段被重置（域名未备案，实测确认），
#    **没有梯子的面试官打不开**；套一层境外托管（如 HuggingFace Spaces）最省事，
#    而 Spaces 需要的就是这个 Dockerfile。
#
# 【一个需要说清的历史（别再被 README 顶部的 frontmatter 误导）】
# README 顶部那段 `sdk: docker` 的 frontmatter **不是给对镜准备的**，
# 它是从青屿日记继承来的：分界前那次「整体重写为对镜」(`81becfd`) 时
# README 被重写，但 frontmatter 原样留着（当时 title 还是「青屿日记 / 🌊」，
# 到 `535374c` 才改成「对镜 / 🪞」）。
# **真正用 HuggingFace Spaces 的是青屿日记** —— 它的独立仓库里
# `hf` 远端指向 `spaces/heihei-666/qingyu-diary`，也专门有一次提交
# `40e8ed6 添加 HF Spaces Docker YAML 元数据`。**对镜从来没有 Space，也没有 hf 远端。**
# 所以：这段 frontmatter 对现在的对镜而言只是「如果将来要建 Space 的话正好用得上」，
# 而不是「一个没兑现的声明」。要建就建一个**新的** Space，别去动青屿那个。

# ─────────────────────────────────────────────────────────────
# 阶段 1：构建前端
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS web

WORKDIR /web

# 先只复制清单，让 npm ci 这一层能被缓存住
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
# build 脚本本身就是 `tsc --noEmit && vite build`，类型不过就不会出产物
RUN npm run build


# ─────────────────────────────────────────────────────────────
# 阶段 2：运行时
# ─────────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# curl 用于 HEALTHCHECK；tzdata 走 requirements（slim 镜像没有 /usr/share/zoneinfo）
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app/ ./app/
# app/main.py 从 <项目根>/web/dist 找前端产物，所以路径必须是 /app/web/dist
COPY --from=web /web/dist ./web/dist

# 非 root 运行。uid 固定 1000 是为了对齐 HuggingFace Spaces 的运行用户。
RUN useradd -r -u 1000 -m app \
    && mkdir -p /app/data \
    && chown -R app:app /app
USER app

# 默认值面向 HuggingFace Spaces（它只认 7860）。
# 自己部署时用 -e PORT=3000 覆盖即可。
ENV PORT=7860 \
    DB_PATH=/app/data/duijing.db \
    AI_PROVIDER=mock \
    ENABLE_SCHEDULER=true \
    COOKIE_SECURE=false

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

# 单 worker：SQLite + 进程内调度器 + 内存限流器都假设只有一个进程。
# 加 worker 会让定时任务重复执行、限流失效。
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1 --proxy-headers"]
