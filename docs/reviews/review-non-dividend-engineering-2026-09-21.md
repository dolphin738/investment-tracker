# 非分红工程审查报告（合并版 · 工程闸门 / 发布编排 / 迁移机制 / 环境治理）

**日期**：2026-09-21
**来源**：合并自 4 份报告中的**非分红**部分
- `docs/reviews/code-review-unpushed-dividend-migration-2026-09-20.md`（22 提交综合审查）
- `docs/reviews/supplement-decisions-and-cninfo-retest-2026-09-20.md`（决策落地 + 遗留闭环 + 接口复测）
- `docs/reviews/review-dividend-special-period-semantics-2026-09-20.md`（仅取其中的迁移/环境条款）
- `docs/reviews/review-dividend-manual-period-2026-09-21.md`（仅取其中的通用迁移机制与执行编排）

**本报告的划分口径**：只收「**不依赖分红业务语义**即可理解与实施」的内容 —— 工程闸门、CI/发布编排、PG 迁移机制、环境与工具链、架构治理基建、以及对应的未裁决项。**分红采集链路 / 报告期语义 / staging 设计 / 股息率算法**另归分红报告（后续合并）。

---

## 📌 TL;DR

- **🔴 唯一机制性阻断**：行数预算闸门 —— 基线 `cnb/main` → HEAD 新增 **2118 行 > 上限 800**（`scripts/check_line_budget.py`，EXIT=2，我亲跑复核）。`AGENTS.md §2` 为硬闸门。
- **其余闸门全绿**：后端 **675 passed / 0 failed**；前端 **573 passed** + `vue-tsc` app+e2e `RC=0`；覆盖率 finance_core **96.13%** / services **72.96%** / app **77.63%**；ruff `All checks passed`；import-linter `4 kept, 0 broken`；openapi paths **96=96**。
- **发布编排**：建议 **PR 路径**（闸门必生效 + CI 四流水线可核验）；**直接 push 到 main 时闸门行为未验证**，且 CNB 非 main 分支 **不触发 CI**。
- **环境最大坑**：`backend/conftest.py` 的 session 级 `DROP/CREATE DATABASE` 使**并发 pytest 互相拆库**（同命令两次得 21 failed 与 152 failed 两种不可复现结果）。
- **状态基线**：`main` 领先 `cnb/main` **22 / 落后 0 → 全部未推送**。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|---|---|
| 整体评级 | 🟡 **有条件通过** —— 代码🟢 / 闸门🔴（仅行数一项）/ 编排🟡 |
| 阻塞项 | 1（行数闸门 2118 > 800） |
| 关键行动项 | 7 条（见 ✅ 行动清单） |
| 建议下一步 | owner 拍板 §7 的 A1~A7 → 拆批推送 → 落地分红语义改动（另报告）→ 最终合并 |

---

## 一、审查范围与状态基线

| 项 | 事实 |
|---|---|
| 分支 / 上游 | `main` / `cnb/main`，**领先 22 / 落后 0** |
| HEAD | `5c28b42 docs: 同步分红迁移方案 P2/§4.7 进度与迁移号顺延 (0031/0032)` |
| 未推送范围 | 35 文件，**+2717 / −2483** |
| 未提交（工作区） | `.codebase-memory/artifact.json` + `graph.db.zst`（索引快照）+ `docs/分红采集链路迁移方案.md`（**CRLF 假象，`git diff` 为空**）+ 4 份报告（未跟踪） |

---

## 二、工程闸门

### 2.1 🔴 行数预算（唯一硬阻断）

```
[行数闸门] 基线 cnb/main → HEAD 新增 2118 行（上限 800，已排除锁文件/生成物）
  top: +556 backend/tests/test_dividend_notice_scan.py
       +491 backend/tests/test_dividend_seed.py
       +236 backend/app/services/dividend_notice_scan.py
       +194 backend/app/services/dividend_seed.py
[行数闸门] ✗ 新增 2118 行超过上限 800。   EXIT=2
```

**机制（决定它何时有牙齿）**：脚本比的是 `merge-base(base, HEAD)..HEAD`（`check_line_budget.py:65-66`），**不是** base 的当前 tip。⇒

| 场景 | 闸门是否生效 | 说明 |
|---|---|---|
| **PR 事件** | ✅ 必生效 | 基线＝目标分支 tip，落后于 PR 提交 |
| **直接 push 到 main** | ⚠️ **未验证** | 若 push 后基线 ref 已随之前移 → diff 归零 → **闸门空放**；基线不可解析也 `return 0`（`:113-115`） |

> ⚠️ 修正前一轮的过度断言：原报告写「直接推送必打回 CI #001」**未经证实**；正确表述是「**走 PR 必被拦，直接 push 待从构建日志确认**」。

**P0 阶段单独即 1829 行 > 800** ⇒ 光靠「分批（P0/P1/P2）」不够，**必须拆到提交粒度**。

### 2.2 其余闸门（全绿，实测）

| 闸门 | 结果 |
|---|---|
| 后端测试 | 隔离库 **675 passed / 3 xpassed / 0 failed**（363s） |
| 覆盖率（`check_coverage.py`） | finance_core **96.13%** ≥90 / services **72.96%** ≥60 / app **77.63%** ≥70 → **PASS** |
| 前端 | `pnpm test` **81 files / 573 tests passed**；`vue-tsc app+e2e` 均 `RC=0` |
| ruff | `uvx --offline ruff check app tests conftest.py` → `All checks passed!` |
| import-linter | **4 kept, 0 broken**（94 files / 299 deps） |
| 契约一致性 | `app.openapi()` vs `docs/openapi.json` paths **96 = 96** |
| knip | 通过（⚠️ 陷阱：以**字符串**引用的依赖如 `@vitest/coverage-v8` 的 `provider:'v8'` 会被判 unused → 须在 `web/knip.json` 的 `ignoreDependencies` 登记） |
| 单文件 ≤400 行 | **人工约定，CI 不拦**（`dividend_notice_scan.py` 537 行超限但不会被拦） |

---

## 三、发布编排

### 3.1 分批切分（同时满足闸门 ≤800 与阶段语义）

| 批 | tip | 内容 | 增量 |
|---|---|---|---|
| **B1** | `183bd3a` | docs + 采集主链路 | 462 |
| **B2** | `d6bb2f3` | 公告扫描单测 + 播种服务 | 796 |
| **B3** | `b5f7cf3` | 播种单测 + openapi + 前端按钮（**P0 完成**） | 571 |
| — | — | **⏸ 观察窗**（≥1 次完整每日扫描） | — |
| **B4** | `c65249d` | P1 删旧回补 + P6 复权重述 | 186 |
| **B5** | `5c28b42` | P2 下线季度抓取 + §4.7 | 142 |

> 该切分同时消除了「Contract 阶段早于替换链路跑通」的架构风险。

### 3.2 推送与 CI

- **推荐 PR 路径**：闸门必生效；且 CNB 的 **PR `statuses` 恒为空，不能据此推断全绿** —— 合并后须从构建页核验四条流水线（`#001 backend-lint` / `#002 frontend-lint` / `#003 backend-test` / `#004 frontend-test`）。
- **非 main 分支 push 不触发 CI** → 不开 PR 就没有任何 CI 验证。
- **`#003 backend-test` 会在全新 PG16 上真实执行 `alembic upgrade head`**（`backend/conftest.py:78-83`）→ **这是迁移可执行性最强的证据**。
- **回退口径 = DB + 镜像必须同退**（否则会出现「库已降级但镜像仍是新版」这类半状态）。
- 健康检查：`GET /api/health`；entrypoint `set -e` + `alembic upgrade head`，失败即退出不半启动（`docker/docker-entrypoint.sh:4-10`）。

---

## 四、PG 迁移机制（通用，供后续迁移复用）

| 约定 | 事实 | 证据 |
|---|---|---|
| **新增枚举值** | PG 无 `DROP VALUE`；`ADD VALUE` 须置于 `autocommit_block()` | `0004:427`、`0011:25`、`0019:52`、`0001:894/2091` |
| **删除枚举值** | 只能**重建类型**：列降 text → `DROP TYPE` → `CREATE TYPE` → `USING col::text::"Name"` | `0008:38-51`、`0031:37-50` |
| **重建前的必须动作** | 先把引用被删值的行 `UPDATE` 回合法值，否则末步 cast 抛 `invalid input value for enum` | `0031:78`、`0001:1986-1987` |
| **原子性** | `env.py:59-60` 单事务；现有 0030/0031/0032 **均无** `autocommit_block` ⇒ `upgrade head` **单事务原子**（任一失败整体回滚）。**一旦引入 `autocommit_block`，该段即非原子** | `env.py:59-60` |
| **迁移链** | head 唯一 = `0032_drop_dividend_report_source`；链闭合；`0029` 缺号属**计划改号**（方案 `:442`），非错误 | `alembic heads` + 脚本解析 |
| **新模型注册** | 新 ORM 模型**必须 import 进 `app/models/__init__.py`**，否则 `conftest.py:113` 的 `TRUNCATE {Base.metadata.sorted_tables}` **漏表** → 用例间数据泄漏（表现为随机 flaky） | `conftest.py:113` |
| **downgrade 顺序** | 删表与删枚举类型：**先 `drop_table` 再 `DROP TYPE`**，反序报依赖错误 | 本次 `0034` 定稿 |

**既有教训（应作为迁移评审清单常驻）**：`0031` 的 downgrade docstring 与其代码**自相矛盾** —— `:64` docstring 写「（默认禁用）」但 `:75` 取 `TRUE`（模板 `0008:65/76` 为 `FALSE`）；且 `:22` 注释「当前 10 个值」**事实错误**（实际 **11**：0008→9、0011 加 `DIVIDEND_SPECIAL_BACKFILL`→10、0019 加 `TRADE_CALENDAR_REFRESH`→11）。另 `_ENUM_VALUES_ALL` 缺 `DIVIDEND_SPECIAL_BACKFILL` → 反向迁移链在 `0015:37` 处断裂。

---

## 五、环境与工具链坑（本环境，非代码缺陷）

| 坑 | 现象 | 处置 |
|---|---|---|
| **并发 pytest 互相拆库** | `conftest.py::_test_db_bootstrap`（**session 级**）每次会话开始 `DROP DATABASE investment_return_tracker_test` + `CREATE` + `pg_terminate_backend`。两个会话同跑 → 同一命令两次得 **21 failed/624 passed** 与 **152 failed/493 passed**；报错 `InvalidCatalogNameError` / `UndefinedTableError` / `ConnectionDoesNotExistError` | **测后端必须串行，或各自用独立 `TEST_DATABASE_URL`** |
| **纯静态用例也被拖入 DB 链路** | `_clean_db`(autouse) → `_engine` → `_test_db_bootstrap`，导致连**纯 AST 用例**也触发整条 DROP/CREATE + `alembic upgrade head` | 串行即可通过（已实测 `test_arch_boundaries.py` → **1 passed in 3.07s**） |
| **Bash 工具链失效** | `ls/grep/cat/mkdir/dirname/cd/tail` 报 `dirname: command not found`；`\| tail` 管道失败；PowerShell 有时不回显 | 改用**文件重定向** + Read；或 Write Python 脚本执行 |
| **索引快照滞后一笔** | `.codebase-memory/artifact.json` 记 `commit`+`indexed_at` → 每次提交后必然再次显示 modified | 属预期；建议纳入忽略或统一提交（见 A6） |
| **CRLF 假象** | `docs/分红采集链路迁移方案.md` `git status` 显示 M 但 `git diff` 为空 | `AGENTS.md §0`：**勿纳入提交** |
| **codebase-memory 双索引** | 存在 `investment-return-tracker`（陈旧）与 `D-agent-AI-Coding-investment_return_tracker` | **一律只用后者**（owner 已裁定）；检索优先用 MCP 而非裸 Grep |
| **临时测试库残留** | `investment_return_tracker_test_tessa_iso`（+ `_iso2`） | 无害（conftest 只管主库名）；清理命令 `DROP DATABASE "..."`（见 A4） |

---

## 六、架构治理与可观测性基建

- **边界测试已闭环**：`tests/test_arch_boundaries.py` → **1 passed in 3.07s，EXIT=0**；独立 AST 复算扫描 **130 个 .py、0 违规**。
- **规则覆盖度缺口**：该 AST 规则的受管映射目前**只有 `data_transfer → {CashFlow}`**，其余领域（含本次 8 个 service）**不受管** → 「他域 ORM 构造」检查的实际覆盖面很窄。
- **导入层契约**：`.importlinter`（`core_no_business` / `bottom_no_common`）实测 **4 kept, 0 broken**。
- **手工约定不进 CI**：单文件 ≤400 行、函数单一职责、依赖自证叙述 —— 只在人工评审/提交闸门处把关。
- **可观测性**：系统**无 Prometheus 指标端点**；观测面＝容器启动日志 + `/api/health` + `app_logs`/`job_run_logs` 表。建议为 `/api/health` 配存活探针；对任何「待人工消费」的队列应提供 **深度 × 龄期** 的可观测量与告警（否则会出现「队列永不消费」这类静默失败）。

---

## 七、未裁决项（非分红）

> ✅ **裁决结果（owner，2026-09-21 03:41）**
> **A1 = ③**（混合拆批）｜**A2 = 不管**（**agent 不手动推送**，推送由 owner 自行执行）｜**A3 = ①**（不重排提交）｜**A4 = ①**（清理临时测试库）｜**A5 = ①**（只立规矩「串行」）｜**A6 = 不管**（维持现状）｜**A7 = ①**（CRLF 假象文件勿纳入提交）

> 以下保留选项与依据供追溯。技术依据见 §2.1（闸门机制）、§3（发布编排）、§5（环境）。

| ID | 待裁决 | 选项 | 我的建议 | 依据 |
|---|---|---|---|---|
| **A1** | **行数闸门如何解除**（22 提交整批 **2118 > 800**；本次语义改动单独估 1250–1970） | ① 严格拆批（每批 <800）<br>② `LARGE_PR_APPROVED=1` 豁免<br>③ **混合**：22 提交按 B1~B5 拆 + 语义改动拆 5 小批 | **③** | 豁免是长期负担；闸门本意是限制单批规模；`AGENTS.md §2` 为硬闸门；**P0 阶段单独即 1829 > 800**，光按阶段分批不够 |
| **A2** | **推送路径**：PR 还是直接 push main | ① **PR**<br>② 直接 push main | **①** | `check_line_budget.py:65-66` 比 `merge-base(base,HEAD)`；直接 push 时基线 ref 可能已前移 → **闸门空放（未验证）**；CNB **非 main 分支 push 不触发 CI** |
| **A3** | **推送顺序 / 是否重排提交**（语义改动提交会落在 B5 之后，而 B4/B5 已删旧链路） | ① **不重排**：B1→B2→B3→观察窗→B4→B5→语义改动小批（每批 diff 小；代价：P1/P2 删旧链路先于语义修正落地，短暂丢 特别分红）<br>② **重排**：`rebase --onto` 把语义改动插到 B3 之后<br>③ 只推到 B3，B4/B5 无限期搁置 | **①** | 本环境 **git 批量写/重写有事故史**（切分支丢 ~90 文件、`git rm` 单文件致 `docs/` 消失）；且不重排时每批 push diff 都很小，风险可控 |
| **A4** | **临时测试库清理**：`investment_return_tracker_test_tessa_iso`（+ `_iso2`） | ① 立即 `DROP DATABASE`<br>② 保留（下轮复用） | **①** | 无害（conftest 只管 `investment_return_tracker_test`）；残留会持续出现在库列表 |
| **A5** | **conftest 并发拆库是否治理** | ① **只立规矩「同一时刻只跑一个 pytest」**<br>② 改 `conftest.py` 按 PID/环境变量派生库名 | **①** | 改 conftest 影响**全仓测试基建**；收益不抵风险。依据：session 级 `DROP/CREATE` + `pg_terminate_backend`，实测同命令两次得 21 failed 与 152 failed 两种不可复现结果 |
| **A6** | **`.codebase-memory/` 索引快照提交纪律** | ① **加入 `.gitignore`**<br>② 随索引重建统一提交<br>③ 维持现状 | **①** | `artifact.json` 记 `commit`+`indexed_at` → **永远滞后一笔**，属预期但持续污染 diff |
| **A7** | **CRLF 假象文件** `docs/分红采集链路迁移方案.md`（`git status` 显示 M 但 `git diff` 为空） | ① 确认「**勿纳入提交**」<br>② 规范化行尾后提交 | **①** | `AGENTS.md §0` 明列「`git diff` 为空的文件勿纳入提交」；规范化会引入一次大 diff |

---

## 八、需要 owner 执行的事项

> 以下为**拍板后要动手做**的事项（不含裁决类选项，裁决见 §七）。

| # | 事项 | 说明 / 命令 | 紧急度 |
|---|---|---|---|
| 1 | 按 B1~B5 拆批推送，每批核验 CI 四流水线（**由 owner 执行；agent 不手动推送**，A2=不管） | 命令见下方「推送执行序列」 | **P0** |
| 2 | B3 之后插入观察窗（≥1 次完整每日扫描 + 播种后对账） | 方案 §8 | **P0** |
| 3 | ~~清理临时测试库~~ | ✅ **已完成**（2026-09-21）：`investment_return_tracker_test_tessa_iso2` 已 DROP；`_iso` 本就不存在。保护名单（`investment_tracker` / `investment_return_tracker_test`）未触碰 | ~~P1~~ 完成 |
| 4 | 固化「CRLF 假象文件勿提交」到提交流程 | `AGENTS.md §0` **已有该规定**，无需新增；`docs/分红采集链路迁移方案.md` 当前显示 M 但 `git diff` 为空，提交时按路径 `git add` 跳过即可 | P1 |

> `.codebase-memory/` 忽略一项已移出（A6 = 不管，维持现状）。

### 8.1 推送执行序列（已按真实行数核准，全部 ≤800）

口径同 `check_line_budget.py`（排除 `.md` / `docs` / 锁文件 / 生成物）。每批的 diff 基线 = **上一批推送后的 tip**，故各批只累计自身增量。

| 批 | 推送 tip | 含提交 | 增量 | 状态 | 语义 |
|---|---|---|---|---|---|
| 1 | `183bd3a` | 1–9 | **462** | PASS | P0 主链路（8 个 docs 提交 0 行） |
| 2 | `d6bb2f3` | 10–11 | **796** | ⚠️ 逼近上限（99.5%） | 扫描单测 + 播种服务 |
| 3 | `b5f7cf3` | 12–15 | **571** | PASS | 播种单测 + openapi + 前端按钮 → **P0 完成** |
| — | — | — | — | **⏸ 观察窗** | ≥1 次完整每日扫描 + 播种后对账 |
| 4 | `c65249d` | 16–19 | **186** | PASS | P1 删回补残留 + P6 复权重述 |
| 5 | `5c28b42` | 20–22 | **142** | PASS | P2 下线季度抓取 + §4.7 |

**命令（owner 执行；agent 不推送）**：
```bash
git push cnb 183bd3a:main    # 批1  462
git push cnb d6bb2f3:main    # 批2  796  ⚠️ 不要在此期间追加任何提交
git push cnb b5f7cf3:main    # 批3  571  → P0 完成
#   ⏸ 观察窗
git push cnb c65249d:main    # 批4  186
git push cnb 5c28b42:main    # 批5  142
```
⚠️ 三点提醒：
1. **分批推送不能用 `dev-scripts/push-all.ps1`**（它会一次性推送到 HEAD）。分批需显式带 `<sha>:main`，并沿用项目的凭据方式（`-c credential.helper=` + `CNB_TOKEN`），否则非交互环境会卡死在凭据弹窗。
2. **批2 = 796 行已达上限 99.5%**，推送前确认该区间（提交 10–11）无新增提交混入。
3. **每批推送后**从构建页核验 `#001 backend-lint` / `#002 frontend-lint` / `#003 backend-test` / `#004 frontend-test`；CNB 的 PR `statuses` **恒为空**，不能据此推断全绿。

> 附：整批一次性推送的累计为 **2157 行**（远超 800）——再次印证必须分批。

---

## ⚠️ 待完善 / 已知局限

- **直接 push 场景的闸门行为仍未验证**（需构建日志证据；选 PR 路径可绕开）。
- **行数估算为区间**（1250–1970 等），实际以落地后 `check_line_budget.py` 实测为准。
- 覆盖率数字来自一次隔离库实跑；`check_coverage.py` 跑全量 pytest，受 conftest 拆库影响须串行。
- 本环境**禁止对开发库 `investment_tracker` 执行任何写/迁移操作**，所有迁移结论均为纯脚本解析或只读验证。
- 本报告**不含**分红业务语义部分（采集链路、报告期归属、staging 与前端人工划分、股息率算法），那部分将在后续合并时并入同一份总报告。

---

## 📚 数据来源索引

- 合并来源：`docs/reviews/code-review-unpushed-dividend-migration-2026-09-20.md`、`supplement-decisions-and-cninfo-retest-2026-09-20.md`、`review-dividend-special-period-semantics-2026-09-20.md`（§5.1/§9 的迁移与环境条款）、`review-dividend-manual-period-2026-09-21.md`（§6 通用迁移机制、§8 执行编排）
- 实测脚本与输出：`.workbuddy/tmp/` 下 `recon_git.py`/`recon2.py`（git 侦察）、`arch_boundary_standalone.py`（AST 复算）、`batch_line_budget.py`/`per_commit_budget.py`（行数切分）、`label_vocab_check.py`/`label_independent_check.py`（抽检）、`upsert_simulation.py`（落库模拟）
- 成员产出：`.workbuddy/tmp/rex_report.md`、`rex_manual.txt`、`rex_task8_report.md`（Rex）；`tessa_test_impact_matrix.md`、`tessa_manual_period_diff_v3.md`（Tessa）；`archi_report.md`、`archi_sample2.txt`（Archi）

---

> 本报告由工程保障团队 AI 协作生成，关键决策请由人类工程负责人复核。
