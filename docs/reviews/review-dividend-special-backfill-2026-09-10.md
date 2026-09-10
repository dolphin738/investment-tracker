# 代码审查报告：特别分红历史回补 + NaN 清洗（未推送序列）

- **审查日期**：2026-09-10
- **审查人**：CodeReviewExpert（按 `docs/代码审查标准与流程.md` §7 模板产出）
- **审查范围**：`cnb/main..HEAD` 共 16 笔提交，14 文件 **+1350 / −22**
- **功能主题**：① §6.9 特别分红历史回补（冷启动一次性）；② §3.5 numeric NaN 清洗（源头/守卫/存量三层）
- **结论**：**可合入（无 P0/P1，M-1/M-2/M-3 测试缺口已修复）**

---

## 0. TL;DR

| 维度 | 结论 |
|---|---|
| 正确性 | ✅ 回补主链路硬约束（只认实施行 / 5 年窗口 / 西向去重 / 顺序 fail fast）均有实现且有测试 |
| 需求一致性 | ✅ 代码与 `docs/股息率排名管理方案.md` §6.9 / 附录 A.12/A.13 对齐 |
| 测试 | ✅ **核心服务层 764 行 + NaN 修复链 / `/backfill-specials` 端点 / 前端按钮全补契约（M-1/M-2/M-3 已修复）** |
| 安全 | ✅ 端点 `require_admin`；任务 `enabled=FALSE` 不自动调度；per-job 锁防堆叠 |
| 数据风险 | ✅ 迁移 downgrade 诚实标注不可逆；删除范围有实测行数支撑 |
| **阻塞项** | **无 P0/P1** |

**一句话**：实现质量高于项目平均水準（罕见的高密度根因注释 + 统计回退 + fail fast），
审查时测试覆盖呈"核心重、边缘空"的不对称形态——NaN 这条真实线上数据污染事故的修复
**零回归护栏**；该缺口已在 2026-09-10 补齐（M-1/M-2/M-3 共 8 条断言，后端 502 / 前端 518 全绿）。

---

## 1. 澄清表（本次核实的关键疑问）

| # | 疑问 | 核实结论 | 证据 |
|---|---|---|---|
| Q1 | 新增 `/backfill-specials` 是同步等待吗？12~25 分钟长任务会否超时？ | **否**。`run_task_now` 为 `create_task` fire-and-forget，立即返回 | `router.py:588` 注释 + `scheduler.py:440-444` |
| Q2 | fire-and-forget 失败会静默丢失吗？ | **不会**。`_run_job_inner` 有 try/except 落 `FAILED` + `error` 到 JobRunLog | `scheduler.py:257-259` |
| Q3 | 重复点击按钮会任务堆叠吗？ | **不会**。`_run_job` 持有 per-job 运行锁，同 job 并发直接 return | `scheduler.py:221-223` |
| Q4 | 前置 `session.commit()` 会让 `detail` 过期吗？ | **不会**。工程全局 `expire_on_commit=False` | `database.py:27` |
| Q5 | 迁移 0011 插入 `job_configs` 字段完整吗？ | ✅ 完整，`max_logs` 可空 | `models/job.py:33-55` |
| Q6 | `dividend_yield != Decimal('NaN')` 能正确排除吗？ | ✅ PG numeric 中 `NaN = NaN` 为真，`!=` 对 NaN 返回 false（排除）；对 NULL 返回 NULL（由 `is_not(None)` 挡住），两条件叠加不冲突 | `router.py:168-174` 及注释 |
| Q7 | 测试是否覆盖 `/backfill-specials` 端点？ | **否**（审查时）→ **已补**（M-2）：401/403/404/200 四类契约齐全 | `tests/test_dividend_yield_api.py::test_backfill_specials_*` |

---

## 2. 缺陷清单

### ✅ M-1｜NaN 修复链零回归测试（已修复）

**三笔提交全部无测试**：

| 提交 | 改动 | 测试 |
|---|---|---|
| `f91870f` | `parse_cash` / `_sina_cash` 显式 `is_nan` 归 None | ❌ 无 |
| `34be1c1` | rank / top20 / 连续榜进榜守卫排除 NaN | ❌ 无 |
| `90e588f` | 迁移 0010 删除两表 NaN 行（359 + 121 行） | ❌ 无 |

**取证**：`grep -rn "NaN" backend/tests/*.py` —— **零命中**。

**为什么这是 M 而非 L**：这不是"新功能缺测试"，而是**一次真实生产数据污染事故的修复缺护栏**。
NaN 曾导致 121 行快照混入榜单并在 PG 排序中被视为最大值霸占榜首（迁移 0010 docstring）。
修复后无任何断言阻止 `parse_cash` 被改回原样、或进榜守卫被误删——**缺陷可静默复发且无人察觉**。

**建议**（成本极低，收益高）：
1. `parse_cash("NaN") is None` / `_sina_cash("nan") is None` —— 2 条纯函数断言；
2. 一条 `rank` 集成测试：种一行 `dividend_yield = Decimal('NaN')` 的快照，断言不进榜；
3. 迁移 0010 可不测（SQL 删除难测），但建议补一条"守卫已拦住存量 NaN"的等价断言兜底。

**✅ 修复确认（2026-09-10）**：已落 4 条断言，后端全量 502 passed 含此——
- `tests/test_dividend_sync.py`：`parse_cash("NaN") is None`（大写 "NaN" 形态原零覆盖）
- `tests/test_dividend_notice_scan.py`：`_sina_cash("NaN") is None`（大写 "NaN" 形态原零覆盖）
- `tests/test_dividend_yield_api.py`：`test_rankings_excludes_numeric_nan_snapshot`（种 `Decimal('NaN')` 快照，断言不进榜、首位为正常值）、`test_top20_excludes_numeric_nan_snapshot`（rank/top20/consecutive 双榜契约）

---

### ✅ M-2｜`/backfill-specials` 端点零契约测试（已修复）

`router.py:577-625` 新增 admin-only 端点，含 **404 分支**（种子任务缺失时抛 HTTPException），
但测试仅覆盖 `DividendNoticeScanService.backfill_specials()` service 层。

**不一致点**：同文件的 `/rebuild` 端点此前已补 403/401/200 三条契约测试
（`test_dividend_yield_api.py`），新端点未对齐同一标准。

**建议**：补 4 条——401（未登录）/ 403（非 admin）/ 404（种子缺失）/ 200（含 `job_id`）。

**✅ 修复确认（2026-09-10）**：已落 4 条契约（`tests/test_dividend_yield_api.py`）——
- `test_backfill_specials_requires_admin`：401 未登录 / 403 非 admin
- `test_backfill_specials_404_when_seed_job_missing`：404 且 `message` 含种子任务编号（信封响应 `data.message`）
- `test_backfill_specials_triggers_job_async`：admin 触发 200 + `job_id`，monkeypatch `run_task_now` 验证 fire-and-forget

---

### ✅ M-3｜前端新增按钮零测试（已修复）

`RankingPage.vue` +25 行新增 admin 按钮（含 `useBackfillSpecialDividends` mutation），
`api/dividend-yield.api.ts` +10、`composables` +16，但 `__tests__/ranking-page.test.ts` **未改**。

**建议**：补 2 条——admin 可见按钮并点击触发 mutation；非 admin 不渲染（与"全量重建"同契约）。

**✅ 修复确认（2026-09-10）**：已落 2 条（`web/.../__tests__/ranking-page.test.ts`）——
- admin 可见「特别分红回补」按钮、点击触发 `backfillSpecialDividends` api（fixtures 计数验证）
- 非 admin 不渲染该按钮（`useIsAdmin` 读 Pinia store.user.role）
- 前端全量 74 文件 / 518 passed 含此

---

### ✅ L-1｜迁移 0010 docstring 与真实 revision 不一致（已修复）

```python
# backend/alembic/versions/0010_dividend_nan_cleanup.py
Revision ID: 0009_dividend_nan_cleanup        # L19  ← 实际是 0010
Revises: 0008_remove_dividend_yield_rebuild_task  # L20 ← 实际是 0009_fix_...
revision: str = "0010_dividend_nan_cleanup"       # L26  ✅
down_revision = "0009_fix_dividend_interface_code_fields"  # L27 ✅
```

执行以 `revision`/`down_revision` 为准（无功能影响），但 docstring 是 copy-paste 遗留，
会误导后续维护者判断迁移链。建议改齐。

**✅ 修复确认（2026-09-11）**：docstring L19-20 已改为真实的
`Revision ID: 0010_dividend_nan_cleanup` / `Revises: 0009_fix_dividend_interface_code_fields`。

---

### ✅ L-2｜`_exists_anchor` 命中跳过不计入任何 stats（已修复）

`dividend_notice_scan.py:394-395`：锚点格已有 SPECIAL 时 `continue`，不计入
`new/dup/window/nocash/failed` 任何一项。

影响：摘要「新写 N」≠「发现的有效行数」，运维按摘要对账时该分支不可见。
（`scan` 路径同样如此，属一致性问题而非 bug。）

**✅ 修复确认（2026-09-11）**：scan/backfill 两路径 stats 新增 `anchor` 计数器，
三处 `_exists_anchor` continue 前均 `+= 1`，两份摘要各加「锚点跳过N」；
新增断言 `stats["anchor"] == 1`（backfill）与 `test_scan_counts_anchor_skip_in_summary`（scan）。

---

### ✅ L-3｜失败路径的重解析自身抛异常会终止整个回补（已修复）

`dividend_notice_scan.py:641-643`：`except` 块内调用 `_re_resolve_detail_after_rollback()`，
该函数**自身若抛异常**（如 DB 瞬时故障）会直接冒泡出 `for` 循环，终止剩余全部证券。

设计意图上「补充源不可用 → fail fast」是对的，但「重解析操作本身失败」被混同处理。
4609 只串行 12~25 分钟，一次瞬时 DB 抖动即前功尽弃（已提交部分保留，剩余未处理）。

**建议**：区分「解析结果 None」（真失效 → fail fast）与「解析过程抛异常」
（可重试 N 次或计入 failed 后继续）。优先级低——触发概率不高。

**✅ 修复确认（2026-09-11）**：新增 `_reresolve_detail_safe`（scan/backfill 两路径共用）——
真失效（`RuntimeError("…变为不可用")`）原样 raise 保留 fail fast；过程异常（DB 瞬时抖动等）
记 warning 后按失败续下一只，**不终止整轮**（下一轮重解析自愈）。既有 fail-fast 用例
`test_backfill_specials_fails_fast_when_source_disabled_mid_run` 保持通过；
新增 `test_backfill_specials_continues_when_reresolve_raises_transient` 守护韧性。

---

### ✅ L-4｜前端按钮无二次确认 / 无进度反馈（已修复）

`RankingPage.vue:276-285`：一键触发 12~25 分钟的写库操作，无确认弹窗，
成功后仅 toast「已触发…进度见定时任务日志」。

与既有「全量重建」按钮行为一致（无不一致），但该操作耗时与影响面更大。
建议至少加 confirm；进度可见性依赖用户主动跳转日志页。

**✅ 修复确认（2026-09-11）**：`RankingPage.vue` 点击按钮改为弹出 AlertDialog 二次确认
（复用项目 `components/ui/alert-dialog`，destructive 样式，文案注明 12~25 分钟写库 +
须在季度抓取后执行 + 进度看定时任务日志）；确认后才触发 mutation。
M-3 测试同步改为「未确认不触发 → 点确认后触发」契约（8/8 passed）。

---

### ✅ L-5｜迁移 0010 删行的副作用未记载（已修复）

删除 153 行 `PAID` + 206 行 `PROPOSED` 的 NaN 分红记录后：
`consecutive_years` / `last_dividend_year` 由 `payout_records()` 从 `security_dividends`
行推导（`dividend_yield.py:156-173`），**删行会改变这两个派生值**。

方向上这是**语义纠正**（NaN 金额 = 上游缺失，本就不该算作「有分红」），
但文档仅记载「快照由 refresh 重算恢复」，未提连续年数会变——运维对账时可能困惑。
建议在迁移 docstring 补一句副作用说明。

**✅ 修复确认（2026-09-11）**：迁移 0010 docstring 已补「副作用（运维对账提示）」段，
明确删行会改变 `consecutive_years` / `last_dividend_year` 且属语义纠正。

---

### ✅ 债务（已收敛）

- **跨服务调私有方法**：`dividend_notice_scan.py` 多处 `self._mds._call_interface_raw(...)`，
  跨服务调用 `MarketDataSyncService` 的私有方法。既有模式（scan 已用），新增 backfill 沿用。
  建议后续抽公共 `InterfaceCaller` 或在 `MarketDataSyncService` 上开公开方法。
- **`create_task` 无强引用**：`scheduler.py:442` 与 `portfolio/router.py:115` 均为
  fire-and-forget 且未保存 task 引用（Python 文档建议保存以防 GC）。
  既有模式；因 `_run_job` 已落日志，实际风险低。

**✅ 收敛确认（2026-09-11）**：
- 跨服务私有调用：`MarketDataSyncService` 新增公开 `call_interface_raw`（委托私有实现），
  `dividend_notice_scan.py` 三处 `self._mds._call_interface_raw` 改走公开入口，
  该模块测试 monkeypatch 同步切换（其余模块沿用私有实现，保持既有模式不动）。
- 强引用：`scheduler.py`（`run_task_now`/`run_user_sync_now`）与
  `portfolio/router.py` 统一经模块级 `_BG_TASKS` set + `_track_task` 持有引用，
  done callback 自动移除。

---

## 3. 值得肯定的实现（正面记录）

审查不只是挑错，以下几处质量明显高于项目平均，建议作为范式沉淀：

1. **`rollback()` → ORM 全量 expire → 重解析补充源**（`_re_resolve_detail_after_rollback`）
   根因分析极扎实：识别出 `MissingGreenlet` 会把「源失效」伪装成「每只都失败」，
   使「失败续下一只」的容错形同虚设。注释完整记录了触发条件与为何仅失败路径重解析
   （避免 4609 次无谓查询）。**这类"静默降级为全失败"的 bug 极难发现**。

2. **`stats` snapshot 回退**（`snapshot = dict(stats)` → 失败时 `stats.update(snapshot)`）
   保证「摘要 == 实际落库结果」，运维按摘要对账不偏大。同样细节：
   `changed.add(mid)` 仅在 commit 成功后执行，「重算 N 只」同口径。

3. **三条 fail fast 前置**：无报告期行 / 仅 SPECIAL 行 / 补充源缺失，
   均以 `RuntimeError` 携带**可操作的原因说明**终止，而非静默空跑。

4. **迁移 0011 三重防御**：`autocommit_block`（PG 枚举 ADD VALUE 硬要求）、
   `IF NOT EXISTS`（幂等）、`enabled=FALSE`（防周期误跑）。

5. **迁移 0010 downgrade 诚实为空**并注明「数据修复不可逆」——不假装可回滚。

---

## 4. 验证状态

| 项 | 状态 |
|---|---|
| 新增回补测试 `test_dividend_special_backfill.py` | ✅ **21 passed**（12.7s） |
| 前端 `vue-tsc` / `vitest` | ✅ **全量 74 文件 / 518 passed**（含 M-3 按钮契约） |
| NaN 相关测试 | ✅ **已补**（M-1：纯函数 2 条 + rank/top20 集成 2 条）；后端全量 502 passed |
| `/backfill-specials` 端点契约 | ✅ **已补**（M-2：401/403/404/200 四条） |

---

## 5. 决议建议

**可合入**（符合 §9「零 P0/P1 未决」门槛）。

合入前建议至少补 **M-1 的两条纯函数断言 + 一条 rank 集成断言**（合计约 20 行），
成本极低但真正守住了这条数据污染修复线。M-2/M-3 可随下一轮补齐；L 系与债务登记 cleanup REP。
