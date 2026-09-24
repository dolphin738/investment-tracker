# 未推送代码审查报告（cnb/main..HEAD）

- **审查日期**：2026-09-23
- **审查范围**：本地 `main` 领先 `cnb/main` 的 **60 个提交**、**84 个文件**、**+12389 / -949 行**
- **跟踪基线**：`git log cnb/main..HEAD`；工作树仅剩 `.codebase-memory/artifact.json`、`graph.db.zst` 两处预期内改动（索引快照随提交滞后一笔）
- **审查方式**：按域并行深审（并发/互斥/取消、后端分红服务层、前端、迁移+契约），关键结论由审查方**逐条回源码复核**，并独立重跑 `gen-api-types.py` 比对生成物
- **本文边界**：只覆盖未推送代码；`docs/` 内既有评审文档（2026-09-20/21/22）已留痕的取舍不再重复计为缺陷

---

## 0. TL;DR

**结论：不建议直接推送。** 主干设计（幂等 staging、原子写主表、跨进程 DB 锁 + 标记取消、契约生成链路）方向正确、注释质量高于平均水平，但有 **7 条阻塞项**必须先修，其中 2 条会造成**静默且不可经 UI 回滚的数据后果**：

| 编号  | 阻塞项                                                 | 后果                                   | 是否亲验 |
| --- | --------------------------------------------------- | ------------------------------------ | ---- |
| B1  | 待划分页行内「忽略」按钮未接线                                     | 忽略的不是你点的那一行；不可撤销、永久丢弃派息信息            | ✅    |
| B2  | `acquire_admin_lock` 抢占陈旧锁时不清 `cancel_requested_at` | 一次取消永久污染后续所有播种：一启动就「秒取消」             | ✅    |
| B3  | 取消端点可被二次点击，`CancelledError` 打断 `finally` 中的释放       | `_seed_lock` 永久占用，播种功能锁死到进程重启        | ✅    |
| B4  | `dividend_pending.py` 553 行（新文件超 400 行约定）           | 约定红线 + 写路径继续堆叠无处安放                   | ✅    |
| B5  | `_assign_one` 无行锁、无原子状态转移                           | 不同目标期并发 assign 留下永久重复主表行，可能重复计息      | ✅    |
| B6  | `docs/openapi.json` 落后后端 docstring                  | 契约产物不可信，下次重生成会混入无关 diff              | ✅    |
| B7  | `GET/PUT /settings` 无 `response_model`              | settings 响应至今不在契约内 → 漏字段缺陷已复发一次、还会再有 | ✅    |

**最担心的链**：B5（并发重复写）× S2（assign 后不重算快照）× S3（窗外年份划分后被年度清理静默删除）× S9（多 worker 下进度面板显示 idle 误导连点）——四者叠加会让管理员「划分成功却看不到、过一阵又消失」，从而反复操作，正好撞上 B5。

---

## 1. 已亲验清单（独立复核，非仅采信分域汇报）

| 结论 | 复核方式 | 结果 |
| --- | --- | --- |
| `acquire` 不清取消标记 | `Read admin_lock.py:56-75` | ✅ 第 62 行仅 `SET owner = :tok, acquired_at = now()` |
| 释放路径可被取消打断 | `Read trigger_router.py:113-122,238,247-248` | ✅ `release` 在 `except Exception` 内，`CancelledError` 继承 `BaseException` 不被捕获，`_seed_lock.release()` 在 122 行 |
| 行内忽略未接线 | `Read PendingDividendTable.vue:217-224` + `Grep Page.vue` | ✅ `emit('ignore', row)` 对 `@ignore="openBatchIgnore"`（无参），`openBatchIgnore` 读 `selectedIds` |
| 单笔忽略端点零业务调用 | `Grep web/src` | ✅ `ignorePendingDividend` 仅命中定义 + 测试 mock，UI 从未调用 |
| `_assign_one` 无行锁 | `Read dividend_pending.py:295-348` | ✅ 305 行 `session.get(...)`，308 判定 → 333 写入，无 `with_for_update`、无条件 UPDATE |
| assign 不触发快照重算 | `Grep dividend_pending.py` | ✅ import 列表无 `refresh_yields_for_masters` |
| settings 无 `response_model` | `Read settings_router.py:156-171` | ✅ 两个端点均无 |
| 契约描述落后 | `python` 解析 `docs/openapi.json` 对比源码 docstring | ✅ cancel 仍写「经 `seed_task.cancel()` 请求取消」（单路径旧文案），progress 的 state 枚举缺 `cancelled`、未提 `failed_securities`/`failed_truncated` |
| 契约未随 docstring 更新 | `git show --stat` 三个相关提交 | ✅ `921e38e`/`9b04b4c`/`947a71e` 均只改 router/前端，未动 `docs/openapi.json` |
| 行数超限 | `wc -l` | ✅ pending 553 / notice_scan 410 / schemas_resp 467 / PendingDividendsPage 399 / AssignDialog 316 / Table 254 / suggest-report-period 222 |

---

## 2. 🔴 阻塞项

### B1. 待划分页行内「忽略」按钮未接线（不可逆数据丢失）✅ 亲验

- **位置**：`web/src/modules/admin/components/PendingDividendTable.vue:217-224`（`emit('ignore', row)`）、`web/src/modules/admin/pages/PendingDividendsPage.vue:341`（`@ignore="openBatchIgnore"`）、`:233-237`（无参处理函数）、`:261`（`batchIgnoreMut.mutate(Array.from(selectedIds.value))`）
- **问题**：行内「忽略」带了行数据，但绑的是**无参**函数，`row` 被静默丢弃。① `selectedIds` 为空时 `openBatchIgnore` 直接 `return` → 点了什么都不发生；② 有勾选时打开确认弹窗，实际忽略的是**整个勾选集合**，而被点击的那一行可能并未被忽略。
- **为什么严重**：忽略是永久且不可撤销的（后端仅支持 `PENDING→IGNORED`，`reopen` 只对 ASSIGNED 有效，`pending_router.py:173-178`；弹窗文案自述「永久丢失」，`PendingDividendBatchDialog.vue:63`）。契约本已定义单笔语义（`docs/design-dividend-pending-batches-2026-09-22.md:275`），`useIgnorePendingDividend`（`use-pending-dividends.ts:114`）+ `ignorePendingDividend`（`dividend-yield.api.ts:263`）也已实现，但零引用。`vue-tsc` 拦不住（零参函数可赋给带参事件处理器），现有测试只点批量条按钮，**该缺陷无覆盖**（`pending-dividends-page.test.ts:219-222`）。
- **建议**：`@ignore="(row) => openIgnoreConfirm(row)"`，单行走 `useIgnorePendingDividend`；确认弹窗改为接收「待忽略行集合」入参，计数改用该集合大小而非 `selectedIds.size`；补一条「未勾选时点行内忽略 → 只忽略该行」的用例。

### B2. `acquire_admin_lock` 抢占陈旧锁时不重置取消标记 ✅ 亲验

- **位置**：`backend/app/services/admin_lock.py:59-66`（62 行）；相矛盾的注释在 `backend/alembic/versions/0037_add_admin_lock_cancel_requested.py:14-16`；自毁点在 `backend/app/services/dividend_seed.py:157-162`
- **问题**：`ON CONFLICT ... DO UPDATE` 只写 `owner`/`acquired_at`，**完全没碰 `cancel_requested_at`**。而 0037 注释写「TTL 抢占陈旧锁时由 acquire 的 SET 天然覆盖为新 NULL 亦可」——这是错的：`NULL` 只可能由 `release_admin_lock`（`admin_lock.py:88`）写入。
- **可达链路**：点取消置位 → 持锁 worker 崩溃/被强杀/释放抛错（`trigger_router.py:117-121` 仅记日志不重试）→ 26h 后抢占成功但标记残留 → 新任务在 chunk 0 检查点自检即退出，报「已取消」。
- **为什么严重**：TTL 抢占存在的唯一意义就是崩溃恢复，却被残留标记变成「一次取消永久污染后续所有运行」。且 `request_cancel` 用 `owner IS NOT NULL` 判「有任务在跑」（`:111`），**陈旧死锁也满足**，于是「按钮像卡住了我点一下取消」会主动写下毒标记。
- **建议**：`DO UPDATE SET owner = :tok, acquired_at = now(), cancel_requested_at = NULL`（一行）；更稳的做法是给标记加 `cancel_target_owner`，检查点只在「发起取消时的 owner = 本进程 token」时退出。同步修正 0037 注释。

### B3. 取消端点二次点击打断锁释放 → 播种功能锁死到重启 ✅ 亲验

- **位置**：`backend/app/modules/dividend_yield/trigger_router.py:113-122`（释放路径）、`:247-248`（`seed_task.cancel()`）、`:238`（`local_running` 判据）
- **问题**：`task.cancel()` 在下一个 await 点注入 `CancelledError`，它继承 `BaseException`，**不被第 120 行 `except Exception` 捕获**。而 `local_running` 用 `not seed_task.done()` 判定，任务在 `finally` 中 await `release_admin_lock` 期间 `done()` 仍为 False → 第二次点击再次 `cancel()` → `CancelledError` 落在该 await 上 → 第 122 行 `_seed_lock.release()` **永不执行**。
- **为什么严重**：`_seed_lock` 是模块级 `asyncio.Lock`（`:45`），全仓仅 `:122` 一处释放；此后任何触发都在 `:144` 被 409 永久拦下，**只能重启后端恢复**。窗口不窄（`finally` 含一次 DB 连接 + commit，抖动时达秒级，而限流允许 10 次/分钟）。附带：DB 锁的 release 也可能被中断，跨进程锁一并泄漏。`app/core/bg.py:80-81` 把 `cancelled()` 当正常路径，**不打任何错误日志**，故障无痕。
- **建议**：释放改为不可取消——`try: await asyncio.shield(release_admin_lock(...)) finally: _seed_lock.release()`；取消端点做幂等去重（`if seed_task.cancelling(): return`，或置一次性标志）；释放失败至少落一条 warning。

### B4. `dividend_pending.py` 553 行，新文件超 400 行约定 ✅ 亲验

- **位置**：`backend/app/services/dividend_pending.py:1-553`；约定见 `AGENTS.md:27`、`docs/架构治理规范.md:90-91`；提交 `0ac6a2f` 无拆分理由段落
- **问题**：新文件 553 > 400（设计 §2.1 预估仅 ~230）；文件内混叠批次 B 的 `stage_pending` + 批次 C 的 `PendingDividendService`。另两处越过或贴近上限：`dividend_notice_scan.py:1-410`（拆分提交 `bc526da` 自述「瘦身至 397 行」，后续 `fe9a68d` 又增至 410）、`schemas_resp.py:1-467`（存量合规文件被本批推过上限）。
- **建议**：拆出 `dividend_pending_assign.py` 承载写路径（`assign`/`batch_*`/`ignore`/`reopen`/`_validate_target`/`_locate_main`/`_insert_main`/`_delete_assigned_main`，约 230 行）；`notice_scan` 的 `_first`/`_westward_dup`/`_reject_proposed`（`:345-400`）移入 `dividend_notice_meta.py`；不拆则须在提交说明写明理由（规范明文允许）。

### B5. `_assign_one` 无行锁/无原子状态转移（并发重复写主表）✅ 亲验

- **位置**：`backend/app/services/dividend_pending.py:305-339`
- **问题**：305 行 `session.get(SecurityDividendPending, pending_id)` 未加 `with_for_update()`，308 判定状态、333 置 ASSIGNED，非「条件 UPDATE ... WHERE status='PENDING'」式原子转移。两个并发 assign 若给**不同目标期**：双双未命中 `_locate_main` → 落在**不同**唯一键 → 两次都插入成功；pending 行只记最后写入者的 `resolved_*`。此后 `reopen` 只按该组 `resolved_*` 删除（`:488-512`），另一条主表行**永久残留**；若两期落在同一 4 季度窗口内，`compute_yield` 会把同一笔分红**计两次**（`dividend_yield.py:108-120`），无 UI 路径可清理。
- **说明**：设计只在 §1 处理了「assign × scan」并发（`ON CONFLICT DO NOTHING`）；同一目标期的 assign × assign 是安全的（第二次 `conflict=True`，`:328-331` 已处理），缺口仅在「不同目标期」这一支。
- **建议**：`session.get(..., with_for_update=True)`，或改为条件 UPDATE 并按 `rowcount` 判定（0 → INVALID_STATE）。修复成本一行，触发窗口窄但后果静默不可回滚。

### B6. `docs/openapi.json` 已落后后端源 ✅ 亲验

- **位置**：`docs/openapi.json`（`/seed-initial-dividends/cancel`、`/seed-initial-dividends/progress` 两个 path 的 `description`）对比 `backend/app/modules/dividend_yield/trigger_router.py:215-232`、`:184-191`
- **问题**：仓库版仍为旧文案——cancel 只讲「本进程 `task.cancel()`」，progress 的 state 枚举缺 `cancelled` 且未提 `failed_securities`/`failed_truncated`；后端已改为「两条取消路径 + DB 标记」与「失败证券清单」。由 `921e38e`/`9b04b4c`/`947a71e` 三次改 docstring 未重跑契约链路引入（已 `git show --stat` 确认三者均未改 `openapi.json`）。
- **影响**：本次漂移只落在 description、不影响 `components.schemas`（TS 产物零影响，已重跑 `gen-api-types.py` 比对**逐字节一致**）；但会让下次重生成的人把无关 diff 混进自己的改动，且 `backend/tests/test_contract.py:165-204` 只断言 paths 计数/schema 名（打运行时 app，非这份 JSON），**拦不住**。
- **建议**：`python scripts/gen_openapi.py && python web/scripts/gen-api-types.py`；新增自验门槛「重生成后 `git diff --exit-code docs/openapi.json web/src/types/api.ts`」。

### B7. settings 端点无 `response_model`，响应不在契约里（历史缺陷的结构性根因）✅ 亲验

- **位置**：`backend/app/modules/dividend_yield/settings_router.py:156`、`:166`
- **问题**：`782660f` 只把手写类型补上了 `dividend_retention_years`，但两个端点仍无 `response_model`，`docs/openapi.json` 中该 path 的 200 schema 为 `{}`，`components.schemas` 里**不存在** `DividendYieldSettingsOut`。前端唯一真相源是手写 `web/src/api/types.ts:837-848`，且 `dividend-yield.api.ts:119-123` 又叠一层扩展接口——同一字段被声明 3 次（`types.ts:847` 可选、`dividend-yield.api.ts:121` 必填）。
- **为什么是根因**：响应无 schema → 无生成类型 → 人工维护 → 漏字段。本次字段已在全部手写处同步（已核），但**下次加字段会原样复发**；且设计文档本就要求本批新端点全部声明 `response_model`（`docs/design-dividend-pending-batches-2026-09-22.md:265`）。
- **建议**：给 GET/PUT settings 加 `response_model=DividendYieldSettingsOut`（Pydantic 模型放 `schemas_resp.py`，与 `_settings_out` 逐字对齐），重生成契约后删除 `dividend-yield.api.ts:119-123` 的扩展接口，收敛为单一真相源。

---

## 3. 🟡 建议（按严重度排序）

| 编号  | 问题                                                               | 位置                                                                                                                            | 要点                                                                                                                                |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `reopen` 会删除**并非 assign 写入**的采集侧主表行，却报 `rolledBack=true`         | `dividend_pending.py:318-338,488-512`                                                                                         | conflict 分支未落库，无法区分「assign 写的」与「本来就在的」；D-5 原文只承诺删「assign 写入的」行                                                                    |
| S2  | assign/reopen 不触发派生快照重算                                          | `dividend_pending.py:339`                                                                                                     | `/rankings`、`/top20` 默认读派生表（`router.py:200-206`），最长滞后到下一次日线同步（跨周末数日）；人工修正恰是最该立即生效的场景                                              |
| S3  | assign 不校验留存窗，窗外年份写入后会被年度清理静默删除                                  | `dividend_pending.py:386-406` vs `dividend_sync.py:91-108`                                                                    | 待划分队列**主力正是窗外年份**（股改 2006~2007，`review-dividend-manual-period-2026-09-21.md:149,287`）；把关只做在前端（`suggest-report-period.ts:207-221`） |
| S4  | TTL 26h 是「获取时一次性写入」，无心跳续期                                        | `admin_lock.py:40-42,62,64`                                                                                                   | 26h/10h ≈ 2.6 倍余量是**隐式**的（依赖 seed set 规模与单只耗时不漂移）；被抢占无告警                                                                          |
| S5  | 跨进程取消生效延迟最坏 ≈20 分钟                                               | `dividend_seed.py:52,153-157`                                                                                                 | `_SEED_CHUNK=200` × 6s；这会**反向放大连点取消**，正好撞上 B3                                                                                     |
| S6  | `task.cancel()` 快路径可能留下「分红行已提交、快照未刷新」且续跑不自愈                      | `dividend_seed.py:166-177,256-258`                                                                                            | 下次续跑被 `_covered_masters` 跳过 → 不进 `changed` → 快照长期陈旧；仅 `/rebuild` 可修                                                               |
| S7  | 缺「两个并发获取者只有一个成功」的测试                                              | `tests/test_admin_lock.py:40-145`                                                                                             | 全部用例在同一 session 串行，未覆盖 `admin_lock.py:23-25` 的核心原子性论证（PG EvalPlanQual 重求值）；未来重构会静默破坏                                              |
| S8  | `is_cancel_requested` 不 commit/rollback，正确性隐式依赖 READ COMMITTED   | `admin_lock.py:124-131`                                                                                                       | 续跑场景（大量 covered 跳过）易形成跨 chunk 长事务；若隔离级别被改为 REPEATABLE READ，跨进程取消会**静默失效**且无测试报警                                                   |
| S9  | 多 worker 下进度面板是进程内内存态，与跨进程锁语义错配                                  | `dividend_seed.py:70-72`、`trigger_router.py:180-207`                                                                          | 触发落 A、轮询落 B → 显示 `idle` → 用户认为没成功 → 再点 → 409；取消同理（本进程面板仍 running）                                                                 |
| S10 | 非 PENDING 行可勾选 → 全选态错误 + 批量忽略送非 PENDING id                       | `PendingDividendTable.vue:62-70,171-180`、`Page.vue:102-111`                                                                   | 两个组件各自定义「可选中」，口径分裂；用户看到「失败 N 笔」而非「这些行本不可忽略」                                                                                       |
| S11 | ASSIGNED 行报告期文案由前端拼装，违反「文案由后端产出」约定                               | `PendingDividendTable.vue:96-100`、`cashPerShare` 直出 `1.000000`（`:194-196`）                                                    | 与证券详情页后端 `periodLabel` 口径不一；`PendingDividendOut` 应补 `periodLabel`/`planLabel`                                                     |
| S12 | 留存窗/年份口径依赖浏览器时钟，4 个魔数在三处重复                                       | `suggest-report-period.ts:35,207-222`、`GlobalSettingsDividendTab.vue:31-32`、`Page.vue:91`、`GlobalSettingsPage.vue:82,105,125` | 跨年/跨时区会给出错提示；后端改 1990 或默认窗 5 时前端静默漂移                                                                                              |
| S13 | 报告期枚举集合散落三处，而契约里 `periodType` 只是 `string`                        | `suggest-report-period.ts:18-23`、`dividend-yield.api.ts:71`、`AssignDialog.vue:76-82`                                          | 后端加枚举值时前端下拉静默漏项，`as keyof` 断言掩盖缺口                                                                                                 |
| S14 | 「待人工划分」唯一入口在概览查询失败时静默置灰                                          | `GlobalSettingsDividendInitBlock.vue:94-96,125-137`                                                                           | `pending ?? 0` → 失败也显示「暂无待划分」且 disabled，无错误态/重试；该页不挂侧边栏，失败即功能不可达                                                                  |
| S15 | 新增 9 端点无路径契约测试；`SeedProgress` 在契约之外                              | `dividend-yield.api.ts:157-207,212-268`、`trigger_router.py:194-207`                                                           | URL 段序/响应形状零断言（本次人工核过**是对的**）；`SeedProgress` 手写，字段改名只会让面板显示 `undefined`，`vue-tsc` 无感                                              |
| S16 | 进度轮询宽限期、批量部分失败保持选中两块最绕逻辑零测试                                      | `use-dividend-yield.ts:230-241`、`Page.vue:238-274`                                                                            | 现有测试把 `useSeedProgress`/`useCancelSeed` 整体替身掉、批量响应固定全成功 → 假绿风险最高处恰是无覆盖处                                                           |
| S17 | `PendingDividendsPage.vue` 399/400 行（设计预估 ~185）                  | 同左                                                                                                                            | 贴上限等于把下一次小改变成拆分任务；建议把「批量结果红条 + 批量操作条」（`:309-376`）抽成子组件                                                                            |
| S18 | 关键字输入无 `maxlength`，超 50 直接 422 且只显示泛化错误                          | `PendingDividendFilterBar.vue:67-73`、`pending_router.py:92`                                                                   | 可在输入层零成本拦住                                                                                                                        |
| S19 | `no_period` 入队发生在留存窗判定之前，注释「窗口外行不入队」与实现不符                        | `dividend_notice_scan.py:232-246`                                                                                             | 无报告期行年份未知，**必定全部入队**（含 1998~2007 老行），队列规模无界；测试只覆盖「可解析且超窗」                                                                         |
| S20 | `summary().total` 手写累加三种状态                                       | `dividend_pending.py:196-205`                                                                                                 | 将来加枚举值会「列表有、汇总无」；改 `sum(counts.values())`                                                                                         |
| S21 | 迁移 upgrade 段普遍缺 `IF NOT EXISTS` 幂等护栏                             | `0033:32-36`、`0034:27-60`、`0035:26-33`、`0036:30-34`、`0037:31-34`                                                              | 因 `alembic_version` 只在整条成功后前进，重试路径实际安全，**不阻塞**                                                                                    |
| S22 | `0033`/`0034` 的 downgrade 会静默销毁不可再生数据，docstring 未声明              | `0034:107-123`（DROP 表，内容是**从未写入主表**的行）、`0033:41-45`（DROP `dividend_label`，再 upgrade 回来值全 NULL）                                | 表/列级降级无法保数据（可接受），但须写明「本步丢数据」，否则运维误判可安全回滚                                                                                          |
| S23 | `0031` upgrade 的 DELETE 从「按 name 删种子行」扩面为「按 task_type 删全部行」，且无日志 | `0031:53-59`                                                                                                                  | 实测风险低（被删枚举值不在 `_CREATABLE_TYPES`），但静默 DELETE 事后无法对账                                                                               |
| S24 | 检索串未转义 LIKE 通配符                                                  | `dividend_pending.py:160-163`                                                                                                 | `q=%` 会命中全表；建议 `contains(..., autoescape=True)`                                                                                   |
| S25 | 批量失败原因透传原始异常文本                                                   | `dividend_pending.py:256-258,280-282`                                                                                         | 可能带出约束名/SQL 片段（仅 admin 可见，风险有限）                                                                                                   |
| S26 | `row_fingerprint` 纳入可变日期字段 → 源站补日期会产生第二条待办                       | `dividend_cninfo_parse.py:214-240`                                                                                            | 主表不会重复计价（有 `ON CONFLICT`），仅队列体验差；**设计已留痕**，按需收敛                                                                                   |

---

## 4. 💭 细节（顺手可修）

- 注释与实现漂移：`dividend_cninfo_parse.py:9-10` 称派息日「不落库」，实则 `:208` 已落 staging；`dividend-yield.api.ts:112-115` 称「不改 `api/types.ts`」但同批改了（`types.ts:847,861`）；`use-dividend-yield.ts:199-206` 仍写「进度经日志查看」；UI 文案「约 10 小时」（`InitBlock.vue:117`）与文件内注释「约 19 小时」（`:7`）冲突；`dividend_sync.py:1,78,165` 与 `enums.py:115` 仍写死「五年留存清理」。
- `trigger_router.py:143` 注释多缩进 4 空格（不影响语法，破坏 diff 整洁）；同文件 `:38-40`「检查-获取无竞态」的理由已过期（现依赖 DB 锁兜底）；`:93-95` docstring 中 `seed_initial_dividends` 既是端点名又是服务方法名，歧义。
- `trigger_router.py:155-165` 获取成功到 `create_task` 之间存在无保护窗口 → 进程被强杀即最长 26h 不可用，而 409 文案会误导运维去别的实例找任务；`:165-172` `record()` 在 `create_task` 之后，失败会 500 但任务已跑。
- `0015_remove_special_backfill_task.py:10` docstring 的 Revises 与实际 `down_revision="0012"` 不符（0013/0014 已物理删除，代码对、注释旧）。
- `_normalize_text` 与 `normalize_label` 同实现两名（`dividend_cninfo_parse.py:85-103`）；`dividend_notice_meta.py:121-129` 靠异常消息子串（"变为不可用"）判源失效，建议改专用异常类型。
- 前端无障碍：进度条无 `role="progressbar"`/`aria-valuenow`、错误与取消文案无 `aria-live`（`InitBlock.vue:185-190`）；表格表头/行 checkbox 无 `aria-label`；弹窗错误未用 `role="alert"`/`aria-describedby`（`AssignDialog.vue:303-306`）；`AlertDialogAction` 在 assign 模式仍用 destructive 红（`BatchDialog.vue:69-74`），语义误导。
- 前端其他：`progress.isError` 未使用（`InitBlock.vue:65-71`）；`state: string` 而非联合类型（`dividend-yield.api.ts:157-159`，新 state 会静默不轮询）；20s 宽限是魔数（`use-dividend-yield.ts:44-47`）；`placeholderData` 保留上一页期间仍可操作（`Page.vue:65`）；建议值展示格式三处不一致（Table / AssignDialog / Page）；筛选子组件把 `status` 声明为 `string` 抹平父级联合类型（`FilterBar.vue:17,38`）。
- 测试断言偏弱：`security-detail-panel-dividends.test.ts:128-138` 的「无标签不渲染 Badge」只断言「第 2 行不含第 1 行的标签文本」，无法区分「无 Badge」与「文案不同」；`global-settings-dividend-tab.test.ts` 的 tab 切换用 `click`，而 reka-ui `TabsTrigger` 真实组件依赖 `mousedown`（属既有手法，非本批引入）。

---

## 5. ✅ 做得好的地方

**后端并发/锁**
- 获取用单条 `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING`（`admin_lock.py:56-75`），是这题的正解：无「先 SELECT 再 UPDATE」窗口，无需显式行锁，三个分支与 RETURNING 有无行的对应在 `:19-21` 写得极清楚。
- 释放严格「谁持有谁释放」（`:84-93`），A 崩溃的陈旧锁不会被 B 误释放；释放时一并清取消标记（`:88`）方向正确。
- 取消选型正确：不持有其他进程协程引用就不杀任务，只留跨进程可见标记由持锁 worker 自检退出（`:103-105`）。
- 取消信号能穿透 `except Exception` 层层拦截（`trigger_router.py:106`、`dividend_seed.py:191` 均非裸 except），`bg.py:80-81` 把 `cancelled()` 当正常路径不打错误日志。
- 检查点走异步 DB 读取，全程无同步 DB 调用阻塞事件循环。
- 锁的生命周期与后台任务严格对齐，且「先抢 DB 锁→再取进程内锁→最后 create_task」顺序正确（`trigger_router.py:162-165`）。
- 取消后不误判失败率（`dividend_seed.py:228-231` 显式 `not cancelled`），摘要区分「完成 / 取消」。

**后端分红服务层**
- staging 幂等扎实：sha1 单列唯一 + `ON CONFLICT DO NOTHING`，并在 docstring 论证「为何不用含可空日期的复合唯一键」（PG 对 NULL 视为互不相等）；「assign 不删 pending 行」的理由（删行会因指纹缺失去重而复活）也写清了。
- 主表写入的原子性与不覆盖语义自洽：`ON CONFLICT DO NOTHING ... RETURNING id`（`dividend_pending.py:453-486`），`conflict` 由 RETURNING 是否为空判定。
- 单只失败隔离完整：`scan()` 的 `snapshot = dict(stats)`、rollback 后**重新解析 detail**（`dividend_notice_scan.py:156-168`，并解释了 rollback 会 expire 实例导致 `MissingGreenlet` 连锁的陷阱）；审查范围内**无** `except Exception: pass`。
- 整轮失败率冒泡（`dividend_notice_scan.py:170-178`、`dividend_seed.py:228-243`），避免上游整体失效被伪装成「扫描完成」。
- `_serialize` 口径统一：金额/日期透传 `Decimal`/`date`，交由 `decimal_jsonable_encoder` 统一序列化，避免 `None` 变 `"None"`；schema 与 wire 字段逐字比对**无漏字段**（历史 `dividend_retention_years` 类漂移未复现）。
- `restate_cells` 三边界修得准：REJECTED 排除出复权基准（`dividend_yield.py:182`）、`ex_dividend_date is None` 改为原样透传（`:193-196`，旧口径会套用 as_of 前全部送转因子，是真实行为变更），并以 spy 单测守护「每只每轮恰一次」不变式。
- 不变量都写进了代码：`period_label` 的 OTHER 分支必须早于 `quarter == 4`（`dividend_period.py:157-167`）、`no_cash` 必须先于 `no_period`（`dividend_cninfo_parse.py:118-119`）、`_westward_dup` 不得加 `period_type` 相等条件、留存窗采集/清理共用同一配置常量。
- 死代码清理彻底（`_TITLE_SPECIAL_RE`/`_match_proposed`/`_exists_anchor`/`_has_proposed`/`RETAIN_YEARS`/旧 `parse_cninfo_row` 全仓零引用）。

**迁移**
- 迁移链干净：28 个 revision、**唯一 head = `0037`**、零分叉/零重复/零未知父节点，未复现「照抄文档旧编号」的坑。
- `0034` 完全遵循 PG 原生枚举约定（`create_type=False` + `create(checkfirst=True)` + downgrade 先 drop_table 再 DROP TYPE）；模型与库逐列双向核对（SQLAlchemy metadata + `alembic --sql`）**零漂移**。
- 反向迁移链被真正打通（本批最有价值的修复）：`0021:82-92` 改 4 条 `IF EXISTS` 解掉 0028 造成反向断链；`0031:42-48` 补齐 `_ENUM_VALUES_ALL` 全历史 11 值，修掉 `0015:37` 的枚举 CAST 断链；`0031:96` 的 `TRUE→FALSE` 让降级回填的种子任务保持禁用。配套护栏 `test_dividend_enum_migration.py` **4 passed**。
- 新增列/表全部满足「不破坏既有数据」：无非空且无 server_default 的破坏性加列。

**契约与前端**
- 生成物确为生成物：`web/src/types/api.ts:1-4` 有自动生成标记，重跑 `gen-api-types.py` 得 111 schemas，与仓库文件**逐字节一致**；`docs/openapi.json` 的 paths/schemas 与后端源结构一致（仅 2 条 description 漂移，即 B6）。
- 前端契约合规：api 层复用 `components['schemas']` 而非再抄；`PendingDividendOut` 20 字段、9 个 URL 段序、`SeedProgress` snake_case 均逐字核对一致；`SecurityDividendItem.dividendLabel` 已进契约。
- 鉴权三层退化与仓库既有口径同构（`Page.vue:53-78` 对齐 `LogCenterPage.vue:43`），并有真断言（非授权不发任何查询、auditor 只读）。
- 不可逆操作有二次确认且文案讲清后果；取消流程**无乐观更新**、不产生假状态。
- 前后端校验与常量对齐，且「禁用优于报错」的设计取舍落实到位（年份/季度/留存窗 + 单格类型自动置季度并置灰）。
- 交互防误套路完整：筛选/翻页一律 `page=1` + 清空选中、只做本页全选、无候选行跳过并显式说明、失败行保持选中便于重试。
- Vue 模板约束**全部合规**：无 `v-if` 与 `v-for` 同元素、`v-else` 均紧邻纯 `v-if` 兄弟、列表用双层 `<template>`；选中态用「替换 Set」而非原地 mutate、表头三态用 `:checked` + DOM `indeterminate`（Vue 下最易写错的写法这里都对）。
- `vue-tsc --noEmit -p tsconfig.app.json` **exit 0、零诊断**，构建不会被前端类型阻断。

---

## 6. 需要 owner 裁决的事项（owner 已拍板 2026-09-24）

> 说明：以下为**存在多个合理选项、需业务/成本取舍**的条目；每条给出选项、我的建议与依据。

### 6.0 裁决结果与实施状态（owner 2026-09-24 回复）

| 编号 | 裁决 | 含义 | 实施状态 |
| --- | --- | --- | --- |
| A1 | **①** | 拆出 `dividend_pending_assign.py` 承载写路径 | ✅ 批次二（实际拆 3 文件，见 §10.1） |
| A2 | **①+③** | 单笔 assign/reopen 成功后立即重算快照；批量结束后统一重算一次 | ✅ 本批 |
| A3 | **①** | 后端 `_validate_target` 硬拒留存窗外年份（400），与前端同口径 | ✅ 本批 |
| A4 | **②** | 删除主表行时追加 `source == ASSIGN_SOURCE` 守卫（零迁移） | ✅ 本批 |
| A5 | **③** | `asyncio.shield` 隔离 DB 释放 **+** 取消端点幂等去重，两者都做 | ✅ 本批 |
| A6 | **①** | 检查点用 `renew_admin_lock` 顺手续期 `acquired_at`（TTL 只承担崩溃检测） | ✅ 本批 |
| A7 | **②** | 检查点每 10 只 + 时间节流（>15s 才查库）；**检查点前显式 `rollback()` 收口** | ✅ 本批（§9.2 偏离：改冻结隔离级别） |
| A8 | **①** | settings 端点补 `response_model` + 重生成契约 + 删前端扩展接口 | ✅ 批次二（§10.2） |
| A9 | **①+②** | `no_period` 维持一律入队（只修注释）+ 增加队列龄期度量 | ✅ 批次二（§10.3） |
| A10 | **②** | 先修 B1/B2/B3/B5 + B6，B4/B7 随后 | ✅ 顺序已遵（批次二即 B4/B7 + A9） |

**A4 的裁决说明（owner 原话：「A4 按主表数据可以清除掉」→ 选 ②）**：
主表 `security_dividends` 的数据可由采集链路重新写入，故「撤销划分」连带删除采集侧行本身可接受；
但既然划分写入的行天然带 `source = "人工划分"`（`ASSIGN_SOURCE`），加一个 `WHERE source = '人工划分'`
即可零成本把「撤销」做成精确动作。**该守卫的失效方向是「不删」（安全侧）**：若采集侧后来更新过
同一格、把 `source` 改写为数据源名，撤销将不删该行，管理员再点一次即可，绝不会反过来误删采集侧数据。

---

**A1｜`dividend_pending.py` 553 行如何收口**
- ① 拆出 `dividend_pending_assign.py`（约 230 行）
- ② 保留单文件，在提交说明补「不拆理由」
- **建议：①**。依据：`AGENTS.md:27` 对新文件是硬上限，且写路径（加行锁、加快照重算、加留存窗校验——见 B5/S2/S3）都要落在这个文件，不拆则三条修复无处安放。

**A2｜assign 后是否立即重算派生快照（S2）**
- ① 单笔 assign/reopen 成功后立即 `refresh_yields_for_masters([mid])`
- ② 不重算，前端明确提示「榜单次日生效」
- ③ 批量 assign 结束后统一重算一次
- **建议：①+③**（单笔走 ①，批量走 ③ 避免逐笔重算）。依据：`/rankings` 默认读派生表（`router.py:200-206`）；人工修正若当天看不到结果，会诱发反复操作并撞上 B5。

**A3｜assign 目标年份落在留存窗外如何处理（S3）**
- ① 后端 `_validate_target` 硬拒（400），与前端提示同口径
- ② 允许写入，但响应带 `warning`
- ③ 自动改判为 IGNORE 并提示
- **建议：①**。依据：窗外的写入必然被 `DIVIDEND_RETENTION_CLEANUP` 删除（`dividend_sync.py:91-108`），且待划分队列主力恰是窗外年份，硬拒可避免「划分成功→过一阵消失」；若业务上确有留存窗外补录需求，再选 ② 并同时延长留存窗。

**A4｜`reopen` 是否只删 assign 写入的主表行（S1）**
- ① 加布尔列 `assigned_wrote_main` 落库（需迁移 0038）
- ② 在 DELETE 上追加 `source == ASSIGN_SOURCE` 守卫（零迁移）
- ③ 维持现状，仅在响应/日志标注 warning
- **建议：②或③**。<br>依据：01 更严格但引入迁移成本；② 零迁移即可区分来源（需确认 assign 写入行的 `source` 是否有稳定标记）；③ 是当前设计已留痕的取舍，可接受但应把 warning 透出到 UI。

**A5｜取消端点的二次点击防护（B3）**
- ① `asyncio.shield` 包裹 release + 内层 `finally` 兜底 `_seed_lock.release()`
- ② 取消端点幂等去重（`seed_task.cancelling()` 或一次性标志）
- ③ 两者都做
- **建议：③**。依据：① 解决「锁泄漏」这一功能级故障，② 解决「语义重复」这一用户级误操作，两者独立且都廉价；`_seed_lock` 一旦泄漏只能重启，代价不可接受。

**A6｜锁 TTL 策略（S4）**
- ① 检查点顺手续期 `acquired_at`（TTL 仅承担崩溃检测）
- ② 仅把 26h 提到 settings 可配置
- ③ 维持硬编码 26h
- **建议：①**。依据：续期后 TTL 与任务时长彻底解耦，顺带获得「被抢占可感知」能力（`rowcount=0` 即已被抢占，可让本进程体面退出）；②③ 都仍依赖「10h 与 26h 的距离不漂移」这一隐式假设。

**A7｜检查点粒度（S5/S8）**
- ① 每只一查（走 PK 的极小 SELECT，相对 6s 网络请求可忽略）
- ② 每 10 只一查 + 时间节流（如距上次 >15s）
- ③ 维持每 chunk（200 只）
- **建议：②**。依据：① 最稳但查询量放大约 200 倍；② 把最坏延迟从 ~20 分钟压到 ~1 分钟，满足「点了有反应」的体感底线，同时不牺牲预算。另建议检查点前显式 `rollback()` 收口，使可见性不依赖隔离级别（S8）。

**A8｜settings 端点是否补 `response_model`（B7）**
- ① 补 `response_model` + 重生成契约 + 删除 `dividend-yield.api.ts` 的扩展接口
- ② 维持手写类型现状
- **建议：①**。依据：同一「漏字段」缺陷（`dividend_retention_years`）已复发一次；不补则第三次必然发生，且本批设计文档本就要求新端点声明 `response_model`。

**A9｜`no_period` 行的入队口径（S19）**
- ① 维持「一律入队」，只修注释
- ② 加队列深度/龄期度量（`oldestPendingAt` 或龄期分桶），超阈值告警
- ③ 限制无报告期行的入队年份下限（按公告日期过滤）
- **建议：①+②**。依据：无报告期行年份未知，硬过滤会丢失真实待办；但「队列不随留存清理 + 无龄期度量 = 静默腐化无红灯」，度量是与上轮评审元结论一致的收口方式。

**A10｜推送策略**
- ① 修完 7 条阻塞项再推
- ② 先修 B1/B2/B3/B5（数据与功能级）+ B6（契约），B4/B7 随后
- ③ 直接推送，阻塞项另开修复批次
- **建议：②**。依据：B4/B7 是结构性问题、不产生数据后果，可随后；B1/B2/B3/B5 都会造成静默且难以定位的后果，且 B6 会让下一个人的 diff 不干净。60 个提交粒度清晰、Conventional Commits 规范，拆分批推也无压力。

---

## 7. 建议的修复顺序

1. **B1**（前端忽略接线，1 处绑定 + 1 个确认弹窗入参）→ 补行内忽略用例
2. **B2 + B3**（各一行级改动 + `shield`/内层 finally）→ 补「TTL 抢占后残留标记」与「连点取消后锁仍可获取」两个用例
3. **B5**（`with_for_update` 或条件 UPDATE，一行）→ 补并发 assign 用例
4. **B6 + B7**（重跑契约链路 + 补 `response_model` + 删前端扩展接口）
5. **B4**（拆文件，建议与 A1 一并定）
6. 按 A2/A3/A4 裁决结果处理 S1/S2/S3（这三条是「划分后看不清结果」的闭环）
7. S5/S7/S8/S9（多 worker 体感与测试护栏）→ S10~S26 择机

---

## 8. 交付物与边界

- 本报告：`docs/reviews/review-unpushed-2026-09-23.md`
- 未覆盖：`docs/` 内方案文档与既有评审（2026-09-20/21/22）已留痕的取舍、`.codebase-memory/` 索引快照、纯文档改动（`docs/` 下 ADR 与设计文档）
- 未执行：未修改任何源码、未运行全量测试（仅按需运行 `test_dividend_enum_migration.py` 与 `vue-tsc --noEmit` 以取证）

---

## 9. 实施记录（2026-09-24，按 owner 裁决落地）

### 9.1 代码改动（12 文件）

| 文件 | 改动要点 | 对应 |
| --- | --- | --- |
| `backend/app/services/admin_lock.py` | ① `acquire` 的 `DO UPDATE` 补 `cancel_requested_at = NULL`（抢占陈旧锁时清残留标记）；② 新增 `renew_admin_lock()`（续期 + 「是否仍持锁」探针）；③ docstring / TTL 常量注释改写 | B2、A6 |
| `backend/alembic/versions/0037_*.py` | 修正与 SQL 不符的注释（原称「acquire 的 SET 天然覆盖 NULL」） | B2 |
| `backend/app/modules/dividend_yield/trigger_router.py` | ① 抽 `_release_admin_lock_safely()` 并包 `asyncio.shield`，`_seed_lock.release()` 落内层 `finally`；② 取消端点按 `cancelling()` 幂等去重；③ 触发时传 `lock_token`；④ 修注释缩进 | B3、A5 |
| `backend/app/services/dividend_seed.py` | ① 检查点改「每 10 只 + 距上次 >15s 才查库」；② 检查点调 `renew_admin_lock`（续期失败=被抢占 → 停止）；③ 摘要区分「用户取消 / 被抢占」；④ **不做 rollback 收口**（见 §9.2） | A7、A6 |
| `backend/app/db/database.py` | engine **显式声明** `isolation_level="READ COMMITTED"`（原依赖 PG 隐式默认） | A7（替代方案） |
| `backend/app/services/dividend_pending.py` | ① `_assign_one`/`_reopen_one` 取行锁 `with_for_update`；② `_validate_target` 增留存窗硬拒（配 `_retention_years()` 读配置）；③ 新增 `_touched_masters` + `_refresh_touched()`：单笔即时重算、批量收尾统一重算；④ `_delete_assigned_main` 增 `source == ASSIGN_SOURCE` 守卫 | B5、A3、A2、A4 |
| `web/.../PendingDividendsPage.vue` | ① 行内「忽略」改绑新增的 `openRowIgnore(row)`，单笔走 `useIgnorePendingDividend`（此前为零引用的单笔端点）；② 弹窗计数改用 `ignoreTargets`；③ 批量路径语义不变 | B1 |
| `web/.../__tests__/pending-dividends-page.test.ts` | 新增 2 例：未勾选时点行内忽略 → 只忽略该行；已勾选他行时点行内忽略 → 仍只忽略被点行 | B1 |
| `backend/tests/test_admin_lock.py` | 新增 ⑨抢占清标记 / ⑩续期刷新 `acquired_at` / ⑪续期探针 | B2、A6 |
| `backend/tests/test_dividend_pending_api.py` | 新增：留存窗硬拒（400、不写主表、仍 PENDING）；reopen 来源守卫（`rolledBack=False` 且采集侧行保留） | A3、A4 |
| `backend/tests/test_dividend_seed.py` | ① 既有取消用例显式把节流压到 0；② 新增节流语义用例（默认节流下 3 只只查 1 次库）；③ **修既有 flaky 断言**（见 §9.3） | A7 |
| `docs/openapi.json` | 重跑契约链路补齐落后的 cancel/progress description | B6 |

### 9.2 ⚠️ 对 A7 的一处偏离（需 owner 知悉）

A7 裁决为「检查点前显式 `rollback()` 收口」。按字面实施后**全量测试出现 24 个失败**，取证得到两个硬事实：

1. `rollback()` 会 **expire 会话内全部实例**（`detail` / `settings`），检查点因此必须就地重解析 `detail`；而 `_reresolve_detail_safe` 在「过程异常」时**返回 `None`**（`dividend_notice_meta.py:121-129`），`or detail` 于是留下**已过期对象** → 下一只访问其属性即 `MissingGreenlet`。
2. engine 未显式声明隔离级别（继承 PG 默认 READ COMMITTED），且 `AsyncSessionLocal` 为 `expire_on_commit=False` → **每只结束时的 `commit()` 已天然收口事务**，检查点不必额外 rollback 就能满足「下一条 SELECT 取新快照」。

故改为**等价且无副作用的替代**：检查点不 rollback，改为在 engine 上**显式固定 `isolation_level="READ COMMITTED"`** 并写明理由（避免有人改默认为 REPEATABLE READ 后跨进程取消静默失效）。裁决的**技术意图**（可见性不依赖隐式默认）已达成，且不破坏调用方事务。若坚持 rollback 字面方案，需同时接受「检查点重解析可能留下过期对象」的风险，或在 rollback 后重建 service 状态（成本更高）。

### 9.3 顺带发现的既有缺陷：一个 flaky 测试

`test_seed_stops_at_checkpoint_when_cancel_requested` 断言「被处理的证券 == `code_a`」，但 `_seed_rows` 按 **id 排序**、测试的 id 是 uuid4（随机）→ 该断言依赖随机顺序。实测连跑 3 次 **1 失败 2 通过**（约 50% flaky）。已改为顺序无关断言（恰好处理 1 只 + 恰好自检 2 次 + 恰好一只落库），改后连跑 5 次全通过。该缺陷属**既有**（非本次改动引入）。

### 9.4 验证结果

| 项 | 结果 |
| --- | --- |
| `ruff check app tests conftest.py` | All checks passed |
| `vue-tsc --noEmit -p tsconfig.app.json` | exit 0 |
| 契约重生成 | `docs/openapi.json` 仅 2 处 description 变化（即 B6 所指落后项）；`web/src/types/api.ts` 逐字节未变（证明漂移仅在描述、未影响类型） |
| 后端 `uv run pytest`（全量） | 见 §9.5 |
| 前端 `vitest run`（全量） | 见 §9.5 |

### 9.5 全量测试结果

| 项 | 结果 |
| --- | --- |
| 后端 `uv run pytest`（全量） | **765 passed, 3 xpassed, 0 failed**（修复前基线为 763 passed + 2 failed） |
| 前端 `vitest run`（全量） | **83 文件 / 569 tests 全绿，0 失败** |

修复过程暴露并解决的三类问题：
1. **我自身的编辑失误**：给 `for` 循环加检查点时把 `if cancelled: break` 插在循环体中间，导致原有「单只处理」整段成为 `break` 之后**不可达的死代码** → 表现为「证券总数 2 只、本轮处理 0 只、失败 0 只」且**无任何异常**，24 个用例失败。定位关键：`log_cli` 下看不到预期的「单只失败」告警 → 反证异常分支未执行 → 是「条件判定为假」而非「异常被吞」。
2. **A7 字面方案不可行**：检查点 `rollback()` 收口引发 `MissingGreenlet`（见 §9.2），改为「不 rollback + 显式固定 READ COMMITTED」。
3. **mock 未同步新签名**：`run_dividend_seed` 新增 `lock_token` 后，`test_dividend_yield_api.py` 的两个桩函数未接受该形参 → fire-and-forget 后台任务 TypeError（接口仍返 200，故只在断言阶段暴露）。已修复并补「令牌须透传」护栏断言；另修掉 1 个既有 flaky 断言（§9.3）。

---

## 10. 批次二实施记录（2026-09-24，A1/B4 + A8/B7 + A9）

> 对应 §6.0 中 A10=② 划为「随后」的三项：B4（拆文件）、B7（settings 契约）、A9（队列度量）。

### 10.1 A1/B4：`dividend_pending.py` 拆分（654 行 → 3 文件）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `backend/app/services/dividend_pending.py` | **300** | staging 写入（`stage_pending`）+ 读侧（`PendingDividendService`：列表/概览/序列化）+ 队列度量（`pending_queue_metrics` 等，见 10.3） |
| `backend/app/services/dividend_pending_assign.py` | **379** | 人工裁定写路径（assign / batch_assign / ignore / batch_ignore / reopen + 报告期校验 + 快照重算 + 项级错误映射）= `PendingDividendAssignMixin` |
| `backend/app/services/dividend_pending_main_write.py` | **138** | 主表写入原语（`_locate_main` / `_insert_main` / `_delete_assigned_main` + `ASSIGN_SOURCE`）= `DividendMainWriteMixin` |

**为何是 3 个文件而非 A1 选项里估的 2 个（约 230 行）**：裁定写路径自身即 379 行（`_assign_one` 73 行、`_insert_main` 47 行、`_validate_target` 41 行），与主表原语合并将回到约 470 行、仍破红线；故按「裁定编排 / 主表原语」再分一层，三者均 ≤400。

**兼容性（零感知拆分）**：`PendingDividendService(PendingDividendAssignMixin)`，继承链 `service → assign → main_write`，因此
`pending_router` / `dividend_notice_scan` / 测试的**导入路径与 `self._x` 调用口径逐字未变**；测试里
`monkeypatch.setattr(PendingDividendService, "_assign_one", …)` 依旧生效（打的是子类属性，遮住 mixin 实现）。

### 10.2 A8/B7：settings 契约进 OpenAPI（根因修复 + 逐字护栏）

- **后端**：`schemas_resp.py` 新增 `DividendYieldSettingsOut`（五字段；`dividend_retention_years` 声明为**非空 int**，与 `_settings_out` 「恒返回有效值」一致）+ `DividendYieldSourceRefOut`；GET/PUT `/settings` 声明 `response_model`。`docs/openapi.json` 两处 `"schema": {}` → `$ref`，**根因消除**。
- **前端收敛单一真相源**：删 `dividend-yield.api.ts` 的 `DividendYieldSettings` 扩展接口；`api/types.ts` 中 `DividendYieldSettingsOut` / `DividendYieldSourceRef` / `UpdateDividendYieldSettingsDto` 三份手写副本一并删除，改由 api 层导出生成类型别名（`DividendYieldSettingsOut` / `SettingsUpdateBody`），消费点（composable / 设置页 / 两个测试）随之改指向。
- **护栏**：新增 `test_settings_wire_matches_response_model`——`_settings_out` 的实际 wire 键集与 `response_model` 字段集**双向逐字比对**（GET/PUT 各一次 + 嵌套 ref + 类型断言）。**要点**：信封机制下 `response_model` 不参与运行时校验（`schemas_resp.py:4-8`），故「后端已返回、契约没声明」不会被 500 抓到——这正是 `dividend_retention_years` 漏过两次的机制，只能靠此类比对测试。该测试模式可直接复用到任何新端点。

### 10.3 A9：`no_period` 注释纠正 + 队列深度/龄期度量

- **注释纠正（S19）**：`dividend_notice_scan.py` 原注释「纯送转（no_cash）与**窗口外行不入队**」与实现相反——入队发生在 `cutoff_year` 判定**之前**，无报告期行年份未知故**一律入队**（含 1998~2007 老行）；已改写并明确「窗口外不入队」只对**报告期可解析**的行成立。
- **度量（A9=②）**：新增 `pending_queue_metrics()`（深度 / `oldestCreatedAt` / `oldestAgeDays` / 四段龄期分桶 / `stale`）+ `pending_queue_age_text()` + `pending_queue_warning()`（阈值 `PENDING_QUEUE_STALE_DAYS = 180`）。每日 `scan()` 摘要追加 `待划分队列N条/最老X天`；超阈值再打**一条** WARNING（进 app_logs），文案含分桶分布与处置动作。
- 口径细节：判据为「**超过** 180 天」（恰 180 不告警）；空队列 `oldest=None`、`stale=False`（不空报）；**仅计 `PENDING`**，`ASSIGNED`/`IGNORED` 不参与深度与最老龄期。
- 归属：阈值/分桶/措辞全部收口在 `dividend_pending.py`（队列语义的唯一归属地），`scan()` 只保留「取度量 → 有则告警 → 拼摘要」4 行，避免采集链路继续堆叠队列语义。

### 10.4 验证结果（批次二）

| 项 | 结果 |
| --- | --- |
| `ruff check app tests conftest.py` | All checks passed |
| 后端 `uv run pytest`（全量） | **770 passed, 3 xpassed, 0 failed**（批次一后基线 765 + 3 xpass；本批新增 5 用例） |
| 前端 `pnpm run lint`（`vue-tsc --noEmit`） | exit 0、零诊断 |
| 前端 `pnpm test`（全量） | **82 文件 / 574 tests 全绿、0 失败**（2 个 unhandled error 为沙箱 fs shim 临时文件 EPERM，与代码无关） |
| 契约重生成 | `docs/openapi.json` 仅 settings 相关 3 处 hunk；`web/src/types/api.ts` 新增 2 个 schema（共 113） |

### 10.5 批次二新增未裁决项

**A11｜两个「既有已超 400 行」的文件被本批增量推高，是否就地收口？**
- 现状（2026-09-24 `wc -l` 实测）：`dividend_notice_scan.py` **431**（原 410，A9 +21）；`schemas_resp.py` **495**（原 467，A8 +28）。
- 全仓 >400 行的 **app** 文件（均为**本批之前**既超，非本次引入）：`aggregation.py 604`、`classification.py 553`、`data_transfer.py 537`、`response_fields.py 486`、`calculation/router.py 466`、`asset_valuation.py 464`、`scheduler.py 457`、`log_center.py 436`（另需注意 `PendingDividendsPage.vue 435` = S17 未修）。
- ① **本批不动**：B4 原文红线针对「**新文件**超 400 行」，本批新文件最大 379 行 ✓；既有文件属历史债。
- ② 顺手收口 `dividend_notice_scan.py`：把 `_locate_cell`/`_first`/`_westward_dup`/`_reject_proposed`（`:351-423`，73 行）移入**新建** `dividend_notice_upsert.py`（`NoticeUpsertMixin`），主文件降到约 360 行。
  - ⚠️ **需修正本报告 B4 原建议**：原文建议移入 `dividend_notice_meta.py`，但该模块自述「**只放选源 / 二筛 / 重解析，不含落库与 upsert**」（`dividend_notice_meta.py:10-13`）——移入会使其职责自相矛盾；且 `_upsert_one` 依赖 `_bump` 与模块 logger，贸然移出会形成环导入，故只宜移上述四个**不含计数与日志**的方法。
- **建议：①**。依据：本批增量已在最小必要范围；一次性治理 8 个历史超限文件会显著放大本批 diff 与回归面，宜纳入下一次「结构债治理」批次（与 S17 一起做）。
- 🔨 **裁决（owner 2026-09-24）：③** —— 做 ②（收口 `dividend_notice_scan.py`），并**连带治理** `schemas_resp.py`。实施记录见 **§11.2**；§11.3 为收口后的超限盘点。

---

## 11. 推送后核验（2026-09-24）与 A11 收口

### 11.1 分批推送与 CI 终态

- **推送方式**：`git push cnb <中间提交sha>:main` 分批推（`b722e79` → `947a71e` → `dad8995` → `ae0ea16` → `6a3c8a4`），全部 fast-forward；远端 `main` = 本地 HEAD（73 提交），无待推提交。
  - **凭据**：owner 提供的 PAT 推送被拒（`Repository Not Found`）。取证：该仓库为 **public**，`ls-remote` 成功**不能**作为令牌有效的证据（无凭据、甚至伪造 token 都能读），且伪造 token 的推送报错与真 token **逐字相同** → CNB 对「令牌无效」与「权限不足」做了同一掩码，git 层无法区分。最终改用本机 `cnb` CLI 的 OAuth 凭据助手完成：`git -c credential.helper= -c credential.helper='!cnb git-credential' push cnb <sha>:main`（先 `--dry-run` 验写权限）；token 未落盘，`git config`/remote URL 均无残留。
- **`line-budget` 在 CI 中通过**（CI 侧基线解析为 HEAD → 新增 0 行）：§9.4 记录的那条本地 FAIL 是「未推送累计区间（70 提交 / +13390 行）」的**假阳性**，**不需要 `LARGE_PR_APPROVED=1`**。
- **CI 终态**（每批 4 条流水线）：

| 构建（提交） | backend-lint | frontend-lint | backend-test | frontend-test |
| --- | --- | --- | --- | --- |
| `cnb-v63`（`b722e79`） | ✅ | ❌ `knip-dependency-gate` | ✅ | ❌ `run-vitest` |
| `cnb-les`（`947a71e`） | ✅ | ❌ `knip-dependency-gate` | ❌ `run-pytest` | ✅ |
| `cnb-2u1`（`dad8995`） | ✅ | ✅ | ✅ | ✅ |
| `cnb-2kp`（`ae0ea16`，tip） | ✅ | ✅ | ✅ | ✅ |
| `cnb-fq3`（`6a3c8a4`，A11 收口，tip） | ✅ | ✅ | ✅ | ✅ |

- **中间态两条红的归因**（按时序 + §9.5 自证）：`947a71e` 的 `run-pytest` 红 = §9.5 所记「修复前 763 passed + 2 failed（mock 未同步 `run_dividend_seed(lock_token)` 新签名）」，由批次一修复提交消除；`b722e79` 的 `knip` / `vitest` 红 = 「行内忽略未接线、单笔端点与 composable 零引用」，由 `f6198cc` 消除。**这正是分批推送的价值**：把「从未过 CI 的中间态」的真实状态暴露出来（这些红会永久留在远端历史，tip 全绿才是结论）。

### 11.2 A11 实施记录（裁决 ③）

**A11-②｜`dividend_notice_scan.py` 收口**（`abd9444`）
- 四个「不含计数与日志」的方法（`_locate_cell` / `_first` / `_westward_dup` / `_reject_proposed`，73 行）迁至**新建** `backend/app/services/dividend_notice_upsert.py`（`NoticeUpsertMixin`，100 行）；主文件 **431 → 365** 行。
- 类改 `DividendNoticeScanService(NoticeUpsertMixin, NoticeMetaMixin)`；实测 MRO = service → upsert → meta，四个方法仍以 `self._x` 访问（测试对 `_westward_dup` / `_reject_proposed` 的直调不受影响）。
- 与 B4 原建议的差异（§10.5 已留痕）：未移入 `dividend_notice_meta.py`（职责自述冲突），且 `_bump` 与模块 logger 留在主文件以避免环导入；三个 notice 模块的归属约定写进了各自模块 docstring。

**A11-③｜`schemas_resp.py` 按域拆包**（`3e96262`）
- `backend/app/schemas_resp.py`（495 行）→ 包 `backend/app/schemas_resp/`：`common.py` 28 / `portfolio.py` 101 / `market.py` 119 / `calc.py` 130 / `transfer.py` 45 / `dividend_yield.py` 119 + `__init__.py` 119（门面）——**单文件最大 130 行**。
- **纯位移**：AST 行号切片逐字搬运（一次性脚本，零手抄）；域模块间**单向依赖**（现值仅 `calc → market`），不成环。
- **兼容性**：`__init__` 显式再导出全部 43 个符号并声明 `__all__` → 15 个引用文件的 `from app.schemas_resp import X` 与 `tests/test_contract.py:221` 的 `schemas_resp.X` **零改动**。
- **硬护栏**：拆包后重跑 `gen_openapi.py`，`docs/openapi.json` **零 diff**（契约完全未变，证据强度高于「测试通过」）；`docs/架构治理规范.md` §1.1 的目录职责表同步更新为包 + 单向依赖约束。

**A11 收口批次已推送并核验**：`ae0ea16..6a3c8a4`（第 5 批），构建 `cnb-fq3-1k3840err` **四条流水线全部 success**。收口后 `pre_commit_gate.py` **五项全过**（含此前假阳性的 `line-budget`：本地与 `cnb/main` 同步后累计区间为空）。

### 11.3 收口后的超限盘点（2026-09-24 实测）

| 文件 | 行数 | 状态 |
| --- | --- | --- |
| `app/services/dividend_notice_scan.py` | 365 | ✅ 本批收口（原 431） |
| `app/schemas_resp/`（7 文件） | ≤130 | ✅ 本批收口（原 495） |
| `app/services/dividend_pending{,_assign,_main_write}.py` | 300 / 379 / 138 | ✅ 批次二拆分 |
| 其余 >400 行的 app 文件 | aggregation 604 / classification 553 / data_transfer 537 / response_fields 486 / calculation-router 466 / asset_valuation 464 / scheduler 457 / log_center 436 | ⏳ 历史债，留待「结构债治理」批次（含 `PendingDividendsPage.vue` 435 = S17） |

## 12. S 类条目现状复核与裁决（2026-09-24，owner 裁决「按建议批发实施」）

### 12.1 复核结论：26 条中 7 条已随批次一/二修复，无须裁决

| ID | 修复落点（当前路径） |
| --- | --- |
| S1 | `dividend_pending_main_write.py` `_delete_assigned_main` 的 `source == ASSIGN_SOURCE` 守卫 |
| S2 | `dividend_pending_assign.py` `_touched_masters` + `_refresh_touched` |
| S3 | `_validate_target` + `_retention_years`（留存窗外年份 400） |
| S4 | `renew_admin_lock` 续期；检查点 `rowcount=0` → 「被抢占」可感知停止 |
| S5 | 检查点 10 只 + >15s 节流（取消延迟 ~1min） |
| S8 | `db/database.py:30` 显式 `isolation_level="READ COMMITTED"` |
| S19 | `pending_queue_metrics` + `PENDING_QUEUE_STALE_DAYS=180` |

⚠️ 复核中对原报告的两处严重性修正：**S6 下调**（`trigger_router.py` 快路径取消虽跳过收尾 refresh，但日线同步会对价格变动的证券重算——`market_daily_price_sync.py:187-188`——最长滞后到下一次有价格变动的日线同步，非「长期陈旧、仅 /rebuild 可修」；⚠️ 但此自愈**仅限场景 A**（任务取消导致快照陈旧），**场景 B**（公告扫描 `_reject_proposed` 置 `REJECTED` 且后续无新分红候选公告）下 `scan()` 的 `want_fetch = (mid in candidate_mids) or (not is_cancel)` 两条件皆否 → 不重拉 → `REJECTED` 永久滞留，日线同步只重算快照不重拉故不自愈，恢复只能手动「补齐历史分红」——精确口径见 §12.2）；**S21 维持不阻塞**（`alembic/env.py:48,59` 单事务包整个 upgrade，中途失败整体回滚，`IF NOT EXISTS` 护栏价值极低）。

### 12.2 裁决结果（owner：按建议批发实施）

**实施（S-1 低成本收口 9 条 / S-2 护栏补测 3 条 / S-3 契约收敛 2 条）**：S20、S24、S25、S18、S10、S14、S17、S22、S23、S7、S16、S15、S11。
**暂不做（附依据）**：S6（严重性下调——① 场景 A：任务取消快路径跳过收尾 refresh 的快照陈旧，可由日线同步对价格变动证券重算自愈；② 场景 B：公告扫描置 `REJECTED` 且后续无新候选公告的纯取消情形，日线同步不重拉、`REJECTED` 永久滞留，仅手动「补齐历史分红」救回；③ 原③方案有二次取消风险）、S12（稳定常量 + 注释交叉引用已收敛，扩契约面收益 < 成本）、S21（见 12.1）、S26（改指纹会让已入队存量行按旧指纹重复插入，需一次性迁移，收益仅队列体验）。
**待规划实施（owner 裁决：按建议修复，本次不落地）**：S9（多 worker 进度面板误导）。

- **证据**：`seed_progress = SeedProgress()` 是 `dividend_seed.py:117` 模块级进程内存单例；`/seed-initial-dividends/progress`（`trigger_router.py:218-232`）只直读本进程 `seed_progress`、零 DB 查询；触发 409 虽已带「另一进程持有」自由文本（`trigger_router.py:179-185`），但前端无法结构化识别，且进度轮询落 B 仍显示误导性 `idle`。注意：跨进程互斥已由 `admin_locks` 表正确承载（`acquire_admin_lock` / `request_cancel`），**功能正确性不受影响**，S9 纯属 UX 体感缺陷。
- **三方案对比（owner 2026-09-24 复核）**：
  - **① 进度态落库（新表 + 迁移）**：根治，任意 worker 轮询都读真实 running 进度且进程重启不丢面板；但新增表 + Alembic 迁移（须先 `alembic heads` 顺延编号）、须设计写入节流（种子 ~10h/5923 只，高频写库放大 DB 负担与锁竞争）、回归面大（`_run_seed`/`/progress`/`/cancel` 三侧 + 与 `admin_locks` 生命周期对齐）；当前单 worker 收益为零。
  - **② 端点返回「任务在其它进程运行」可感知提示（不动进度存储，推荐）**：②A（触发 409 的「另一进程持有」由自由文本提升为结构化信号——独立 business code 或响应体 `running_elsewhere: true`，前端据此显式提示）；②B（进度端点额外查 `admin_locks` 是否被人持锁——当前 `admin_lock.py` 无现成只读函数，仅 `request_cancel` 读 `cancel_requested_at`（`admin_lock.py:172`），须新增轻量 `SELECT owner, acquired_at`；逻辑：本进程 idle 且锁被他人持有未过期 → 返回 `state=running` + `running_elsewhere=true`）。改动极小、零写入负担、直接消除「误判 idle→误点→409」主困惑；代价：不根治跨进程进度细节可见（B 仅见 running 不见 total/processed 真实计数），且依赖 26h TTL 语义（持锁进程崩溃后 B 最长显示「运行中」26h 才被抢占）。
  - **③ 不改（基线）**：单 worker 下零问题；多 worker 下仅 UX 困惑，功能正确性由 DB 锁保证不受影响。
- **裁决**：当前单 worker 部署 → ③ 安全；未来上多 worker 时 → 优先 **②（尤其 ②B）** 性价比最高；① 仅当确需「跨进程真实进度计数」时才值得（种子 10h 任务用户通常只关心「在跑还是没跑」，细节价值有限，故 ① 偏过度设计）。
**并入其它批次**：S13 → 5.2b 枚举收敛批次（同一议题，不单点做）。
**owner 追认（2026-09-24）**：S13 维持「等枚举批次」——不单点实施，随 5.2b 枚举收敛批次统一处理（报告期枚举三处散落 + `periodType` 契约 string 属同一议题）。
**实施（2026-09-25）**：5.2b 枚举收敛**续批**已执行，S13 结项——后端 DTO 7 处裸 `str` 改真实枚举类型 → OpenAPI 提取 `ReportPeriodType`/`DividendStatus`/`DividendPendingStatus` 命名 schema → 前端删手写联合改引用生成物（运行时 `as const` 与标签映射保留，以 `Record<PendingPeriodType, …>` 约束完整性，后端加值即 `vue-tsc` 报错）；契约护栏 `test_openapi_enum_schemas_extracted` 扩 3 枚举 + 6 处 `$ref` 断言。详见 §12.6。

### 12.3 实施记录

**S-1｜低成本收口（后端 5 + 前端 4）**

| ID | 改动 | 落点 |
| --- | --- | --- |
| S20 | summary `total` 改 `sum(counts.values())`（防新枚举值漏计） | `dividend_pending.py:257-261` |
| S24 | `q` LIKE 转义 `_like_pattern()`（`%`/`_`/`\` 字面匹配，`escape="\\"`） | `dividend_pending.py:167-176`、`:210-219` |
| S25 | 批量 `failed[].reason` 改通用文案 + 服务端 `logger.exception` 留原始栈 | `dividend_pending_assign.py` |
| S22 | 0033/0034 downgrade 补「本步丢数据、不可再生」声明 | `0033_extend_report_period_type.py`、`0034_create_dividend_pending.py` |
| S23 | 0031 宽面 DELETE 前后补 INFO 日志（行数 + 保留集）；rowcount 用 `getattr` 容错（护栏测试只 patch `op.execute`，日志路径不得绑架 DDL 可测试性——实施中踩坑一次已修） | `0031_remove_quarterly_dividend_fetch.py` |
| S18 | 关键字输入 `maxlength=50`（与后端校验同界，防 422 泛化错误） | `PendingDividendFilterBar.vue` |
| S10 | 「可勾选」口径唯一化：`isSelectablePendingRow()`（仅 PENDING）供表头全选 + 行内 checkbox 共用；行内对非 PENDING 禁用 | `lib/pending-dividends.ts`、`PendingDividendTable.vue` |
| S14 | 待划分入口补 `isError` 态 + 重试按钮（查询失败不再静默不可达） | `GlobalSettingsDividendInitBlock.vue` |
| S17 | `PendingDividendsPage.vue` 435 → **285** 行：抽 `PendingDividendBatchBar.vue`（82）+ `use-pending-batch.ts`（190） | 页面 + 两新文件 |

**S-2｜护栏补测**

| ID | 新增用例 | 落点 |
| --- | --- | --- |
| S7 | 两个会话并发 `acquire_admin_lock` → **恰一个成功**（多会话 gather，锁原子性的唯一直接护栏） | `test_admin_lock.py`（264 行） |
| S16a | 进度轮询「宽限期」时序（done 后仍按宽限间隔轮询一次确认终态） | `use-seed-progress.test.ts`（新，140 行） |
| S16b | 批量部分失败 → 失败行保持选中、成功行移出选中集 | `pending-dividends-page.test.ts` |
| S15a | 9 个 dividend-yield 端点 URL 段序契约断言（web api 层 ↔ openapi paths） | `dividend-yield.api.test.ts`（1 → 5 例） |

**S-3｜契约收敛**

| ID | 改动 | 落点 |
| --- | --- | --- |
| S11 | `PendingDividendOut` 补 `planLabel` / `resolvedPeriodLabel`（后端复用 `dividend_period.plan_label`/`period_label` 产出，与 `/{master_id}/dividends` 同口径）；前端表格删自拼逻辑 + 金额格式化 | `schemas_resp/dividend_yield.py`、`dividend_pending.py _serialize`、`PendingDividendTable.vue` |
| S15b | `SeedProgressOut`/`SeedFailedSecurityOut` 入契约 + progress 端点声明 `response_model`；前端手写 `SeedProgress` 接口删除、改用生成类型；护栏 `test_seed_progress_wire_matches_response_model` | `trigger_router.py`、`web/src/api/dividend-yield.api.ts`、`test_dividend_yield_api.py` |

### 12.4 验证

| 项 | 结果 |
| --- | --- |
| `ruff check app tests conftest.py` | All checks passed |
| 后端全量 `uv run pytest` | **773 passed / 3 xpassed / 0 failed**（基线 770+3，本批 +3 用例：S7 并发 1 + S24 转义 1 + S15b wire 1） |
| 前端 `vue-tsc --noEmit` | exit 0 |
| 前端全量 `vitest run` | **83 文件 / 570 用例全绿、0 失败**（2 个 unhandled EPERM 为沙箱 fs shim 临时文件，非代码）；静态逐文件核对**零删除、净增 6 例** |
| `gen_openapi.py` + `gen-api-types.py` | 契约产物随 S-3 重生成（新增 2 schema + `PendingDividendOut` 2 字段） |

> 测试文件 `test_dividend_pending_api.py` 823 / `test_dividend_yield_api.py` 839 行：本批前已 768/785（>400 系历史债），本批各 +55/+54，未新引入违约；`line-budget` 按 merge-base 累计新增行数计（本批 +761 < 800），不触发 CI。

### 12.5 第三批实施记录（2026-09-24：S9 ②B + §4 顺手项 + S13 归属确认）

**S9 ②B：进度端点跨进程冲突态提示**

| 项 | 改动 | 落点 |
| --- | --- | --- |
| 新增只读探测 | `is_lock_held(session, name, ttl_hours)`：`SELECT owner, acquired_at` + 与 `acquire_admin_lock` **同一 TTL 口径**（`acquired_at >= now() - TTL`），零写入 | `services/admin_lock.py` |
| 端点逻辑 | progress 端点补 `db` 依赖；**仅本进程 `idle`** 且锁被他人持有未过期 → `state="running"` + `running_elsewhere=true`（计数零值）；本进程非 idle 时以本进程终态为准（done/error 的展示价值高于跨进程提示，②B 裁决口径） | `trigger_router.py` |
| 契约 | `SeedProgressOut` 补 `running_elsewhere: bool = False`；`state` 由裸 `str` 收紧为 `Literal[...]`（openapi enum → 前端生成联合类型，新 state 漏分支由 vue-tsc 报错，§4「新 state 静默不轮询」收口） | `schemas_resp/dividend_yield.py` |
| 前端 | 进度面板区分「运行中」/「其它进程运行中」badge 文案；跨进程态隐藏本进程进度条与计数、如实说明并保留跨进程可用的「取消」；进度条补 `role="progressbar"` + `aria-valuenow/min/max`，状态/错误/取消消息 `aria-live="polite"`；进度查询失败态 + 重试按钮（§4 `progress.isError` 未消费收口） | `GlobalSettingsDividendInitBlock.vue` |
| 测试 | +2 用例：锁被持有 → running+true；锁释放 → idle+false；本进程 done → 不被改写。wire 护栏（`test_seed_progress_wire_matches_response_model`）沿用自动覆盖新字段 | `test_dividend_yield_api.py` |
| 契约产物 | `gen_openapi.py` + `gen-api-types.py` 重生成（state enum + running_elsewhere；⚠️ 生成脚本需显式传参 `python scripts/gen-api-types.py ../docs/openapi.json src/types/api.ts`） | `docs/openapi.json`、`web/src/types/api.ts` |

②B 已知边界（裁决时已接受）：持锁进程崩溃后 TTL（26h）内 B 仍显示「运行中」；不根治跨进程真实计数（方案①，暂不做）。

**§4 细节顺手项（已修 15 项）**

| # | 修复 | 落点 |
| --- | --- | --- |
| 1 | 头注释「三个未用列含派息日不落库」→ 实况两个未用列（`COL_PAY` 派息日已落 `pay_date`） | `dividend_cninfo_parse.py:8-11` |
| 2 | `_normalize_text`/`normalize_label` 同实现两名 → 删别名收口单实现（零外部引用核实；连带改测试导入） | `dividend_cninfo_parse.py`、`test_dividend_cninfo_parse.py` |
| 3 | 「五年留存清理」写死 → 配置化口径（`dividend_retention_years`，默认 5） | `dividend_sync.py:1,78,165`、`models/enums.py:115` |
| 4 | 0015 docstring `Revises: 0014` 与 `down_revision="0012"` 不符 → 纠正为 0012 | `alembic/versions/0015_*.py` |
| 5 | 源失效判别「RuntimeError + 子串『变为不可用』」→ 专用 `DetailSourceUnavailableError(RuntimeError)`（子串误判免疫；继承 RuntimeError 保持既有语义） | `dividend_notice_meta.py` |
| 6 | 「检查-获取无竞态」注释补「跨进程竞态由 DB 锁兜底」；`_run_seed` docstring 端点名/服务方法名歧义澄清 | `trigger_router.py` |
| 7 | POST 返回文案「进度见应用日志」→「进度见本页进度面板」（无测试断言旧文案，已核实） | `trigger_router.py` |
| 8 | 头注释/区块注释/弹窗注释「约 19 小时」→「约 10 小时」（对齐后端 5923 只 × ≈6s 实况） | `GlobalSettingsDividendInitBlock.vue` ×3 |
| 9 | 「全市场播种 19 小时 + 进度经应用日志查看」过期注释 → 10 小时 + 进度面板 | `use-dividend-yield.ts` |
| 10 | 20s 轮询宽限魔数 → 导出常量 `SEED_PROGRESS_GRACE_MS` | `use-dividend-yield.ts` |
| 11 | 「进度见应用日志」页面文案 ×2 → 进度面板 | `GlobalSettingsDividendInitSection.vue`、`GlobalSettingsPage.vue` |
| 12 | FilterBar `status: string` 抹平联合 → `PendingStatusFilter` 联合类型收口 lib，门面/子组件共用 | `lib/pending-dividends.ts`、`PendingDividendsPage.vue`、`PendingDividendFilterBar.vue` |
| 13 | BatchDialog 确认按钮 destructive 红 → 仅 ignore 模式（assign 可经「重新划分」撤销，警示强度不匹配） | `PendingDividendBatchDialog.vue` |
| 14 | AssignDialog 错误 `<p>` 补 `role="alert"` | `PendingDividendAssignDialog.vue` |
| 15 | 弱断言「无 Badge」→ `findComponent(Badge)` 精确断言（区分「无 Badge」与「文案不同」）；连带修 2 个测试 mock 缺 `isError`/`refetch` | `security-detail-panel-dividends.test.ts`、`global-settings-*.test.ts` |
| 16 | **建议值展示格式三处统一**（owner 2026-09-25 裁决：以批量预览口径为准）：新增共享 `formatSuggestionPreview()`（`{code} {年}Q{季} {类型标签}`，approximate 自动带「（除权日推定，粗略）」后缀），Table 报告期列 / AssignDialog 主候选+备选 / BatchDialog 预览三处改同一实现；备选行前缀「（由除权日推定，粗略）」改由后缀承载避免重复；ASSIGNED 行正常路径仍用后端 `resolvedPeriodLabel`（非建议值口径，不动）；新增 4 断言单测 | `lib/pending-dividends.ts`、`PendingDividendTable.vue`、`PendingDividendAssignDialog.vue`、`use-pending-batch.ts`、`pending-dividends.test.ts`（新） |

**§4 明确不修（附依据）**

| 项                                      | 依据                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `Page.vue:65` placeholderData 保留上一页可操作 | 既有缓解已覆盖主要风险：翻页即清空选中；placeholder 行本身是真实 DB 行（非脏数据），批量操作不会作用到不存在/已删行      |
| tab 切换 `click` vs `mousedown`          | reka-ui 真实组件依赖 mousedown 属既有手法（非本批引入），改动面含全部 tab 类测试，收益低                |
| `trigger_router.py:143` 缩进异常           | 已随后续批次改动消除（现文件无该缩进问题），无需处理                                              |

**验证**：ruff 全绿；定向后端 126 passed（admin_lock / dividend_yield_api / notice_scan / seed / contract）+ cninfo_parse 14 passed；前端 `vue-tsc --noEmit` exit 0、全量 vitest 82 文件 / 565 用例 0 失败（3 个 EPERM 为沙箱 fs shim 噪声；盘上 84 个测试文件与 git 跟踪集零差异，`dividend-yield.api.test.ts` 5 例单独运行全绿——全量计数差为 collect 阶段沙箱干扰假象，非回归）；后端全量 `uv run pytest` **775 passed / 3 xpassed / 0 failed**（基线 773+3，本批净增 2 例：S9 ②B 冲突态 + 本进程终态优先；其间全量曾抓出 ②B 用例被 `test_dividend_seed` 单例残留污染 → 端点冲突分支改为显式清零计数 + 用例改「保存-强制-恢复」手法，复验通过）。

### 12.6 第四批：5.2b 枚举收敛续批（S13 结项，2026-09-25）

**后端（单一事实源 = `models/enums.py`）**

| 字段 | 原 | 现 |
| --- | --- | --- |
| `PendingDividendOut.status` / `.resolvedPeriodType` | `str` / `Optional[str]` | `DividendPendingStatus` / `Optional[ReportPeriodType]` |
| `PendingAssignResultOut.status` / `.periodType` | `str` / `str` | `DividendPendingStatus` / `ReportPeriodType` |
| `PendingIgnoreResultOut.status`、`PendingReopenResultOut.status` | `str` | `DividendPendingStatus` |
| `SecurityDividendItemOut.periodType` / `.status` | `str` / `str` | `ReportPeriodType` / `DividendStatus` |

**前端（删手写联合 → 引用生成物）**：`suggest-report-period.ts` `PendingPeriodType` 改 `components['schemas']['ReportPeriodType']`（`LEGAL_QUARTERS`/`PERIOD_TYPE_LABELS` 仍手写键值，靠 `Record<PendingPeriodType, …>` 完整性约束捕获新枚举值——这正是 S13「后端加值前端静默漏项」的护栏）；`dividend-yield.api.ts` 三处（`SecurityDividendItem.periodType`/`.status`、`PendingAssignPayload.periodType`、`PendingDividendFilters.status`）；`lib/pending-dividends.ts` `PendingStatusFilter`。

**契约产物**：`docs/openapi.json` + `web/src/types/api.ts` 重生成（118 schema，新增 3 个枚举联合）。

**类型收紧当场抓到 1 处**：`dividend-yield.api.test.ts` 批量夹具把 `periodType` 写成裸 `string` → 改 `PendingAssignItemPayload[]` 标注（护栏生效的实证，非回归）。

**验证**：ruff 全绿；定向后端 60 passed（contract/dividend_yield_api/dividend_pending_api）；`vue-tsc --noEmit` exit 0；受影响前端 6 文件全绿；后端全量 `uv run pytest` **775 passed / 3 xpassed / 0 failed**（契约护栏仅扩断言，用例数不变）；前端全量 `vitest run` **606 例 / 0 失败**（1 个 EPERM 为沙箱噪声）。
