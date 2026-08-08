# 代码审查报告 · investment_return_tracker（FastAPI 重写）

> 审计日期：2026-08-09 ｜ 审计方：软件开发团队（架构师「高见远」需求覆盖率审计 + QA「严过关」实现缺陷核查）
> 审计方式：仅读真实代码，**未修改任何文件**；以 `docs/PRD.md` 为需求权威、`docs/openapi.json`（55 路径）为 API 暴露面权威、`docs/ARCHITECTURE.md` 为设计说明。
> 旧 NestJS 应用（`../app`）为只读参考源，不在改动范围。

---

## 1. TL;DR（一句话结论）

后端 55 个端点与 PRD 的 **P0 主线功能基本全部落地**，冻结金融口径/不变量（FG/G/C、信封、Decimal、JWT、口径分离、每日唯一总资产）**100% 满足**；但发现 **1 个 High 级崩溃型缺陷（XIRR 极端值落库溢出）**、**4 个 Medium 缺陷**、**5 个 Low 边界缺陷**，以及 **6 处"代码 vs 需求/架构"偏差**（含 1 处已核实为误报）。前端 `web/src` 实为**完整可运行实现**，与"Phase 5 待开工"的旧记忆不符——应以代码事实为准。

**覆盖率（PRD 共 129 条需求）**：✅ 已实现 ≈ 86% ｜ 🟡 部分实现 ≈ 11% ｜ ⚠️ 不一致 ≈ 2%（含 1 误报）｜ ❌ 未实现 ≈ 1%（均为 PRD 标注的 P2 增强项）。

---

## 2. 四个必须先澄清的关键判断

| # | 原假设 / 旧记忆 | 本次代码核实结果 | 处置 |
|---|---|---|---|
| A | PRD「实现现状」声称"所有功能模块均已实现" | 大体属实（P0 全绿），但**高估**了 P1/P2 与若干偏差 | 见 §4–§8 |
| B | 项目记忆："Phase 5 前端（待开工）" | **误**。 `web/src` 是真实实现：11 页面、13 功能模块、5 个 ECharts 图表、react-query/zustand、信封解包、`asset-metrics.ts` 仅做格式化（FG3 ✅）。前端与后端一并被重写落地 | **纠正记忆** |
| C | "ARCHITECTURE.md §7.1 仍写自实现 Newton-Raphson，与 pyxirr 代码矛盾" | **误报**。本项目 `docs/ARCHITECTURE.md` L837/L841 已写明"委托 pyxirr，非自实现 Newton-Raphson"；`finance_core/xirr.py:16,49` 用 `pyxirr.xirr(..., guess=0.1)`，与 PRD §3.7 一致。旧记忆引用的 `../app/docs/ARCHITECTURE.md` 是**参考旧应用**文档，描述对象不同，无矛盾 | 无需标注不一致 |
| D | 持仓成本口径：Python = PRD 附录 C（`q×price + fee`） | 与 PRD 附录 C 逐字一致，**非 bug**；但与 NestJS 参考实现的"含费单价（INC-03，仅 `q×p`）"不同。若两后端共享同一 DB/前端，`cost_price` 列语义分歧会导致盈亏/净值/XIRR 分歧 | 需团队拍板（见 §7 N1） |

---

## 3. 需求覆盖率（按族汇总）

> 图例：✅ 已实现 ｜ 🟡 部分实现 ｜ ⚠️ 不一致 ｜ ❌ 未实现

| 需求族 | PRD 章节 | 条数 | 状态 | 说明 |
|---|---|---|---|---|
| FIN-F0（金融核心·冻结） | §6.1 | 11 | ✅ 11/11 | XIRR/每日XIRR/累计净值/当年净值/校验/触发，全部与 PRD 附录 A/B/C 吻合 |
| FLOW（出入金） | §6.2 | 13 | ✅12 + 🟡1 | 缺批量删除、标签（P1）；首笔校验缺失（M1） |
| HOLD-B（持仓·方案B） | §6.3 | 21 | ✅20 + 🟡1 | 证券/交易/价格/分红 CRUD + 实时推导齐全；缺自动报价（P1） |
| CASH（现金余额） | §6.4 | 7 | ✅ 7/7 | 变更触发重算且不覆盖 MANUAL ✅ |
| SNAP（总资产·每日） | §6.5 | 7 | ✅ 7/7 | 每日唯一 + 手工/重置 ✅ |
| DASH（概览） | §6.6 | 15 | ✅14 + 🟡1 | `account_stats` 缺统计卡计数（D5） |
| ANL（分析） | §6.7 | 10 | ✅9 + 🟡1 | 粒度 `quarter` 不被计算支持（D3） |
| ACC（账户） | §6.8 | 12 | ✅11 + 🟡1 | 缺登录历史（P1） |
| SET（设置） | §6.9 | 20 | ✅18 + ⚠️/🟡2 | 偏好含 `quarter` 白名单（D3）；缺 API token/全量备份/FEES 导出（P2） |
| SYS（平台通用） | §6.10 | 13 | ✅11 + 🚵2 | 缺标签体系/API token/全量备份（P2） |

**冻结不变量核验（全部 ✅，零破坏）**：FG1 三段式 XIRR+NAV ｜ FG2 每日可追溯（DailyXirr/DailyNav `UniqueConstraint(portfolio_id,date)`）｜ FG3 仅后端算（前端无数值计算）｜ G1 现金流/资产分离 ｜ G2 持仓回放（方案 B）｜ G3 每日一行快照 ｜ C-01 信封 `{code,data,message}` ｜ C-02 Decimal→字符串 ｜ C-03 JWT HS256 `{sub,email}` ｜ C-04 XIRR NUMERIC(20,8) ｜ C-05 bcrypt cost=10 ｜ C-06 6 枚举/12 表 ｜ C-07 `passive_deletes=True` 级联 ｜ C-08 pyxirr 0.10.8 ｜ C-09 跨用户归属隔离 ｜ C-10 唯一权威表（`on_conflict_do_nothing`）。

---

## 4. 代码与需求不一致清单（⚠️，共 6 处，含 1 误报）

- **D1（误报，无矛盾）** XIRR Newton-Raphson 矛盾 —— 见 §2-C，已澄清无矛盾。
- **D2（契约偏差）** 常规写入端点触发了重算却**未回传 `recalculatedDays`**。
  - 证据：`routers/data.py` 各写处理器调用 `RecalculationService.recalculateRange(...)`（如 `create_cashflow` L182-184），但返回 `serialize_cashflow(cf)`，响应体无 `recalculatedDays`；仅 `data_transfer.py:555-565`（导入提交）与 `schemas_resp.py:277`（`RecalcOut`）回传。
  - 影响：§8.4 触发契约的"响应回传"验收未完全满足（重算已发生，仅未回传天数），前端 toast 无法精确显示重算范围。
- **D3（能力错位）** 偏好白名单含 `"quarter"` 粒度，但 `calc.py` 时间序列**不支持 quarter**。
  - 证据：`preference.py:24` `_GRANULARITIES = ["day","week","month","quarter","year"]`；`calc.py:_period_key` L45-52 / `_bucket_date` L55-62 / `_bucket` L65-79 无 quarter 分支（fallback=day）。
  - 影响：若用户设 `defaultGranularity=quarter`，分析页取数将以 day 呈现或落空（SET-P0-02 / ANL-P0-06 语义断点）。
- **D4（轻微）** `SecurityType.CASH` 未标 `@deprecated`。
  - 证据：`models/enums.py:21` 仍保留 `CASH="CASH"`，无弃用标注；后端校验不拒绝该值（仅靠前端隐藏）。功能无破坏，仅元数据/意图不一致。
- **D5（数据缺口）** `account_stats` 仅返回 4 字段，缺账户级统计卡计数。
  - 证据：`services/aggregation.py:237-258` 仅 `portfolioCount/totalAssets/cumulativeXirr/yearXirr`；Dashbo⁠ard 所需统计（笔数/天数/起止/使用天数）未提供，前端需多次调用拼接。
- **D6（次要 P1/P2 缺口，非"偏离"）** 批量删除、出入金标签、证券自动报价、登录历史、API token、全量备份/恢复、FEES 导出——均为 PRD 标注 P1/P2，按优先级一致地未实现，列此备查。

---

## 5. 实现缺陷清单（QA · 按严重度）

### 🔴 HIGH
**H1 · XIRR 极端年化值在 NUMERIC(20,8) 下落库溢出，导致整笔重算事务失败**
- 位置：`finance_core/xirr.py:63`（`Decimal(str(rate)).quantize(1e-8)`）；`services/calculation.py:113-115`；`models/calc.py:61-63`（`xirr_value Numeric(20,8)`）。
- 现象：pyxirr 对"1 日 +10%"返回 `1.28e15`（数学正确，需 16 位整数；NUMERIC(20,8) 仅容 12 位整数）。量化后 INSERT/UPDATE 触发 Postgres `numeric field overflow (22003)`，该异常在 `compute_range`/`recalculateRange` 中**未捕获**，使当次重算事务整体失败（500）。
- 阈值：约 >7.85% 的"1 日收益"即超界（单票/虚拟币/杠杆可达）。
- 修复：① 落库前量程保护（超界置 NULL 或饱和到大边界值并记日志）；② `compute_range` 整段 try/except，单日失败不影响区间其余日；③ 不改列精度（PRD 冻结 NUMERIC(20,8)），优先"饱和/NULL"。

### 🟠 MEDIUM
- **M1 · 缺"首笔出入金必须为存入"校验（违反 PRD §3.6）**：`routers/data.py:187-201` 的 `create_cashflow` 仅建对象提交，无首笔/顺序校验；`nav.py:49` 注释承诺"该校验在 API 层执行"未兑现。以 SELL 作组合首笔会被接受，导致 XIRR 现金流出现无对应存入的正向流，口径失真。
- **M2 · `GET /holdings` 多 `securityId` 仅返回第一个（静默丢数据）**：`routers/calc.py:115-123` 多 ID 时把 `security_id=sec_ids[0]` 传入 `derive`（只推导第一个），随后集合过滤——结果永远只剩第一个，其余标的被静默丢弃。
- **M3 · 汇总接口收益率量纲不一致**：`services/aggregation.py:82-83`（`portfolio_summary`：`(cum_nav-1)*100` 百分比）vs `:215-216`（`summary_list`：`(year_nav-1)` 比值）；同一 `yearReturnRate` 在 `/summary` 返 `20.0`、在 `/portfolios/summary` 返 `0.2`，与永远为比值的 XIRR 混用，前端 100× 偏差风险。
- **M4 · 导入 `_parse_decimal` 对数量/价格误用"≤2 位小数"约束**：`services/data_transfer.py:160-170,220-228` 统一拒绝指数 `< -2`；但 `SecurityTrade.quantity/cost_price` 为 `Numeric(18,6)`，碎股/高精度报价（如 `10.123`/`12.345`）会被判 `INVALID_DECIMAL_PRECISION` 整行失败。

### 🟡 LOW / 边界
- **L1 · 事件日期改"更晚"留下陈旧派生快照空洞**：`routers/data.py:438-441/532-535/620-621` 的 `force = snapshot_dates_since(p.id, new_date)` 以新（更晚）日期为起点，使 `[old,new)` 内依赖该事件的 DERIVED 快照未被重建 → 这些值陈旧。建议 `force_dates = snapshot_dates_since(p.id, min(new_date, old_date))`。
- **L2 · 导入 SELL 跳过 §9.2 卖出硬校验**：`services/data_transfer.py:482-496` 提交 securityTrades 直接 `db.add`，未调用 `_assert_sell_ok`/`validate_trades_no_negative`，超额 SELL 静默产生负持仓。
- **L3 · 入参缺 `amount>0`/`quantity>0` 校验**：`schemas.py:69-73,97-104` 仅 `DecimalStr` 无 `gt=0`，可建 0/负值出入金与买卖。
- **L4 · `compute_range` 在 `start` 之前无 DailyNav 时把区间首日误判为成立日**：`services/calculation.py:56-73` + `finance_core/nav.py:52-55`，显式传入非成立日 `startDate` 且该组合此前未算前缀时会重置份额链、污染累计净值/XIRR。
- **L5 · 同 `as_of` 多条 CashBalance"最新"取值不确定且单查/批量两条路径不一致**：`asset_valuation.py:264-278`（单查 `as_of.desc().limit(1)` 平局取任意行）vs `:108-111`（批量按迭代顺序后者覆盖），可能返回不同现金余额。建议加 `(portfolio_id, as_of)` 唯一约束或统一确定性排序。

### ⚠️ 迁移一致性风险（非 Python bug，需拍板）
- **N1 · 持仓成本口径**：Python（`finance_core/holding.py:64` 等）用 `cost_total += q*cost_price + t.fee_total`，与 PRD 附录 C 逐字一致、**非 bug**；但 NestJS 参考（`holding-derivation.service.ts:200-207`）用 `q * p`（含费单价，成本总额不再加 fee）。若两后端共享同一 DB/前端，`cost_price` 列语义分歧会导致盈亏/净值/XIRR 分歧。建议确认迁移目标口径，必要时在迁移脚本重算 `cost_price`。

---

## 6. 未被实现 / 部分实现的功能清单

**❌ 未实现（主要为 PRD 标注 P2 设计外，前后端一致地未做）**
- 已实现盈亏/公司行为/ FIFO / 标的级 XIRR / 再平衡（HOLD-B-P2-*）
- 合并总览 / 布局自定义 / 基准对比（DASH-P2-*）
- 滚动 XIRR / 自定义基准日 / 复杂现金流（ANL-P2-*）
- 多语言 / API Token / 全量备份恢复(JSON) / 费用导出 FEES（SET-P2-*）
- 多现金账户（CASH-P2-01）、多币种（SYS-P2-03）、第三方登录/2FA/会话管理（ACC-P2-*）、标签体系（SYS-P2-01）

**🟡 部分实现（P1 缺口，非冻结核心）**
- 批量删除（FLOW-P1-03/04、HOLD-B-P1-05）、出入金标签（SYS-P2-01）、证券自动报价（HOLD-B-P1-04）、登录历史（ACC-P1-02/03）、`account_stats` 统计卡计数（D5）、偏好 `quarter` 粒度（D3）。

---

## 7. 测试盲区（78 测试通过，但以下风险路径缺覆盖）

1. XIRR 短持有期高收益溢出（漏 H1） 2. `create_cashflow` 首笔为 SELL（漏 M1） 3. `get_holdings` 多 securityId（漏 M2） 4. 汇总接口百分比 vs 比值量纲（漏 M3） 5. 导入 quantity/price 6 位小数（漏 M4） 6. 价格/交易改更晚日期后的陈旧快照（漏 L1） 7. 导入超额 SELL（漏 L2） 8. `amount/quantity ≤ 0` 入参（漏 L3） 9. 同组合并发写重算竞态（无测试） 10. 账户级 XIRR 聚合空组合/无现金流边界薄弱。

---

## 8. 修复优先级建议

| 优先级 | 项 | 说明 |
|---|---|---|
| **立即修（P0）** | H1 | 防重算事务 500 崩溃，量程保护 + try/except |
| **立即修（P0）** | M1 | PRD §3.6 硬约束，首笔 SELL 拒绝 |
| **立即修（P0）** | M2 | 静默丢数据，多 securityId 修复 |
| **尽快修（P1）** | M3 | 收益率量纲统一为比值，避免 100× 偏差 |
| **尽快修（P1）** | M4 | 导入数量/价格放开到 6 位 |
| **排期修（P2）** | L1–L5 | 边界/健壮性 |
| **需决策** | N1 | 跨后端口径对齐（含费单价 vs 净单价） |
| **文档纠偏** | — | 删除"XIRR Newton 矛盾"误判；将"前端 Phase 5 待开工"修正为"前端已实际实现" |

---

## 9. 已验证为正确/稳健的部分（避免重复劳动）

净值引擎 `finance_core/nav.py` 与 PRD 附录 B 完全一致；XIRR 符号与边界（<2 笔/全同号→None、退化→0.0、非有限→None）探针验证通过；信封与 Decimal→str 在所有成功/异常处理器统一；跨用户隔离经 `get_portfolio`+`user_id` 过滤正确；增量重算无陈旧（仅"改晚"路径 L1 有空洞）；鉴权验签+查库+软删拦截；数据导入 token 为 HS256 签名且绑定 portfolio_id+type 不可伪造；FK 级联与 `gen_random_uuid()` 一致。

> 本报告未改动任何项目文件；所有结论附 `file:line` 证据，详见架构师报告与 QA 报告原始产出。
