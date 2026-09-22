# 分红总报告（合并版）· 采集链路迁移 / 分类扩展 / 人工划分报告期 / 旧源清理

**日期**：2026-09-21
**工作流**：工作流 1（代码审查）+ 工作流 2（系统设计 / 决策）
**合并来源**：`code-review-unpushed-dividend-migration-2026-09-20.md`（22 提交审查的分红侧）、`supplement-decisions-and-cninfo-retest-2026-09-20.md`（决策落地 + 接口复测）、`review-dividend-special-period-semantics-2026-09-20.md`（语义裁决）
**分工**：**非分红部分**（工程闸门 / 发布编排 / PG 迁移机制 / 环境治理）已并入 `review-non-dividend-engineering-2026-09-21.md`，本报告不再重复。
**参与成员**：Archi（系统架构师）、Rex（SRE）、Tessa（测试专家）、Cody（代码审查，前两轮）；主理人（实测复核与落库模拟）

---

## 📌 TL;DR（执行摘要）

- **🔴 最重要缺陷**：巨潮「**特别分红**」行被**静默丢弃** —— 因其「报告时间」常为空。真实数据量化：600519 留存窗内每股派息 **160.32 → 201.34 元/股，丢 41.016 元/股 = 25.6%**。
- **缺陷是三层的**（不是单点）：L1 标签映射缺失 + 报告期缺失即丢；L2 `_westward_dup` 的 `ex_date` 判据误杀**同日除权的兄弟分量**；L3 `(ry,rq,cash)` 判据缺源限定。**离线复刻落库模拟：现金留存率 85% → 98%（只修 L1）→ 100%（三层全修）。**
- **owner 三项终局裁决**：① 未知/空标签 → **「其他」独立分类**；② **股改分红不并入 SPECIAL** —— **04:45 再改判：不单列 type，改入「其他」**（原文标签由 `dividend_label` 保留）；③ 报告期**不回退**，无报告期行**落 staging 交人工划分**。
- **落地规格**：`ReportPeriodType` 扩为 **5 值**（+`OTHER`；股改改入「其他」） + 新增 `dividend_label`（原文标签）列；新表 `security_dividend_pending` 承载待办；前端**独立页为主 + 管理端入口**。
- **旧源处置**：**走增量改造，不清空重构**；旧源代码已删净，**旧源数据必须先删再播种**（否则浪费 2×19h 播种）。
- **⚠️ 我自己的三处结论被实测推翻**（§4）：标签词表**不是闭集 5 项而是 7 项**；待人工规模**不是 1~2% 而是 0.05%**；`_code_of` **不是活代码**。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| 整体评级 | 🟡 **有条件通过** —— 设计完整可实施；需 owner 拍板 **9 项分红相关未决**（§11） |
| 阻塞项 | 2（owner 未决项；行数闸门拆批纪律，见非分红报告 A1） |
| 关键行动项 | 10 条（见 ✅ 行动清单） |
| 建议下一步 | owner 拍板 §11 → 按 §9 的 5 小批落地 → 部署迁移 → **先删旧源再播种（一次）** → 前端处理待办队列 |

---

## 一、范围、基线与继承关系

| 项 | 事实 |
|---|---|
| 审查对象 | `cnb/main..HEAD` = **22 提交 / 35 文件 / +2717 −2483**（分红采集链路迁移 P0/P1/P2/P6 + §4.7） |
| 分支状态 | `main` 领先 `cnb/main` **22 / 落后 0** → **全部未推送** |
| 上一轮报告的状态 | `review-dividend-special-period-semantics-2026-09-20.md` 的 **Q2 / Q3 / Q4 已被 owner 改判作废**（该报告顶部已加横幅）；其 **Q1 / Q5 / Q6 / Q7 / Q8 仍有效**，已并入本报告 §5 / §8 |

**作废条款对照**（避免误用旧规格）：

| 旧条款 | 状态 | 现口径 |
|---|---|---|
| Q2 报告期**三级回退** | ❌ 作废 | **不回退** → staging 交人工 |
| Q3 未知/空标签 → SPECIAL | ❌ 作废 | → **OTHER** |
| Q4 股改并入 SPECIAL | ❌ 作废 | → 先定 `SHARE_REFORM` 独立，**04:45 owner 再改判：不单列 type，改入「其他」（`dividend_label` 保留原文标签）** |
| Q1 特别分红 → SPECIAL / Q5 撞键护栏 / Q6 留存口径不改 / Q7 ADR / Q8 跨源去重 | ✅ 有效 | 见 §5 |

---

## 二、实测证据（真实上游，非构造数据）

### 2.1 巨潮接口复测：C1 硬闸门已解除

- `akshare 1.18.87` 的 `stock_dividend_cninfo` 正常返回：**600519 = 31 行 / 000001 = 29 行 / 300750 = 13 行**；**11 列中文列名与 `dividend_cninfo_parse.py:23-33` 逐字一致**。
- 300750 复跑遇代理 `502 Bad Gateway` → **已恢复但有抖动**，保留观测。
- **端到端首次实证**（原方案自认「本机无法做」）：3 样本 73 行 → 解析成功 67 / 跳过 6 / 异常 0；单位换算 raw 6.0→0.6、25.2→2.52、219.1→21.91 ✅；报告期 `'2001年报'→(2001,4)`、`'1999半年报'→(1999,2)`、`'2024三季报'→(2024,3)` ✅。
- ⚠️ **脚手架假红灯留痕**：首版把 pandas `Series` 喂 `parse_cninfo_row` 得「成功 0/跳过 31」，实因 `row_get`（`response_path.py:147-174`）规格是「dict 走路径 / list 单段纯数字走下标 / **其余返回 None**」。**是脚手架缺陷非产品缺陷**。教训：**喂给 `_row_get` 的行必须是 dict/list，不能用 pandas Series。**

### 2.2 标签词表与「报告时间」缺失率

| 口径 | 结果 |
|---|---|
| 我 30 只 / 817 行 | **5 标签**（年度 657 / 中期 124 / 特别 18 / 季度 11 / 股改 7）—— 后证明样本偏差 |
| Archi **600 只随机** / 6076 行 | **7 标签**：年度 5446 / 中期 483 / 季度 98 / 股改 21 / 特别 14 / **重整转增 12** / **承诺补偿 2** |
| 我独立抽样 537 行复核 | **复现 `重整转增`**（`002822`，2 行）；并 3/3 复现 Archi 点名的 `601828`/`300770`/`600483` |

**「报告时间」缺失集中在两类**：`特别分红`（600 样本 2/5652；16 样本 4/9）、`股改分红`（80%）；年度/中期/季度**零缺失**。

### 2.3 偏移分布（owner 否决意见的数据支撑）

```
「除权季度 − 报告季度」： +1季×53  +2季×198  +3季×163  +4季×4
offset = 0（同季）的行数 → 0
```
→ 除权日季度与报告期季度**从不相同**，「按除权日占位」是**系统性错位 1~4 个季度**。

### 2.4 落库模拟（离线复刻 `_upsert_one` 三条判据，非真库执行）

| 口径 | 现金留存率 | 600519 | 300750 |
|---|---|---|---|
| **A 现状** | **85%** | 80% | **67%** |
| **B 只修 L1** | **98%** | 100% | **67%** |
| **C 三层全修** | **100%** | 100% | 100% |

找回：600519 **+41.016 元/股**（21.91 + 19.106）；300750 **+7.796 元/股**（3.017 + 4.779）。

### 2.5 源站把「同一次分配」拆成多行（关键新事实）

```
300750 2023Q4  年度分红 ex=2024-04-30  20.11/10股 → 2.011/股
300750 2023Q4  特别分红 ex=2024-04-30  30.17/10股 → 3.017/股   ← 同 ex_date、同 record_date
                20.11 + 30.17 = 50.28/10股 = 该次完整分配方案
300750 2025Q4  年度分红 ex=2026-04-22 21.78 ／ 特别分红 ex=2026-04-22 47.79
601088 2017    年度分红 ex=2017-07-10  0.46 ／ 特别分红 ex=2017-07-10  2.51
```
→ **必须两行都留、求和才对**，不是重复。

---

## 三、缺陷全景（分红侧，含 22 提交审查全部发现）

| # | 严重度 | 缺陷 | 位置 | 机制 / 量化 |
|---|---|---|---|---|
| **L1a** | 🔴 | 标签映射缺失：`_PERIOD_TYPE_BY_LABEL` 只有 年度/中期，**未收录一律兜 QUARTERLY** | `dividend_cninfo_parse.py:36-39`、`:67-69` | 真实的 特别/季度/股改 全落 QUARTERLY；SPECIAL 槽位空置且 `period_label` 的「YYYY特别分配」分支不可达 |
| **L1b** | 🔴 | 「报告时间」不可解析 → 整行丢弃（含真实现金） | `dividend_cninfo_parse.py:85-87` | 600519 丢 41.016 元/股 = **25.6%**；与「纯送转跳过」共用同一 `None` 与同一计数，无法区分 |
| **L2** | 🔴 | `_westward_dup` 的 `ex_date` 判据**不分源**，误杀同日除权的兄弟分量 | `dividend_notice_scan.py:401-405` → `:456-459` | 300750 少 **7.796 元/股 = 33%**；**丢哪一半取决于源站行序** |
| **L3** | 🟠 | `(ry,rq,cash)` 判据缺源限定 | `:461-466` | 架空「SPECIAL 与 ANNUAL 可同格并存」的唯一键设计 |
| **D1** | 🟠 | `0031` 迁移三处缺陷 | `0031:22/34/64/75` | ① `_ENUM_VALUES_ALL` 缺 `DIVIDEND_SPECIAL_BACKFILL` → **反向迁移链在 `0015:37` 处断**；② `enabled=TRUE` 与自身 docstring「默认禁用」及方案 §4.3 矛盾（`0008:65/76` 为 FALSE）；③ 注释「当前 10 个值」**实为 11** |
| **D2** | 🟠 | 播种端点**无单飞锁** | `backfill_router.py:67-90` | 连点即并发多个 **19h** 全市场任务，双倍打满 `rate_limit=10/min` |
| **D3** | 🟠 | `except Exception` **无日志、不冒泡** | `notice_scan.py:254`、`dividend_seed.py:99` | 上游整体失效时 11430 只被吞成 `skipped`，摘要仍报「完成」，scheduler 记 **SUCCESS**。对照 `dividend_yield_refresh.py:158-160` 有正确写法 |
| **D4** | 🟠 | UI 承诺的日志落点不存在 | `GlobalSettingsDividendInitBlock.vue:88`、`backfill_router.py:89` | 弹窗说「进度可在定时任务日志查看」，但播种不写 `job_run_logs`，只 python logger 打点 |
| **D5** | 🟡 | `restate_cells` 三边界 | `dividend_yield.py:156-197` | ① **非幂等**（无重入标记，二次调用重复缩股）；② `splits` **不过滤 status** → REJECTED 污染他笔复权基准；③ `i_date is None` 时套用 as_of 前**全部**送转因子（方案 §9.1 未定义该情形）。当前调用方均喂新投影故未触发 |
| **D6** | 🟡 | 死代码簇（基于已废弃语义） | `notice_scan.py:66/468/488/497` | `_TITLE_SPECIAL_RE`/`_match_proposed`/`_exists_anchor`/`_has_proposed` 生产零调用（MCP 图谱复核：零入边）→ 方案 §3「保留清单」失真 |
| **D7** | 🟡 | 4 个覆盖空洞 | 删除 `test_dividend_special_backfill.py`（−843 / 23 用例）后 | 19 个有等价替代；**4 个空洞**：`_reresolve_detail_safe` 真失效 fail-fast、L-3 过程异常续跑、`anchor` 计数端到端、scan 无明细源注记 |
| **D8** | 🟡 | 跨模块私有符号耦合 | `dividend_seed.py:31/68/91/108` | seed 调 scan 的 `_bump`/`_resolve_detail_itf`/`_settings`；`dividend_cninfo_parse.py:20` 还 import `market_data_sync._row_get` |
| **D9** | 🟡 | 逐只容错骨架重复 ≈30 行 | `notice_scan.py:232-264` vs `dividend_seed.py:81-108` | 同源逻辑未抽公共函数 |
| **D10** | 🟡 | 单只采集能力归属错位 | `notice_scan.py:347-370` | `fetch_and_upsert_master`（巨潮单只采集）长在「每日公告扫描」类上，却被播种依赖 |
| **D11** | 🟡 | 单文件超 400 行 | `notice_scan.py` **537** | 而 `dividend_cninfo_parse.py:4` 声称「已压回 400 行内」，不实；CI 不拦（800 才拦） |
| **D12** | 🟢 | 模块命名与内容不符 | `backfill_router.py:1-7,25-90` | 已无 backfill，只剩 rebuild + seed |
| **D13** | 🟢 | 移除主源后注释/文案残留 | `settings_router.py:96-104`、`use-dividend-yield.ts:157`、`dividend-yield.api.ts:120` | 仍写「主源/行情源」「股息主源 / 补充源候选」 |

### 3.1 反证（已确认无问题，勿重复怀疑）

后端隔离库 **675 passed / 0 failed**；前端 **573 passed** + `vue-tsc` app+e2e `RC=0`；覆盖率 finance_core **96.13%** / services **72.96%** / app **77.63%**；ruff `All checks passed`；import-linter `4 kept, 0 broken`；openapi paths **96=96**、无 `backfill-specials`/报告源残留；3 个迁移在 fresh 库**往返可逆**；`0032` 只删主源列、`announcement_source_interface_id` 未误伤；`parse_cash` 确有 ÷10；`_code_of` 未被误伤（collection 不崩）；`restate_cells` 三调用点各恰一次、无二次复权；其 O(n²) 因输入是单只记录集（n≤20）**非性能问题**；`SecurityDividend` 全 `app/` **只有 1 处构造点** → 无「双真源」风险。

---

## 四、⚠️ 我自己三处结论被推翻（诚实留痕）

| # | 我此前的结论 | 实测 | 影响 |
|---|---|---|---|
| 1 | 「标签词表是**闭集 5 项**」（30 只/817 行） | 600 只随机 → **7 项**；我独立抽样复现 `重整转增` | ❌ 推翻 → **默认分支必须存在**；owner 的「未知→其他」**是必要裁决** |
| 2 | 「待人工规模 **1~2%**」 | 随机样本 **3/5652 = 0.05%** → 全市场估**数十行** | ❌ 高估约 **20 倍**（大市值偏差）→ 批量 UX 是加分项 |
| 3 | 「`_code_of` 是活代码、被 `response_fields.py` 引用） | 那三处是 **docstring/注释文字**；MCP 图谱确认零生产入边 | ❌ 推翻 → 它是**测试导入符号**，删需连带改 6 处 |

> 附：`重整转增`/`承诺补偿` 实测**派息恒为 0** → 会被「无派息跳过」拦下，实际不进「其他」桶；但兜底映射仍必要。

---

## 五、三项裁决的落地规格

### 5.1 分类扩展（A 节）

**推荐 = A1 + A2 混合**：`ReportPeriodType` 扩 **5 值**承载唯一键 + **新增 `dividend_label String(32)` 可空列**（原文标签，**不入唯一键**）承载「详细区分」与撞键判别。**不采纳字典表 A3**（过度设计）。

> 🔄 **owner 2026-09-21 04:45 改判：股改分红不再单列 `SHARE_REFORM`，改入「其他」（`OTHER`）**
> 依据（实测）：股改分红集中 **2006~2007 → 留存窗外**（`retention_cleanup` 按 `report_year < cur-4` 删），且 **80% 无报告时间** → **大概率永不落主表**；为它单列枚举值要付一次 `ADD VALUE` 迁移，换来的只是「语义正确性」而非任何可见性收益。
> ⇒ 枚举 **5 值**（ANNUAL/INTERIM/QUARTERLY/SPECIAL/OTHER）；迁移只需 `ADD VALUE 'OTHER'` **一个值**；`period_label` 只需新增 `OTHER` 分支。原文标签仍写 `dividend_label="股改分红"`，前端据此呈现细节。

| 维度 | **A1 扩枚举（5 值）** | A2 粗分 + 标签列 | A3 字典表 |
|---|---|---|---|
| 唯一键去重 | **强** | **弱**（特别/股改同为 QUARTERLY → 必撞键） | 中 |
| 「详细区分」展示 | 中 | **最强** | 强 |
| 复权因子 / 留存 | 无影响 | 同左 | 同左 |
| 迁移成本 | **低**（只需 1 个 `ADD VALUE`） | 中 | **高** |

**标签判定表（04:45 改判后）**：年度→ANNUAL｜中期→INTERIM｜季度→QUARTERLY｜特别→SPECIAL｜**股改→OTHER**（`dividend_label="股改分红"`）｜其他/空/未知（含 `重整转增`、`承诺补偿`）→**OTHER** + WARN + `stats["unknown_label"]`。
**展示文案**：只需新增 `OTHER` → `"{year}其他分红"`（quarter 仅作键位，不进文案）；股改通过 `dividend_label` 呈现原文「股改分红」。

**「其他」撞键护栏**（复刻 L3 教训）：`_locate_cell`（`:425-438`）命中后比对 `dividend_label`（辅以 `ex_dividend_date`），标签均非空且不同 → `stats["collision"]` + WARNING + **保留旧值不覆盖**。合法刷新天然豁免（同一事件重扫标签必相同）。

> **4+2 不够**（保留原论证）：股改若与特别共用 **SPECIAL**，同 (master,ry,rq) 会撞唯一键。现改判为「股改→OTHER」后此顾虑消失，但 OTHER 成为 catch-all ⇒ **撞键护栏成为必需项**（见上一节）。

### 5.2 无报告期行 → staging + 人工划分（B 节）

- **表 `security_dividend_pending`**；幂等键 = **`row_fingerprint`**（sha1，避开「复合唯一键含可空日期 → PG NULL 不相等」）；重复 scan 用 `ON CONFLICT DO NOTHING`。
- **保留**原始列：分红类型、派息、送股、转增、登记日、除权日、**派息日**、公告日、**报告时间原文**；不保留股份到账日、分红说明。
- **`status` = 原生枚举 `DividendPendingStatus`**（PENDING/ASSIGNED/IGNORED）；`resolved_period_type` 刻意用 **`String(16)`（非 native enum）**。
- **⚠️ assign 后置 `ASSIGNED`、不删行**：删行会因 fingerprint 唯一键缺失而在下次 scan **复活**。
- **写入主表用 PG 原子 upsert**：`INSERT ... ON CONFLICT (master_id, report_year, report_quarter, period_type) DO UPDATE` → 解决与每日 scan 并发的「双 INSERT → IntegrityError」。
- **API**（全 `require_admin`）：`GET /pending-dividends`（分页+筛选）、`GET /pending-dividends/summary`、`POST /{id}/assign`、`POST /batch-assign`、`POST /{id}/ignore`、`POST /batch-ignore`。**建议不由后端返回 `suggested*`**（后端永不判定报告期）。

### 5.3 前端方案（Archi 可实施级规格）

#### 5.3.1 入口形态：**A 路由跳转独立页**（推荐）｜B 大 Dialog/抽屉（**不推荐**）

owner 已定：**管理端「补齐历史分红」区块内只放 1 个按钮**，文案「**待人工划分 N 笔**」（N ← `GET .../pending-dividends/summary`），点击后**路由跳转到承载全部操作的独立页**（形态 = A）。

**🟢 入口安置（P1，已定）**：独立路由页 **不挂常驻侧边栏菜单项**，按钮是当前唯一的入口。选 P1 的理由——待办量仅全市场 0.05%（数十行），属偶发低频维护动作，给永久导航位（P3）是过度暴露；按钮本身在 N>0 时即「待办指示器」，足够可达。侧边栏项（N>0 时条件显示 + 数字徽标）降为**可选增强 P2**，本批不做（见 §5.3.8 D-2）。

**B 的六项具体代价**（这是选 A 的依据，不是审美问题）：
1. **表头 sticky 退化**：reka-ui `Dialog` 走 Portal 挂 `document.body`（`web/src/components/ui/dialog/index.ts:1`），首列 `sticky left-0` 仍可用，但表头 `sticky top-0` 会退化到 viewport；双轴 sticky 需手工分层 `z-index`（表头 20 / 首列 10），易碎。
2. **双层滚动 + `dvh` 抖动**：`DialogContent` 已有 `max-h-[85dvh] overflow-y-auto`（`SecurityDetailDialog.vue:46`），表格再要横向+纵向 → 双层滚动条；移动端 `dvh` 随地址栏变化会把分页挤出视口。
3. **三层 Portal + 焦点归还**：弹层内还有 `Select`（也走 Portal）与批量确认 `AlertDialog`；`Dialog` 默认 `trapFocus`，关闭 AlertDialog 后焦点常回不去，`Esc` 还会与「放弃批量」语义重合 → 误关即前功尽弃。
4. **分页/筛选/选中态不保活**：弹层关闭即卸载 —— 翻到第 3 页、勾了 8 笔、误关 → 全丢。
5. **URL 不可分享/刷新/回退**：路由页可带 query（如 `?q=600519`）且天然支持后退。
6. **代码量不省**：B 反而要多写弹层宽度、内部滚动高度、`z-index` 分层、焦点兜底。

> 若仍选 B，须满足：弹层 `max-h-[88dvh] w-[calc(100vw-2rem)] sm:max-w-6xl`；表格容器 `max-h-[calc(88dvh-9rem)] overflow-auto`；**批量确认 `AlertDialog` 提到弹层外**（避免嵌套 Portal）；选中集/分页/筛选**提升到页面层**；弹层内禁用 `Esc`。

#### 5.3.2 入口按钮规格

| 项 | 规格 |
|---|---|
| 落点 | `web/src/modules/admin/components/GlobalSettingsDividendInitBlock.vue:56-77`（「补齐历史分红」区块内）**不新增 Tab** |
| N 取法 | queryKey `['dividend-yield','pending-summary']`，`staleTime` **30s**，非 admin **不发请求** |
| 刷新时机 | `assign`/`batch-assign`/`ignore`/`batch-ignore` 四个 mutation `onSuccess` 均 invalidate 该 key |
| 三态 | `isLoading`→**不渲染**；`pending>0`→可点「待人工划分 N 笔 →」；`pending===0`→**置灰**「暂无待划分」（**不隐藏**：隐藏会让人分不清「功能存在但为空」还是「没做」，且 N 变化会造成布局跳动） |
| 权限 | `useIsAdmin()`（`web/src/stores/auth.store.ts:119-121`）非 admin **不渲染**；页面侧同样自守卫 + 后端 403 兜底 |
| 行数 | **+34**（20–40 区间 ✅） |

> ⚠️ **本项目路由层没有 meta/role 机制**：`authGuard`（`router/index.ts:144-169`）只做 JWT。角色守卫走三层：① 页内 `useIsAdmin()` 自守卫；② 侧边栏 `roles:['admin']`；③ 后端 `require_admin` 403。**不要为本页发明 meta**。本页 P1 不挂侧边栏（无 ②），守卫退化为 ①+③——靠页内 `useIsAdmin()` + 所有 pending 查询 `enabled:isAdmin` + 后端 403 防直接 URL 进入。

#### 5.3.3 页面、路由与行数

| 文件 | 行数 | 职责 |
|---|---|---|
| `admin/pages/PendingDividendsPage.vue` | 185 | 路由页：权限自守卫、筛选/分页/选中态、批量编排、弹窗挂载、结果反馈 |
| `admin/components/PendingDividendTable.vue` | 145 | 哑表格：9 列、checkbox 三态、sticky 首列、行内操作 |
| `admin/components/PendingDividendAssignDialog.vue` | 155 | 指定弹窗：原文摘要 + 建议值 + 一键采纳 + 自定义表单 + 校验 |
| `dividend-yield/composables/use-pending-dividends.ts` | 105 | vue-query：list/summary/assign/batch/ignore/batch-ignore |
| `dividend-yield/lib/suggest-report-period.ts` | 70 | 纯函数：建议报告期算法 + 类型↔季度合法性 + 留存窗判定 |
| **页面族小计** | **660** | 原估 400–650 的上沿差 10 行（口径一致） |
| api / 常量 / 路由 / 明细面板 | **85** | 原估未计（API +72、路由 +7、常量 +1、明细面板 +5）。**侧边栏 +2 不计入本批**：P1 不挂常驻菜单项，侧边栏项降为可选 P2（D-2） |
| 入口按钮 | 34 | |
| **批次 D 合计** | **779** | **≤800 ✅**（侧边栏 +2 已挪出本批；含测试则 929 > 800 → 仍须拆批） |
| 测试（建议独立小批） | ~150 | 含测试则 929 > 800 → **必须拆批** |

**🟢 页面路径（D-1，已定）**：`/admin/pending-dividends` + `admin/pages/`（语义分组 + 页内 `useIsAdmin()` 守卫 + 后端 `require_admin` 403 兜底成立）。**不挂常驻侧边栏**，唯一入口 = 管理端「补齐历史分红」区块按钮（`§5.3.2`），点击 `router.push(ROUTE_PATH.ADMIN_PENDING_DIVIDENDS)`。

> 🔴 已否决的 `/dividend-yield/pending`：父项「股息率排名」对**所有登录用户可见**，其子项再叠 `roles:['admin']` 仍会暴露「点不进去的深链」给普通用户 —— 与 P1「零导航噪音」目标相悖。

#### 5.3.4 列表设计

9 列：`☑`(w-10) ｜ 证券(sticky 首列) ｜ 原文标签 `dividend_label` ｜ 派息(元/股,右对齐等宽) ｜ 公告日 ｜ 除权日 ｜ **建议报告期(前端算)** ｜ 状态 Badge ｜ 操作(指定/忽略)。
- **不提供列头排序**：后端 pending 端点未定义 `sort`，前端不臆造；建议后端固定 `ORDER BY created_at DESC, id DESC` 保证翻页稳定（风险 5）。
- 筛选：状态 / 原文标签 / 关键字 `q`（250ms 防抖）/ 重置；**任一筛选变化 → `page=1` 且清空选中集**（防跨筛选批量误操作）；翻页同样清空。
- 空态区分「库内无行」与「筛选无结果」；错误态用 `ErrorState` + `#action` 重试；无权限整页 Card（与 `GlobalSettingsPage.vue:148-152` 逐字一致）。
- 窄屏：`overflow-x-auto` + 首列 sticky；批量条用 `sticky bottom-0` 而非 fixed。
- 模板纪律：`v-if`/`v-else-if`/`v-else` **必须连续兄弟**（注释只能放块外）；**禁 `v-if` 与 `v-for` 同元素**。

#### 5.3.5 建议报告期算法（核心）

纯函数 `suggest-report-period.ts`，**后端永不判定**，仅前端计算：

- 标签→类型：`年度→ANNUAL｜中期→INTERIM｜季度→QUARTERLY｜特别→SPECIAL｜**股改→OTHER**｜其他/空/未知→OTHER`
- 合法季度格：`ANNUAL=[4]｜INTERIM=[2]｜QUARTERLY=[1,3]｜SPECIAL=[1,2,3,4]｜OTHER=[1,2,3,4]`
- **主候选 = 公告日**（模型注释 `dividend_yield.py:87`「公告日期：SPECIAL 行的财年/季度落格锚点」）；年报/中期另做财年回退（年报常在次年 1–7 月公告）
- **备选 = 除权日 −2 季**（实测偏移 +1~+4 季、中位 2、从不同季），标记 `approximate=true`
- 两者皆空 → `[]` → UI「无候选，须人工」

**真样本回归（工程师照此写断言）**：

| 样本 | 输入 | 主候选 | 备选 |
|---|---|---|---|
| `600519` 特别分红 | ann 2022-12-21 / ex 2022-12-27 | **2022Q4 SPECIAL** | 2022Q2 `approximate` |
| `600519` 特别分红 | ann 2023-12-14 / ex 2023-12-20 | **2023Q4 SPECIAL** | 2023Q2 `approximate` |
| `300770` 特别分红 | ex 2024-11-26（无 ann） | — | 2024Q2 |
| `601828` 特别分红 | ex 2023-07-24（无 ann） | — | 2023Q1 |
| `300750` 年度分红 | ex 2024-04-30 | — | **2023Q4 ANNUAL**（对上报告 §2.5 真值 ✅） |
| `601088` 年度分红 | ex 2017-07-10 | — | **2017Q4 ANNUAL**（对上报告 §2.5 标注 ✅） |
| `600900` 股改分红 | ex 为空、ann 为空 | — | **[] → 「无候选，须人工」** |

**一键采纳（裁决 3）**：弹窗打开时表单**保持空**（强制显式决策）；点「采纳建议」→ 只填表单、按钮变「已采纳（可修改）」、**不提交**；「提交」始终可点，校验失败显示红字。无候选 → 不渲染「采纳建议」按钮。
**校验**：年份 `1990 ~ 次年`；季度 `1~4`；**跨字段联动用禁用优于报错**（选 ANNUAL → 季度自动置 4 且 disabled）。
**留存窗外**：建议值旁加 Badge「留存窗外」并说明「转正后可能被留存清理删除；若确无归属建议点『忽略』」。

#### 5.3.6 批量与防误

- **只做「本页全选」**（不做跨页全选，避免「以为只选了本页、实际提交几百笔」）。
- 批量条：`已选 N 笔 · 采纳建议 (M) · 忽略 (N) · 清空`；`M` 只计**有候选**的行，`title` 说明「已跳过 K 笔无候选行」。
- **忽略不可撤销**（派息永久丢失）→ `AlertDialog` 二次确认，正文写明「不会写入分红主表」。
- **采纳建议**（写主表）→ 同样二次确认，正文列**前 3 笔**（如 `600519 2022Q4 特别分红`）。
- **部分失败**：依赖后端返回 `{ succeeded, failed:[{id,code,reason}] }` → 成功 N、失败 M，页内红条列前 5 条；**失败行保持选中**便于重试。

#### 5.3.7 类型与 API 对接

- **生成物禁手改**：`gen_openapi.py` → `docs/openapi.json` → `gen-api-types.py` → `web/src/types/api.ts`。**批次 C 硬前提**：pending 六端点**必须声明 Pydantic `response_model`**，否则前端无字段类型。
- **手写**（`web/src/api/dividend-yield.api.ts`，不改 `web/src/api/types.ts`）：6 个端点函数 + `PendingDividendFilters`；`:61` 的 `periodType` 补 `'OTHER'`；`SecurityDividendItem` 增 `dividendLabel`（E6=①）。
- **明细面板**（`SecurityDetailPanel.vue:77` 右侧）：`<Badge v-if="d.dividendLabel" variant="outline">{{ d.dividendLabel }}</Badge>`（+5 行）。

#### 5.3.8 前端侧未决（D1~D6 已定；D7/D8 归批次 C）

| #   | 项                                                                               | 建议                                                                                              |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D-1 | 页面路径 / 归属模块                                                                     | **已定** `/admin/pending-dividends` + `admin/pages/`；**不挂常驻侧边栏**（P1 目标=零导航噪音）                     |
| D-2 | 入口形态 A / B + 侧边栏安置                                                              | **A（路由页）**；P1 = **不挂常驻侧边栏**，唯一入口=按钮。侧边栏「N>0 条件显示 + 徽标」降为**可选 P2 增强**（需 app 级 `summary` 订阅，本批不做） |
| D-3 | 撞键冲突（「转正成功但主表同格已存在、未覆盖」）是否前端可见                                                  | **已定：可见** — 后端 assign 返回 `conflict: bool` + warning 文案；前端成功 toast 旁追加「主表同格已存在、未覆盖（原标签=X / 本次=Y）」提示                                 |
| D-4 | 留存窗年数常量前端硬编码 `cur-4` 会漂移                                                        | **已定：完整可配** — `dividend_yield_settings` 加列 `dividend_retention_years`；`retention_cleanup`（`dividend_sync.py:41,83`）改读它弃 `_RETENTION_YEARS` 常量；`GET/PUT /settings` 暴露；前端 `suggest-report-period.ts` 改读 `GET /settings` 不再硬编码 `cur-4` |
| D-5 | `ASSIGNED` 误指定不可撤销 → 是否加 `POST /{id}/reopen`                                    | **已定：可撤销** — 加 `POST .../{id}/reopen`（ASSIGNED→PENDING）；reopen 连带回滚主表同键错误行；前端 `ASSIGNED` 行加「重新划分」按钮（≤8 行）                              |
| D-6 | auditor 角色是否只读可见（E3=全 admin-only，与 `Sidebar.vue:69` 的 ADMIN_LOGS 含 auditor 不一致） | **已定：a（auditor 只读可见）** — pending 页对 auditor 开放「看」（`useHasRole('admin','auditor')` 门控，与日志中心 `LogCenterPage.vue:43` 同口径）；写操作（指定/忽略/reopen）仍 `require_admin`。与日志中心权限模型统一，auditor 可审计人工划分动作 |
| D-7 | 批量响应契约（部分失败表达）与列表默认排序                                                           | 需**批次 C** 定                                                                                     |
| D-8 | `dividend_label` 取值集合（前端硬编码 9 项 vs 后端返回 `labels[]`）                             | 需**批次 C** 定                                                                                     |

**两点期望管理**：① 股改实测集中 2006~2007（留存窗外）+ 80% 无报告时间 → **大概率永不落主表**，独立 type 的收益是**语义正确性**非可见性；② 删旧源后**无报告期的特别分红不会自动回灌**（600519 两笔），须人工指定后才回填。

---

## 六、旧源：增量 vs 清空（回答 owner 的排序问题）

**走增量改造，不清空重构。**

| 你问的 | 答复 |
|---|---|
| 是不是等于重构了？ | **不是**。旧源采集代码已在 22 提交里删净（0031/0032 下线 JobType + 配置列）；新链路**复用** `_process_master`/`_upsert_one`/`_westward_dup`/`response_fields` → 是「换数据源 + 语义修正」 |
| 要先清空旧源代码吗？ | **不必**。只会撑大 800 行闸门 diff 且无收益 → **代码走增量修改** |
| 旧源数据呢？ | **必须清，且必须先于播种** |

**真死符号 5 个（可删，本批不做，建议独立小批 E）**：`_exists_anchor`(`:488-495`)、`_has_proposed`(`:497-506`)、`_match_proposed`(`:468-487`)、`_TITLE_SPECIAL_RE`(`:66`)、`_code_of`(`dividend_sync.py:46-57`) —— 均为**零生产调用**（MCP 图谱复核）。
**不可删**：`retention_cleanup`（被 `scheduler.py:47-49`/`backfill_router.py:34` 用）、`_upsert_one`/`_locate_cell`/`_westward_dup`。
**非代码残留**：6 处注释提及旧源；DB 配置行 `QuoteInterface('东财-分红配送')`/`('新浪-分红配股')`。

### 6.1 数据清理时序（推翻方案文档 `:404` 的「先采后删」）

```
❌ 先播种 → 再删 → 再播种 = 浪费 2×19h
   旧新浪行仍在时，_westward_dup 的跨源 ex_date 判据会挡掉新行；删完旧行格子变空 → 必须重播
❌ 先删但巨潮接口未恢复 → 采集空窗
✅ 备份 → 部署迁移 → 删除旧源(§6) → 播种（一次）→ 前端人工划分
```
**C1 已过**（见 §2.1）。

---

## 七、迁移（分红侧）

| 迁移 | 内容 | 原子性 / downgrade |
|---|---|---|
| **0033_extend_report_period_type** | `autocommit_block` 内 `ADD VALUE IF NOT EXISTS 'OTHER'`（**04:45 改判后只需 1 个值**，不再加 `SHARE_REFORM`）+ `add_column dividend_label String(32)` | **非原子**（与 `0004` 同款既有取舍，可接受：残留=枚举多 1 值，`IF NOT EXISTS` 可重跑自愈）；downgrade = 删列 + **枚举值 no-op 留值** |
| **0034_create_dividend_pending** | 建表 + 索引 + `status` 原生枚举；`resolved_period_type` 用 `String(16)` | **单事务原子**；downgrade **必须先 `drop_table` 再 `DROP TYPE`**（反序报依赖错误） |
| **0031 缺陷修法（F1）** | 补 `DIVIDEND_SPECIAL_BACKFILL` 回 `_ENUM_VALUES_ALL`；`enabled` 改 `FALSE`；注释「当前 10 个值」改 11；重建前补 `DELETE ... WHERE task_type IN (...)` | 未修则 `0015:37` 反向迁移链断裂 |

**三条强制注册（漏一必红）**：`app/models/__init__.py` 双注册；`tests/test_models.py` 表清单（`:33-68`，set 相等）补 `security_dividend_pending`；枚举名清单（`:76-94`）补 `DividendPendingStatus`。
**Rex 收尾清单**：`dividend_yield.py:3-8` docstring「五张表」→「六张表」；`enums.py` 名==值；`status` 默认值自洽；**pending 端点必须 Pydantic 响应模型**（否则 openapi schema 为空 → 前端无字段类型）。

---

## 八、测试影响（Tessa）

| 项 | 结论 |
|---|---|
| **必改断言** | 4 条：`test_dividend_notice_scan.py:426`（`skip==2` → `skip==0` + `no_period==2`）、`:297`（`"三季度分红"`→`"季度分红"`）、**`:298`/`:299`（`""`/`None` → `is OTHER`）**；构造行 `:491` 同改（`:500` 保持 QUARTERLY） |
| 键集/文案 | 6 处：`:294`/`:483` docstring、`_new_stats:70-75`、`dividend_seed.py:57-66`、摘要 `:274`/`seed:125`；**`period_fallback_ann`/`period_fallback_ex` 作废** |
| **作废用例** | 旧 tier2/tier3 回退用例 → 改「无报告期 → 落 staging」；`..._falls_back_to_special` 改名 `_to_other` |
| **新增用例** | **≈28 条**（后端 ≈22 / 前端 ≈6） |
| **元结论升级** | 失败模式从「**静默丢失**」变「**静默不消费**」（队列永不消费 = 等效丢失且无红灯）→ **度量从「丢弃行数」转向「队列深度 × 龄期」** |
| **断言红线** | downgrade 后**不得**断言枚举值消失（`ADD VALUE` downgrade 是 no-op）；`resolved_period_type` 走**字符串往返**断言，不得写枚举断言 |

---

## 九、执行顺序与拆批（分红侧）

| 批 | 内容 | 估算 |
|---|---|---|
| **A** | 枚举 + `dividend_label` + 迁移 0033 + 映射补全 + 跳过分桶 + `period_label` + 撞键护栏 | 200–320 |
| **B** | staging 模型 + 迁移 0034 + `scan` 集成 + 三条强制注册 | 270–380 |
| **C** | pending API + `require_admin` + `ON CONFLICT` 写主表 + 契约重生成 | 300–400 |
| **D** | 前端独立页 + 入口按钮 + composable + 建议值交互 | 400–650 |
| **E（可选）** | 删 5 个真死符号 + 同步改测试 + 注释更新 | ≤150 |
| **数据批** | 备份 → 部署迁移 → **先删旧源** → **立即播种（19h）** → 人工划分 | — |

> 各小批**独立提交**且**自带单测**（B 不配单测会下拉 `services` 覆盖率；C 不配 API 单测会拖 `app` 70 阈值）。22 提交的 B1~B5 拆批见非分红报告 §3.1。

---

## 十、ADR（待 owner 批准后落 `docs/adr/`）

- **ADR-004**：分红报告期类型扩展与「无报告期」人工划分 —— **5 值枚举（新增 `OTHER`）** + `dividend_label` + staging 队列；记录三个 Context 事实：① 源站词表**非闭集**（7 标签）；② 同一次分配被拆成**多行**（同 ex_date、金额不同）；③ **股改分红实测永不落主表**，故不为其单列 type（04:45 改判）。
- **ADR-005**：送转市值中性与「除权复权重述」股息率口径（推翻原「送转并入综合收益率」裁决）。
- **ADR-002 修订**：补记分红明细源切至巨潮、`dividend_report_source_interface_id` 退役。

---

## 十一、分红相关未裁决项

> ✅ **裁决结果（owner，2026-09-21 05:39「未裁决都按建议来」）**
> **E1=①｜E2=①｜E3=①｜E4=①｜E5=①｜E6=①｜E7=①｜F1=①｜F2=①｜F3=①** —— 全部取「我的建议」列首选项。
> 叠加 04:45 的股改改判（不单列 `SHARE_REFORM`，股改改入 `OTHER`）后，本节**已无未决项**。
> **一致性复核**：E2（动数据时**先删旧源 → 立即播种**，避免 2×19h）与 F2（**等语义改动落地 + 播种跑通后再执行 §6 删除**）不冲突 —— F2 定「何时开始动数据」，E2 定「动的时候先删还是先播」。

| ID     | 待裁决                                  | 选项                                        | 我的建议  |
| ------ | ------------------------------------ | ----------------------------------------- | ----- |
| **E1** | 「其他」撞键策略                             | ① **检测+告警+保留旧值** ② `dividend_label` 并入唯一键 | **①** |
| **E2** | §6 旧源删除 × 播种顺序                       | ① **先删后播（一次）** ② 先采后删（浪费 2×19h）           | **①** |
| **E3** | pending API 权限                       | ① 全 admin-only ② 普通用户可见只读提示               | **①** |
| **E4** | `重整转增`/`承诺补偿`（cash=0）是否单独呈现          | ① 否（不入库） ② 是                              | **①** |
| **E5** | `ASSIGNED` 旧行是否随留存清理                 | ① 不清理 ② 清理但保留 fingerprint 墓碑              | **①** |
| **E6** | `dividend_label` 是否进 `/dividends` 响应 | ① 是 ② 否                                   | **①** |
| **E7** | 方案 §3 把 3 个死符号列「明确保留」与实测零引用矛盾        | ① **改「待清理」并独立小批删** ② 维持保留                 | **①** |
| **F1** | `0031` 三处缺陷修法                        | ① 全修 ② 只修注释与 enabled                      | **①** |
| **F2** | §6 旧源数据 `DELETE` 现在执行吗               | ① 等语义改动落地+播种跑通后 ② 现在                      | **①** |
| **F3** | 观察窗时长 / 准入                           | ① ≥1 次完整每日 scan ② ≥2 周                    | **①** |

---

## ✅ 行动清单

| #   | 行动                                                               | 负责       | 紧急度    |
| --- | ---------------------------------------------------------------- | -------- | ------ |
| 1   | owner 拍板 §11 的 10 项                                              | owner    | **P0** |
| 2   | 批次 A（枚举 + `dividend_label` + 映射 + 分桶 + 护栏 + 迁移 0033）             | 工程师      | **P0** |
| 3   | 批次 B（staging + 迁移 0034 + scan 集成 + 三条注册）                         | 工程师      | **P0** |
| 4   | 批次 C（pending API + 契约重生成）                                        | 工程师      | **P0** |
| 5   | 批次 D（前端独立页 + 入口按钮 + 建议值）                                         | 前端       | **P1** |
| 6   | 修 `0031` 三处缺陷（F1）                                                | 工程师      | **P1** |
| 7   | 数据批：**先删旧源 → 立即播种（一次）**                                          | ops/DBA  | **P1** |
| 8   | 播种**单飞锁** + `except` 补日志（失败占比过高改为抛错）+ UI 文案落点修正                  | 工程师      | **P1** |
| 9   | `restate_cells` 三边界修复 + 死代码小批 E + 537 行拆分 + `backfill_router` 更名 | 工程师      | P2     |
| 10  | 更新方案文档 `:263/:264/:394/:404` + 落 ADR-004/005                     | owner/文档 | P2     |

---

## ⚠️ 待完善 / 已知局限

- **规模估计**：`0.05%` 来自 600 只随机样本（事件量级仅 3 条），「数十行」是量级估计。
- **`600900` 股改分红连除权日都为空** → 证明「按除权日占位」在真实数据上根本走不通。
- **`row_fingerprint` 稳定性依赖原始字段**：上游修正某字段会产生新 PENDING 而非更新原行（兜底未定）。
- **pending 队列无 `report_year`** → `retention_cleanup` 不会清理它 → 需独立清理/龄期策略（E5）。
- **落库模拟为离线复刻**（内存复刻三条判据 + akshare 原行序），**非真库执行**。
- 全程**只读**：未改业务代码/测试/迁移，未连开发库，未做 git 写操作。

---

## 📚 数据来源索引

- **主理人**：`.workbuddy/tmp/{pending_volume_check,label_vocab_check,label_independent_check,special_double_count_check,upsert_simulation,cninfo_e2e_v2,cninfo_diagnose}.py` + 同名 `_out.txt`
- **Archi**：`.workbuddy/tmp/archi_sample.py` → `archi_sample2.txt`（600 只/6076 行/7 标签）、`archi_report.md`、`archi_westward.txt`、`archi_desc.txt`
- **Rex**：`.workbuddy/tmp/rex_manual.txt`、`rex_task8_report.md`、`rex_report.md`
- **Tessa**：`.workbuddy/tmp/tessa_test_impact_matrix.md`、`tessa_manual_period_diff_v3.md`、`tessa_semantics_baseline.txt`
- **Cody**：`.workbuddy/tmp/cody_final.txt`、`cody_mig3.txt`、`cody_openapi.txt`
- **关联**：非分红报告 `docs/reviews/review-non-dividend-engineering-2026-09-21.md`；设计基准 `docs/分红采集链路迁移方案.md`

---

> 本报告由工程保障团队 AI 协作生成，关键决策请由人类工程负责人复核。
