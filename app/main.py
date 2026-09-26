"""对镜 · FastAPI 入口

开发：前端跑 Vite dev server（5173），通过 proxy 打到本服务的 3000 端口。
生产：Nginx 托管 web/dist，/api/ 反代到本服务（方案 7.5）。
若 web/dist 存在，本服务也会直接托管它，方便单机预览。
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api import (
    account,
    advantages,
    archive,
    auth,
    debates,
    event_cards,
    observations,
    principles,
    push,
)
from app.api import status_bar
from app.api import weaknesses
from app.ai.router import provider_status
from app.config import settings
from app.db import healthcheck, init_db
from app.services.metrics import snapshot as metrics_snapshot
from app.services.scheduler import shutdown_scheduler, start_scheduler

logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("duijing")

WEB_DIST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "dist")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    logger.info("%s v%s 启动完成（ENV=%s，AI=%s）", settings.APP_NAME, __version__, settings.ENV, settings.AI_PROVIDER)
    if settings.AI_PROVIDER == "mock":
        logger.info("AI 运行在 Mock 模式：全链路可用，内容为模拟生成。填入 API Key 并改 AI_PROVIDER 即可切换。")
    start_scheduler()
    try:
        yield
    finally:
        shutdown_scheduler()


app = FastAPI(
    title=f"{settings.APP_NAME} API",
    version=__version__,
    description="个人成长工作台：AI 辩论房、弱点墙、回环、事件卡、优势库、原则库。",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,  # httpOnly Cookie 必须开
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """统一 500，避免把堆栈泄露到前端。"""
    logger.exception("未处理异常 %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "服务器内部错误"})


# ── 路由 ──────────────────────────────────────────────────────

app.include_router(auth.router)
app.include_router(status_bar.router)
app.include_router(debates.router)
app.include_router(weaknesses.router)
app.include_router(weaknesses.loops_router)
app.include_router(event_cards.router)
app.include_router(advantages.router)
app.include_router(principles.router)
app.include_router(observations.router)
app.include_router(archive.router)
app.include_router(push.router)
app.include_router(account.router)


@app.get("/api/health", tags=["系统"])
async def health():
    """健康检查。生产监控探针打这个（方案 7.7）。"""
    db_ok = await healthcheck()
    return {
        "status": "ok" if db_ok else "degraded",
        # 方案 7.7 的四个监控指标里，只有 SSE 连接数需要应用内埋点，
        # 其余三个由 deploy/check-health.sh 从操作系统读取
        "metrics": metrics_snapshot(),
        "app": settings.APP_NAME,
        "version": __version__,
        "env": settings.ENV,
        "database": "ok" if db_ok else "unreachable",
        "ai": provider_status(),
    }


# ── 静态资源（可选） ──────────────────────────────────────────

if os.path.isdir(WEB_DIST):
    assets_dir = os.path.join(WEB_DIST, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """SPA 回退：非 /api 路径一律交给 index.html 处理前端路由。"""
        if full_path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": "接口不存在"})

        candidate = os.path.join(WEB_DIST, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(WEB_DIST, "index.html"))
