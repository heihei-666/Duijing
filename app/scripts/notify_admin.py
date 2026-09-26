"""对镜 · 给管理员发一条推送

用法：
    python -m app.scripts.notify_admin "标题" "正文"

存在的意义：方案 7.7 要求四个指标超阈值时告警，但服务器上没有任何
发信通道（没配 SMTP，也没有短信）。而项目已经有一套现成的
Web Push 通路（预约辩论提醒用的），直接复用最省事——
管理员只要在设置里开过通知，就能收到。

发不出去也不报错退出：告警失败不能反过来影响被监控的服务。
"""

from __future__ import annotations

import asyncio
import sys

from sqlalchemy import select

from app.db import session_scope
from app.models import User
from app.services import push as push_service


async def notify(title: str, body: str, *, url: str = "/") -> int:
    sent = 0
    async with session_scope() as session:
        rows = await session.execute(select(User).where(User.is_admin.is_(True)))
        for admin in rows.scalars().all():
            sent += await push_service.send_to_user(
                session,
                user_id=admin.id,
                payload={"title": title, "body": body, "url": url, "tag": "duijing-alert"},
            )
    return sent


def main() -> int:
    if len(sys.argv) < 3:
        print("用法: python -m app.scripts.notify_admin <标题> <正文>", file=sys.stderr)
        return 2
    title, body = sys.argv[1], sys.argv[2]
    try:
        sent = asyncio.run(notify(title, body))
    except Exception as exc:  # noqa: BLE001 - 告警失败不能影响主流程
        print(f"告警发送异常: {exc}", file=sys.stderr)
        return 1
    print(f"已发送 {sent} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
