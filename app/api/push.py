"""对镜 · 推送订阅 API

只负责「浏览器订阅」这一层。辩论提醒的预约入口在 /api/debates/{id}/reminder，
因为那是辩论房的一部分，权限校验也复用那边的一套。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models import User
from app.services import push as push_service

logger = logging.getLogger("duijing.api.push")

router = APIRouter(prefix="/api/push", tags=["推送"])


class SubscribePayload(BaseModel):
    endpoint: str = Field(..., max_length=2000)
    keys: dict = Field(...)


class UnsubscribePayload(BaseModel):
    endpoint: str = Field(..., max_length=2000)


@router.get("/config")
async def push_config():
    """前端初始化推送需要的信息。

    不需要登录：前端要在用户登录前就知道「这台设备支不支持推送」，
    以便决定设置页里显示开关还是提示文案。
    """
    public = push_service.public_key()
    return {
        "available": public is not None,
        "public_key": public,
        "presets": [
            {"key": key, "label": label}
            for key, label in push_service.REMINDER_PRESETS.items()
        ],
    }


@router.get("/status")
async def push_status(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    count = await push_service.device_count(session, user.id)
    return {
        "available": push_service.public_key() is not None,
        "subscribed": count > 0,
        "device_count": count,
    }


@router.post("/subscribe")
async def subscribe(
    payload: SubscribePayload,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """保存浏览器推送订阅。

    前端在拿到用户授权后调用。密钥缺失说明浏览器给的订阅信息不完整——
    这种情况直接报错，而不是存一条注定推送失败的记录。
    """
    p256dh = (payload.keys or {}).get("p256dh")
    auth = (payload.keys or {}).get("auth")
    if not p256dh or not auth:
        raise HTTPException(status_code=400, detail="推送订阅信息不完整")

    if not payload.endpoint.startswith("https://"):
        raise HTTPException(status_code=400, detail="推送 endpoint 必须是 https 地址")

    await push_service.save_subscription(
        session,
        user_id=user.id,
        endpoint=payload.endpoint,
        p256dh=p256dh,
        auth=auth,
        user_agent=request.headers.get("user-agent", ""),
    )
    await session.commit()

    count = await push_service.device_count(session, user.id)
    return {"ok": True, "device_count": count}


@router.post("/unsubscribe")
async def unsubscribe(
    payload: UnsubscribePayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    removed = await push_service.remove_subscription(
        session, user_id=user.id, endpoint=payload.endpoint
    )
    await session.commit()
    return {"ok": True, "removed": removed}


@router.post("/test")
async def send_test(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """给自己发一条测试推送。

    存在的意义：Web Push 的失败大多发生在「用户以为开了、其实没开」的时候，
    而它在浏览器里几乎是静默的。给一个能立刻验证的入口，
    比让用户猜「为什么到点没提醒」要好。
    """
    delivered = await push_service.send_to_user(
        session,
        user_id=user.id,
        payload={
            "title": "对镜",
            "body": "通知已经通了。到点我会来叫你。",
            "url": "/debates",
            "tag": "duijing-test",
        },
    )
    await session.commit()

    if delivered == 0:
        raise HTTPException(
            status_code=409,
            detail="没有可用的推送设备。请确认浏览器已允许通知，且已把对镜添加到主屏幕。",
        )
    return {"ok": True, "delivered": delivered}
