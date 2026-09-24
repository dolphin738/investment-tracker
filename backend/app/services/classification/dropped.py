"""是否应丢弃（不写入） securities 主数据表 的判定。"""

from __future__ import annotations

import re

from ._constants import DELISTED_FUND_CODES, DROP_PREFIX1
from .parse import _parse_raw

__all__ = ["is_dropped"]


def is_dropped(raw_code: str, name: str = "") -> bool:
    """是否应**丢弃（不写入）** ``securities`` 主数据表。

    按 ``fund-classification-rules.md`` 规则，以下类别丢弃（噪音/非投资标的）：

    - 老三板 / 全国股转系统：``4xxxxx``（含 ``400xxx`` 退市A股、``420xxx`` 退市B股）；
    - 北交所旧代码段：``8xxxxx``（精选层平移，与 ``920`` 新段区分，一并丢弃）；
    - 深市分级基金：``sz150xxx``（结构化分级基金份额，一律视为噪音，丢弃不入库）；
    - B股：``900xxx``（沪市B股）、``200xxx``/``201xxx``（深市B股，如 201872 招港B）
      ——B股整体不入主数据表。

    保留：``920xxx``（北交所主板新段）、A股主板/科创板/创业板、场内基金、可转债、
    指数 等。

    说明：``4xxxxx`` 段（含 ``400xxx`` 退市A股、``420xxx`` 退市B股、以及名称含
    「退债」的退市可转债）一律按老三板/全国股转处理，**丢弃不入库**——既不归入
    未分类（UNCATEGORIZED），亦不写入主数据表。
    """
    _, code = _parse_raw(raw_code)
    if not re.fullmatch(r"\d{6}", code):
        return False
    # 已退市基金（精确 code，见 DELISTED_FUND_CODES）：不入 securities 主数据表
    if code in DELISTED_FUND_CODES:
        return True
    # 4xxxxx=老三板/全国股转、8xxxxx=北交所旧段、150xxx=深市分级基金、
    # 900xxx=沪市B股、200xxx/201xxx=深市B股，一律丢弃不入库
    # （名称含「退债」的退市可转债落 4xxxxx 段，同样丢弃，不作例外）
    return (
        code[0] in DROP_PREFIX1
        or code.startswith("150")
        or code.startswith("900")
        or code.startswith(("200", "201"))
    )
