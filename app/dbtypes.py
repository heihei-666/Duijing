"""对镜 · 自定义字段类型

**为什么需要这个文件**

SQLite 没有原生时间类型，SQLAlchemy 的 `DateTime` 会把 aware datetime
按字面存成字符串，读回来时**丢掉时区信息**，变成 naive datetime。

于是就会出现这种崩法：

    obs.expires_at > now_utc()
    # TypeError: can't compare offset-naive and offset-aware datetimes

这类错误极其危险，因为它是**条件触发**的：只有当某个字段真的被写过值
（比如 expires_at 首次被设置）之后才会炸，在此之前所有测试都是绿的。

修法有两种：
  A. 在每个比较处手动补时区——散落各处，早晚漏一个
  B. 让类型层保证「写进去是 UTC，读出来带 UTC 时区」——只有一处

这里选 B。全库所有 datetime 列都用 UTCDateTime，业务代码可以放心地
直接和 `app.utils.now_utc()` 比较，不需要任何防御性代码。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime
from sqlalchemy.types import TypeDecorator


class UTCDateTime(TypeDecorator):
    """始终以 UTC 读写的 datetime。

    · 写入：naive 视为 UTC，aware 统一转成 UTC，落库为 naive（SQLite 友好）
    · 读出：补上 UTC 时区，保证是 aware

    这样「库里存的是什么时区」这件事只在本类里出现一次，
    业务层永远拿到带时区的 UTC 时间。
    """

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            # naive 一律当作 UTC（约定：内部只传 UTC）
            return value
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
