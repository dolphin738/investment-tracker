# 股息率排名管理 — 已提交未推送代码审查报告

- **审查日期**：2026-09-06
- **审查范围**：4 个未推送 commit（`bdd2ca0` → `299d7b2` → `134e1cf` → `b333b67`），基线 `25a326f..HEAD`，29 文件、+4782 行
- **对照基准**：`docs/股息率排名管理方案.md`（1390 行，含 §14 落地路线图）
- **审查方式**：架构师（一致性/复用/结构）+ QA（逻辑/边界/测试）双路并行，主理人对关键 P0 结论独立复现取证
- **性质**：只读审查，未修改任何源码

---

## 0. TL;DR

1. **后端采集与计算核心质量高、复用到位**：§11.3 列的既有能力（`_fetch_sdk_raw`/`_guarded_fetch`/`_RATE_LIMITER`/`_upsert_masters`/`_interfaces_for_category`/`_mark_failure`/`paged()`）全部走既有入口，**未发现重复造轮子**。
2. **但交付是不完整的**：方案承诺的「排名管理」实际只交付了「一个合并展示页 + Top20」，**管理页主体、5 个过滤参数、连续分红榜、近两年无分红剔除、stale 机制**全部缺失。共 **5 项 P0、9 项 P1、12 项 P2**。
3. **唯一的方案「契约」级条款被破坏**：§9「曲线末点股息率 == 快照值」在预案行 `ex_dividend_date=NULL` 的真实场景下不成立（QA 实测：快照 0.10 vs 曲线末点 0.05），而唯一守护它的测试只覆盖退化场景，属**假守护**。
4. **有一处实现优于方案**：LFY 锚点方案 §2.5 伪代码写 `_cells(L.year-1, 1)` 有跨年拼接 bug，实现用 `(y-1, 4)`（`b333b67`），**方案需回修，代码不要改回去**。
5. **测试有效性偏低**：新增 45 条用例全通过，但混有「常量镜像断言」（复制字面量比对，零防护价值）；§12 点名的分批边界契约测试（800/905/910）、§2.6 四时点黄金断言、前端模块测试全部缺失 —— 前端 `modules/dividend-yield/` **零测试**。

---

## 1. 一致性对照表

| 方案章节 | 方案要求 | 实现现状（文件:行号） | 判定 | 严重度 |
|---|---|---|---|---|
| §5.1–5.5 表结构 | 5 表、字段/唯一键/索引 | `models/dividend_yield.py:42-215` + `0004:248-423` | 一致 | — |
| §11.2 迁移链 | 单一迁移 | `0004_dividend_yield.py:24-25`（0003 已被 `61631df` 占用） | **合理演进** | — |
| §2.5 纯函数 | TTM/LFY/连续年数 | `dividend_yield.py:96-195` | 一致（且修正方案 bug） | — |
| §6.1 季度抓取 | 季末 guard/断点/去重 | `dividend_sync.py:278-443` | 完整 | — |
| §6.2 日线 | 双防线防污 | `market_daily_price_sync.py:119-225` | 部分（防线二弱于方案） | P2 |
| §6.3 留存清理 | 按 `report_year` | `dividend_sync.py:448-480` | 完整 | — |
| §6.4 全量重建 | 默认禁用 | `dividend_sync.py:485-498` | 完整 | — |
| §6.8 公告扫描 | 六步齐全 | `dividend_notice_scan.py:100-432` | 完整 | — |
| **§6.1 时区** | 显式 `timezone=APP_TZ` | `scheduler.py:388` `AsyncIOScheduler()` 无参 | **缺失** | **P1** |
| **§7 stale** | 落后 ≥3 交易日置 true | 全仓仅 `dividend_sync.py:205` 置 False | **缺失** | **P1** |
| **§8.1 过滤** | 5 个过滤参数 + 过滤态股息率 | `router.py:97-103` 无 | **缺失** | **P0** |
| **§8.2 近两年无分红** | 剔除 | `dividend_yield.py:155` 已实现，**生产零调用** | **缺失** | **P0** |
| **§8.3 榜单二** | 连续分红榜，≥2 年、封顶 20 | `router.py:122-142` 无；前端 `useRank(1,30,…)` 顶替 | **缺失** | **P0** |
| **§9 契约** | 曲线末点 == 快照 | `dividend_yield.py:167-195`，预案 NULL ex_date 时不成立 | **破坏** | **P0** |
| §9 路径 | `/rankings`、`/{id}/curve` | `router.py:96/145/206` 为 `/rank`、`/curve?master_id=` | 偏离（前后端自洽） | P2 |
| §9 响应字段 | 每点含 `close`+`numerator_per_share` | `router.py:191-197` 仅 3 字段 | 偏离 | P1 |
| §5.4 接口校验 | **四重**（含调用形态） | `router.py:260-272` 仅三重 | 缺失 | P1 |
| §6.6 审计 | 配置变更写 `AppLog` | `router.py:315-344` 无 | 缺失 | P2 |
| **§10.2 管理页** | 排序/分页/过滤/覆盖度 | 未实现 | **缺失** | **P0** |
| §10.3 展示页 | `TopPage.vue` | 未实现（`router/index.ts:86` 仅 1 条路由） | 缺失 | P1 |
| **§10.4 设置页** | 新建 `PrefsDividendTab.vue` | 未建；内联进 `SettingsPage.vue`，884→**1154 行** | **偏离** | **P1** |
| §12 测试 | API/配置/前端测试 | 路由层 0 覆盖，前端模块 0 测试 | 缺失 | P1 |

---

## 2. P0 问题清单（阻塞合入）

### P0-1｜§10.2 管理页（RankingPage）整体未实现

- **证据**：`web/src/modules/dividend-yield/` 下只有 `pages/DividendYieldRankPage.vue` 与 `composables/`；该文件无分页、无列头排序交互、无过滤条、无「当前覆盖 N 家」覆盖度。
- **方案依据**：§10.2「管理页 RankingPage：表格各列点击排序、分页复用 `Pagination`、骨架屏 `TableSkeleton`、空态 `EmptyState`、过滤条（交易所/口径/连续年数下限/是否含预案/是否显示两年无分红）」。
- **影响**：该功能是方案主体页面。当前 `useRank(1, 30, …)` 被硬编码调用一次，翻页能力形同虚设；后端 `page/pageSize/sort` 参数无真实消费方。
- **改进建议**：新建 `pages/RankingPage.vue`（路由 `/dividend-yield`），复用既有 `components/common/Pagination.vue`、`TableSkeleton.vue`、`EmptyState`；现有页改造成 §10.3 TopPage（`/dividend-yield/top`）。

### P0-2｜§8.1 五个过滤参数 + 「过滤态股息率」全部未实现

- **证据**：`router.py:97-103` 签名仅 `page/pageSize/sort`；前端 `api/dividend-yield.api.ts:32-35` 同样只传 `{page,pageSize,sort}`。
- **方案依据**：§9「参数 `sort/order/exchange/mode/min_consecutive/include_proposed/include_no_dividend`」；§8.1「`include_proposed=false` 时过滤掉 PROPOSED 记录后**分子会随之改变**，须由服务端按过滤后记录集现调 §2.5 纯函数计算，并在响应中标注过滤态口径」。
- **影响**：无法按交易所/口径/连续年数筛选；「过滤态股息率」能力完全不存在，用户看到的数值与筛选条件不自洽。
- **改进建议**：后端补 6 个 Query 参数 + 白名单校验；`include_proposed=false` 时走 `compute_yield(过滤后集, price, cur_year)` 现算并回传 `filtered: true`；前端补过滤条。

### P0-3｜§8.3 Top20 未剔除「近两年无分红」，`has_recent_dividend` 为零调用死代码

- **证据**（主理人独立复现）：`grep -rn "has_recent_dividend" backend/app/` → 仅 `dividend_yield.py:155` 定义处命中，生产代码零调用。`router.py:122-138` 的 `/top20` 只过滤 `dividend_yield IS NOT NULL` + `suspicious IS False`。
- **方案依据**：§8.3 榜一「剔除近两年无分红的公司（**避免僵尸记录污染榜单**）」。
- **影响**：已停发公司的旧快照会占据 Top20。已实现且已单测的能力没接线。
- **改进建议**：`/top20` 增加 `last_dividend_year >= cur_year - 1` 过滤（`last_dividend_year` 库列已就位，无需现算），直接表达 §8.2 的 `[Y, Y-1]` 窗口语义。

### P0-4｜§8.3 连续分红榜（榜单二）服务端缺失，前端 30 条顶替且违反 A13

- **证据**（主理人独立复现）：`router.py:139-142` `return {"items": items}`（仅 Top20 单榜）；前端 `DividendYieldRankPage.vue:74` `useRank(1, 30, 'consecutive_years', true)`。
- **方案依据**：§9「`/top20` 返回 Top20 榜 **+ 连续分红榜**」；§8.3「`consecutive_years >= 2`…条数上限**确定取 20**（决策 A13）」；排序 `consecutive_years DESC, dividend_yield DESC, master_id ASC`。
- **影响**：①契约少一个榜；②条数 30 ≠ 20（违反 A13）；③无 `>=2` 下限，0 年/1 年行混入；④排序缺 `dividend_yield DESC` 次级序。
- **改进建议**：`/top20` 改返 `{top: [...], consecutive: [...]}`，连续榜独立查询 + `>=2` + 三元组排序 + `.limit(20)`。

### P0-5｜§9「曲线末点 == 快照」契约在真实场景被破坏（唯一契约级条款）

- **证据**：`dividend_yield.py:167-179`（`_anchor_date`：`ex_dividend_date` 为 NULL 时回退报告期期末日 Q4→12-31）+ `:182-195`（`compute_yield_at` 按 `anchor <= as_of` 过滤）。
- **实测复现**（QA 只读脚本）：记录集 `[2025Q4 PAID ex=2026-05-10 cash=1.0, 2026Q4 PROPOSED ex=NULL cash=2.0]`，price=20，as_of=2026-09-05 → 快照 **0.10**、曲线末点 **0.05**，不等。
- **触发场景**：东财报告期行在**预案阶段** `ex_dividend_date` 恒空（§6.1 明说）。A 股年报预案 3-4 月公告、7-8 月才实施 → **一年中近半年**凡有年报预案的证券曲线与表格不一致。
- **方案依据**：§9「**契约**：曲线最后一个点的股息率必须等于该证券快照值。§12 须有对应断言。」
- **影响**：用户在同一页面看到表格 10.00%、曲线末端 5.00%，属方向性误导。
- **改进建议**：推荐方案 (a) —— 快照计算也走「可见集」，`compute_yield` 内部对 `ex_dividend_date` 为 NULL 的行统一按 `min(anchor, today)` 处理，语义自洽；备选 (b) 曲线端点强制用 `compute_yield(...)` 兜底覆盖末点。
- **须补测试**：`test_curve_end_equals_snapshot_with_proposed_null_exdate`。现有 `test_dividend_yield.py:226` 名为 `..._when_all_visible`，**只测退化场景**，须改名或补新例。

---

## 3. P1 问题清单

| # | 问题 | 证据 | 影响 | 改进建议 |
|---|---|---|---|---|
| P1-1 | `price=0` 触发 `DivisionByZero`，被 `except Exception: continue` 静默吞掉 | `dividend_yield.py:123-125`；`dividend_sync.py:207-208` | 该证券快照永久停滞、无日志、无 `suspicious`、`stale` 永 False → 三无静默失败；`/curve` 现算直接 500 | `if price is None or price <= 0: return None`（§3.5 缺失而非 0）；except 改 `logger.warning` |
| P1-2 | `stale` 机制零实现（主理人复现：`dividend_sync.py:205` 是全仓唯一写点，值恒 False） | `models/dividend_yield.py:162`；`dividend_sync.py:205` | 前端灰显 +「数据截至」分支（`RankPage.vue:216/252/304/332`）**永不触发**，死 UI | `daily_close_fetch` 末尾加 `update_stale_flags()`：以日历表最新交易日（空则 `max(trade_date)`）为基准，落后 ≥3 交易日置 True |
| P1-3 | 调度器未显式 `timezone=APP_TZ` | `scheduler.py:388` 无参；`core/date_utils.py:6` 仍私有 `_APP_TZ` | 5 条新 cron 按 UTC+8 书写，TZ=UTC 容器下整体推迟 8h（日线 15:05→23:05、公告扫描 06:00→14:00） | `_APP_TZ` 提为可导入 `APP_TZ`；`AsyncIOScheduler(timezone=APP_TZ)` + `CronTrigger.from_crontab(expr, timezone=APP_TZ)`。**共享改动，须回归既有任务** |
| P1-4 | §5.4「四重校验」只做三重，缺**调用形态** | `router.py:260-272`（docstring 自认「三重」）；L329-330 主源/补充源同传分类 3 | admin 可把「新浪-分红配股」（逐只）选为主源 → §6.1 按报告期抓取静默失效 | 接口行增形态标识（`params` 含 `symbol` 占位即逐只），PUT 侧校验；前端两个下拉给不同候选集 |
| P1-5 | 曲线响应缺 `close` 与 `numerator_per_share` | `router.py:191-197` 仅 `{trade_date, dividend_yield, mode}` | §9 要求 `numerator_per_share` 供前端叠加「分子不变段」提示 → 前端无法渲染 | 按 §9 补齐字段（成本极低） |
| P1-6 | §10.4 未拆 `PrefsDividendTab.vue`，`SettingsPage.vue` 反向膨胀 | `SettingsPage.vue` **1154 行**（+292）；股息率 TAB 逻辑内联于 L132-232 | 远超 `AGENTS.md §1` ≤400 行人工约定，且跨 `check_line_budget.py` >800 硬失败线（存量违规被放大） | 按方案拆组件，SettingsPage 先降至 ~600 行 |
| P1-7 | 路由层测试 + 前端模块测试缺失 | `backend/tests/` 无 router 测试；`web/src/modules/dividend-yield/` 下无 `__tests__` | P0-2/P0-3/P0-4 这类「契约未实现」正是路由层测试才能拦截的 | 补 `test_dividend_yield_api.py`（httpx AsyncClient）+ 前端 vitest |
| P1-8 | 前端 `TopPage.vue` 未实现，路由只注册 1 条 | `router/index.ts:86` 仅 `analysis/dividend-yield`（方案要求 `/dividend-yield` 与 `/dividend-yield/top`） | §10.3 展示页整体缺失 | 按 §10.1/§10.3 补页面与路由 |
| P1-9 | §8.1 排序缺 `NULLS LAST` | `router.py:51` `.desc()` 无 `.nulls_last()`（主理人复现）；列 `nullable=True`（`models:126`） | 当前靠 `.where(is_not(None))` 规避，但 `consecutive_years` 可为 NULL 且未过滤 → 有 NULL 即顶首页 | 显式 `.desc().nulls_last()`，并按 §8.1 原式重写 |

---

## 4. P2 问题清单

| # | 问题 | 证据 |
|---|---|---|
| P2-1 | 防线二「返回日期比对」用 `today not in dates`（任一命中即整批放行），弱于方案；停牌脏价拦不住 | `market_daily_price_sync.py:173-181`；§6.2 要求「不一致则整批跳过」 |
| P2-2 | 历史回补 `symbol` 传带前缀 code（`"sh600519"`），对照 `notice_scan.py:267` 已做 `re.sub(r"\D","",code)` 剥离 | `market_daily_price_sync.py:270-275`；该路径**零测试** |
| P2-3 | §6.6 配置变更审计未落地（无 `AppLog`） | `router.py:315-344` |
| P2-4 | §3.2 未识别「方案进度」静默 `continue`，无日志（模块无 logger） | `dividend_sync.py:378-383`；§3.2「记日志跳过，不得臆测」 |
| P2-5 | 排名索引未表达 `DESC NULLS LAST` | `0004:371-374` |
| P2-6 | 可排序列仅 2/5，无 `order` 参数，口径列未做 TTM 优先固定序 | `router.py:50-53`；§8.1 |
| P2-7 | 默认源硬编码接口 name，未走「priority 最小 enabled」 | `0004:203-220` |
| P2-8 | 阈值 UI 直接用小数，未按「百分数展示 + 提交转小数」 | `SettingsPage.vue:803-819` |
| P2-9 | 未复用 `TableSkeleton`（用裸 `Skeleton`）、无 `Pagination` | `RankPage.vue:37/194/283` |
| P2-10 | §2.3「列头与卡片**必须**标注『税前』」未标注 | `RankPage.vue` 全文无「税前」 |
| P2-11 | **图例色块与文案自相矛盾**：红块（`--color-up`）标注「（绿）」 | `RankPage.vue:443-449` + `index.css:46`（`--color-up`=红）— **真实 UI bug** |
| P2-12 | 曲线 `connectNulls: true` 与 §3.5「缺段不返回 0」冲突，跨空连线等于伪造中间值 | `RankPage.vue:156` |

---

## 5. 重复造轮子专项（结论：**未发现重复实现，复用到位**）

| §11.3 既有能力 | 是否复用 | 证据 |
|---|---|---|
| `paged()` + `EnvelopeRoute` 响应包装 | ✅ | `router.py:39,44-46,116` |
| `_fetch_sdk_raw`/`_fetch_https_raw`/`_RATE_LIMITER`/`_guarded_fetch` | ✅ | `market_data_sync.py:385-400,552-600`；调用点 `dividend_sync.py:340`、`market_daily_price_sync.py:101,280`、`notice_scan.py:111,269` |
| `_upsert_masters` | ✅ | `dividend_sync.py:352` |
| `_normalize_master_code`/`infer_exchange`/`_row_get` | ✅ | `dividend_sync.py:46-47`；`market_daily_price_sync.py:31-37`；`notice_scan.py:34-41` |
| `_interfaces_for_category` / `_mark_failure` | ✅ | `notice_scan.py:104,114` |
| 前端 `ui/tabs`、`ui/select`、`ui/card`、`BaseChart`、`EmptyState`、`PageHeader`、`formatPercent/formatCurrency` | ✅ | `RankPage.vue:20-58`；`SettingsPage.vue` |
| 前端 `listAllInterfaces()` | ✅ | `use-dividend-yield.ts:27,149` |

**唯一轻微重复（P2）**：`dividend_sync.py:128` 新写 `_parse_date`，与 `data_transfer.py:142` 私有 `_parse_date` 语义重叠 → 建议上提到 `core/date_utils` 并让 `data_transfer` 收敛（既有技术债，非本次引入）。

**不构成重复**：东财中文列映射器、季末 guard、交易日历刷新、SPECIAL 双向去重 —— §11.3 已明确「确认不存在、需新增」。

---

## 6. 代码结构与可维护性

| 文件 | 行数 | 判定 |
|---|---|---|
| `web/src/modules/settings/pages/SettingsPage.vue` | **1154** | 超 `check_line_budget.py` >800 硬失败线（改动前 884，存量违规被放大） |
| `backend/app/services/dividend_sync.py` | 541 | 超 §4 ≤400 人工约定 |
| `web/src/modules/dividend-yield/pages/DividendYieldRankPage.vue` | 454 | 超 400 |
| `backend/app/services/scheduler.py` | 442 | 超 400，**直接违反 §14.4-3.1「scheduler.py 不超 400 行」验收项** |
| `backend/app/services/dividend_notice_scan.py` | 441 | 超 400 |
| `backend/alembic/versions/0004_dividend_yield.py` | 490 | 迁移文件可豁免（已拆 `_seed_*`，结构尚可） |

**PR 行数预算**：本次 +**4782** 行，远超闸门 800 上限（`check_line_budget.py` 实测 ✗）。`134e1cf` 已声明 `LARGE_PR_APPROVED=1` 豁免 → 闸门层面合规，但**这正是 P0 问题未被拦截的直接原因之一**，建议后续按阶段拆分提交。

**模块边界**：
- 前端 ✅ —— `web/src/api/*.api.ts` + `types.ts` 与仓库既有 25 个 api 文件约定一致；`modules/dividend-yield/{pages,composables}` 分层清晰、无跨模块引用。
- 后端 ⚠️ —— `router.py:40` 导入服务私有函数 `dividend_sync._to_cell`；三个服务调用 `MarketDataSyncService._call_interface_raw`（私有跨服务）。建议把 `_to_cell` 上提到 `services/dividend_yield.py`（纯函数模块本就该在那儿）。

**硬编码**：`RankPage.vue:74` 页大小 30 硬编码（且与 A13 的 20 冲突）；`0004:203-220` 默认源硬编码接口 name。常量抽取良好（`dividend_sync.py:51-83`、`market_daily_price_sync.py:41-48`、`notice_scan.py:44-54`）。

---

## 7. 测试有效性专项

### 7.1 实测结果

| 命令 | 结果 |
|---|---|
| 新增 4 个股息率测试文件 | **45 passed** (20.6s) |
| 后端全量 `pytest -q` | 1 failed, 35 passed, **382 errors**（`ProgrammingError`，单独重跑 `test_storage` 9 passed → 判为测试隔离/DB fixture 问题，本环境无 PG 服务；4 个 commit 未触碰相关代码，判**非本次引入**，建议在有 PG 环境复核） |
| 前端 `vitest run` | **66 文件 / 478 passed**（主理人预警的 vitest 损坏本次**未复现**）；但 66 个文件中**没有一个**属于 `modules/dividend-yield/` |

> 覆盖率数字未采集（本机 `--cov` 子进程异常报 45 errors），**不编造**，改以逐函数人工核对呈现。

### 7.2 「应测未测」清单（对照 §12，阻塞级优先）

1. **§2.6 四时点黄金断言**（7.4 / 6.3 / 5.3 / 5.4）—— 全部缺失
2. 除零 / 负价（price = 0、-1）
3. 方案进度五值经 `_upsert_dividend_batch` 真实落库（尤其 `取消分配`→REJECTED 不得落 PAID）
4. 未识别方案进度 → 跳过且不落库
5. 同一 `(报告期, period_type)` 多行（A3：须告警而非静默覆盖）
6. **腾讯分批边界契约：800 正常 / 905 静默空 / 910 414（httpx mock）—— 完全缺失**
7. 返回条数 ≠ 请求条数 → 重试
8. 公告扫描 `scan()` 端到端（2024-12-14 周六茅台样本 mock）
9. SPECIAL 双向去重「不同额保留」分支
10. 所选接口停用 → fail fast（4 个 handler 全未测）
11. `dividend_yield_rebuild`（§6.4）与 `backfill_historical`（§6.2）**零覆盖**
12. 并列 + 翻页不重不漏（tiebreaker 守护）
13. 非 admin PUT 返回 403；阈值 `red >= green` → 400
14. 前端：排序交互 / 标色随阈值变化 / stale 灰显 / 曲线空态 / 计算器数值 / TAB 保存 / 下拉联动 / **偏好项 TAB 化后读写不变回归**

### 7.3 测试质量评价

| 文件 | 评价 |
|---|---|
| `test_dividend_yield.py` (15) | 中偏好。LFY 用例对 `b333b67` 修复**有区分度**（实测 0.75 vs 0.25，真覆盖）；但 §2.6 黄金断言全缺、曲线一致性只测退化场景 |
| `test_dividend_sync.py` (10) | 中等。但 `_STATUS_MAP == {...}` 属**常量镜像断言**（P2-8），`_upsert_dividend_batch`/`quarterly_fetch` 主流程零覆盖 |
| `test_dividend_notice_scan.py` (9) | 偏好。但 `scan()` 主流程零覆盖 |
| `test_market_daily_price_sync.py` (4) | 偏差。`assert _BACKFILL_BURST == 10` 常量镜像零防护；分批边界契约完全缺失 |
| `settings-danger-zone.test.ts` (+19) | 合格。TAB 化后危险操作区的必要回归适配（但只守危险区，未守偏好项） |

> **常量镜像断言**（P2-8）：把常量重抄一遍做比对，改常量的人必然同步改测试，零防护价值 —— §3.2 最强调的「取消分配不得落入 PAID」这条方向性防线，实际没有端到端守护。

---

## 8. 待裁决事项（需 owner 拍板后实施）

| # | 裁决点 | 选项 |
|---|---|---|
| 1 | **标色方向与图例矛盾**：方案 §10.2 写「> green 绿 / < red 红」，实现用 `--color-up`（=**红**，A 股语义）标高股息率，而图例把红块标注「（绿）」 | A：按 A 股语义（高=红），回修方案 §10.2 + 修图例文案；B：按方案字面（高=绿），改用 `--color-down` 并重命名语义类。**无论选哪个，图例文案矛盾都必须修** |
| 2 | **§9 路径契约**：实现 `/rank` + `master_id` query，方案写 `/rankings` + 路径参数，前后端已自洽 | 回改代码对齐方案 / 回修方案契约，二选一，避免二次返工 |
| 3 | **方案 §2.5 伪代码 bug**：`_cells(L.year-1, 1)` 会跨年拼接，实现用 `(y-1, 4)` 正确 | 回修方案为 `(y-1, 4)`，否则后续维护者照伪代码「修回去」会引入回归 |
| 4 | **§11.2 迁移编号**：0003 已被占用，落 0004 是唯一正确解 | 回修方案表述为「链上下一个单一迁移」，避免后人按字面找 0003 |
| 5 | **时区修复范围**：P1-3 改 `AsyncIOScheduler` + `CronTrigger` 会**同时影响既有任务** | 本次一并修（须全量回归）/ 单独开「调度时区」专项 |
| 6 | **§6.3 留存措辞**：标题「五年留存」但规则为 `report_year < cur - 5`（实际保留 6 个财年） | 确认真 5 年（改 `< cur-4`）还是按现有规则改标题 |

---

## 9. 建议修复顺序（若只做三件事）

1. **P0-5 + 回归测试**：修曲线末点一致性，并把断言改成含 PROPOSED + NULL ex_date 的真实场景（方案唯一「契约」项，当前是假守护）。
2. **P0-2 / P0-3 / P0-4**：`/top20` 补近两年无分红剔除 + 连续分红榜（≥2、封顶 20、三元组排序），并补管理页过滤（含过滤态股息率现算）。
3. **P1-1 + P1-2**：`price<=0` 返回 None + 落地 `stale` 扫描 + 三处 `except: continue` 加日志（合起来才让 §3.5「不静默展示」成立）。

- 收尾（实现阶段）：迁移 0003 落地、§6.8 handler、上线前召回率校准。

## 股息率审查裁决落地（2026-09-06，owner 拍板）

- 代码改动（未提交，owner 按 Conventional Commits 拆分）：
  - 标色选 A（A 股：高=红）：`DividendYieldRankPage.vue` 图例文案 红块→「（红）」、绿块→「（绿）」；实现 text-up/红 已符合，仅修矛盾文案。
  - 时区一并修：`core/date_utils.py` 提 `APP_TZ`（保留 `_APP_TZ` 别名）；`scheduler.py` 4 处 `timezone=APP_TZ`（AsyncIOScheduler + from_crontab + 3×CronTrigger）。共享改动须回归既有任务。
  - §6.3 改真 5 年：`dividend_sync.py` `cutoff = today.year - _RETENTION_YEARS + 1`；测试同步守护边界（cur-4 保留、cur-5 删）。
- 方案文档回修 4 处：`§2.5` LFY 锚点 `(y-1,4)`（代码已实现正确、勿改回）、`§6.3` 留存 `当前年-4` 真5年 + 清理后重算、`§10.2` 标色 A 股语义 + 修正「无涨跌色 token」错误前提、`§11.2/§13.1-D1/§14.1-0.3` 迁移编号改为 0004（链上下一可用编号）。
- 裁决点 2（§9 路径）→ **已执行**：回改代码对齐方案（`router.py` `/rankings`、`/{master_id}/curve`、`/{master_id}/implied-price`，master_id 改 `Path(...)`；前端 `api/dividend-yield.api.ts` 同步把 `master_id` 移入 path；`top20` 方案与实现一致未动；grep 确认前端无旧路径硬编码残留）。
- 验证：本环境 `py_compile` 通过；留存测试因无 PG 未实跑，边界断言已更新，待 PG 环境
