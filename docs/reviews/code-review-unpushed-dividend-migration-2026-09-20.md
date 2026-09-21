# 未推送/未提交代码综合审查报告 — 分红采集链路迁移（P0/P1/P2/P6）+ §4.7 报告源下线

**日期**：2026-09-20
**工作流**：工作流 1（综合代码审查）+ 工作流 4（部署前检查 Go/No-Go）
**参与成员**：Cody（代码审查师）/ Archi（系统架构师）/ Rex（SRE 工程师）/ Tessa（测试专家）
**审查对象**：`investment_return_tracker` 分支 `main`
**基线**：`cnb/main` = `bee1810cac09440c5c5bb104dc5e21b2be0360cb` → HEAD = `5c28b428a1fd3fa2d9e003fc7d206ce11ca0ca96`

---

## 📌 TL;DR（执行摘要）

- **代码质量本身通过**：无 🔴 严重缺陷；后端 675 passed / 前端 573 passed、ruff 与 import-linter 全绿、覆盖率分层达标、3 个新迁移往返可逆、新增端点鉴权与契约产物均正确。
- **但有 1 项机制性阻断 + 2 项发布前置**：① `check_line_budget.py` **硬闸门 FAIL（新增 2118 行 > 上限 800，EXIT=2）**，直接推送会打回 CI #001；② 巨潮上游接口**从未端到端成功**（方案 §7 自陈 500）却已删掉唯一可用的旧采集链路；③ 发布编排把 P0/P1/P2/P6 压成一批，未走方案 §8 要求的观察窗。
- **严重度分布**：🔴 严重 1 项 / 🟠 高 6 项 / 🟡 中 11 项 / 🟢 低 4 项（去重合并后）
- **阻塞性质**：**非代码缺陷阻塞**，是「CI 闸门 + 发布编排」阻塞；代码可推，但需 owner 先做 2 个决策。
- **未提交部分无风险**：工作区仅 `.codebase-memory/artifact.json` + `graph.db.zst` 两个索引快照文件（项目已知的「索引永远滞后一笔」预期现象，非业务代码）。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| 整体评级 | 🟡 **有条件通过**（代码🟢 / CI 闸门🔴 / 发布编排🟡） |
| 阻塞项数量 | **1 项机制性阻断**（行数预算闸门）+ **2 项发布前置**（巨潮复测、分批观察窗） |
| 关键行动项 | 10 条（P0 三条必须 owner 决策） |
| 建议下一步 | ① owner 决定「拆批」还是 `LARGE_PR_APPROVED=1` 豁免；② 复测 `stock_dividend_cninfo`；③ 补 4 个失败韧性用例 + 播种单飞锁 + 0031 downgrade 三修 |

### 各维度独立结论

| 维度 | 成员 | 结论 |
|---|---|---|
| 代码正确性/安全/可维护性 | Cody | 🟢 通过（未发现 🔴；1 项 🟠 异常吞噬无日志） |
| 架构影响 | Archi | 🔴 时序问题（Contract 早于链路跑通）+ 3 🟠（无单飞锁 / 日志落点不存在 / downgrade 还原启用态） |
| 迁移与发布安全 | Rex | 🟢 迁移代码本身 / 🟡 整批发布编排（C1 巨潮复测、C2 分批、C3 DB+镜像同退） |
| 测试与覆盖 | Tessa | 🟡 功能全绿 + 覆盖率达标，但**行数预算闸门 FAIL**；4 个删除用例存在未迁移空洞 |
| 契约与生成物 | Cody + lead 复核 | 🟢 paths 96=96；无 `backfill-specials`/报告源残留；前端声明未沿用旧 `job_id` 漂移 |

---

## 🔍 审查发现（按严重度排序，已去重合并）

| #   | 严重度  | 类别     | 文件:行                                                                                                                     | 问题描述                                                                                                                                                                                                                                                                                                                               | 建议修复                                                                                                                                                                                                   | 来源                                       |
| --- | ---- | ------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| 1   | 🔴严重 | CI 闸门  | `scripts/check_line_budget.py` 输出                                                                                        | 基线 `cnb/main` → HEAD **新增 2118 行 > 上限 800，EXIT=2**。`AGENTS.md §2` 与 `.cnb.yml` backend-lint 将其列为**硬闸门** → 推送即打回 CI #001                                                                                                                                                                                                            | owner 二选一：按任务微型化纪律拆成多轮小步提交，或显式设 `LARGE_PR_APPROVED=1` 豁免（等同人工说明）                                                                                                                                       | Tessa 实测 + lead 复核（`EXIT=2`）             |
| 2   | 🟠高  | 发布编排   | `docs/分红采集链路迁移方案.md:9,424-431,440-448`                                                                                   | **Contract 早于「替换链路跑通」**：0031（回收枚举值）/0032（drop 列）属 Expand→Contract 的 Contract 段，却与旧链路删除同批未推；新链路（巨潮）**从未端到端成功**，方案 §8 要求的 P0→P1 观察窗在运行层未发生                                                                                                                                                                                           | 先只推 P0（巨潮采集 + 播种 + 前端按钮），跑通一轮每日扫描后再推 P1/P2                                                                                                                                                             | Archi 🔴#1，Rex 独立复核后修订为 🟡（C2）           |
| 3   | 🟠高  | 运维安全   | `docs/分红采集链路迁移方案.md:13,424-431`                                                                                          | **上线前置未满足**：巨潮 `stock_dividend_cninfo` 带 token 返回 **HTTP 500**（`LoadBalancerRoutingFilter ... connect timed out`，上游服务端故障）。本批已删除唯一可用的旧采集链路 → 接口未恢复即推送＝**删掉唯一可用链路**                                                                                                                                                                  | 推送前复测该接口；无法复测则须显式接受「分红采集降级」                                                                                                                                                                            | Rex C1 硬门槛                               |
| 4   | 🟠高  | 并发/限流  | `backend/app/modules/dividend_yield/backfill_router.py:67-90`（尤其 `:78`）                                                  | `/seed-initial-dividends` 为 fire-and-forget，**无单飞锁**，也不走 `scheduler.py:217-228` 的 `_running_job_ids` 去重 → admin 连点即并发多个约 19h 全市场任务，各自打满 `rate_limit=10/min`，与方案 §7:422「维持 10/min 安全余量」论证冲突                                                                                                                                         | 加进程内运行标志或 DB 运行令牌（对齐旧 `price_backfill_run_token` 范式），已在跑则返回 409 或复用                                                                                                                                    | Archi 🟠#2 + Cody 🟡#7 + lead 预扫（三方独立命中） |
| 5   | 🟠高  | 可观测性   | `backend/app/services/dividend_notice_scan.py:254`；`backend/app/services/dividend_seed.py:99`                            | 单证券 `except Exception:` **既不记日志也不向上冒泡**。若巨潮列名变更/接口整体失效（每只都抛），11430 只被静默吞成 `skipped`，摘要仍返回「…完成…失败N只」，`scan()` 由 scheduler 记 **SUCCESS** → 真实根因在日志中完全不可见                                                                                                                                                                             | `except` 内补 `logger.warning(..., exc_info=True)`；失败占比超阈值时 `raise`，避免「全灭却 SUCCESS」。对照 `dividend_yield_refresh.py:158-160` 已有正确写法                                                                        | Cody 🟠#1                                |
| 6   | 🟠高  | 迁移可逆性  | `backend/alembic/versions/0031_remove_quarterly_dividend_fetch.py:22-34,63-81`                                           | **三处缺陷合并**：① `_ENUM_VALUES_ALL` 缺 `DIVIDEND_SPECIAL_BACKFILL` → downgrade 非对称，且 `0015:37` 的 downgrade 要 `CAST` 该值 → **反向迁移链在 0015 处断裂**；② `:75` 用 `enabled=TRUE`，而 `:64` docstring 写「默认禁用」、方案 §4.3:125 写 `enabled=FALSE` → **docstring 与代码自相矛盾**（`:64` 是 `0008:65` 的逐字拷贝，`0008:76` 却是 `FALSE`）；③ `:22` 注释「当前 10 个值」**事实错误**（实际 11） | ①补回缺失值或注释显式声明回收行为；②`TRUE`→`FALSE`（最小改动、迁移未上生产无回溯成本）；③修正计数注释；另建议重建前补 `DELETE ... WHERE task_type IN ('DIVIDEND_QUARTERLY_FETCH','DIVIDEND_SPECIAL_BACKFILL')` 以对存量库鲁棒                                   | lead 预扫 + Rex 复核强化 + Cody 🟡#3/#4（三方确认）  |
| 7   | 🟠高  | 正确性/UX | `web/src/modules/admin/components/GlobalSettingsDividendInitBlock.vue:88`；`backfill_router.py:89`；`dividend_seed.py:109` | **UI 承诺的日志落点不存在**：弹窗写「进度可在『定时任务日志』查看」，但播种不写 `job_run_logs`、只在 python logger 打点 → 用户按提示去任务日志页会找不到任何记录                                                                                                                                                                                                                               | 或补写一条 `job_run_logs`/AppLog 供「任务日志」页可见，或把文案统一改为「应用日志」                                                                                                                                                  | Archi 🟠#3                               |
| 8   | 🟡中  | 正确性    | `backend/app/services/dividend_yield.py:156-197`                                                                         | `restate_cells`（P6 核心）：① **非幂等**——无重入/已重述标记，二次调用会重复缩小分子（0.4→0.4/1.4→0.4/1.96）；② `splits` 构造（`:163-169`）**不看 `status`** → 已 REJECTED 方案若残留 `ex_dividend_date`+送转值，会给**其它**现金分红叠加虚假缩股因子；③ `:178` 的 `if i_date is None or ex_date >= i_date` 对**无除权日的 PROPOSED 行**会套用 `as_of` 前全部送转因子（含公告**之前**发生的送转）→ 可能过度缩股，方案 §9.1 未定义该情形          | ①docstring 声明「仅可作用于原始投影、不可重入」；②`splits` 加 `j.status in _PAYABLE` 过滤；③对 `i_date is None` 显式裁决并补测试。当前三处调用方均喂新投影故未触发                                                                                      | Cody 🟡#6 + Archi 风险#5 + lead 独立复核③      |
| 9   | 🟡中  | 测试覆盖   | `backend/tests/`（4 处空洞）                                                                                                  | 删除的 23 个用例中 **19 个已有等价替代、4 个存在未迁移空洞**，全部集中在高风险不可见故障：`_reresolve_detail_safe` 的真失效 fail-fast（`notice_scan.py:134` 未覆盖）、L-3 过程异常续跑（`:151-157` 未覆盖）、`anchor` 计数端到端（`:404-405` 未覆盖）、`scan` 明细源缺失注记                                                                                                                                     | 优先补回：`test_scan_fails_fast_when_detail_source_disabled_mid_run` / `..._continues_when_reresolve_transient` / `test_upsert_bumps_anchor_skip_end_to_end` / `test_scan_without_detail_source_marks_note` | Tessa §4                                 |
| 10  | 🟡中  | 覆盖缺口   | `backend/app/services/dividend_period.py:77-85`                                                                          | `parse_report_period_cn` 的**日期形态整段未覆盖**（`"20241231"`/`"2024-12-31"`/`"2024年12月31日"`）、`None`/空串早退、非法月份、长度不足、`year<=0` → 文件覆盖率仅 84.54%                                                                                                                                                                                               | 补 `test_parse_report_period_cn_date_forms` / `_invalid_returns_none` / `_label_map`                                                                                                                    | Tessa §3#1                               |
| 11  | 🟡中  | 覆盖缺口   | `backend/app/services/dividend_yield_refresh.py:137`                                                                     | P6 restate 仅在**纯函数层**被验证；`refresh` 的 DB 级装配路径无用例（现有 `_div` 的 bonus 全为 `None`＝恒等变换）                                                                                                                                                                                                                                                 | 补 `test_refresh_applies_restatement_with_bonus`                                                                                                                                                        | Tessa §3#6                               |
| 12  | 🟡中  | 死代码    | `dividend_notice_scan.py:66,468,488,497`                                                                                 | `_TITLE_SPECIAL_RE`/`_match_proposed`/`_exists_anchor`/`_has_proposed` 生产代码**零调用**（仅测试引用），且过滤条件均为已废弃的 `period_type==SPECIAL` 语义 → 方案 §3「保留清单」失真                                                                                                                                                                                    | 连同「§3 明确保留」注释一并评估：确无消费方则删除（含测试）；若属兼容占位则改为测试内本地常量                                                                                                                                                       | Cody 🟡#2 + Archi 🟡#6 + lead 全仓 grep 复核 |
| 13  | 🟡中  | 架构/耦合  | `dividend_seed.py:31,68,91,108`；`dividend_cninfo_parse.py:20`                                                            | **跨模块私有符号耦合**：seed 直接调 scan 服务的 `_bump`/`_settings`/`_resolve_detail_itf`/`_reresolve_detail_safe`；parse 模块 import `market_data_sync._row_get` → 弱化模块边界（项目已有「私有符号上提为公共 API」的示范，见 `dividend_yield.py:58-64`）                                                                                                                        | 把所需能力提升为公共采集 API                                                                                                                                                                                       | Archi 🟡#5                               |
| 14  | 🟡中  | 架构/职责  | `dividend_notice_scan.py:347-370`、`dividend_seed.py:91`                                                                  | **单只采集能力归属错位**：`fetch_and_upsert_master`（巨潮单只采集）长在「每日公告扫描」类上，却被播种依赖 → 「谁能采集」取决于「扫描器」                                                                                                                                                                                                                                               | 抽独立 `dividend_cninfo_collect` 采集模块，scan 与 seed 同为其调用方                                                                                                                                                  | Archi 🟡#9                               |
| 15  | 🟡中  | 重复逻辑   | `notice_scan.py:232-264` vs `dividend_seed.py:81-108`                                                                    | **逐只容错骨架重复**约 30 行（try/commit/rollback/snapshot-expire/reresolve），逻辑同源未抽公共函数                                                                                                                                                                                                                                                       | 抽 `_iter_masters_with_tolerance(...)` 到采集层共用                                                                                                                                                           | Archi 🟡#7                               |
| 16  | 🟡中  | 行数纪律   | `dividend_notice_scan.py`=**537**；`test_dividend_seed.py`=**491**；`test_dividend_notice_scan.py`=**768**                 | 均超 §4「单文件 ≤400 行」人工约定（CI 800 行硬阈未破，故 CI 不拦）。且 `dividend_cninfo_parse.py:4` 声称「把该文件压回 400 行内」**与实测不符**                                                                                                                                                                                                                              | 继续按职责拆分采集/去重/取消三块；测试按场景拆分；修正不实注释                                                                                                                                                                       | Archi 🟡#8 + Tessa + lead 实测行数           |
| 17  | 🟡中  | 数据运维   | 方案 §6 / Q4（`docs/…:392-404`）                                                                                             | 旧新浪 `SPECIAL` 存量行**直接删除未执行**（刻意延后，依赖播种跑通）。并存窗内 `_westward_dup` 会「旧数据优先」挡住重叠新行，且 `period_type` 不同不满足唯一键 → 同笔可能双计                                                                                                                                                                                                                    | 属刻意延后项；须在运维单显式登记「待播种完成即执行 §6 DELETE + SELECT 条数留痕」并写入发布检查表                                                                                                                                             | Cody 🟡#5 + Archi 风险#4                   |
| 18  | 🟡中  | 文档一致性  | 方案 `:206,211`；`docs/股息率排名管理方案.md:484,693,1314,1383,1416`                                                                 | ① 方案 §4.7 内部不一致：`:206` 仍写 `0031_drop_dividend_report_source`（实际 `0032`）、`:211` 仍写 `0029/0030/0031` 三段；② 旧文档仍把已 drop 的 `dividend_report_source_interface_id` 当现存配置项描述，且含"加列迁移"片段                                                                                                                                                    | 修正迁移编号；给旧文档加「已被《分红采集链路迁移方案》§4.7 取代」状态注记                                                                                                                                                                | Archi 🟡 + lead 复核                       |
| 19  | 🟡中  | 设计兑现   | `router.py:320-342`；`dividend_period.py:170-179`                                                                         | 方案 §5.3.1 消费侧#3「dividends 端点 + `plan_label` 补 `bonusShareRatio`/`convertRatio`（×10 还原展示）」**未兑现** → 两列目前只作复权因子                                                                                                                                                                                                                      | 方案自注「由独立前端 ticket 承接」，确认该 ticket 已建                                                                                                                                                                    | Archi 🟡                                 |
| 20  | 🟢低  | 文案残留   | `settings_router.py:96-104`；`use-dividend-yield.ts:157`；`dividend-yield.api.ts:120`                                      | 移除主源后注释/错误消息仍写「主源」「三接口源设置」                                                                                                                                                                                                                                                                                                         | 校正为「明细源/行情源」「补充源/行情源」现行口径                                                                                                                                                                              | Cody 🟢#9                                |
| 21  | 🟢低  | 命名     | `backfill_router.py:1-7,25-90`                                                                                           | 文件名与内容不符：已无任何 backfill，只剩 rebuild + seed 两个「手动触发」端点                                                                                                                                                                                                                                                                                | 更名 `manual_router` / `admin_actions_router`                                                                                                                                                            | Archi 🟢#10                              |
| 22  | 🟢低  | 提交纪律   | `.codebase-memory/artifact.json`、`graph.db.zst`                                                                          | 未提交的索引快照属已知「滞后一笔」现象，但会干扰业务 diff                                                                                                                                                                                                                                                                                                    | 纳入忽略或随索引重建统一提交                                                                                                                                                                                         | Cody 🟢#10                               |
| 23  | 🟢低  | 效率     | `dividend_seed.py:142-173`                                                                                               | 断点检查只记「已写近 5 年行」的证券 → **零产出行**的证券（无分红股）每次重跑都重新拉取巨潮，浪费预算                                                                                                                                                                                                                                                                            | 可选：加「已尝试」哨兵；非阻塞                                                                                                                                                                                        | Cody 🟢#11                               |

---

## 🧪 测试覆盖评估（工作流 1 正文·测试节）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `uv run pytest -q`（本会话隔离库） | **0** | **675 passed / 3 xpassed / 0 failed / 0 errors**（363s） |
| 同上 + `--cov=app` | **0** | `TOTAL 8005 stmts, 1791 miss, 78%` |
| 覆盖率分层闸门 | **0** | finance_core **96.13%**（≥90）/ services **72.96%**（≥60）/ app **77.63%**（≥70）→ **PASS** |
| `pnpm test` | **0** | Test Files **81 passed**；Tests **573 passed** |
| `pnpm run lint` / `typecheck:e2e` | **0** / **0** | `vue-tsc --noEmit` 无输出 |
| `uvx --offline ruff check app tests conftest.py` | **0** | `All checks passed!` |
| `uv run lint-imports` | **0** | `Contracts: 4 kept, 0 broken`（94 files / 299 deps） |
| `python scripts/check_line_budget.py` | **2** | ✗ 新增 2118 行 > 800 ← **唯一硬阻断** |
| `python scripts/check_tests_touched.py` | **0** | 35 文件改动（业务 21 / 测试 8）→ 通过（告警型） |

**被改文件覆盖率**（实跑）：`dividend_cninfo_parse.py` 100% / `dividend_seed.py` 100% / `models/dividend_yield.py` 100% / `dividend_yield.py` 96.46% / `dividend_yield_refresh.py` 91.04% / `dividend_notice_scan.py` 89.55% / `dividend_period.py` 84.54% / `dividend_sync.py` 80.36%。

---

## 🚀 部署前检查清单（Go/No-Go 正文）

- [ ] **CI 四流水线全绿**（#001/#002/#003/#004）｜⚠️ 当前 **#001 backend-lint 必失败**（行数闸门），需先解除
- [ ] **owner 决策行数闸门**：拆分提交 或 `LARGE_PR_APPROVED=1` 豁免
- [ ] **复测巨潮 `stock_dividend_cninfo`**（C1 硬门槛）｜未恢复即推送＝删掉唯一可用采集链路
- [ ] **确认生产库当前版本**｜`SELECT version_num FROM alembic_version;`（预期 `0028_drop_price_backfill`）
- [ ] **存量枚举行核对**｜`SELECT task_type,count(*) FROM job_configs WHERE task_type IN ('DIVIDEND_QUARTERLY_FETCH','DIVIDEND_SPECIAL_BACKFILL') GROUP BY 1;`（预期 QUARTERLY=1、SPECIAL_BACKFILL=0）
- [ ] **全库逻辑备份**｜`pg_dump -Fc -d "$PGURL" -f investracker_$(date +%Y%m%d_%H%M).dump`
- [ ] **定向备份 0032 将删的配置列**｜`\copy (SELECT id, dividend_report_source_interface_id FROM dividend_yield_settings) TO 'dy_report_src.csv' CSV HEADER`
- [ ] **前后端同镜像发布**（`settings_router.py:43` 为 `extra=forbid`，陈旧 SPA 发已删字段会 400）
- [ ] **健康端点** `GET /api/health` → `{"status":"ok"}`
- [ ] **回退触发条件与责任人已指派**

### Go / No-Go 决策

| 层次 | 判定 | 说明 |
|---|---|---|
| 迁移代码本身 | 🟢 **Go** | 链闭合、head 唯一 = `0032`；0030/0031/0032 **单事务原子**（均无 `autocommit_block`），任一失败整体回滚无半应用态；往返可逆已在 fresh 库实测 |
| 代码质量 | 🟢 **Go** | 无 🔴；测试/覆盖率/ruff/import-linter 全绿 |
| CI 闸门 | 🔴 **No-Go** | 行数预算 2118 > 800，`EXIT=2`，按当前配置分支会被打回 |
| 发布编排 | 🟡 **有条件 Go** | 需满足 C1（巨潮复测）/ C2（分批或立即验证新链路）/ C3（DB+镜像同退） |

> 一句话给决策：**代码可以推，但「删旧链路 + 依赖仍故障的上游新链路 + 超 800 行预算」这三件事必须先解决其中至少两件。**

---

## ✅ 反证与已核查项（确认「没问题」，避免重复怀疑）

1. **后端全量绿**：隔离测试库 675 passed / 0 failed / 0 errors（先前大量失败已定位为团队并发跑 pytest 争用同一测试库，非代码缺陷）。
2. **前端无残留引用**：全仓 `grep report_source|dividendReportSource` 于 `web/src` **零命中**；`vue-tsc` app+e2e 均 RC=0。
3. **契约一致**：脚本比对 `app.openapi()` vs `docs/openapi.json` → paths **96 = 96** 完全一致；`docs/openapi.json` 无 `backfill-specials`/报告源，含 `/rebuild` 与 `/seed-initial-dividends`。前端 `seedInitialDividends()` 声明 `Promise<{ message: string }>`，**未沿用旧 `job_id` 契约漂移**。
4. **迁移往返可逆（fresh 库实测）**：`upgrade head` → 增列在/删列在；`downgrade 0028` → 两列消失、报告源列恢复、枚举含 `DIVIDEND_QUARTERLY_FETCH`；`upgrade head` → 复原。
5. **裁决兑现核对**（对照方案 §9.3）：A1 纯送转不落库 ✓ / A2 除权日非空→PAID ✓ / A3 真 5 年 `[cur-4,cur]` 与 `retention_cleanup` cutoff 严格对齐 ✓ / A4 仅全市场播种 ✓ / A6 三未用列仅留常量 ✓ / Q3 下线报告源 ✓ / Q6 送转不进收益率改重述 ✓。
6. **重述一致性**：快照（`refresh.py:137`）、曲线（`dividend_yield.py:273`）、过滤态排名（`router.py:227`）**各重述恰好一次**且均作用于新投影 → 「曲线末点 == 快照」成立，无二次复权。
7. **我的独立反证**：0032 只删主源列，`announcement_source_interface_id` 完好（`models/dividend_yield.py:217`、`settings_router.py:47/163`、`notice_scan.py:169`）→ **公告链路未被误伤**。
8. **口径核对**：`parse_cash` 确有 `÷10`（`dividend_period.py:100`），与 0030 docstring 声明的「每 10 股→每股」一致 ✅。
9. **安全**：`/seed-initial-dividends`、`/rebuild`、`PUT /settings` 均 `Depends(require_admin)`；全 ORM/`bindparams`，**无 SQL 注入**；0031 的 f-string 仅拼常量枚举名；无新 SSRF 面；日志不含凭证。
10. **历史坑未被误伤**：`dividend_sync._code_of` **保留**（仅签名 `QuoteInterface`→`Any`），`test_response_fields_equivalence.py:23` 与 `test_qa_round2_regression.py:20` 的 import 正常，pytest collection 不崩。
11. **性能非问题（我排除的疑点）**：`restate_cells` 为 O(n²) 双层循环，但三处调用点传入的**都是单只证券记录集**（n ≤ 约 20），不构成性能风险。
12. **行数净变化**：`dividend_sync.py` 479→165、`dividend_notice_scan.py` 719→537（净降）；其余改动文件均在 400 内。

---

## 🏗️ 建议新增/修订的 ADR（架构师意见）

1. **【新增】ADR-004：分红采集数据源迁移（公告探测 + 巨潮 `stock_dividend_cninfo`）与 Expand→Contract 分批策略** — 明确 Contract 前置门槛（新链路连续产出 ≥1 日增量 + 覆盖率核对）；登记播种的「一次性手动、不注册 JobType、单飞/可观测约束」。
2. **【新增】ADR-005：送转市值中性与「除权复权重述」股息率口径** — 记录推翻原「送转并入综合收益率」裁决的法理（市值中性）与 `Π(1+bonus+convert)` 公式及 `as_of` 语义。
3. **【修订】ADR-002** — 补记分红明细源经管理端切至巨潮（零代码），并**显式作废**季度抓取/特别分红回补相关旧描述。
4. **【记录】旧能力下线** — `DIVIDEND_QUARTERLY_FETCH` JobType、`POST /backfill-specials`、`dividend_report_source_interface_id` 标注 `superseded`。

---

## ✅ 行动清单（按优先级排序）

| # | 行动 | 负责角色 | 紧急度 | 说明 |
|---|------|---------|--------|------|
| 1 | owner 决策行数闸门：拆批提交 或 `LARGE_PR_APPROVED=1` 豁免 | owner | **P0** | 否则推送必打回 CI #001 |
| 2 | 复测巨潮 `stock_dividend_cninfo` | owner/ops | **P0** | C1 硬门槛；未恢复则不得删旧链路 |
| 3 | 决定是否分批：先只推 P0，观察一轮每日扫描再推 P1/P2 | owner | **P0** | C2；解除 Archi 🔴#1 |
| 4 | 修 0031 三处：补 `_ENUM_VALUES_ALL` 缺失值 / `:75` `TRUE`→`FALSE` / 修正「10 个值」注释 | senior-dev | P1 | 三方确认；迁移未上生产，改动零成本 |
| 5 | 补 4 个失败韧性用例（`_reresolve_detail_safe` fail-fast / L-3 / anchor 计数 / scan 无明细源） | senior-dev | P1 | 守护「失败被静默吞掉 / 摘要虚高」类高风险不可见故障 |
| 6 | 播种端点加单飞锁（进程标志或 DB 运行令牌） | senior-dev | P1 | 三方独立命中；防并发 19h 任务打满限流 |
| 7 | `except Exception` 补 `logger.warning(exc_info=True)`；失败占比超阈值时 raise | senior-dev | P1 | 消除「全灭却 SUCCESS」排障盲区 |
| 8 | 修 UI 日志落点（补 `job_run_logs` 或统一文案为「应用日志」） | senior-dev | P2 | 用户按提示找不到记录 |
| 9 | `restate_cells` 加 `status` 过滤 + docstring 声明不可重入；裁决 `i_date is None` 语义 | senior-dev | P2 | 防 REJECTED 污染复权基准与重复缩股 |
| 10 | 清理死代码簇 / 跨模块私有符号 / 文档编号不一致 / 旧文档状态注记 | senior-dev | P2 | 整洁度与文档债 |
| 11 | 运维单登记「§6 存量 DELETE 待播种跑通后执行」并写入发布检查表 | ops | P2 | 防新旧口径双计 |
| 12 | 清理泰莎遗留的临时测试库 `investment_return_tracker_test_tessa_iso` | ops | P3 | 见「待完善」节 |
| 13 | 统一团队测试纪律：后端 pytest **串行**执行或各自用独立库名 | 全体 | P1 | 见「环境风险」节 |

---

## ⚠️ 待完善 / 已知局限

### 环境风险（重要，会影响后续任何验证）
1. **并发 pytest 会互相拆库**：`backend/conftest.py::_test_db_bootstrap` 为 **session 级**，每次会话开始即 `DROP DATABASE investment_return_tracker_test` + `CREATE` + `pg_terminate_backend` + `alembic upgrade head`。实测同一命令两次结果完全不同（21 failed/624 passed → **152 failed/493 passed**），报错为 `InvalidCatalogNameError: database "..." does not exist` / `UndefinedTableError: relation "app_logs" does not exist` / `UndefinedColumnError: column "green_threshold" ...`。**静置时该库健康（28 表、`alembic_version=0032`）→ 非 schema 漂移**。结论：**测后端必须串行，或各自用独立 `TEST_DATABASE_URL`**。（此项为既有基建问题，与本次 22 提交无关。）
2. **遗留物**：泰莎为规避上述冲突启用了专用库 `investment_return_tracker_test_tessa_iso`，按硬约束未自行删除。清理命令：`DROP DATABASE "investment_return_tracker_test_tessa_iso";`（需人工确认后执行）。
3. **前端覆盖率闸门本地无法测量**：`web/node_modules/@vitest/coverage-v8` 缺失，`check_frontend_coverage.py` 按设计退出 3，由 CI 强制执行；本次未改变前端覆盖基线。

### 未能机器复核的项
4. **`tests/test_arch_boundaries.py`（AST 边界检查）本轮未能运行** —— 被上述并发拆库阻断，故「他域 ORM 构造」规则属**未验证项**。建议在干净单会话环境补跑。
5. **0031 在真实开发库上的枚举重建**：开发库 `investment_tracker` 冻结（硬约束禁连），无法确认 `job_configs` 是否存在携带被删枚举值的行；理论风险见发现 #6（已由 `_CREATABLE_TYPES` 收窄为「仅 `JobUpdate.task_type` 理论上可改出」）。
6. **§6 存量 SPECIAL 删除状态**：属数据运维步，无法从代码验证执行状态与条数。
7. **巨潮上游列名鲁棒性**：无法对真实接口取样（接口仍 500）。逻辑上若列名整体变更，`_row_get` 返回 None → 每行 skip，摘要可观察到异常，但**无显式告警**（并入行动 #7）。
8. **A2 语义假设**：`status=PAID if ex_date 非空` 依赖「巨潮仅在除权后回填除权日」；若源站提前回填计划除权日，未实施分红会被记 PAID（方案 §9.3-A2 已接受的取舍，无法离线证实）。

---

## 📚 数据来源 & 成员产出索引

- **Cody（代码审查师）原始产出**：11 项发现（1 🟠 + 7 🟡 + 3 🟢）+ 12 条反证；证据脚本 `cody_final.txt` / `cody_web_tsc.txt` / `cody_web_test.txt` / `cody_openapi.txt` / `cody_mig3.txt` / `cody_ruff2.txt` / `cody_loc.txt` / `cody_diff1.txt` / `cody_diff2.txt`（均在 `.workbuddy/tmp/`）
- **Archi（架构师）原始产出**：16 项裁决符合度核对（13 ✅ / 3 偏差）+ 10 项架构问题（1 🔴 + 3 🟠 + 6 🟡 + 1 🟢）+ 3 类风险权衡 + 4 条 ADR 建议；核验命令 `import_linter` API（4 kept / 0 broken）、`pytest tests/test_import_linter.py`（1 passed）
- **Rex（SRE 工程师）原始产出**：迁移链核验（24 revision / head 唯一）、逐迁移风险表、发布前检查清单、回滚三场景方案、24h 观测建议；报告 `rex_report.md`（含 🟢→🟡 修订稿）
- **Tessa（测试专家）原始产出**：10 条命令实测结果、被改文件逐文件覆盖率、8 项覆盖缺口、23 个删除用例的覆盖迁移核查表、失败原始输出；留存 `tessa_*.txt`
- **team-lead（工程督导）独立复核**：未推送/未提交范围核实（22 提交 / 35 文件 / +2717 −2483）、0031 枚举值计数与 downgrade 非对称性预扫线索、`check_line_budget.py` 亲跑 `EXIT=2`、`_TITLE_SPECIAL_RE` 等死代码全仓 grep、文件行数实测、契约产物与前端声明一致性核对、`restate_cells` 三个调用点作用域与 O(n²) 判定、工作区卫生检查（无成员遗留文件）

---

> 本报告由工程保障团队 AI 协作生成，关键决策请由人类工程负责人复核。所有数值均来自实际命令输出；无法取证的结论已显式标注「推测」或「未能验证」。
