# 诊断：回补游标残余窗口（P2-1 Residual Window）

- 日期：2026-09-16
- 模块：`backend/app/services/market_price_backfill_*` + `backend/app/modules/dividend_yield/backfill_router.py`
- 关联任务：P2-1 / P2-2 / P2-3 / P2-4 / P2-5 / P2-6 回补健壮性加固（提交链 `5f478ba`…`7a656bd` 等）
- 状态：**根因已定位、闭合已实现、回归已实证（14 passed）**

---

## TL;DR

`rebuild`（全量重抓）模式下，取消（协作式取消）恰好发生在「最后一只证券抓取期间」时，
`backfill_historical` 的三个取消检查点全部覆盖不到，主函数走**正常完成分支**返回普通 `str`，
导致 `run_pending_price_backfill` 误判为「完成」并**推进 `price_backfill_rebuild_cursor`**。

闭合点在 `market_price_backfill_pending.py:283-289`：推进游标前**二次校验世代标记**
（`_backfill_run_still_valid`），且该检查用**列查询**直查 DB，绕过 `expire_on_commit=False`
不挡 `rollback` 的缓存语义，对**跨会话取消**（HTTP router 提交）同样生效。

---

## 1. 背景与问题来源

回补任务（`run_pending_price_backfill`）支持三种模式：`legacy`（存量默认）、`gap`（严格补洞）、
`rebuild`（清空后全量重抓）。`rebuild` 模式按 `master_id` 游标推进，每跑完一批（`pending`）就
把 `price_backfill_rebuild_cursor` 推进到本批最后一只，下一批从那里续跑，走到池尾即终态。

取消是**协作式**的：`DELETE /backfill-prices`（实为 `cancel_price_backfill`）在**另一会话**
提交，清空 `price_backfill_start_date` 并将 `price_backfill_run_token` 置 `NULL`
（`backfill_router.py:318`）；正在跑的批次靠循环内的检查点察觉并优雅中止。

**P2-1 问题**：中止（取消）后游标仍被推进 —— 覆盖了删除端点清 `rebuild_cursor` 的意图
（取消即放弃本轮重抓进度），且「取消 → 立刻重新触发」时老批次收尾写回的游标可能被新 run 读到，
从旧批尾部续跑、跳过池首一段（该段保留旧复权口径），与 rebuild「全量重抓」目的相悖。

---

## 2. 根因分析：三个检查点为什么覆盖不到「最后一只抓取中」

`backfill_historical`（`market_price_backfill_engine.py`）在循环内分布三个取消检查点，
均调用 `_backfill_run_still_valid` / `_sleep_with_cancel_check` 判定世代标记是否仍有效，
失效则 `return _abort_summary(...)`（`AbortSummary` 是 `str` 子类，供调用方 `isinstance` 判定）：

| 检查点 | 位置 | 触发时机 |
|---|---|---|
| ① 每只证券开始前 | `engine.py:136`（→ `return` 于 `:140`） | 进入下一轮fetch前 |
| ② 退避 sleep 之后 | `engine.py:214`（→ `return` 于 `:218`） | 单只失败后退避重试前 |
| ③ 批间冷却分片之间 | `engine.py:273`（→ `return` 于 `:274`，经 `_sleep_with_cancel_check`） | 一批内多只之间的冷却 |

**残余窗口成因**：取消恰好落在「最后一只证券的抓取期间」时：
- ① 彼时尚未取消（取消发生在这一只已经开始抓取之后）→ 检查点 ① 已越过；
- ② 只在退避后触发，成功路径不经过 → 检查点 ② 命中不到；
- ③ 只在批间冷却触发，而**最后一批之后没有下一批** → 检查点 ③ 再无机会执行。

于是 `backfill_historical` 走**正常完成分支**返回普通 `str`（非 `AbortSummary`）。
调用方原推进逻辑仅判定 `isinstance(batch_note, AbortSummary)`：

```python
# market_price_backfill_pending.py（加固前）
if rebuild_active and not isinstance(batch_note, AbortSummary):
    settings.price_backfill_rebuild_cursor = pending[-1]
    await session.commit()
```

普通 `str` 被判为「完成」→ **游标被推进**。这就是 P2-1 残余窗口。

> 注：该窗口实际危害可忽略（读取游标的前提 `start_date` 已被取消清空；重新 `POST /backfill-prices`
> 会重置游标）。但它属于「abort 仍推进游标」这一 P2-1 主题的未闭合情形，而非新问题，故补掉。

---

## 3. 闭合机制：推进游标前二次校验世代标记

`market_price_backfill_pending.py:283-289`：

```python
if (
    rebuild_active
    and not isinstance(batch_note, AbortSummary)
    and await _backfill_run_still_valid(session, run_token)   # ← 二次校验
):
    settings.price_backfill_rebuild_cursor = pending[-1]
    await session.commit()
```

三条件**全部满足**才推进：① `rebuild` 模式 ② 非中止（不是 `AbortSummary`）③ **世代标记仍有效**。

### 3.1 为什么列查询能读到「另一会话提交的 NULL」

`_backfill_run_still_valid`（`market_price_backfill_lease.py:107-120`）：

```python
async def _backfill_run_still_valid(session, run_token):
    if run_token is None:
        return True
    current = await session.scalar(
        select(DividendYieldSettings.price_backfill_run_token).limit(1)   # 列查询
    )
    return current == run_token
```

关键点在于它用 **`select(Model.col)` 列查询**，而不是访问 ORM 对象属性。

- `database.py:27` 配置 `expire_on_commit=False`：commit 后 ORM 实体**属性不过期**，
  但这是「属性访问走 identity-map 缓存」的前提；`rollback` 仍会使属性过期
  （`pending.py:258` 注释点明：`backfill_historical` 内部 rollback 会让 `settings` 对象过期）。
- **列查询绕过 identity-map**，直接向 DB 发 `SELECT col`，因此能读到被**另一会话**
  （`cancel_price_backfill` 在 HTTP 请求里 `commit` 把 token 置 `NULL`）提交的最新值。

所以即便本会话的 `settings` 对象因 rollback 过期、也无法靠属性访问拿到最新 token，
列查询仍能读到 `NULL` → 判定失效 → **不推进游标**，窗口闭合。

### 3.2 为什么 `run_token` 要在判定处「之前」快照

`pending.py:236-241` 在函数开头取一次快照：

```python
run_token = settings.price_backfill_run_token   # 批次开始前快照，全程用同一个值
```

不在收尾判定处现取 `settings.price_backfill_run_token`，原因（`pending.py:236-241` 注释）：
该 ORM 对象在函数内会被 `refresh` / `rollback` 影响，现取可能与本批实际使用的值不一致，
且过期态属性访问有 `MissingGreenlet` 风险。快照保证「传入 `backfill_historical` 的标记」
与「二次校验比较的标记」是同一个值。

### 3.3 `run_token` 为 `None` 时零行为变更

`cancel_price_backfill` 把 token 置 `NULL`；但 `POST /backfill-prices` 重新触发时会写入
**新的 UUID**（`backfill_router.py:232` `settings.price_backfill_run_token = str(uuid4())`）。
当 `run_token is None`（非在途链路，如定时任务带 `backfill_start` 直接调 `backfill_historical`），
`_backfill_run_still_valid` 恒返回 `True`（`lease.py:115-116`）→ 照旧推进，与加固前行为完全一致。

---

## 4. 实证验证

### 4.1 此前被阻断的真实原因

首轮尝试实跑回归时失败：`asyncpg.exceptions.InvalidPasswordError: password authentication failed for user "postgres"`。

根因不是 Postgres 不可达，而是 `BaseSettings(env_file=".env")` 相对**进程 cwd** 解析，
pytest 当时从非 `backend/` 目录运行 → `backend/.env` 未加载 → 退化到 `config.py` 默认
`postgres:postgres@localhost`，而非 `.env` 中的 `investment_app:123456789@127.0.0.1`。

### 4.2 修复（可复用命令模板）

env var 优先级高于 `env_file`，与 cwd 无关；用绝对路径调 venv python 避开坏 shim 的 `cd`/`tail`：

```bash
DATABASE_URL='postgresql+asyncpg://investment_app:123456789@127.0.0.1:5432/investment_tracker' \
TEST_DATABASE_URL='postgresql+asyncpg://investment_app:123456789@127.0.0.1:5432/investment_return_tracker_test' \
"D:/agent/AI Coding/investment_return_tracker/backend/.venv/Scripts/python.exe" \
  -m pytest "D:/agent/AI Coding/investment_return_tracker/backend/tests/test_backfill_historical.py" -q
```

### 4.3 结果

- `tests/test_backfill_historical.py -k rebuild` → **5 passed**
- 全文件 **14 passed**

残余窗口闭合由实跑确认，非仅代码阅读层面。

### 4.4 回归测试清单（含行号）

`backend/tests/test_backfill_historical.py`：

| 用例 | 行号 | 作用 |
|---|---|---|
| `test_rebuild_abort_does_not_advance_cursor` | `:502` | 中止不推进游标 |
| `test_rebuild_success_advances_cursor` | `:538` | 正常完成推进游标（反向对照） |
| **`test_rebuild_cancel_during_last_fetch_still_does_not_advance_cursor`** | `:564` | **残余窗口主回归**：最后一只抓取中取消 → 游标不推进、无 `AbortSummary` |
| `test_rebuild_cursor_advances_without_run_token_even_if_token_changed` | `:600` | `run_token=None` 被改写仍推进（零行为变更） |
| `test_rebuild_cursor_advances_when_token_still_valid` | `:636` | 标记有效 + 正常完成 → 推进（确认未误挡正常路径） |

> 工程师曾做变异测试证伪：删掉二次校验后主回归 **FAILED**（游标被误推进），两条对照仍 PASSED，
> 恢复后逐字节一致 → 证明用例非恒真、加固点即阻断处。

---

## 5. 关键代码引用索引

| 关注点 | 文件:行 |
|---|---|
| 残余窗口闭合（二次校验） | `backend/app/services/market_price_backfill_pending.py:283-289` |
| 二次校验注释 / 三不推进情形 | `market_price_backfill_pending.py:268-282` |
| `run_token` 快照（判定处前） | `market_price_backfill_pending.py:236-241` |
| 调用 `backfill_historical`（传 token） | `market_price_backfill_pending.py:242-254` |
| 检查点 ① / ② / ③ | `market_price_backfill_engine.py:136 / 214 / 273` |
| `AbortSummary(str)` 子类 | `market_price_backfill_lease.py:44` |
| `_backfill_run_still_valid`（列查询） | `market_price_backfill_lease.py:107-120` |
| `_sleep_with_cancel_check`（分片复查） | `market_price_backfill_lease.py:123-141` |
| `expire_on_commit=False` | `backend/app/db/database.py:27` |
| `cancel_price_backfill`（token→NULL） | `backend/app/modules/dividend_yield/backfill_router.py:276-340`（`:318`、`:322`） |
| 重新触发写新 UUID | `backfill_router.py:232` |

---

## 6. 经验教训（可复用）

1. **列查询绕缓存**：需要读取「其他会话刚提交」的最新值时，用 `select(Model.col)` 列查询，
   不要用可能过期的 ORM 属性访问（尤其 `expire_on_commit=False` + 函数内 `rollback` 场景）。
2. **世代标记要在判定前快照**：避免 ORM 对象被 refresh/rollback 影响导致判定值与实际不一致 +
   `MissingGreenlet` 风险。
3. **「优雅 return 而非抛异常」的设计**需要调用方显式区分「中止 vs 完成」——`str` 子类哨兵
   （`AbortSummary`）比换返回类型更省改动面，但要求调用方**永远**用 `isinstance` 判定，
   任何「只判类型/只判子串」的收尾逻辑都会漏掉「普通完成串」这一逃逸窗口。
4. **pytest 跑测试务必从 `backend/` 目录或显式传 DB env var**：`env_file=".env"` 相对 cwd 解析，
   非 backend cwd 下会静默用默认 `postgres:postgres` 凭据导致 `InvalidPasswordError`。
5. **变异测试证伪回归用例**：删掉加固代码后确认用例 FAILED、恢复后 PASSED，能证明用例非恒真、
   加固点即阻断处，比单纯「用例绿」更有说服力。
