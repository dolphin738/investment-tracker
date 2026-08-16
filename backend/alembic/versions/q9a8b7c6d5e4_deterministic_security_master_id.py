"""证券主数据 id 由业务自然键 (asset_class, code) 确定性派生。

背景：原先 securities.id 由 DB 端 gen_random_uuid() 随机生成；证券被删除后重新同步
会得到全新 id，导致 portfolio_securities.master_id 外键引用无法稳定复用（删除即失联）。
本迁移一次性把存量 securities.id 重写为
``uuid5(固定命名空间, f"{asset_class.value}|{code}")``，
与 ``app.services.market_data_sync.master_id_for`` 完全一致，使删除重建保持同一 id。

步骤（均在 Alembic 事务内，env.py 已 ``context.begin_transaction()``）：
1. 冲突合并：重复 ``(asset_class, code)`` 组保留 ``updated_at`` 最新行，其余 dup 的持仓
   引用安全转移/删除后删除 dup 行（不级联误删）。
2. 建临时备份表 ``_sec_id_backup(old_id, new_id)`` 记录 old→new 映射（供 downgrade 还原）。
3. Python 端按 uuid5 计算新 id（SQL 无 uuid5 内置），写入备份表。
4. DROP 子表→主表 FK（动态读约束名，不硬编码）。
5. 改子表 ``portfolio_securities.master_id`` 指向新 id。
6. 改主表 ``securities.id`` 为新 id。
7. 重加 FK（ondelete=CASCADE）。
8. 校验：无孤儿、全部 id==master_id_for、前后行数一致。

注意：仅 ``UPDATE id``，**绝不 DELETE 任何 securities 行** → ondelete=CASCADE 永不触发，
绝不级联误删。换 id 期间子表外键值暂指向不存在父 id 的风险由 step4 DROP / step7 ADD 解决。
"""
from __future__ import annotations

import logging
import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

from app.models.enums import SecurityType

# 与 app.services.market_data_sync.SECURITY_MASTER_NAMESPACE 完全一致（锁死不可改）
SECURITY_MASTER_NAMESPACE = uuid.UUID("b3f7e0c2-1a4d-4e9b-9c2a-000000000001")

log = logging.getLogger("alembic.runtime.migration")

# revision identifiers, used by Alembic.
revision: str = "q9a8b7c6d5e4"
down_revision: str | None = "p4f7a8b9c0d1"
branch_labels: str | None = None
depends_on: str | None = None


def _master_id_for(asset_class: "SecurityType | None", code: str) -> str:
    """与 app.services.market_data_sync.master_id_for 保持一致（锁死命名空间）。"""
    ac = asset_class.value if asset_class is not None else "NULL"  # 哨兵
    return str(uuid.uuid5(SECURITY_MASTER_NAMESPACE, f"{ac}|{code}"))


def _parse_asset_class(raw: object) -> "SecurityType | None":
    """DB 原生枚举列按 text 取出时为字符串标签（如 'STOCK'），转回 SecurityType。"""
    if raw is None:
        return None
    if isinstance(raw, SecurityType):
        return raw
    return SecurityType(str(raw))


def upgrade() -> None:
    bind = op.get_bind()

    # -------- step 1: 冲突合并（重复 (asset_class, code)） --------
    dup_groups = bind.execute(
        text(
            "SELECT asset_class, code, count(*) AS c "
            "FROM securities GROUP BY asset_class, code HAVING count(*) > 1"
        )
    ).fetchall()
    for ac_raw, code, _ in dup_groups:
        ac_param = None if ac_raw is None else str(ac_raw)
        rows = bind.execute(
            text(
                "SELECT id, updated_at FROM securities "
                "WHERE asset_class::text IS NOT DISTINCT FROM :ac AND code = :code "
                "ORDER BY updated_at DESC NULLS LAST, id"
            ),
            {"ac": ac_param, "code": code},
        ).fetchall()
        if len(rows) <= 1:
            continue
        keep_id = rows[0][0]
        dup_ids = [r[0] for r in rows[1:]]
        for dup_id in dup_ids:
            # 转移/清理引用该 dup 的持仓：keep 已持有→删除重复引用，否则改指 keep
            holdings = bind.execute(
                text(
                    "SELECT id, portfolio_id FROM portfolio_securities "
                    "WHERE master_id = :dup"
                ),
                {"dup": dup_id},
            ).fetchall()
            for hid, pid in holdings:
                exists = bind.execute(
                    text(
                        "SELECT 1 FROM portfolio_securities "
                        "WHERE portfolio_id = :pid AND master_id = :keep"
                    ),
                    {"pid": pid, "keep": keep_id},
                ).first()
                if exists:
                    bind.execute(
                        text("DELETE FROM portfolio_securities WHERE id = :hid"),
                        {"hid": hid},
                    )
                else:
                    bind.execute(
                        text(
                            "UPDATE portfolio_securities SET master_id = :keep "
                            "WHERE id = :hid"
                        ),
                        {"hid": hid, "keep": keep_id},
                    )
            bind.execute(
                text("DELETE FROM securities WHERE id = :dup"), {"dup": dup_id}
            )

    # -------- step 2: 备份映射表 --------
    bind.execute(
        text(
            "CREATE TABLE _sec_id_backup ("
            "old_id VARCHAR(36) PRIMARY KEY, new_id VARCHAR(36) NOT NULL)"
        )
    )

    # -------- step 3: Python 算新 id 并写入备份 --------
    sec_rows = bind.execute(
        text("SELECT id, asset_class, code FROM securities")
    ).fetchall()
    mapping: dict[str, str] = {}
    for old_id, ac_raw, code in sec_rows:
        mapping[old_id] = _master_id_for(_parse_asset_class(ac_raw), code)
    if mapping:
        bind.execute(
            text("INSERT INTO _sec_id_backup (old_id, new_id) VALUES (:old, :new)"),
            [{"old": o, "new": n} for o, n in mapping.items()],
        )

    # -------- step 4: DROP FK（动态读约束名，不硬编码） --------
    fk_name = bind.execute(
        text(
            "SELECT conname FROM pg_constraint "
            "WHERE conrelid='portfolio_securities'::regclass "
            "AND confrelid='securities'::regclass AND contype='f'"
        )
    ).scalar()
    if fk_name:
        op.drop_constraint(fk_name, "portfolio_securities", type_="foreignkey")

    # -------- step 5/6: 改子表与主表 id（经备份表 JOIN 一次性更新） --------
    bind.execute(
        text(
            "UPDATE portfolio_securities ps SET master_id = b.new_id "
            "FROM _sec_id_backup b WHERE ps.master_id = b.old_id"
        )
    )
    bind.execute(
        text(
            "UPDATE securities s SET id = b.new_id "
            "FROM _sec_id_backup b WHERE s.id = b.old_id"
        )
    )

    # -------- step 7: 重加 FK --------
    op.create_foreign_key(
        "portfolio_securities_master_id_fkey",
        "portfolio_securities",
        "securities",
        ["master_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # -------- step 8: 校验（仅 log） --------
    orphan = bind.execute(
        text(
            "SELECT count(*) FROM portfolio_securities ps "
            "LEFT JOIN securities s ON ps.master_id = s.id "
            "WHERE s.id IS NULL"
        )
    ).scalar()
    bad = 0
    for old_id, ac_raw, code in sec_rows:
        new_id = mapping.get(old_id)
        if new_id is None:
            bad += 1
            continue
        if new_id != _master_id_for(_parse_asset_class(ac_raw), code):
            bad += 1
    log.info(
        "[deterministic_id] securities rows=%s, id_mismatch=%s, orphans=%s",
        len(sec_rows),
        bad,
        orphan,
    )


def downgrade() -> None:
    bind = op.get_bind()

    # 动态读当前 FK 名并 DROP
    fk_name = bind.execute(
        text(
            "SELECT conname FROM pg_constraint "
            "WHERE conrelid='portfolio_securities'::regclass "
            "AND confrelid='securities'::regclass AND contype='f'"
        )
    ).scalar()
    if fk_name:
        op.drop_constraint(fk_name, "portfolio_securities", type_="foreignkey")

    # 用备份把 id 精确还原为 old_id（new_id 现作为 securities.id 存在）
    bind.execute(
        text(
            "UPDATE portfolio_securities ps SET master_id = b.old_id "
            "FROM _sec_id_backup b WHERE ps.master_id = b.new_id"
        )
    )
    bind.execute(
        text(
            "UPDATE securities s SET id = b.old_id "
            "FROM _sec_id_backup b WHERE s.id = b.new_id"
        )
    )

    op.create_foreign_key(
        "portfolio_securities_master_id_fkey",
        "portfolio_securities",
        "securities",
        ["master_id"],
        ["id"],
        ondelete="CASCADE",
    )

    bind.execute(text("DROP TABLE _sec_id_backup"))
