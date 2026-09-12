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

### 🟡 M-1｜`/backfill-prices` 重复触发无并发护栏，且在途 `start_date` 被静默覆盖— ✅ 已修复 `be84dbb` / `d34919e`

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

### 🟡 M-2｜每日额度未按自然日记账（触发当天跑 2 批）— ✅ 已修复（详见 §六）

- `quota` 仅体现在 `_select_pending_backfill_masters` 的 `.limit(quota)`，语义是
  **「每次调用最多 quota 只」**。每日自动续跑一天一次，故成立；
- 但手工端点一天可点多次，每次都跑满 quota → 每日额度形同虚设，且叠加 M-1 的并发会成倍放大。
- **建议**：明确「手动触发是否计入当日额度」；若额度是成本/限流保护，应加当日已用计数或触发频率限制。

---

### 🟡 M-3｜在途回补**无取消入口**，持续失败会每天重试— ✅ 已修复 `be84dbb` / `d34919e`

- `settings_router.py:50` 明确 `price_backfill_start_date` 不接受 PUT（服务端管理，避免状态不一致）——合理；
- 但 `run_pending_price_backfill` **仅在「选出 0 只」时清空状态**（终态）。若数据源持续不可达，
  熔断（`37f4ee1`）每天触发却不清 `start_date` → **每天重试、每天白烧额度**，
  而 admin 无任何 API 手段停止（只能直接改库）。
- **建议**：补一个「取消在途回补」端点（清空 `start_date`），或允许 PUT 清空、或连续 N 天熔断后自动放弃并告警。

---

### 🟡 M-4｜死代码 `if itf.access_method if False else True: pass`— ✅ 已修复 `bae4ee5`

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
| 并发与状态机 | ✅ M-1/M-3 已修；⚠️ M-2 额度绕过仍开放（待定）|
| 代码整洁 | ✅ M-4 已清 |
| 全量回归（修复后） | ✅ 后端 653 passed / 3 xpassed；前端 77 文件 568 passed；ruff 全绿；vue-tsc EXIT=0 |

---

**一句话**：实现质量高于平均、文档与注释密度出色，**可推送**；但「在途任务」这条状态机
缺了并发护栏与取消入口两个口子，建议在推送前补 M-1 与 M-3，顺手删掉 M-4 的死代码；
工作树 WIP 请先收尾同批提交，避免 0015 与 enums.py 分离。

---

## 六、修复记录（2026-09-12 后续）

| 项 | 处理 | 提交 |
| --- | --- | --- |
| **M-1** 重复触发 / 覆盖 | `/backfill-prices` 在途（`start_date` 非空）→ 400，回显在途起点；前端按钮同步置灰 + 文案变「回补进行中…」+ title 说明禁用原因 | `be84dbb`、`d34919e` |
| **M-3** 无取消入口 | 新增 `DELETE /backfill-prices`（admin-only）清在途标记；前端「取消在途回补」按钮 + 二次确认。取消与护栏成对，避免只禁不给退路 | `be84dbb`、`d34919e` |
| **M-4** 死代码 | 删除 `_run_backfill` 内恒真空分支 | `bae4ee5` |
| **L-1** `security_count` 估算 | 已写进 `backfill_prices` docstring（明确为估算值、可能与实际有偏差） | `be84dbb` |
| **新增发现**：akshare 导入断言顺序依赖 | 见下 | `bae4ee5` |
| **M-2** 额度未按日记账 | **已修复**：quota 改为按自然日消耗（迁移 0016 + 当日记账 + 行锁），触发当天不再跑第二批 | 见 §六 |

### 修复期新增发现（**非本次改动引入**，顺带修掉）

`test_market_data_sdk.py::test_module_import_does_not_import_akshare` 在全量跑失败、单独跑通过。
根因：该用例在**同进程**断言 `"akshare" not in sys.modules`，而日线任务链路
（`update_stale_flags` → `refresh_trade_calendar`，`dividend_yield_refresh.py:156`）会真实
`import akshare` 并将其常驻 `sys.modules`，导致本用例**随执行顺序随机失败**。
已改为**子进程**断言 import 期副作用，与执行顺序无关。

> 这条属于路线B 提交引入的测试隔离缺陷，若不在推送前修，CI `#003` backend-test 会红。

### 关键实现说明

- **前端禁用不能替代后端校验**：多标签页/多管理员/直接 curl 都能绕过 UI，
  故 400 护栏保留在后端，前端禁用只作 UX 层防误操作。
- **触发/取消后必须失效 settings 查询**：否则 `price_backfill_start_date` 不回填，
  按钮仍显示可点 → 用户可连点第二次（正是并发场景）。已在两个 mutation 的 onSuccess 里 invalidate。
- **取消的能力边界**（已写进 docstring）：仅清标记，**不中断正在运行的当前批次**，
  该批次会跑完本批（≤ quota）后自然停止，此后不再续跑，已补数据保留。

### M-2 复核结论（实现 M-1/M-3 后重新评估）

**事实核对**：全仓**不存在**任何「当日已用」计数。`price_backfill_quota` 只在
`_select_pending_backfill_masters` 的 `.limit(quota)` 处生效（`market_daily_price_sync.py:579`），
语义是**「每次调用最多 quota 只」**，并非按自然日的硬顶。UI/文案称之为「每日额度」，
是因为自动路径一天只调一次，由此产生了名实偏差。

**M-1 / M-3 已经解决了什么、还剩什么**：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 连点两次 / 两个标签页各点一次（**并发**） | 两个任务同时跑，同批证券被请求两次 | ✅ 被 M-1 的 400 拦住 |
| 任务跑完后再次触发 | 直接再跑一批 | 仍会 400——`start_date` 只在「全部补完」时才清 |
| 想再跑一批 | — | 必须**显式点「取消在途回补」**再触发（每多一批约 4 次点击 + 2 次确认） |
| 触发当天出现 2 批 | 同左 | **本设计**：手动跑第一批 + 当日「收盘价抓取」续跑第二批（`market_daily_price_sync.py:335-337`，端点 docstring 已写明） |

**结论**：M-1 消除了唯一现实的意外路径（并发翻倍）；M-3 提供退路后，突破额度只剩
「刻意反复取消→触发」一种，属管理员主动行为，后果仅为多消耗 akshare 调用
（落库 upsert 幂等，无数据风险）。故 M-2 由「应修」降级为**可选**。

**若仍要硬上限**（属新增能力，非修复）：
1. 记录「最近一次手动触发日期」，同一自然日只允许手动触发一次（需新增列）；
2. 在 `run_pending_price_backfill` 内累计当日已处理只数，达 `quota` 即当日不再跑。

**低成本改进（建议做）**：把语义写实——`price_backfill_quota` 实为「每批额度」，
触发日会跑 2 批（手动 1 + 日任务续跑 1）。建议设置项说明与端点 docstring 注明，
避免后续维护者按「每日硬顶」理解。

### M-2 口径修正与最终实现（2026-09-12 补记）

> 更正：此前我把「触发当天跑 2 批」误判为**设计如此**并据此将 M-2 降级为可选，这是错的。
> 正确口径由 owner 给出：**额度是每天的**，任何方式/原因触发都消耗，
> 当天再次执行只能在**剩余额度**内跑，次日才续跑第二批。

**实现（已落地）**：
- 新增 `price_backfill_last_run_date` / `price_backfill_used_today`（迁移 `0016`，
  依赖未提交的 `0015`，**两者须一并提交**否则迁移链断）；
- `run_pending_price_backfill`（手动与自动的唯一公共入口）：跨日自动重置 →
  `remaining = quota - used_today` → 取批 `limit(remaining)` →
  跑完 `used_today += 本批实际处理只数`（**成败都计**，避免数据源抖动时反复重试刷爆当天额度）；
- 余额 ≤ 0 时**零请求**直接返回；读 settings 加 `FOR UPDATE` 行锁，防手动与每日续跑同日双花；
- `/backfill-prices` 先算余额（置于写 `start_date` 之前，避免留下无效在途状态），余额 ≤ 0 → 400。

**验证**：新增 3 条（同日消耗 / 跨日重置 / 端点余额耗尽 400）；全量 656 passed。
