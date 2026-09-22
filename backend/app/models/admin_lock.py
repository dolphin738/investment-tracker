"""跨进程管理端动作互斥锁表（``admin_locks``）。

背景：进程内 ``asyncio.Lock`` 只在**单 worker** 内有效。多 worker / 多副本部署下，
每个进程各持有一个 Lock，连点会各自启动一个长耗时任务（如历史分红播种约 10 小时），
并发打满接口 ``rate_limit=10/min`` 预算。本表以**数据库行**作为跨进程共享的互斥标记。

表结构极简（主键即锁名）：
- ``owner``：持锁令牌（UUID 字符串）；``NULL`` = 空闲（已释放）。
- ``acquired_at``：获取时刻；配合 TTL 判据，防止持锁进程崩溃 / 被强杀后锁永久残留。

锁的获取与释放由 ``app.services.admin_lock`` 用**单条原子 SQL** 完成（非 ORM 赋值），
故本模型只用于把表注册进 ``Base.metadata``——否则 ``alembic revision --autogenerate``
会把这张「DB 有、metadata 无」的表判为多余并生成 ``op.drop_table()``。
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AdminLock(Base):
    """跨进程互斥锁行（行级乐观锁 + TTL）。"""

    __tablename__ = "admin_locks"

    # 锁名（业务动作标识，如 "dividend_seed"）；即主键，天然单行互斥
    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    # 持锁令牌；NULL = 空闲
    owner: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    # 获取时刻；NULL = 空闲
    acquired_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 取消请求标记（跨进程取消）：NULL = 无请求；非 NULL = 已请求取消（值为请求时刻）。
    # 取消端点只置此列（不依赖本进程是否持有任务对象），持锁 worker 的循环自检后自行退出。
    # 释放锁时一并清空，防一次运行的取消标记泄漏到下一次。
    cancel_requested_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
