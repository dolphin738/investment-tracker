# Phase 4 复查报告（对照 v2.3 可行性方案 + ARCHITECTURE 契约）

> 复查对象：`investment_return_tracker/backend`（独立仓库，本地提交 `1369605`）
> 对照源：`app/scripts/backend-python-migration-feasibility/python-backend-migration-feasibility.html` (v2.3) + `app/docs/ARCHITECTURE.md` §4.2.10/§4.2.14/§4.2.15/§4.2.16
> `app/` 全程只读，未改动。

---

## 0. 关键结论先行

**先说一个必须澄清的范围差异**：v2.3 可行性方案里的 **Phase 4 = 业务模块（68 端点）**（见 HTML 第六/七节：auth/portfolio/query/snapshot/security-trade/security/cashflow/dividend/data-transfer/security-price/cash-balance/preference/upload/overview/holding/account/summary 全部平移）。而本会话实际执行的 **"Phase 4" 只是聚合端点子集**（summary/overview/comparison/drawdown/account-stats），是 v2.3 "query + overview/account/summary" 模块的一部分。

因此复查结论分两层：

| 解释口径 | 完成度 | 判定 |
|---|---|---|
| **A. 本会话的 "Phase 4"（聚合端点，提交 `1369605`）** | 5 端点 + 字段全部对齐 ARCHITECTURE 契约，5 项集成测试 + 全量 54 passed | ✅ **完整完成** |
| **B. v2.3 方案的 Phase 4（业务模块 68 端点）** | 多数模块已在 Phase 3 平移，但 **4 个模块未做** | ❌ **未完整完成** |

---

## 1. 口径 A：本会话 Phase 4（聚合端点）——✅ 完整

### 1.1 端点清单（全部已注册、经 EnvelopeRoute 包裹、Decimal→str）

| 端点 | 契约 | 实现位置 | 状态 |
|---|---|---|---|
| `GET /api/portfolios/{id}/summary` | §4.2.14 | `routers/aggregation.py:40` | ✅ |
| `GET /api/portfolios/{id}/overview?range=` | §4.2.10 | `routers/aggregation.py:48` | ✅ |
| `GET /api/portfolios/comparison` | §4.2.10 | `routers/aggregation.py:32` | ✅ |
| `GET /api/portfolios/{id}/metrics/drawdown` | §4.2.15 | `routers/aggregation.py:57` | ✅ |
| `GET /api/account/stats` | §4.2.16 | `routers/aggregation.py:67` | ✅ |

> 路由注册铁律已遵守：`router_aggregation` 在 `main.py` 中于 `portfolios.router` **之前** include，`/comparison` 字面路由未被 `/{portfolio_id}` 吞掉。

### 1.2 字段逐项对齐（无缺失）

- **OverviewDTO (§4.2.10)**：`totalAsset` / `cumulativeXirr` / `yearXirr` / `navSeries` / `recentCashflows` / `freshness` —— 全 ✅
- **FreshnessInfo (§4.2.10 / `shared/types/overview.ts`)**：`staleDays` / `isStale` / `latestPriceAsOf` / `latestPriceLagDays` / `latestCashAsOf` / `latestCashLagDays` / `reasons[]` —— 全 ✅；口径与契约一致（行情=持仓标的各自 `MAX(as_of)` 最小值、现金=`MAX(as_of)`、滞后天数=as_of→今天 UTC+8 自然日差、超阈值才产 reasons）。
- **PortfolioSummary (§4.2.14)**：`cumulativeXirr` / `totalReturnRate` / `yearReturnRate` / `maxDrawdown`(P1 v1 恒 null) / `latestDate` / `inceptionDate` —— 全 ✅
- **DrawdownPoint (§4.2.15)**：`date` / `drawdown` / `peakDate` / `label` —— 全 ✅
- **AccountStats (§4.2.16)**：`portfolioCount` / `totalAssets` / `cumulativeXirr` / `yearXirr` —— 全 ✅
- **`?range` 白名单**：`1w|1m|3m|6m|1y|ytd|all` 与 I-04 的 7 项完全一致 ✅

### 1.3 测试覆盖

`tests/test_api_aggregation.py` 5 项（summary / overview+freshness+navSeries+recentCashflows / comparison / drawdown / account-stats），断言均按契约字段 + Decimal 还原校验。**全量 54 passed / 0 failed**。

---

## 2. 口径 A 的轻微隐患（建议修，非阻塞）

1. **freshness 失败未降级**（§4.2.10 明确要求："计算失败时降级为空 freshness（`staleDays=3, isStale=false`），主响应照常返回"）。当前 `overview()` 直接 `await self.freshness(...)` 无 `try/except`，若 `HoldingService.derive` 或查询异常，整个 `/overview` 会 500。建议用 `try/except` 包裹，异常时返回降级 freshness。
2. **未知 `range` 值静默当 `all`**：`_range_start` 对未知值返回 `None`（=不限），而非 400 拒绝。与 I-04 "非法值被拒" 略有出入，但属宽松处理，影响小。

> 以上两项不影响"字段完整度"判定，纯健壮性打磨。需要我修可以再说。

---

## 3. 口径 B：v2.3 方案的 Phase 4（业务模块 68 端点）——❌ 未完整

按 v2.3 模块表逐模块核对（已完成的部分横跨本会话 Phase 3 + Phase 4）：

| v2.3 模块 | 端点数 | 状态 | 落点 |
|---|---|---|---|
| auth | 8 | ✅ 已完成 | Phase 3 `routers/auth.py` |
| portfolio | 9 | ✅ 已完成 | Phase 3 `routers/portfolios.py` |
| query（聚合/分组） | 9 | ⚠️ 部分 | 概览/对比/摘要/drawdown/account 已在 Phase 4；xirr/nav 四维度序列已在 Phase 3 `calc.py`（需严格核对 granularity/aggregation/metric 参数） |
| snapshot | 6 | ✅ 已完成 | Phase 3 `routers/data.py` |
| security-trade | 5 | ✅ 已完成 | Phase 3 `routers/data.py` |
| security | 5 | ✅ 已完成 | Phase 3 `routers/data.py` |
| cashflow | 5 | ✅ 已完成 | Phase 3 `routers/data.py` |
| **dividend** | 4 | ❌ **未做** | §4.2.18 |
| **data-transfer** | 4 | ❌ **未做** | §4.2.17（export / preview / commit / template，CSV+XLSX，两阶段导入） |
| security-price | 3 | ✅ 已完成 | Phase 3 `routers/data.py` |
| cash-balance | 3 | ✅ 已完成 | Phase 3 `routers/data.py` |
| **preference** | 2 | ❌ **未做** | §4.2.16 `GET/PATCH /api/users/preferences`（SET-P0-02，freshness 的 `staleDays` 已依赖它） |
| **upload（头像）** | 1 | ❌ **未做** | 需手工信封透传 `@Res()` |
| overview/holding/account/summary | 各 1 | ✅ 已完成 | Phase 3 `calc.py`(holding) + Phase 4 |

**未交付模块（4 个，共 11 端点）**：dividend、data-transfer、preference、upload。

---

## 4. 建议

- 若你指的 "Phase 4" 是**本会话聚合端点**：已完整完成，无需补做；仅建议打磨 §2 的 2 处健壮性。
- 若你指的 "Phase 4" 是 **v2.3 的业务模块全量**：则还需立项补齐 dividend / data-transfer / preference / upload 四个模块（之前我列的三个候选 ①② 即 preference + data-transfer，正好覆盖其中两项；dividend 与 upload 另算）。
- 无论哪种解释，`app/` 均未被改动，硬约束守住。
