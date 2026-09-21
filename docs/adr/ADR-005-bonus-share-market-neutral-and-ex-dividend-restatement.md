# 送转市值中性与「除权复权重述」股息率口径（ADR-005）

> 架构师：dolphin738 ｜ 上游输入：分红总报告（合并版）`docs/reviews/review-dividend-manual-period-2026-09-21.md` ｜ 状态：**决策已收口；`restate_cells`（P6）已实现并落地，批次 E 收口三个已知边界**
> 变更性质：**股息率口径修订**（送转不进收益率，改按「除权复权重述」处理分子），触及 `services/dividend_yield.py`（`restate_cells`）、`services/dividend_yield_refresh.py`（快照）、`modules/dividend_yield/router.py`（排名过滤重算）、`compute_yield_at`（曲线）三调用方；**不改动报告期分类模型**（后者见 `ADR-004`）。
> 全部结论均基于本次实际代码核实（`services/dividend_yield.py`、`models/dividend_yield.py`）与外部佐证，非记忆推断。

---

## 0. 决策现状核实（先于记录）

| 项 | 位置（实际代码） | 状态 |
|----|------------------|------|
| 重述函数 | `backend/app/services/dividend_yield.py:restate_cells` | ✅ P6 已实现；由快照 + 排名过滤 + 曲线三调用方共用 |
| 送转列 | `backend/app/models/dividend_yield.py`：`SecurityDividend.bonus_share_ratio` / `convert_ratio`（迁移 `0030`） | ✅ 已加，`Numeric(18,6)` 可空；用途为**复权重述因子 + 方案展示** |
| `DividendCell` 投影 | `services/dividend_yield.py:to_cell` | ✅ 已投影 `bonus_share_ratio` / `convert_ratio` |
| `compute_yield` 分子 | `services/dividend_yield.py:compute_yield` | ✅ **仍只累加现金**；`YieldResult` 未新增 `bonus_yield` / `total_yield` |
| 三调用点 | `dividend_yield_refresh.py:137`（快照）/ `router.py:227`（排名重算）/ `compute_yield_at:273`（曲线） | ✅ 各恰一次（已核实）；契约「每链恰调一次」+ 单测守护 |
| 已知未收口边界 | `dividend_yield.py:156-197` | ⚠️ 三处，属**批次 E**：① 非幂等；② `splits` 不过滤 `status`；③ `i_date is None` 套用全部送转因子 |

**结论**：「送转不进收益率、改按除权复权重述」的口径已实现（P6 落地 `restate_cells`）；`compute_yield` 分子仍只计现金。批次 E 需收口三个边界（见 §4）。

---

## 1. 背景与问题

送股 / 转增是**股票股利**：除权除息后股价按同比例下调，股东总财富不变（**市值中性**）。它**不产生现金收益**。

旧口径（方法 A）把「每股多得 b 股」直接加成收益率（`total_yield = cash_yield + bonus_yield`），本质是把**股数增加当成收益**，却未扣除对应的股价稀释 → 对高送转个股**系统性虚增**。

以万盛股份 SH603010「10 转 4 派 4」为佐证（雪球《基础知识：股息率的算法（二）》）：

| 时点 | 每股分红 | 股价 | 股息率 |
|---|---|---|---|
| 除权前 2021-04-26 | 0.4（转增不额外发现金） | 26.97 | **1.48%** |
| 除权后 2021-04-27 | 4 元 / 14 股 = **0.2857** | 19.09 | **1.497%** |

分子（每股分红）与分母（股价）**同比例下降**，股息率基本不变（1.48% → 1.50%，残差来自现金出表与市场噪声）。而方法 A 会给出 `0.4/19.09 + 0.4 ≈ 42%` 的荒谬值，正解是 `1.497%`。

**代码侧根因**：分母 = 最新**不复权**收盘价（已是「当前股本」基准），而 `cash_per_share` = 方案宣告口径（**旧股本**基准，「每 10 股派 X 元」÷10）。某股发生送转后，只要该笔分红仍在 TTM / LFY 窗口内，计算即退化成「**旧股本分子 ÷ 新股本股价**」，股息率被高估约 **`(1 + 送转率)`** 倍，直至该笔分红滚出窗口。

---

## 2. 决策内容

| 项 | 决策 | 理由 |
|----|------|------|
| 送转是否进收益率 | **不进** | 送转市值中性，不产生现金收益；把股数增加当收益是重复计算 |
| 分子口径 | 改按**除权复权重述**：`cash_adj = cash / Π(1 + bonus + convert)` 重述到**当前股本基准** | 分母（最新不复权价）已是当前股本基准，分子须同基准相除才不虚增 |
| `bonus_share_ratio` / `convert_ratio` 两列用途 | 由「加进收益率」改为「**复权重述因子 + 方案展示**」 | 两列仍保留，语义修正 |
| 重述函数落点 | 窗口级纯函数 `restate_cells`，由**快照 / 排名 / 曲线**三调用方共用 | 重述需跨行送转信息，无法塞进逐行 `to_cell`；三处共用避免口径分叉 |

### 2.1 重述公式

对进入 TTM / LFY 窗口的每笔现金分红 `i`，按其自身 `ex_dividend_date` 之后发生的**所有**送转事件 `j`（含同一方案同时除权的送转，即 `j.ex_date >= i.ex_date`，且 `j.ex_date <= 计算基准日`）累乘缩股因子重述分子：

```
b_j        = bonus_share_ratio_j + convert_ratio_j        # 每股送转股数（源「每 10 股」已 ÷10）
cash_adj_i = cash_per_share_i / Π_j (1 + b_j)             # 重述到「当前股本」基准
股息率      = Σ_i cash_adj_i / price                      # price = 最新不复权收盘价，已是当前股本基准
```

- 分子分母同为**当前股本基准**，相除还原为真实现金股息率，**不虚增**；
- 未来才除权的送转（`j.ex_date > 基准日`）不参与——彼时股价仍是旧股本基准；
- 万盛验证：`0.4 / (1 + 0.4) = 0.2857` → `0.2857 / 19.09 = 1.497%` ✓ 与原文一致；
- 累乘天然覆盖**多次累计送转**，弥补原文只讲单次除权的局限。

---

## 3. 被否决 / 替代方案

| 方案 | 表述 | 否决理由 |
|------|------|----------|
| 方法 A：送转并入综合收益率 | `total_yield = cash_yield + bonus_yield` | 把股数增加当收益，未扣股价稀释 → 对高送转个股**系统性虚增**（万盛例给出 ≈42% 的荒谬值）；且掩盖真实缺口「该修的分子没修」，属重复计算 |
| 纯送转行撑起连续分红计数 | 送转-only 年计入 `consecutive_years` | 市值中性、无现金收益；纯送转行**不落库**，计数天然不含（零改动） |
| 逐行 `to_cell` 内重述 | 在单行投影里算复权 | 重述**需跨行**送转信息，单行视图拿不到 → 无法实现 |

---

## 4. 后果与回退

| 维度 | 影响 | 处理 |
|------|------|------|
| 数值结果 | 含送转个股的股息率不再高估约 `(1+送转率)` 倍 | `restate_cells` 三调用方共用；单测覆盖万盛例 |
| `compute_yield` 分子 | **仍只计现金**，语义不变 | `YieldResult` 不新增 `bonus_yield` / `total_yield` |
| 纯送转行 | **不落库**、不计入连续分红 | `_PAYABLE` 过滤口径不变（仍仅看 `status`），**零改动** |
| **批次 E 未收口边界** ① | `restate_cells` **非幂等**（无重入标记，二次调用重复缩股） | 保持纯函数无状态，改用「**调用点唯一**」契约 + 单测守护（断言「对输出再调一次不改变结果」）；三调用点各恰一次（已核实） |
| **批次 E 未收口边界** ② | `splits` **未按 `status` 过滤** → `REJECTED` 会污染复权基准 | `splits` 仅取 `status in (PROPOSED, PAID)`（复用 `_PAYABLE` 口径），排除 `REJECTED`（`dividend_yield.py:163-169`） |
| **批次 E 未收口边界** ③ | `i_date is None` 时套用 as_of 前**全部**送转因子（口径未定义） | **冻结**：`i_date is None` 的行**不参与重述**（原样透传）——无除权锚点无法判定「之后发生的送转」，避免对未来/全部送转滥用因子（`dividend_yield.py:178`） |
| 排名阈值 | `user_preferences` 阈值 0.05 / 0.03 不受影响 | 维持现金口径；「综合排名是否改用 `total_yield`」随之消解 |
| 回退 | 如需回到方法 A | 从 git 历史恢复 `total_yield` 累加逻辑；不建议（方法 A 已被数据推翻） |

---

## 5. 落地范围（分阶段）

1. **P0（已实现）**：迁移 `0030` 扩 `bonus_share_ratio` / `convert_ratio` 两列 + `DividendCell` 投影两列 + 采集侧写入。
2. **P6（已实现，2026-09-21）**：`services/dividend_yield.py:restate_cells` 落地，快照 / 排名重算 / 曲线三调用方共用，闭合分子/分母股本基准错配；`§9.2` 所述约 `(1+送转率)` 倍高估消除。
3. **批次 E（待实现）**：收口 §4 三个已知边界（幂等守护 / `splits` 过滤 `status` / `i_date is None` 透传）+ 对应单测。

---

## 6. 参考

- `docs/分红采集链路迁移方案.md` §9.1（Q6 口径）/ §9.2（分子分母基准错配缺口）/ §5.3.1（送转列与消费侧）
- `backend/app/services/dividend_yield.py` — `restate_cells`（`:156-197`）/ `compute_yield` / `to_cell`
- `backend/app/services/dividend_yield_refresh.py` — 快照调用点（`:137`）
- `backend/app/modules/dividend_yield/router.py` — 排名过滤重算调用点（`:227`）
- `backend/app/services/dividend_period.py` / `compute_yield_at` — 曲线调用点（`:273`）
- `backend/alembic/versions/0030_add_dividend_bonus_columns.py` — 送转两列
- `docs/adr/ADR-004-dividend-report-period-and-manual-assignment.md` — 报告期分类扩展（关联决策）
