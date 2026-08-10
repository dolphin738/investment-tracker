"""定时清理服务 — 对齐 app/ modules/auth/cleanup.service.ts（外部 cron 调用形态，方案 P0-c）。

包含两个幂等清理作业，均可由外部 cron 安全地重复调用：
- physical_purge()       物理删除软删除超过 ACCOUNT_RETENTION_DAYS 的用户；
                         子数据（组合 / 现金流 / 证券 / 交易 / 快照 / 净值 / XIRR 等）
                         依赖 SQLAlchemy 的 onDelete=CASCADE（已配 passive_deletes=True）
                         由数据库级联清理，与 app 的 Prisma cascade 语义一致。
- sweep_orphan_avatars() 删除头像目录下未被任何 user.avatar 引用的孤儿文件；
                         安全闸门只删本驱动生成的、符合命名约定的文件，防误删 / 路径穿越。

口径必须与 UserService.restore / _assert_restore_window 同源（同取 ACCOUNT_RETENTION_DAYS），
否则会出现「登录说还能恢复、跑批却已删库」的不一致（SYS-P1-02）。
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.enums import ACCOUNT_RETENTION_DAYS
from app.models import User

settings = get_settings()

# 头像文件名白名单：<uuid>.<jpg|png|webp>
# 与 upload.py 的 _remove_old / app 的 AVATAR_FILENAME_PATTERN 同源（三重校验之「文件名正则」一重）
AVATAR_FILENAME_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$",
    re.IGNORECASE,
)
AVATAR_SUBDIR = "avatar"


def _avatar_dir() -> Path:
    return Path(settings.UPLOAD_DIR) / AVATAR_SUBDIR


class CleanupService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def physical_purge(self) -> int:
        """物理删除软删除超过保留期的用户，返回删除数量（幂等）。

        使用 bulk delete（单条 DELETE SQL），子数据由数据库 FK onDelete=CASCADE 级联清理。
        重复执行无副作用（已删除的不再匹配 where 条件）。
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=ACCOUNT_RETENTION_DAYS)
        stmt = delete(User).where(User.deleted_at < cutoff)
        result = await self.session.execute(stmt)
        await self.session.commit()
        # asyncpg 对 DELETE 返回受影响行数；保守处理 None
        return int(result.rowcount) if result.rowcount is not None else 0

    async def sweep_orphan_avatars(self) -> int:
        """删除头像目录下未被任何 user.avatar 引用的孤儿文件，返回删除数量（幂等）。

        安全闸门：仅删除匹配 <uuid>.<ext> 命名约定且不在「被引用集合」中的文件，
        避免误删历史脏数据 / 外链 / 路径穿越文件。
        """
        directory = _avatar_dir()
        if not directory.is_dir():
            return 0

        # 收集所有被引用的头像文件名（取 URL 末段，兼容 / 与 \\ 分隔）
        result = await self.session.execute(select(User.avatar))
        referenced: set[str] = set()
        for (avatar_url,) in result.all():
            if not avatar_url:
                continue
            fname = avatar_url.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
            if fname:
                referenced.add(fname)

        removed = 0
        for entry in directory.iterdir():
            if not entry.is_file():
                continue
            # 安全闸门：仅删本驱动生成的、符合命名约定的文件
            if not AVATAR_FILENAME_RE.match(entry.name):
                continue
            if entry.name in referenced:
                continue
            try:
                entry.unlink()
                removed += 1
            except OSError:
                # 删除失败（权限 / 被占用 / 沙箱回收站不可用）仅跳过，不中断批处理
                pass
        return removed
