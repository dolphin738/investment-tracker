# 未推送代码审查报告（2026-09-12 · 行情回补路线B）

- 审查人 role：CodeReviewExpert
- 范围：`cnb/main..HEAD` 共 **20 笔提交** + **工作树未提交 WIP**
- 主线：路线A（横截面批量回补）已被 **revert**（`0ee22e4`/`2955009`/`24708cf`），改走**路线B**（历史行情回补源配置 + 在途任务 + 每日额度）
- 结论：**无 P0/P1 阻断**；建议在推送前处理 M-1 / M-3，顺手清 M-4；WIP 需先收尾合并

---

## 一、TL;DR

这是一批**质量相当高**的改动：熔断设计克制正确、单只超时把「无法真正取消线程」的局限
诚实写进注释、`bg.py` 的异常可观测考虑了强引用与「未取回异常」警告的相互作用、
`_select_pending_backfill_masters` 用一条 NOT EXISTS SQL 精确选批并写清了两条设计理由。

主要风险集中在**在途任务的状态机**：`/backfill-prices` 可重复触发且会静默覆盖
`price_backfill_start_date`，两个并发任务会选中**同一批**待补证券（回补是长耗时，批完成前
这些证券仍未覆盖），导致重复请求、白烧配额；同时**在途任务没有取消入口**，
数据源持续不可达时会每天重试熔断、无法从 API 停止。

---

## 二、提交主线

| 提交 | 内容 |
| --- | --- |
| `e7c198e` | feat 路线B：历史行情回补源配置 + `/backfill-prices`（迁移 0013、模型、测试 149） |
| `d9221cc` / `e1227b3` / `4c0e1b1` | 前端：设置页「初始化」块、手工按钮自排名页迁入、额度与在途状态展示、拆子组件 |
| `67d8e84` | fix：源校验弃用 symbol 形态启发式，改验 sdk 接入方式 |
| `08e63b0` | fix(core)：`bg.py` 后台任务未捕获异常落 error 日志（+ `test_bg.py` 66） |
| `0cffe3d` | fix：单只请求加兜底超时上界 `_BACKFILL_FETCH_TIMEOUT` |
| `37f4ee1` | feat：连续失败熔断（阈值 3） |
| `f8f2c1d` | feat：改为跨日在途任务 + 每日额度（迁移 0014） |
| `928a38d` | refactor：拆分过大 router（backfill_router 209 / settings_router 280） |
| `0ee22e4` 等 3 笔 | Revert 路线A 及其测试 |

---

## 三、发现项

### 🟡 M-1｜`/backfill-prices` 重复触发无并发护栏，且在途 `start_date` 被静默覆盖

- 位置：`backfill_router.py:166-176`
- 现状：`settings.price_backfill_start_date = start` **无条件覆盖**后 commit，随即
  `track_task(asyncio.create_task(_run_price_backfill()))`。
- **危害**：若已有在途任务，二次触发会 ① 改写后续每日续跑的判定基准；② 派生第二个并发任务。
  更关键的是——两个并发 `run_pending_price_backfill` 会各自执行
  `SELECT ... LIMIT quota` 选出**同一批** pending 证券（`backfill_historical` 长耗时，
  批完成前这些证券仍是「未覆盖」），于是**同一批证券被重复请求**，白烧配额，
  且对 akshare 并发可能触发限流。
- **建议**：
  1. 请求级：若 `price_backfill_start_date is not None` → 400「已有在途任务」，或显式提供「重启」语义；
  2. 任务级：轻量互斥（内存锁 / DB 标记），避免同批重复拉取；
  3. 至少把覆盖语义写进 docstring（当前只说「启动在途任务」，未提覆盖）。

---

### 🟡 M-2｜每日额度可被手动触发绕过

- `quota` 仅体现在 `_select_pending_backfill_masters` 的 `.limit(quota)`，语义是
  **「每次调用最多 quota 只」**。每日自动续跑一天一次，故成立；
- 但手工端点一天可点多次，每次都跑满 quota → 每日额度形同虚设，且叠加 M-1 的并发会成倍放大。
- **建议**：明确「手动触发是否计入当日额度」；若额度是成本/限流保护，应加当日已用计数或触发频率限制。

---

### 🟡 M-3｜在途回补**无取消入口**，持续失败会每天重试

- `settings_router.py:50` 明确 `price_backfill_start_date` 不接受 PUT（服务端管理，避免状态不一致）——合理；
- 但 `run_pending_price_backfill` **仅在「选出 0 只」时清空状态**（终态）。若数据源持续不可达，
  熔断（`37f4ee1`）每天触发却不清 `start_date` → **每天重试、每天白烧额度**，
  而 admin 无任何 API 手段停止（只能直接改库）。
- **建议**：补一个「取消在途回补」端点（清空 `start_date`），或允许 PUT 清空、或连续 N 天熔断后自动放弃并告警。

---

### 🟡 M-4｜死代码 `if itf.access_method if False else True: pass`

- 位置：`market_daily_price_sync.py:363-364`（`_run_backfill` 内）
- 条件表达式恒为 `True`、分支体是 `pass`，是明显的调试/重构残留。
  因短路求值，`itf.access_method` 实际不会被读取（故不会因属性缺失报错），
  但会误导读者，且掩盖此处原本应有的校验意图。
- **建议**：直接删除，或补上真实校验（邻近的 `run_pending_price_backfill` 已有等价 sdk 校验，
  这里多半是多余分支，删掉即可）。

---

### 💭 L-1｜响应 `security_count` 是估算值

- 请求内先 commit `start_date` 再算 `pending`（`:172-173`），后台任务用**独立 session** 重新选取，
  两者非原子，极端情况下响应值与实际处理只数不一致。
- docstring 已写「本批将处理的只数」，语义可接受；建议补一句「估算，可能与实际有偏差」。

### 💭 L-2｜工作树 WIP 处于中间态

- 9 个文件改动 + **未跟踪**迁移 `0015_remove_special_backfill_task.py`，主题是
  「删除特别分红回补系统任务（功能已由设置页按钮取代）」。
- 改动自洽：迁移删 `job_configs` 行、`enums.py` 去枚举值、`scheduler.py` 去注册、router 简化。
  已核对 `JobTaskType.DIVIDEND_SPECIAL_BACKFILL` 的 **Python 符号已无引用**（仅 0011/0015 迁移内以字符串出现），
  `run_dividend_special_backfill` 服务函数仍被按钮使用，删除安全。
- **但**：此刻推送不会带上 0015，且 `enums.py` 改动与 0015 是配套整体，分开提交易产生不一致。
  建议收尾后**迁移 + 代码同批提交**。

---

## 四、✅ 做得好的地方

1. **熔断设计正确且克制**（`:464-484`）：单只成功即清零 `consecutive_failures`；
   连续失败达阈值在**批中途**立即中止（不等本批 10 只跑完）；中止前已写入行保留、幂等可续。
2. **单只兜底超时的局限诚实标注**（`:445-448`）：明确写出 `asyncio.to_thread` 无法真正取消
   已启动线程，超时只是让循环推进、底层 HTTP 可能仍在跑完——把局限写进注释而非假装解决。
3. **`bg.py` 异常可观测**（`08e63b0`）：done-callback **先 `discard` 再读 `exception()`**，
   并在注释里解释顺序原因（否则强引用会让 asyncio「未取回异常」警告延迟甚至永不触发）；
   取消属正常路径不打 error 日志。这是对上一轮 M-2 的正确加固。
4. **`_select_pending_backfill_masters` 一条 NOT EXISTS SQL**（`:559-583`）是本轮最有价值的设计：
   并在 docstring 写清「为什么不用逐只判定」——① 留存清理删早期数据后各证券 `earliest` 变晚，
   逐只判定会每天重复请求全池、次年再被删 → 无限循环白烧配额；② 避免每天扫全池 4609 次。
5. **端点防护齐全**：三个端点均 `Depends(require_admin)`；`/backfill-prices` 三重 400
   （未配置 / 接口不存在 / 非 sdk）；`67d8e84` 把源校验从「symbol 形态启发式」改为
   「验证 sdk 接入方式」，是实质正确性提升。
6. **拆分及时**：`router.py` 437 行拆为 backfill_router(209) + settings_router(280)；
   前端设置页拆出子组件回到 400 行内（`4c0e1b1`），符合架构规范 §4。
7. **文档随实现同步**：方案 md 更新 A.14 补测结论、修正 A.11 归因（`7f41f6d`）。

---

## 五、验证状态

| 项 | 状态 |
| --- | --- |
| 代码事实核对 | 逐条 `Read`/`Grep` 实测（非凭记忆） |
| 鉴权 / 输入校验 | ✅ 三端点 admin-only；回补源三重 400 |
| 并发与状态机 | ⚠️ M-1 重复触发 / M-2 额度绕过 / M-3 无取消入口 |
| 代码整洁 | ⚠️ M-4 一处死代码 |
| 本轮是否跑测试 | 否（本轮为审查，未改代码） |

---

**一句话**：实现质量高于平均、文档与注释密度出色，**可推送**；但「在途任务」这条状态机
缺了并发护栏与取消入口两个口子，建议在推送前补 M-1 与 M-3，顺手删掉 M-4 的死代码；
工作树 WIP 请先收尾同批提交，避免 0015 与 enums.py 分离。
