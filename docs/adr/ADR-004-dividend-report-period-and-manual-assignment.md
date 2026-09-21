# 分红报告期类型扩展与「无报告期」人工划分（ADR-004）

> 架构师：dolphin738 ｜ 上游输入：分红总报告（合并版）`docs/reviews/review-dividend-manual-period-2026-09-21.md`、增量设计稿 `docs/design-dividend-pending-batches-2026-09-22.md` ｜ 状态：**核心决策已收口；批次 A（枚举 + `dividend_label` + 迁移 `0033`）、批次 B（staging + 迁移 `0034`）、批次 C（pending 七端点 + 契约）已实现并本地提交（未 push）；数据批未执行**
> 变更性质：**分红报告期分类模型扩展 + 新增人工划分队列**（`ReportPeriodType` 扩 5 值 + `dividend_label String(32)` 原文列 + staging 表 `security_dividend_pending` + pending 人工划分 API 与独立页），触及 `models/enums.py`、`models/dividend_yield.py`、迁移 `0033`/`0034`/`0035`、`services/dividend_cninfo_parse.py`、`services/dividend_pending.py`、`services/dividend_notice_scan.py`、`services/dividend_seed.py`、`modules/dividend_yield/pending_router.py`、前端页族。**不改动股息率计算口径**（送转口径见 `ADR-005`）。
> 全部结论均基于本次实测上游（巨潮 `stock_dividend_cninfo`，akshare 1.18.87）与代码核实，非记忆推断。

---

## 0. 决策现状核实（先于记录）

| 项 | 位置（实际代码） | 状态 |
|----|------------------|------|
| 报告期类型枚举 | `backend/app/models/enums.py`：`ReportPeriodType` | ✅ 批次 A 已扩为 **5 值**（`ANNUAL`/`INTERIM`/`QUARTERLY`/`SPECIAL`/`OTHER`），迁移 `0033_extend_report_period_type` |
| 原文标签列 | `backend/app/models/dividend_yield.py`：`SecurityDividend.dividend_label String(32)` | ✅ 批次 A 已加（**不入唯一键**） |
| 唯一键 | `security_dividends`：`uq_security_dividends_master_period(master_id, report_year, report_quarter, period_type)` | ✅ 不变；`dividend_label` 刻意不入键 |
| staging 表 | `backend/app/models/dividend_yield.py`：`SecurityDividendPending`（表 `security_dividend_pending`） | ✅ 批次 B 已加，迁移 `0034_create_dividend_pending`；`row_fingerprint String(40)` sha1 幂等键 |
| staging 写入口 | `backend/app/services/dividend_pending.py:stage_pending` / `services/dividend_notice_scan.py`（`no_period` 分支） | ✅ 批次 B：现金 >0 且「报告时间」不可解析 → 入队 |
| pending 端点 | `backend/app/modules/dividend_yield/pending_router.py`（7 端点） | ✅ 批次 C 已加，契约重生成后 openapi paths 96 → 103 |
| 前端页族 | `web/src/modules/admin/pages/PendingDividendsPage.vue` 等 | ✅ 批次 D 已加（独立路由 `/admin/pending-dividends`，无侧边栏项） |
| 数据批（删旧源 + 播种 + 人工划分） | — | ❌ **未执行**（依赖巨潮接口复测恢复 + 开发库冻结解除，见 `docs/分红采集链路迁移方案.md` §6） |

**结论**：分类扩展（枚举 5 值 + `dividend_label` + staging 队列 + 人工划分 UI）的**代码侧已落地**（批次 A/B/C/D，本地提交未 push）；报告期分类模型从「闭集假定」修正为「非闭集 + 显式默认桶」，「无报告期」从「静默丢弃」修正为「入队待人工划分」。

---

## 1. 背景与问题

旧链路（新浪逐股分红补充/回补）把报告期类型当作**闭集**处理，且对「报告时间不可解析」的行**整行丢弃**。本次以巨潮 `stock_dividend_cninfo` 为新明细源重做采集链路（见 `ADR-002` 修订补记）时，实测出三条推翻闭集假定的真实事实：

**事实 ①：源站「分红类型」词表非闭集。**
最初在 30 只 / 817 行样本上只看到 **5 个**标签（年度 657 / 中期 124 / 特别 18 / 季度 11 / 股改 7），据此误判为闭集；扩到 **600 只随机 / 6076 行**实测出 **7 个**：年度 5446 / 中期 483 / 季度 98 / 股改 21 / 特别 14 / **重整转增 12** / **承诺补偿 2**。独立抽样 537 行复现了 `重整转增`（`002822`）。（注：`重整转增`/`承诺补偿` 实测派息恒为 0 → 会被「无派息跳过」拦下，实际不进「其他」桶，但兜底映射仍必要。）

**事实 ②：源站把「同一次分配」拆成多行，不是重复行。**
同 `ex_date`、同 `record_date`，金额不同：
```
300750 2023Q4  年度分红 ex=2024-04-30  20.11/10股 → 2.011/股
300750 2023Q4  特别分红 ex=2024-04-30  30.17/10股 → 3.017/股   ← 同 ex_date
                20.11 + 30.17 = 50.28/10股 = 该次完整分配方案
```
`601088 2017` 同为「年度 0.46 / 特别 2.51，同 `ex_date` 2017-07-10」。**两行必须都留、求和才是完整方案**；旧 `_westward_dup` 的跨源 `ex_date` 判据会误杀同日除权的兄弟分量（300750 少 7.796 元/股 = 33%）。

**事实 ③：股改分红实测集中 2006~2007，大概率永不落主表。**
股改分红集中在 **2006~2007**（`retention_cleanup` 按 `report_year < cur-4` 删除 → 落在留存窗外），且 **80% 无报告时间**。为它单列一个枚举值（`SHARE_REFORM`）需要一次 `ADD VALUE` 迁移，换来的只是「语义正确性」而非任何可见性收益。

**附带缺口**：旧映射 `_PERIOD_TYPE_BY_LABEL` 只有 年度/中期，**未收录一律兜 `QUARTERLY`** → 真实的 特别/季度/股改 全落 `QUARTERLY`，`SPECIAL` 槽位空置；且「报告时间」不可解析 → 整行丢弃（600519 丢 41.016 元/股 = **25.6%** 现金）。

---

## 2. 决策内容

| 项 | 决策 | 理由 |
|----|------|------|
| 报告期类型 | `ReportPeriodType` 扩为 **5 值**：`ANNUAL`/`INTERIM`/`QUARTERLY`/`SPECIAL`/**`OTHER`** | `OTHER` 作非闭集词表的兜底桶，避免「未收录 → 误落 `QUARTERLY`」 |
| 原文标签 | 新增 `dividend_label String(32)` 可空列（**不入唯一键**） | 承载「详细区分」与撞键判别；前端据此呈现原文「股改分红」等 |
| 股改分红 | **并入 `OTHER`**，**不单列 `SHARE_REFORM`** | 实测集中 2006~2007（留存窗外）+ 80% 无报告时间 → 大概率永不落主表；单列换不来可见性收益 |
| 「无报告期」行 | 从「整行丢弃」改为 **入 staging 队列**（`security_dividend_pending`），由人工划分报告期 | 携带真实现金却被丢弃，是本链路最大现金流失点（25.6%）；入队后可人工兜底 |
| 幂等键 | staging 用 `row_fingerprint String(40)`（sha1 文本列） | 复合键含可空日期，PG 唯一索引对 NULL 视为互不相等，无法幂等 |
| 撞键护栏 | 命中主表同格（`master_id`+`report_year`+`report_quarter`+`period_type`）且标签不同 → 告警 + **保留旧值不覆盖** | `OTHER` 成为 catch-all ⇒ 撞键护栏成为必需 |

### 2.1 标签判定表（04:45 改判后）

`年度→ANNUAL｜中期→INTERIM｜季度→QUARTERLY｜特别→SPECIAL｜股改→OTHER（dividend_label="股改分红"）｜其他/空/未知（含 重整转增、承诺补偿）→OTHER + WARN + stats["unknown_label"]`。

**展示文案**：`OTHER` → `"{year}其他分红"`（quarter 仅作键位、不进文案）；股改通过 `dividend_label` 呈现原文「股改分红」。

### 2.2 staging 队列与人工划分

- **入队条件**：仅「现金 > 0 且报告时间不可解析（`no_period`）」入队；纯送转（`no_cash`）与窗口外行**不入队**。
- **幂等**：`stage_pending` 走 `pg_insert(...).on_conflict_do_nothing(index_elements=["row_fingerprint"])`，**仅新插入返回 True**。
- **不计入变更集**：staging 不参与 `changed` 计数，调用方**不得**因入队而把 `mid` 加入派生快照重算集。
- **人工划分 API**（`/api/dividend-yield/pending-dividends`，读 `admin`/`auditor`、写仅 `admin`）：list（固定排序 `created_at DESC, id DESC`，无 `sort` 参数）/ summary / assign / batch-assign / ignore / batch-ignore / reopen。
- **assign 语义**：取 pending 行 → 非 `PENDING` 返回 404/409 → 校验报告期合法 → 主表同键命中则 `conflict=True` **保留旧值不覆盖**；未命中则 `INSERT ... ON CONFLICT DO NOTHING`；随后 pending 行置 `ASSIGNED` + `resolved_*`（`resolved_period_type` 存**字符串** `ReportPeriodType.value`）。**assign 后不删 pending 行**（删了会因 fingerprint 缺失去重而在下次 scan 复活）。
- **reopen 语义**：仅 `ASSIGNED` 可撤销；按 `resolved_*` 组主表唯一键 `DELETE` 命中行（`rolledBack = 删除行数>0`）→ pending 回 `PENDING` 并清空 `resolved_*`。

---

## 3. 被否决 / 替代方案

| 方案 | 表述 | 否决理由 |
|------|------|----------|
| A2 粗分 + 标签列（不扩枚举） | 只加 `dividend_label`，`period_type` 不加 `OTHER` | **弱**：特别/股改同为 `QUARTERLY` → **必撞键**，架空唯一键去重设计 |
| A3 字典表 | 标签走独立字典表管理 | 过度设计，迁移成本高 |
| 为股改单列 `SHARE_REFORM` | 枚举加第 6 值承载股改 | 股改集中 2006~2007（留存窗外）+ 80% 无报告时间 → 大概率永不落主表；多付一次 `ADD VALUE` 迁移却无可见性收益 |
| 「无报告期」继续整行丢弃 | 维持旧行为 | 丢弃真实现金（600519 丢 25.6%），是本链路最大现金流失点 |
| 人工划分用大 Dialog / 抽屉 | 不做独立路由页 | 批量与跨筛选防误、选中态管理复杂度高；独立页可承载筛选/分页/批量，见 `review-dividend-manual-period` §5.3.1 |
| assign 覆盖主表旧值（`DO UPDATE`） | 人工划分直接覆盖同格 | D-3 拍板「不覆盖」：`OTHER` catch-all 下误覆盖会丢真数据 → 命中共格即保留旧值并告警 |

---

## 4. 后果与回退

| 维度 | 影响 | 处理 |
|------|------|------|
| `OTHER` 成 catch-all | **撞键护栏成为必需**（命中主表同格且标签不同 → 告警 + 保留旧值不覆盖） | assign 走 `ON CONFLICT DO NOTHING` + `conflict=True` 可见；`stats["unknown_label"]` 计数兜底 |
| 队列**无 `report_year`** | **不随留存清理** ⇒ 需独立龄期策略 | 当前裁决 **E5 = 不清理**（队列深度 × 龄期即新的失败度量，见下）；将来若清理须另立策略 |
| 失败度量口径变了 | 从「**静默丢失多少行**」转为「**队列深度 × 龄期**」 | 队列永不消费时**等效于丢失且没有红灯** → 运维须以队列深度为监控指标，不能只看「摘要报完成」 |
| 源站词表非闭集 | 前端**不得硬编码标签集合** | 由后端 `GET /pending-dividends/summary` 返回 `labels[] = sorted(set(KNOWN_LABELS) ∪ {表内 DISTINCT 非空 label})` |
| 迁移原子性 | `0033` 含 `ADD VALUE` → **非原子**（与 `0004` 同款既有取舍） | `ADD VALUE IF NOT EXISTS` 可重跑自愈；`0034`/`0035` 单事务原子；`0034.downgrade` 必须先 `drop_table` 再 `DROP TYPE` |
| 回退 | 如需回到「闭集 + 丢弃」旧行为 | 从 git 历史恢复旧 `_PERIOD_TYPE_BY_LABEL` 与 `no_period` 分支；staging 表可 `DROP`（迁移 `0034.downgrade`），pending 端点与页族可下线（OpenAPI 契约随之回落） |

---

## 5. 落地范围（分阶段，实施状态如实）

1. **批次 A（已实现，本地提交）**：`ReportPeriodType` 扩 5 值 + `SecurityDividend.dividend_label` + 迁移 `0033_extend_report_period_type` + 映射补全 + 「无派息/无报告期」分桶 + `period_label` 新增 `OTHER` 分支 + 撞键护栏。
2. **批次 B（已实现，本地提交）**：`DividendPendingStatus` 枚举 + `SecurityDividendPending` 模型 + 迁移 `0034_create_dividend_pending` + 三条强制注册 + `parse_pending_row` / `pending_fingerprint` / `stage_pending` + scan/seed 落 staging。
3. **批次 C（已实现，本地提交）**：`pending` 服务层（list/summary/assign/batch_assign/ignore/batch_ignore/reopen）+ 迁移 `0035_add_dividend_retention_years`（D-4 留存窗配置化）+ 七端点 + 全部 `response_model` + E6 契约缺口修复 + 契约重生成（openapi paths 96 → 103）。
4. **批次 D（已实现，本地提交）**：前端独立路由页 `/admin/pending-dividends`（无侧边栏项，入口为「补齐历史分红」区块内按钮）+ 建议报告期纯函数 + composable + `dividendLabel` Badge。
5. **数据批（未执行）**：备份 → 部署迁移 → **先删旧源** → **立即播种（≈19h，一次）** → 人工划分。详见 `docs/分红采集链路迁移方案.md` §6。

> **三条强制注册（漏一必红）**：`app/models/__init__.py` 双注册 `SecurityDividendPending` / `DividendPendingStatus`；`tests/test_models.py` 表清单补 `security_dividend_pending`；枚举名清单补 `DividendPendingStatus`。

---

## 6. 参考

- `docs/reviews/review-dividend-manual-period-2026-09-21.md` — 分红总报告（三事实实测 + 缺陷全景 + 落地规格）
- `docs/design-dividend-pending-batches-2026-09-22.md` — 批次 B~E 增量设计稿（staging / 七端点 / 配置化 / 页族）
- `docs/分红采集链路迁移方案.md` §5.3 / §6 — 字段映射与存量数据迁移时序（本次已同步）
- `backend/app/models/enums.py` — `ReportPeriodType` / `DividendPendingStatus`
- `backend/app/models/dividend_yield.py` — `SecurityDividend.dividend_label` / `SecurityDividendPending`
- `backend/alembic/versions/0033_extend_report_period_type.py` / `0034_create_dividend_pending.py` / `0035_add_dividend_retention_years.py`
- `backend/app/services/dividend_cninfo_parse.py` — `parse_pending_row` / `pending_fingerprint`
- `backend/app/services/dividend_pending.py` — `stage_pending` / `list` / `summary` / `assign` / `reopen`
- `backend/app/modules/dividend_yield/pending_router.py` — pending 七端点
- `docs/adr/ADR-005-bonus-share-market-neutral-and-ex-dividend-restatement.md` — 送转口径（关联决策）
- `docs/adr/ADR-002-quote-interface-priority-chain.md` — 分红明细源切换修订补记
