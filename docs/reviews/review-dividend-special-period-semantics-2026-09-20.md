# 裁决报告：巨潮「特别分红」落库语义（period_type 与报告期归属）

**日期**：2026-09-20
**工作流**：工作流 2（系统设计 / 决策）— 派生自主报告 `code-review-unpushed-dividend-migration-2026-09-20.md` 的 P0 行动项 #1
**参与成员**：Archi（系统架构师，裁决规格 + ADR）、Tessa（测试专家，测试影响矩阵）；主理人（实测画像 + 落库模拟）
**触发**：owner 提供一条**能正常获取**的真实数据，并给出约束「**不能单纯只靠按除权日所在年+季占位落库**」

> ## ⚠️ 部分条款已于 2026-09-21 被 owner 改判 —— 以新报告为准
> 新报告：`docs/reviews/review-dividend-manual-period-2026-09-21.md`
>
> | 本报告条款 | 状态 | 改判后 |
> |---|---|---|
> | **Q2** 报告期**三级回退**（报告时间→公告日→除权日→丢弃） | ❌ **作废** | **不回退**：无报告期的行**不推测**，落 staging 表交人工划分 |
> | **Q3** 未知/空标签 → **SPECIAL** + warn | ❌ **作废** | 未知/空 → **「其他」独立分类** |
> | **Q4** 股改分红**并入 SPECIAL** | ❌ **作废** | **不并入**，分红类型**详细区分** |
> | §7.1b 仲裁（`"三季度分红"`→改字面量、`:298-299`→SPECIAL） | ⚠️ **部分作废** | `:298-299` 断言应改为**「其他」分类**；`"三季度分红"` 改真标签仍成立 |
> | Q1（特别分红→SPECIAL）/ Q5 / Q8（跨源去重）/ Q6 / Q7 | ✅ **仍有效** | 不变 |
> | §7.2 中 tier2/tier3 回退用例（#5/#6） | ❌ **作废** | 改为「无报告期 → 落 staging 待办」用例 |
>
> **另**：`600900 股改分红` 实测**连除权日都为空**（`除权日=None`）——证明「按除权日占位」这条路径在真实数据上根本走不通，本报告的 🔴 判定因此得到反证支持。

---

## 📌 TL;DR（执行摘要）

- **owner 的否决意见被数据完全证实**：418 个样本行中「除权季度 − 报告季度」**等于 0 的行数为 0**（偏移只落在 +1/+2/+3/+4 季）→ 用除权日作主锚点是**系统性错位 1~4 个季度**，不是偶发偏差。
- **本次实测把缺陷从「1 处」扩到「3 层」**：L1 标签映射缺失（特别分红落成 QUARTERLY）+ 报告期缺失即整行丢弃；L2 `_westward_dup` 的 `ex_date` 判据**误杀同日除权的兄弟分量**；L3 `_westward_dup` 的 `(ry,rq,cash)` 判据**缺 `period_type` 过滤**，架空「SPECIAL 与 ANNUAL 可并存」的唯一键设计。
- **量化影响**：16 只样本「现金留存率」现状 **85%**；只修 L1 → **98%**；三层全修 → **100%**。最重的两例：600519 少 **20%**（41.016 元/股）、300750 少 **33%**（7.796 元/股）。
- **裁决方向**：`特别分红 → SPECIAL`（不是 QUARTERLY、不是打散到 ANNUAL/INTERIM）+ 报告期**三级回退**（报告时间 → 公告日 → 除权日 → 丢弃告警）+ 跳过原因**分桶计数** + `_westward_dup` **收窄为跨源去重**。
- **行数闸门**：语义修复**必须独立成小批**（估算 330–520 行 < 800）；若与未推送 22 提交合成一批（整批 2118 行 / P0 单批 1829 行）→ **必超 800 打回**。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| 整体评级 | 🟡 **有条件通过** —— 裁决方向明确、证据充分；但需 owner 拍板 **5 项未决**（见 §9）后才能实施 |
| 阻塞项数量 | 1（owner 裁决未定；技术方案本身无未解死结） |
| 关键行动项 | 7 条（见 ✅ 行动清单） |
| 建议下一步 | owner 对 §9 的 5 项拍板 → 按 §4 规格实施（**独立小批**）→ 按 §7 补 ≥18 条测试 → 落 ADR-004 + 修订方案文档 |

---

## 一、问题溯源（三层缺陷）

| 层 | 缺陷 | 位置 | 机制 |
|---|---|---|---|
| **L1a** | 标签映射缺失 | `dividend_cninfo_parse.py:36-39`、`:67-69` | `_PERIOD_TYPE_BY_LABEL` 只有 年度分红/中期分红；未收录**一律兜成 QUARTERLY** → 真实存在的 `特别分红`/`季度分红`/`股改分红` 全落 QUARTERLY。SPECIAL 槽位（`enums.py:156`、唯一键含 period_type、`period_label` 的「YYYY特别分配」分支）**空置且不可达** |
| **L1b** | 报告期不可解析即整行丢弃 | `dividend_cninfo_parse.py:85-87` | `报告时间` 缺失 → `return None` → 该行**连同真实现金一起丢**；且与「纯送转跳过」共用同一 `None` 与同一计数（`:82-84`），调用方无法区分 |
| **L2** | `_westward_dup` ex_date 判据过宽 | `dividend_notice_scan.py:401-405` → `:456-459` | 新增路径上，同 master 已有**同 `ex_dividend_date`** 的行即判重复 → 丢弃。年度分红行先入库后，**同日除权的特别分红分量被一并误杀**（丢哪一半取决于源站行序） |
| **L3** | `_westward_dup` 第二判据缺 `period_type` | `dividend_notice_scan.py:461-466` | 只比 `master_id + report_year + report_quarter + cash_per_share`，**不过滤 period_type** → 同 (年,季) 已有 `cash` 相等的 ANNUAL 行时，新 SPECIAL 被误判重复 → 「SPECIAL 与 ANNUAL 可同格并存」的**唯一键设计目的被架空** |

> L1 由主理人在预扫中定位；L2 由主理人量化后交两位成员独立复核（Archi 独立复现 + 新增取证）；**L3 由 Tessa 独立发现**（主理人已回源码核实成立）。
>
> **⚠️ L3 勘误（Archi 提出反向陷阱，Tessa 已勘误其 v2）**：L3 的现象成立（`:461-466` 确实不比 `period_type`），但**修复方向不是「加 `period_type`」**——旧链路把每行都写成 `period_type=SPECIAL`（`方案:394`），同笔分红新链路可能落 ANNUAL/INTERIM/QUARTERLY；若判据要求 `period_type` 相等，会因 `SPECIAL ≠ ANNUAL` **漏挡跨源重复**，与护栏初衷相反。正解 = **两分支均只加「跨源」限定**，「同源豁免」后 L3 的场景自然不复存在（见 §5.1 / §7.1b-4）。

---

## 二、实测数据（真实上游，非构造数据）

样本：16 只（600519/000001/300750/600036/601318/000858/600030/002594/601899/600887/000651/601398/600900/601088/000333/600028）；来源 `akshare.stock_dividend_cninfo`；**只读、不落库、不连开发库**。

### 2.1 「分红类型」取值与「报告时间」缺失率

| 分红类型 | 总行 | 报告时间不可解析 | 占比 |
|---|---|---|---|
| 年度分红 | 332 | 0 | 0% |
| 中期分红 | 72 | 0 | 0% |
| **特别分红** | **9** | **4** | **44.4%** |
| 季度分红 | 9 | 0 | 0% |
| 股改分红 | 5 | 4 | 80% |

> **词表独立复验**（主理人另跑 30 只 / **817 行**）：不同标签数恒为 **5**，**无变体** —— `年度分红 657 / 中期分红 124 / 特别分红 18 / 季度分红 11 / 股改分红 7`。→ 现实词表是**闭集**，故匹配取**精确 5 项 dict**（不加前缀/模糊/包含匹配）；未来若出现新变体 → `SPECIAL + WARN` **显式暴露**，而不是被静默吸进某个桶。
> （过程留痕：曾评估「特征词包含匹配」以容忍变体，817 行实证无变体后**作废**，回到精确匹配。）

→ `特别分红` **并非一律无报告时间**（5/9 有）；缺失的 4 行**都有公告日与除权日**。owner 给出的例子（`报告时间=2023年报`）正是「有报告时间且跨年」的典型。

### 2.2 「除权季度 − 报告季度」偏移（owner 否决意见的数据支撑）

```
offset=+1季 ×53   +2季 ×198   +3季 ×163   +4季 ×4
offset= 0季 ×0        ← 关键：从不相同
```

### 2.3 特别分红明细（9 行全量）

```
sym     公告日        除权日        报告时间     解析报告期    派息raw   每股      送股/转增
600519  2022-12-21  2022-12-27  None        None         219.1    21.91    None/None
600519  2023-12-14  2023-12-20  None        None         191.06   19.106   None/None
300750  2024-04-23  2024-04-30  2023年报     (2023,4)      30.17    3.017    None/None
300750  2025-01-17  2025-01-24  2024年报     (2024,4)      12.3     1.23     None/None
300750  2026-04-15  2026-04-22  2025年报     (2025,4)      47.79    4.779    None/None
600036  2006-09-15  2006-09-21  None        None           1.8      0.18     None/None
601318  2018-05-31  2018-06-07  None        None           2.0      0.2      None/None
601088  2017-07-03  2017-07-10  2017一季报   (2017,1)      25.1     2.51     None/None
600028  2020-10-15  2020-10-23  2020半年报   (2020,2)       0.7      0.07     None/None
```
附带事实：特别分红行 **9/9 无送股/转增** → 对 `restate_cells` 复权因子**零影响**；派息从未为空；`派息比例` 单位与其他类型一致（「10派X元」→ ÷10 成立）。

### 2.4 源站把「同一次分配」拆成多行（本裁决的关键新事实）

```
300750  2023Q4  年度分红 ex=2024-04-30  20.11/10股 → 2.011/股
300750  2023Q4  特别分红 ex=2024-04-30  30.17/10股 → 3.017/股   ← 同 ex_date、同 record_date
                  20.11 + 30.17 = 50.28/10股  = 该次完整分配方案
300750  2025Q4  年度分红 ex=2026-04-22  21.78  ／ 特别分红 ex=2026-04-22  47.79
601088  2017    年度分红 ex=2017-07-10   0.46  ／ 特别分红 ex=2017-07-10   2.51
```
→ 这两行是**同一分配方案的两个分量，必须都留存并求和**，不是重复。

### 2.5 落库模拟（离线复刻 `_upsert_one` 的三条判据，非真库执行）

「现金留存率」= 实际入库现金 Σ / 源站窗内现金 Σ（cutoff=2022）：

| 口径 | 合计 | 600519 | 300750 | 统计明细 |
|---|---|---|---|---|
| **A 现状** | **85%** | 80% | **67%** | `anchor=2 ins=101 skip_nocash=10 skip_noperiod=7` |
| **B 仅修 L1（映射 + 三级回退）** | **98%** | 100% | **67%** | `anchor=2 ins=103` |
| **C B + 收窄 `_westward_dup`** | **100%** | 100% | 100% | `anchor=0 ins=105` |

找回的漏计：**600519 +41.016 元/股**（2022-12-27 / 2023-12-20 两笔无报告期的特别分红，占其留存窗内现金的 **25.6%**）＋ **300750 +7.796 元/股**（3.017+4.779，被 `ex_date` 判据吃掉的兄弟分量）。

> 保真度声明：本模拟为**纯内存复刻**（`dividend_notice_scan.py:372-400` / `:425-438` / `:446-466` 三条判据 + 留存裁剪 + 按 akshare 原始行序），**非真实数据库执行**。Archi 已独立复跑复现一致。
> 对账：Archi 另做「全历史」口径复算，得差 41.6070 = 41.016（两笔特别分红）+ 0.591（2006 股改分红 5.91/10，窗外），与留存窗口径的 41.016 **无矛盾**。

---

## 三、裁决方案（Q1~Q8 结论）

| #      | 裁决项                        | 结论                                                                                                                                                                                                           |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Q1** | 特别分红落哪个 period_type        | **`SPECIAL`**（不是 QUARTERLY、不是按报告期打散）。SPECIAL 槽位本就是为它而设（`enums.py:156`、唯一键含 period_type、`period_label:161-162` 现成）；只有靠 period_type 才能让 300750「年度+特别」**同报告期(2023,4)并存**并被 `_quarter_cell` 正确求和                 |
| **Q2** | 报告期归属口径                    | **`报告时间` 优先**；缺失回退序列 = **报告时间 → 公告日期 → 除权日 → 丢弃+告警**。公告日 = 模型注释明定的 SPECIAL 落格锚点（`models/dividend_yield.py:87`）+ 旧 `_anchor` 同口径；除权日**仅作 tier3 兜底**（owner 已否其为主口径）                                            |
| **Q3** | 未收录/未知标签兜底                 | 现状「一律 QUARTERLY」**危险**（与真实季度行同键，`_locate_cell` 命中即覆盖 → 静默互覆）。改为**显式映射 5 个已知标签**，未知/空 → **`SPECIAL` + WARNING + 独立计数**（不丢弃、不兜 QUARTERLY）                                                                      |
| **Q4** | 股改分红                       | **并入 SPECIAL**（显式映射）。实际是「惰性」的：5 行全在 2006~2007（留存窗外）、4/5 无报告时间、2/5 派息=0 → **无论如何都不会落库**；显式映射只为语义稳定                                                                                                            |
| **Q5** | 撞键护栏                       | 主护栏**不是** SPECIAL 内部撞键（实测 0 组），而是 `_westward_dup`。最小改动：**限定为跨源去重**（仅当已存在行 `source` ≠ 本次 source 才算重复）；并新增「撞键覆盖检测」计数（命中且 `existing.ex_dividend_date != row.ex_dividend_date` → WARNING + `stats["collision"]`） |
| **Q6** | 留存口径（report_year vs 现金流日期） | **不改，记为已知取舍**。收益率分子走「报告期格子」口径（`dividend_yield.py:99-105`），留存按 report_year 与之**自洽**；影响上界 = 1 个边界财年。改口径要动唯一键 + 全量重算，收益不抵风险                                                                                     |
| **Q7** | 是否需 ADR / 修订文档             | **需要**：新增 `ADR-004`（草案见 §8）+ 修订方案文档 6 处行段（见 §5）                                                                                                                                                              |
| **Q8** | `_westward_dup` 判据如何收窄     | **跨源去重**（Archi 方案），优于「(ex_date ∧ cash) 双等」与「(ex_date ∧ cash ∧ period_type) 三等」——它直接编码「只在新旧源并存期挡同源旧行」的原设计意图，且对同源同 ex_date 的合法兄弟分量天然放行。**⚠️ 但必须与 §6 删除顺序联动，见 §9 未决项 #4**                                       |

### 3.1 选项对比

| 选项 | 特别分红 period_type | 报告期口径 | 撞键风险 | 数据完整性 | 结论 |
|---|---|---|---|---|---|
| A 现状兜底 | → QUARTERLY | 仅报告时间（缺失即丢） | **中**（与真实季度行同键互覆） | **低**（600519 丢 25.6%） | ❌ |
| B 按报告期打散 | 按 quarter 反推 ANNUAL/INTERIM/QUARTERLY | 报告时间 | **高**（与真实报告期行同键覆盖） | 低 | ❌ |
| **C 落 SPECIAL + 三级回退 + 去重收窄** | **SPECIAL** | 报告时间→公告日→除权日→丢弃 | **低** | **高** | ✅ **采纳** |
| D 落 SPECIAL 不加回退 | SPECIAL | 仅报告时间 | 低 | 中（仍丢 600519 两笔） | ❌ |
| E 打散 + 无回退 | 按报告期 | 报告时间 | 高 | 低 | ❌ |

### 3.2 对 Q4（原「§6 直删旧 SPECIAL 存量」）的语义反转

原主报告中的 🔴「先删后无」风险**被本裁决消解**：巨潮确实返回 `分红类型=特别分红`（实测 9 行），落 SPECIAL 后新链路会把它们**重新灌回**；§6 的 DELETE 按 `source='新浪-分红配股'` 而新行 source=巨潮接口名 → 互不影响。
**唯一前置**：Q2 的回退必须同时落地，否则 600519 两笔（占 25.6%）仍会被丢。

---

## 四、推荐的精确规格（可直接实现）

**输入** = 一行巨潮 dict；**输出** = `(落库?, 跳过原因, period_type, report_year, report_quarter, anchor_source)`

**period_type 判定表**

| 「分红类型」 | period_type | 备注 |
|---|---|---|
| 年度分红 | ANNUAL | |
| 中期分红 | INTERIM | |
| 季度分红 | QUARTERLY | 实测报告时间=一/三季报，正确 |
| 特别分红 | **SPECIAL** | 本次裁决 |
| 股改分红 | **SPECIAL** | 惰性（窗外） |
| 其他 / 空 | **SPECIAL** + warn + `stats["unknown_label"]` | **不兜 QUARTERLY** |

**报告期三级回退判定表**

| 级 | 取值来源 | 动作 | 告警 |
|---|---|---|---|
| 1 | `报告时间`（`parse_report_period_cn`） | 采用 | 无 |
| 2 | `实施方案公告日期` → `(year, (month-1)//3+1)` | 采用 | WARNING + `stats["period_fallback_ann"]` |
| 3 | `除权日` → 同上 | 采用 | **强制 WARNING** + `stats["period_fallback_ex"]` |
| 4 | 全缺 | **跳过** | **强制告警** + `stats["no_period"]` |
| — | `派息比例` 空/NaN/0 | **跳过**（纯送转） | 计数 `stats["no_cash"]`（**与 no_period 分开**） |

**伪代码**
```python
PERIOD_TYPE_BY_LABEL = {
    "年度分红": ANNUAL, "中期分红": INTERIM, "季度分红": QUARTERLY,
    "特别分红": SPECIAL, "股改分红": SPECIAL,
}

def parse_cninfo_row(row) -> ParseOutcome:
    cash = parse_cash(row["派息比例"])
    if cash is None or cash == 0:
        return SKIP("no_cash")                      # 与 no_period 分桶

    label = str(row["分红类型"] or "").strip()
    pt = PERIOD_TYPE_BY_LABEL.get(label)
    if pt is None:
        pt = SPECIAL
        warn("unknown_dividend_label", label); bump("unknown_label")

    period, src = parse_report_period_cn(row["报告时间"]), "report"
    if period is None:
        ann = parse_date(row["实施方案公告日期"])
        if ann is not None:
            period, src = (ann.year, (ann.month - 1) // 3 + 1), "announcement"
            warn("period_from_announcement"); bump("period_fallback_ann")
        else:
            ex = parse_date(row["除权日"])
            if ex is not None:
                period, src = (ex.year, (ex.month - 1) // 3 + 1), "ex_date"
                warn("period_from_ex_date"); bump("period_fallback_ex")
            else:
                warn("row_dropped_no_period"); bump("no_period")
                return SKIP("no_period")

    return EMIT(pt, period[0], period[1], src)      # anchor_source 仅作审计，不进唯一键
```

---

## 五、改动点清单

### 5.1 生产代码

| 文件:行 | 现状 | 应改为 |
|---|---|---|
| `dividend_cninfo_parse.py:36-39` | 只映射 年度/中期 | 补齐 5 标签（季度→QUARTERLY、特别→SPECIAL、股改→SPECIAL） |
| `dividend_cninfo_parse.py:67-69` | 未收录一律 QUARTERLY | 未知/空 → SPECIAL + warn + 计数 |
| `dividend_cninfo_parse.py:85-87` | 报告期不可解析即 `return None` | 三级回退；全缺才跳过；**区分 `no_period`** |
| `dividend_cninfo_parse.py:82-84` | cash 空/0 → 同哨兵 `None` | 保留跳过，但返回**原因码 `no_cash`** |
| `dividend_cninfo_parse.py:72-100` | 返回 `Optional[CninfoDividendRow]` | 返回带 `reason` 的结果（或 `(row, reason)`），供调用方分桶计数 |
| `dividend_notice_scan.py:361-364` | `parsed is None → _bump(stats,"skip")` | 按 reason 分桶；新增 `unknown_label` / `period_fallback_*` / `collision` 计数 |
| `dividend_notice_scan.py:456-459`（`ex_date` 分支） | 同 ex_date **不分源**即判重 → 丢异笔 | **限定跨源**：`跨源 ∧ 同 ex_date` 才判重；**同源豁免**（否则 300750「年度+特别」同日除权被吞） |
| `dividend_notice_scan.py:461-466`（`(ry,rq,cash)` 分支） | 不分 source | **限定跨源**：`跨源 ∧ (ry,rq,cash) 全等` 才判重；**同源豁免**。⚠️ **不得加 `period_type` 相等条件**（见下方反向陷阱） |
| `dividend_notice_scan.py:376-400`（覆盖路径） | 命中即静默覆盖全部字段 | 覆盖前若 `existing.ex_dividend_date != row.ex_dividend_date`（均非空）→ WARNING + `bump("collision")` |
| `dividend_notice_scan.py:215-216, 500-501, 511-514` | 注释「新链路不再写 SPECIAL」 | 改为「写 ANNUAL/INTERIM/QUARTERLY/SPECIAL」 |
| `dividend_notice_scan.py:468-495`（`_match_proposed`/`_exists_anchor`） | 标注「旧新浪遗留，§3 保留」 | 注释更新：SPECIAL 语义复归，方法**重新可达** |
| `dividend_sync.py:78-95` | 留存按 `report_year < cutoff` | **不改**（Q6 维持 report_year 口径） |

### 5.2 方案文档 `docs/分红采集链路迁移方案.md`

| 行段 | 修订 |
|---|---|
| `:263`（report_year/quarter 行） | 补回退序列 报告时间→公告日→除权日→丢弃 |
| `:264`（period_type 行） | 「其余 → QUARTERLY」→「特别/股改 → SPECIAL；季度 → QUARTERLY；未收录 → SPECIAL+warn」 |
| `:238-242` | 裁剪「年份由报告时间解析」→ 补「缺失时按回退序列」 |
| `:309` | 「删除新浪 SPECIAL 旧行后由巨潮重新灌入」本裁决后**字面成立**，保留并交叉引用 ADR-004 |
| `:334-337`（§5.6 去重） | 补「`_westward_dup` 限定跨源 + 撞键覆盖计数」 |
| `:394` | 「新链路写 ANNUAL/INTERIM」→「ANNUAL/INTERIM/QUARTERLY/**SPECIAL**」 |

### 5.3 契约/前端

`docs/openapi.json` 与 `web/src/types/api.ts` **无需改动**（`ReportPeriodType` 枚举集合未变，SPECIAL 本就在册；前端只需能渲染「XXXX特别分配」，已有测试 `test_dividend_yield_dividends_api.py:82` 断言）。

---

## 六、影响面与兼容性

| 面 | 影响 |
|---|---|
| 唯一键 | `models/dividend_yield.py:43-57` **不变**；SPECIAL 与报告期行异键 → 300750「年度+特别」同格并存，`_quarter_cell`（`dividend_yield.py:99-105`，不按 period_type 过滤）求和 = 50.28/10股 ✅。**前提：Q5/Q8 的去重收窄必须同批修**，否则第二笔仍被丢 |
| 留存清理 | 不变（report_year 口径），Q6 记为已知取舍 |
| `period_label` 展示 | SPECIAL 分支**从不可达变可达** → 详情面板出现「2023特别分配」（已有测试覆盖） |
| `restate_cells` 复权因子 | 特别分红 9/9 无送转 → **零影响**；其现金照常进分子 |
| 历史数据 | §6 删旧源（`source='新浪-分红配股'`）**仍必要**（不删会与新 SPECIAL 行在新旧键上重复累加）；删后须**重跑播种**方可灌回 SPECIAL。**顺序问题见 §9 未决项 #4** |

---

## 七、测试影响矩阵（Tessa）

### 7.1 会被打破的现有断言

| # | 文件:行 | 断言 | 因哪条变更失败 | 置信度 |
|---|---|---|---|---|
| 1 | `tests/test_dividend_notice_scan.py:426` | `assert stats["skip"] == 2` | 跳过计数解耦（no_period 移出）→ 归 0 | **高（必红）** |
| 2 | `tests/test_dividend_notice_scan.py:390` | `assert stats["skip"] == 1`（纯送转） | 仅当纯送转也改名/移出 `skip` | 视实现 |
| 3 | `tests/test_dividend_notice_scan.py:407` | `assert stats["skip"] == 1`（显式 0） | 同上 | 视实现 |
| 4 | `tests/test_dividend_notice_scan.py:297` | `parse_period_type("三季度分红") is QUARTERLY` | 仅当未知标签默认不再 QUARTERLY | 视实现 |
| 5 | `tests/test_dividend_notice_scan.py:298-299` | `parse_period_type("")/(None) is QUARTERLY` | 同上 | 视实现 |
| 6 | `tests/test_dividend_notice_scan.py:293-299`、`:481-500` | 标签→period_type 映射表 | 映射补全后需改断言 | **确定需改** |
| 7 | `tests/test_dividend_notice_scan.py:660-665` | `_match_proposed` SPECIAL 用例 | **保留**（SPECIAL 复归后重新可达） | 不需改 |

另需扩断言（语义漂移但不破）：`:351`、`:498-500`（period_type 分布**未含 SPECIAL**）、`:472-478`、`:505-545`、`test_dividend_seed.py:440-445`（摘要未断言跳过片段）、`test_dividend_period_label.py:8-26`、`test_dividend_yield_dividends_api.py:79-89`、`test_dividend_yield.py:245-258/302-329`。

### 7.1b 主理人仲裁（已定，实施时照此改）

**（1）真实标签集合 = 精确匹配这 5 项（不做前缀/模糊匹配）**

| 「分红类型」 | 实测行数（16 只样本） | → period_type |
|---|---|---|
| 年度分红 | 332 | ANNUAL |
| 中期分红 | 72 | INTERIM |
| 季度分红 | 9 | QUARTERLY |
| 特别分红 | 9 | SPECIAL |
| 股改分红 | 5 | SPECIAL |
| 其他 / 空 | — | SPECIAL + WARN + `unknown_label` |

**（2）`"三季度分红"` 是测试专有字面量，真实数据中不存在** —— 主理人回源码 + 实测标签分布核实。两处引用须改：

| 位置 | 现状 | 应改为 |
|---|---|---|
| `tests/test_dividend_notice_scan.py:297` | `assert parse_period_type("三季度分红") is QUARTERLY` | `assert parse_period_type("季度分红") is QUARTERLY`（变成**真标签回归**） |
| `tests/test_dividend_notice_scan.py:298-299` | `parse_period_type("")/(None) is QUARTERLY` | `is ReportPeriodType.SPECIAL`（未知/空 → fail-visible） |
| `tests/test_dividend_notice_scan.py:491` | `_cn_row(report=f"{cur-1}一季报", ptype="三季度分红", cash="30")` | `ptype="季度分红"`；`:500` 的断言与结构**不变**（保住「季度分红 → QUARTERLY」的结构意图） |
| 新增 | — | `test_parse_period_type_unknown_label_falls_back_to_special`：`"三季度分红"`/`"未知标签"` → SPECIAL（把已删除的 QUARTERLY 兜底固化为红灯） |

**（3）tier2/tier3 命中时季度定义**：`quarter = (锚定日期的 month - 1) // 3 + 1`（自然季度）。唯一键必须有 quarter 才能落库；而 SPECIAL 的展示标签只用 `year`（`period_label` → 「{year}特别分配」），故 quarter 仅承担键位、不影响文案。

**（4）`_westward_dup` 收窄的最终判据 = 跨源限定**（与 Archi Q5 一致）：`跨源 ∧ 各自条件`（`:456-459` = 跨源 ∧ 同 ex_date；`:461-466` = 跨源 ∧ (ry,rq,cash) 全等）。**两分支均不加 `period_type` 相等条件**——旧链路全写 `period_type=SPECIAL`，加它会导致 `SPECIAL ≠ ANNUAL` 而**漏挡跨源重复**，与护栏初衷相反。「同源同格同额异类型被吞」的担忧由**同源豁免**自然消解。

**（5）`test_upsert_idempotent_and_refreshes_dates`（`:505-545`）保留不动**：它守护「同唯一键命中 → 更新路径」（`:508-509` docstring：旧 `(ry,rq,cash)` 全等分支曾永久挡住日期刷新，P0 已移除，**不得反向放宽**）。`_westward_dup` 只在**新增**路径生效（`:449-454`），故本次收窄**不影响**该用例。

**（6）期望值仲裁**：#5 tier2 用 600519 实况（`report=None, 分红类型="特别分红", 派息比例="219.1", 公告日=2022-12-21, 除权日=2022-12-27` → `SPECIAL` + `(2022,4)` + `21.91/股` + 计数含 `period_fallback_ann`）；#6 tier3 再置空公告日 → 由除权日推 + `period_fallback_ex`；#14 用 300750 实况（2.011 + 3.017，同 ex=2024-04-30 → 两行在库、合计 5.028/股、`anchor=0`）。

### 7.2 必须新增用例（≥18 条，2 条高优先级）

| # | 测试函数名 | 输入 → 期望 | 守护风险 |
|---|---|---|---|
| 1 | `test_parse_period_type_special_labels` | "特别分红"/"股改分红" → SPECIAL | Q1/Q4 |
| 2 | `test_parse_period_type_quarterly_explicit_and_unknown_default` | "季度分红"→QUARTERLY；未知/空/None→SPECIAL；" 特别分红 "→SPECIAL(strip) | Q3 |
| 3 | `test_parse_report_period_cn_chinese_and_date_forms` | "2024年报"→(2024,4)、"2025半年报"→(2025,2)、"2024三季报"→(2024,3)、"2024-12-31"/"20241231"/"2024年12月31日"→(2024,4)、非法→None | **该函数现无任何直接单测** |
| 4 | `test_row_report_time_hit_takes_priority` | report 命中 → 忽略 ann/ex | Q2 tier1 |
| 5 | `test_row_report_absent_falls_back_to_announcement` | report=None, ann=2022-12-21, ex=2022-12-27, 特别分红, 219.1 → SPECIAL + 由 ann 推 + 21.91/股 | Q2 tier2（**600519 实况**） |
| 6 | `test_row_report_and_ann_absent_falls_back_to_ex_date` | 由 ex 推 | Q2 tier3 |
| 7 | `test_row_all_sources_absent_dropped_and_counted` | 全缺 → 丢弃 + `no_period` 计数 | Q2 tier4 |
| 8 | `test_skip_counters_decoupled_pure_bonus_vs_missing_period` | 纯送转×1 + 无报告期有派息×1 → 两桶各 1 | 事实 2 |
| 9 | `test_missing_period_with_cash_over_threshold_logs_error` | caplog 捕获告警 | 可观测性 |
| 10 | `test_special_row_persisted_as_special` | 特别分红 + "2023年报" → 落 SPECIAL | Q1 |
| 11 | `test_special_and_annual_coexist_same_report_cell` | ANNUAL(2023,4,X) + SPECIAL(2023,4,Y) → **两行并存** | 唯一键设计 |
| **12** | **`test_westward_dup_does_not_block_special_on_equal_cash`** | **同源**：预置 ANNUAL(2023,4,3.0)，喂 SPECIAL(2023,4,3.0) → SPECIAL **必须插入**、`anchor` 不增（同源豁免）；**跨源**：同字段但 `source` 不同 → **跳过、`anchor` +1** | 钉「跨源限定 + 同源豁免」；⚠️ **判据不得含 `period_type`**（含则漏挡跨源重复） |
| 13 | `test_upsert_special_same_cell_refreshes_not_duplicates` | 同 SPECIAL(ry,rq) 跑两次 → 行数=1 | 幂等 |
| **14** | **`test_same_ex_date_sibling_components_both_persisted`** | 年度(2.011, ex=2024-04-30) + 特别(3.017, ex=2024-04-30) → **两行都在库**，现金合计 5.028/股 | **钉 L2（300750 实况）** |
| 15 | `test_same_ex_date_same_cash_duplicate_is_blocked` | 同 ex_date 同 cash 的跨源重复 → 只留一行 | 防反向回归 |
| 16 | `test_anchor_counter_with_sibling_components` | 上述场景 anchor==0（端到端计数） | 计数正确性 |
| 17 | `test_two_special_same_cell_not_silently_lost` | 两笔 SPECIAL 落同格 → 可发现（抛错/计数/告警），不得静默剩 1 行 | 静默丢失 |
| 18 | `test_special_ex_in_window_but_report_out_of_window` | 报告期窗外、除权日窗内 → 按 Q6 口径断言 | 留存边界 |
| 19 | `test_scan_summary_exposes_split_counters` | 摘要含两个独立计数片段 | 可观测性 |
| 20 | `test_dividends_api_lists_special_and_annual_same_cell` | 同格 SPECIAL+ANNUAL 两条都返回 | 契约 |

### 7.3 元结论：为什么 100% 语句覆盖漏掉了 L1

1. **覆盖率度量「执行过的语句」，不度量「输入域组合」**：`if period is None: return None`（`dividend_cninfo_parse.py:86-87`）被现有用例执行过 → 标记「已覆盖」，但那个输入恰好「丢弃正确」；真实组合「特别分红 ∧ 报告时间=None ∧ 派息>0 ∧ 除权日非空」**从未被构造**。
2. **缺陷是「缺一条决策分支」而非「分支未执行」**：代码里根本没有「报告时间缺失但有派息且有可回退日期」这条路径 — 覆盖率对**没写的分支**天然盲区。
3. **两类跳过共用同一返回值与计数**：丢弃被「无派息或报告期不可解析=N」这一模糊中文摘要**合理吸收**，不产生红灯。
4. **fixture 系统性填满字段**：`_cn_row` 默认 report/ann/ex 全有值，从不做「字段缺失 × 类型 × 派息」交叉。

**反模式清单**：断言计数/返回值而非语义类别；happy-path fixture 一把梭；把 100% 覆盖率当目标；无真实响应回放/黄金样本；唯一键多列却只测单类型组合；跳过路径无可观测性断言。

---

## 八、ADR-004 草案（待 owner 批准后落 `docs/adr/ADR-004-dividend-special-period-type.md`）

```markdown
# ADR-004: 巨潮分红采集——特别分红落 period_type=SPECIAL 与报告期回退口径

**状态:** Proposed
**日期:** 2026-09-20
**关联:** docs/分红采集链路迁移方案.md（§5.3/§5.6/§6）；ADR-002（接口优先级链）

## 背景
分红采集链路由「东财季度海抓 + 新浪逐股补充」迁移到「巨潮 stock_dividend_cninfo 拉全历史」。
巨潮「分红类型」实测 5 类：年度/中期/季度/特别/股改分红。原方案 §5.3 只映射 年度→ANNUAL、
中期→INTERIM，其余兜底 QUARTERLY；且「报告时间」不可解析即整行丢弃。实测暴露三个问题：
1) 特别分红在真实数据里兼有「有报告期」（300750：报告期 2023年报、除权 2024-04-30）与
   「无报告期」（600519 两笔：除权 2022-12-27 / 2023-12-20）两形态；后者被整行丢弃，致
   600519 留存窗内每股现金从 201.34 掉到 160.32（丢 41.016 元/股，25.6%）。
2) 「除权季度 − 报告季度」偏移恒为 +1~+4 季（无 0），故不能用除权日作主锚点（owner 已否决）。
3) 源站把同一次分配拆成「年度分红 + 特别分红」两行（同 ex_date、同 record_date、金额不同；
   如 300750 20.11+30.17=50.28/10股），而 `_westward_dup` 的 ex_date 护栏会静默丢弃第二笔。

## 决策
1. 「分红类型」显式映射 5 个已知标签：年度→ANNUAL、中期→INTERIM、季度→QUARTERLY、
   特别→SPECIAL、股改→SPECIAL；未知/空标签 → SPECIAL + WARNING（不再静默 QUARTERLY）。
2. report_year/report_quarter 归属：报告时间优先；缺失回退 公告日（SPECIAL 既定锚点）；
   再缺回退 除权日（最后兜底，强制告警）；三者全缺 → 丢弃 + 强制告警。
3. `parse_cninfo_row` 区分跳过原因（no_cash / no_period），各分桶计数。
4. `_westward_dup` 限定为跨源去重（仅当已存在行 source ≠ 本次 source）；命中同键但 ex_date
   不同者记 collision 计数并 WARNING，不静默覆盖。
5. 留存继续按 report_year（与报告期格子口径自洽），记为已知取舍。

## 后果
- 正：特别分红现金不再丢失（600519 +41.016 元/股）；「年度+特别」同格可并存且求和正确；
  SPECIAL 展示分支复归；§6 删旧源后 SPECIAL 由巨潮重灌，「先删后无」风险消解。
- 负：新增计数/告警与若干单测改写；`_westward_dup` 语义收窄需回归 P0~P1 并存场景。
- 需重跑：§6 删旧源后须重跑播种（否则 SPECIAL 缺失）——顺序另定，见裁决报告未决项 #4。

## 备选方案
- A 维持「其余→QUARTERLY」：与真实季度行同键互覆、语义错误、丢 600519 两笔 → 否。
- B 按报告期反推 ANNUAL/INTERIM/QUARTERLY：与真实报告期行同键，覆盖丢失 → 否。
- C 落 SPECIAL 但不加回退：仍丢 600519 两笔 → 否。
```

---

## 九、保留意见与未决项

### 9.1 不赞同 / 保留意见（成员 + 主理人）

1. **不赞同「按 report_quarter 反推 period_type」**（选项 B）：会把未知标签行塞进真实报告期行的键，正好触发覆盖丢失。
2. **不赞同「未知标签直接丢弃」**：仅标签未知就丢现金过激；`SPECIAL+warn` 兼顾不丢数 + 不覆盖。
3. **与方案文档既有判断不一致**：`方案:394`「新链路写 ANNUAL/INTERIM（无 SPECIAL）」在全量巨潮数据下**不成立**（实测确有 `分红类型=特别分红`）→ 文档须修订，否则与实现漂移。
4. **Q6 保留**：`_anchor_date`（`dividend_yield.py:239-256`）是**日期口径**、留存是**报告期口径**，本质不同源。当前无害（5 年 vs 短曲线窗口）；**若未来曲线窗口拉长到 >4 年**，会浮现「曲线缺最老 1 年」的边界缺口 → 届时再裁决。
5. **主理人保留（新增）**：Archi 的「跨源去重」方案虽优，但**与 §6 删除顺序存在耦合**（见未决项 #4）。若不解决，可能出现「新行被旧行挡住 → 删旧行后 SPECIAL 为空 → 必须再跑一次 19h 播种」。

### 9.2 未决项（需 owner 拍板）

| #   | 待裁决                                         | 成员建议                          | 主理人意见                                                                                                                |
| --- | ------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | 未知/空「分红类型」处置                                | → SPECIAL + warn              | 同意                                                                                                                   |
| 2   | 股改分红是否并入 SPECIAL                            | 并入（实际惰性）                      | 同意                                                                                                                   |
| 3   | tier3 除权日回退是否放行                             | 放行但**强制告警**                   | 同意（owner 已否其为主口径，兜底可用）                                                                                               |
| 4   | **`_westward_dup` 收窄 × §6 删除 × 播种 的顺序**     | 本次一并修去重                       | **建议把 §6「先采后删」改为「先删旧源 SPECIAL → 再播种」**，否则跨源去重会把新行挡住 → 删旧行后 SPECIAL 为空 → 需再跑 19h 播种。若坚持「先采后删」，须把「删后补跑第二次播种」写进发布计划     |
| 5   | ~~是否接受「跨源去重」而非「…∧ period_type 三等」~~ **已裁决** | 跨源限定，**两分支均不加 `period_type`** | **已定 + 双向验证**：加 `period_type` 会漏挡跨源重复（旧链路全写 SPECIAL）。Tessa 已勘误其 v2 的「identity 分支加 period_type」方向性错误；定稿 = `跨源 ∧ 各自条件` |

---

## ✅ 行动清单

| # | 行动 | 负责角色 | 紧急度 | 预期完成 |
|---|---|---|---|---|
| 1 | owner 对 §9.2 的 5 项未决拍板 | owner | **P0** | 实施前 |
| 2 | 按 §4 规格实现 L1 修复（映射补全 + 三级回退 + 跳过分桶计数） | 工程师 | **P0** | 独立小批提交 |
| 3 | 同批修 `_westward_dup` 两条判据（跨源去重）+ 撞键覆盖计数 | 工程师 | **P0** | 与 #2 同批 |
| 4 | 补 §7.2 的 ≥18 条测试；改 `test_dividend_notice_scan.py:426` 断言 | 工程师/QA | **P0** | 与 #2 同批 |
| 5 | 独立小批提交（**不得与未推送 22 提交合成一批**，否则行数闸门 800 必超） | owner | **P0** | 提交前 |
| 6 | 落 `docs/adr/ADR-004-*.md` + 修订方案文档 6 处行段 | owner/文档 | P1 | 批准后 |
| 7 | 重排 §6 删旧源与播种顺序（按未决项 #4 结论） | ops | P1 | 发布窗口 |

---

## ⚠️ 待完善 / 已知局限

- **落库模拟是离线复刻，非真库执行**：留存率 85%/98%/100% 来自纯内存复刻 `_upsert_one` 三条判据（按 akshare 原始行序），未经真实数据库验证；Archi 已独立复跑复现一致，但仍建议实施后在测试库跑一次端到端落库核对。
- **样本规模有限**：16 只证券。`特别分红` 仅 9 行、`股改分红` 5 行。市场级占比未统计（全市场 11430 只 × 限流 10/min 不可行）。
- **「同源、同 ex_date、同 cash、不同 period_type」的合法分量**是否真实存在，尚未取到实例（未决项 #5 已挂测试护栏）。
- **Q4（§6 旧新浪 SPECIAL 直删）仍未执行**，`DELETE` 语句与存量条数未核对（开发库冻结，硬约束禁连）。
- **方案文档 `docs/分红采集链路迁移方案.md` 在 `git status` 显示 M 但 `git diff` 为空**（CRLF 假象，`AGENTS.md §0` 明列勿提交）——修订该文件时勿顺手纳入。
- 前端仅需渲染「XXXX特别分配」文案，本轮未实际启动前端验证渲染效果。

---

## 📚 数据来源 & 成员产出索引

**主理人（实测与模拟）**
- `.workbuddy/tmp/special_div_semantics.py` → `special_div_semantics_out.txt`：类型分布 / 报告时间缺失率 / 偏移分布 / 特别分红 9 行明细
- `.workbuddy/tmp/special_double_count_check.py` → `special_double_count_out.txt`：类型×报告期交叉表 / 双计检测 / 同格并存检测
- `.workbuddy/tmp/upsert_simulation.py` → `upsert_simulation_out.txt`：离线复刻落库，三口径现金留存率

**Archi（系统架构师）原始产出**
- 裁决规格 Q1~Q7 + 推荐口径判定表与伪代码 + 改动点清单 + ADR-004 正文 + 影响面
- `.workbuddy/tmp/archi_verify.py` → `archi_semantics.txt`（独立复现 A/B/C/D）
- `.workbuddy/tmp/archi_westward.py` → `archi_westward.txt`（量化 `_westward_dup` 静默丢弃）
- `.workbuddy/tmp/archi_desc.py` → `archi_desc.txt`（取证同除权日两笔分红为独立现金）

**Tessa（测试专家）原始产出**
- 测试影响矩阵（被打破断言表 / ≥18 条新增用例 / 元结论 / CI 闸门预判）
- `.workbuddy/tmp/tessa_test_impact_matrix.md`；改前基线 `.workbuddy/tmp/tessa_semantics_baseline.txt`（隔离库聚焦 4 文件 **63 passed / 31.75s / EXIT=0**）

**关联文档**
- 主报告：`docs/reviews/code-review-unpushed-dividend-migration-2026-09-20.md`
- 补充报告：`docs/reviews/supplement-decisions-and-cninfo-retest-2026-09-20.md`
- 设计基准：`docs/分红采集链路迁移方案.md`（§5.3 / §5.6 / §6 / §9.3）

---

> 本报告由工程保障团队 AI 协作生成，关键决策请由人类工程负责人复核。
