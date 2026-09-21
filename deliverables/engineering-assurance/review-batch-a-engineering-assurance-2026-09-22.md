# 批次 A · 工程保证复核报告（Engineering Assurance）

- 复核对象：`investment_return_tracker` 后端「分红报告期语义扩展」批次 A
- 复核日期：2026-09-22
- 复核角色：EngineeringAssuranceTeam（team `engineering-dividend-batch-a`，lead 综合 architect / testing-expert / code-reviewer / engineer-a 结论）
- 代码状态：**已实现，已提交（local，未 push）**（feat + docs 拆分两笔，author `senior-dev <dev@local>`）

---

## TL;DR

批次 A 的**实现已完整落地并通过定向 + 全量验证**：`ReportPeriodType` 追加 `OTHER` 枚举、

`security_dividends` 新增 `dividend_label` 原文标签列、巨潮「分红类型」5 项精确映射 + 未知标签兜底

`OTHER`、撞键护栏（`effective_label` 对称口径 + 整行不更新）、`period_label()` 的 `OTHER` 分支定位、

聚合 WARN 报文口径统一读 `stats["unknown_label"]`、Alembic 迁移 `0033`、以及 R1–R5 全部测试。

**定向 70 测试全绿、ruff 零告警、2 项只读自检通过，全量回归 697 passed / 3 xpassed / 0 failed（424.78s）**。

**裁决**：L2（`_westward_dup` 去重护栏未做 source 作用域）已裁决 **③ 单独立项**；批次 A 已提交本地。

---

## 结论卡片（Conclusion Card）

| 维度 | 结论 | 证据 |
|---|---|---|
| 实现完整性 | ✅ 完成 | 枚举/模型/解析/period_label/scan+seed 护栏/router/迁移/测试 全部到位 |
| 定向测试 | ✅ 70 passed / 0 failed | `pytest` 4 个 dividend 测试文件 |
| 静态门禁 | ✅ ruff 0 问题 | `uvx --offline ruff check app tests conftest.py` → RUFF_EXIT=0 |
| 只读自检 1 | ✅ 枚举含 OTHER | `backend/app/models/enums.py:157` |
| 只读自检 2 | ✅ 列已存在 | `backend/app/models/dividend_yield.py` `dividend_label: Mapped[Optional[str]]` |
| 行数闸门 | ✅ 507 ≤ 800 | `git diff --numstat` 加总行数（剔除 `.codebase-memory`） |
| 全量回归 | ✅ 697 passed / 3 xpassed / 0 failed | task `YU8mle`，424.78s，0 失败 |
| 提交状态 | ✅ 已提交（local，未 push） | feat + docs 两笔，author `senior-dev <dev@local>` |

**整体判定：批次 A 实现层 🟢 + 全量回归 🟢 0 失败 + 已提交（local，未 push）；L2 已裁决单独立项。批次 A 放行完成。**

---

## 文件清单（改动 +507 行）

| 文件 | 增行 | 说明 |
|---|---|---|
| `backend/tests/test_dividend_notice_scan.py` | +277 | R2/R3/R4/R5 断言 + 既有用例改写 |
| `backend/app/services/dividend_notice_scan.py` | +69 | 撞键护栏、`effective_label`、聚合 WARN 读 `stats["unknown_label"]`、router 响应加 `dividendLabel` |
| `backend/tests/test_dividend_seed.py` | +54 | seed 侧 R2/R3 断言 |
| `backend/app/services/dividend_cninfo_parse.py` | +53 | `normalize_label`(NaN 守卫) / `parse_period_type`(兜底 OTHER) / `parse_cninfo_row_ex` / 5 项精确映射 |
| `backend/app/services/dividend_seed.py` | +22 | `_new_stats` 同键集、聚合 WARN 复用 scan 计数 |
| `backend/tests/test_dividend_period_label.py` | +19 | OTHER 分支位置硬约束 |
| `backend/app/services/dividend_period.py` | +7 | `period_label` 的 OTHER 分支（SPECIAL 之后、`quarter==4` 之前） |
| `backend/app/models/enums.py` | +3 | `ReportPeriodType.OTHER`（末尾，保 PG 排序） |
| `backend/app/models/dividend_yield.py` | +2 | `dividend_label` 列（不入唯一键） |
| `backend/app/modules/dividend_yield/router.py` | +1 | `/dividends` 响应加 `dividendLabel` |
| `backend/alembic/versions/0033_extend_report_period_type.py` | 新增 | ADD VALUE OTHER（autocommit_block）+ 加列（batch_alter_table） |
| `backend/tests/test_dividend_cninfo_parse.py` | 新增 | 解析模块 5 映射 / 兜底 / 撞键 / NaN 守卫 |

---

## 验证证据链（Trust but verify）

1. **只读自检 1 — 枚举含 OTHER**：`backend/app/models/enums.py:157` `OTHER = "OTHER"  # 其它（股改分红/重整转增/承诺补偿等非闭集词表兜底，批次 A 追加）`，且注释明确要求追加在末尾（PG 原生枚举定义顺序即排序顺序，router `ORDER BY period_type.asc()` 期望 OTHER 垫底）。

2. **只读自检 2 — 列已存在**：`backend/app/models/dividend_yield.py` 已含 `dividend_label: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)`；唯一约束仍为 4 列（不含该列），与 R4 断言一致。

3. **撞键护栏（核心不变量）**：`dividend_notice_scan.py:407-417` — 命中唯一键且 `old_label`/`new_label` 均非空且不等 → `collision++` + WARNING + **`return False`（整行不更新）**；`:421` `effective_label = new_label if new_label is not None else old_label`（对称口径，防新标签为空把旧标签覆盖成 NULL）；`:433`/`:443` 用 `effective_label` 做比较与赋值。

4. **period_label 定位**：`dividend_period.py:166-167` OTHER 分支位于 `SPECIAL` 之后、`ANNUAL or quarter==4` 之前；`:157-158` 注释为该顺序硬约束（若排在之后，`OTHER`+`quarter==4` 会被回退误产「YYYY年报」，分支不可达）。

5. **聚合 WARN 口径（R1）**：`dividend_notice_scan.py:272-279` 聚合 WARNING 总量读 `stats["unknown_label"]`（随快照 rollback，口径与摘要一致），不再直读私有 `Counter`。

6. **测试 R2–R5 落地**：
   - R2 摘要片段：`test_dividend_notice_scan.py:290/353/375/821` 等断言 `stats["unknown_label"]`、`test_dividend_seed.py:520` seed 侧聚合 WARN。
   - R3 caplog 钉 logger：`test_dividend_notice_scan.py:960-996` 断言聚合 WARN 仅出现一次，且 `:968` `caplog.set_level(logging.WARNING, logger="app.services.dividend_notice_scan")` 钉死 logger（避免 root logger 进程级可变状态跨测试污染）；seed 侧 `test_dividend_seed.py:528` 钉 `app.services.dividend_seed`。
   - R4 唯一键 4 列：`test_dividend_notice_scan.py:1000-1020` 直查 `information_schema` 确认 `uq_security_dividends_master_period` = `{master_id,report_year,report_quarter,period_type}`，不含 `dividend_label`。
   - R5 两入口键集相等：`test_dividend_notice_scan.py:1024-1033` 断言 `set(scan._STATS_KEYS) == set(seed._STATS_KEYS)` 且含 `unknown_label/collision/no_period/skip`。

7. **静态 + 行数**：`ruff` 0 问题；`git diff --numstat` 加总 507 行 ≤ 800。

8. **全量回归（最终闸门）**：后台任务 `YU8mle` 跑完整 `pytest` —— **697 passed, 3 xpassed, 0 failed**（424.78s）。`xpassed` 为既有 xfail 标记用例实际通过（非新增），无新增失败。

---

## 未裁决项（保留供 owner 逐项拍板）

> 依交付约定：未裁决项**必须保留并列出**（ID + 选项 + 建议 + 依据），不得删除、不得只留行动清单。

### U1 · L2 缺陷：`_westward_dup` 去重护栏未做 source 作用域 —— ✅ 已裁决 ③ 单独立项
- **现状**：`dividend_notice_scan.py:423` 注释「去重护栏只作用于『未命中目标格』的新增路径」；`_westward_dup` 仅按 `(mid, ex_date, year, quarter, cash)` 判重，**未含 source**。撞键护栏（命中路径）与之正交。
- **✅ 已裁决（2026-09-22）：③ 单独立项。** 理由：与已验证的撞键护栏正交，混入 A 需重新走验证闸门、污染 70 测试已锁定的回归基线；且语义未定（跨 source 是否判重）不应在 A 内拍脑袋。
- **后续动作**：单独立项时先确认「跨 source 同 ex_date 是否应视为同一笔」语义，再决定加 source 维度或保持现状。

### U2 · 前端 TS 联合类型补 `'OTHER'`（batch D）— ✅ 已实施（`1cc9b98`）
- `period_type` 前端联合类型需补 `OTHER` 分支，否则类型收窄会丢 OTHER（前端页 batch D 一并处理）。非 A 阻塞。
- **落地**：`web/src/api/dividend-yield.api.ts:61` 补 `| 'OTHER'`；`vue-tsc --noEmit`（web lint）通过。`periodType` 全仓仅 4 处消费（`SecurityDetailPanel.vue:74` 的 `:key` 插值 + 测试字面量），无收窄逻辑，无需改消费侧。

### U3 · `_KNOWN_LABELS` 私有符号跨模块导入（batch B）— ✅ 已实施（`02dacbe`）
- `dividend_notice_scan.py:45` 导入 `dividend_cninfo_parse._KNOWN_LABELS`（私有）。建议 batch B 升为公开常量或显式导出，消除跨模块私有依赖。
- **落地**：升为公开常量 `dividend_cninfo_parse.KNOWN_LABELS`，同步 `dividend_notice_scan.py` 导入与 `:391` 使用点；MCP 索引核验代码中 `_KNOWN_LABELS` 零残留。

### U4 · `parse_cninfo_row` 死代码（batch E）— ✅ 已实施（`02dacbe`）
- 旧 `parse_cninfo_row` 已被 `parse_cninfo_row_ex` 取代，建议 batch E 清理。
- **落地**：删除 `dividend_cninfo_parse.parse_cninfo_row` 薄包装；测试 3 处调用改 `parse_cninfo_row_ex(...)[0]`（保留 `dividend_label` 透传/空值/截断断言，不丢覆盖），`dividend_seed` docstring 引用同步更正。受影响测试 51 passed、ruff(F) clean；MCP graph 已无 `parse_cninfo_row` 函数节点。

### U5 · 存量 `QUARTERLY(未知标签)` 行归并（batch B）— ⚠️ 已消解 / N/A（owner 2026-09-22 清库）
- 原决策对象：迁移前存量数据中 `period_type=QUARTERLY` 但 label 未收录的行，是否归并/回填 `dividend_label`。batch B 决策。
- **消解原因**：`dividend_label` 是 `SecurityDividend` 列（models/dividend_yield.py:102），随旧分红行一并删除；旧分红数据已清空 → 目标行不复存在，无可归并对象。
- **复发护栏**：L1 解析修复（5 标签 dict + OTHER + `unknown_label` 计数桶，`dividend_cninfo_parse.py`）使新采集数据不再产生「未知标签→QUARTERLY 兜底」行；即便重新 19h 播种，新行亦带规范标签 → 不产生新 U5 群体。
- **结论**：无需裁决；batch B 不再含 U5。保留条目作审计留痕。

> U2/U3/U4 已实施（`1cc9b98` / `02dacbe`），U5 已消解（数据清空）；均非批次 A 放行阻塞。

---

## 需 owner 执行的事项（拍板后动手做）

- **A1**：✅ 已裁决 **③ 单独立项**（2026-09-22）；后续立项时先定「跨 source 同 ex_date 是否判重」语义，不在 A 内改。
- **A2**：✅ 已提交 —— 按项目约定由 `senior-dev <dev@local>` 以 Conventional Commits 提交（本地 commit，不自动 push），feat 与 docs 拆分两笔。
- **A3**：✅ 全量回归已确认 —— `YU8mle` 实测 **697 passed / 3 xpassed / 0 failed**，可合入（本环境 conftest 会 session 级 DROP/CREATE 测试库，多个 pytest 进程会互毁，须串行）。
- **A4**：✅ 已吸收 —— U2（batch D，`1cc9b98`）、U3（batch B）、U4（batch E）同批落地（`02dacbe`）；U5 已消解（数据清空）；L2 已单独立项（`89c666e`）。

---

## 免责声明（Disclaimer）

本报告结论基于工作树（已提交本地）的静态核查 + 定向测试（70 passed）+ `ruff` 零告警 + 2 项只读自检 + 行数闸门（507≤800）+ 全量回归实测（697 passed / 3 xpassed / 0 failed，424.78s）。

已知约束不在本报告消解范围内：
- 迁移 `0033` **非原子**（ALTER TYPE 与加列分两段事务），依赖 `IF NOT EXISTS` / 可重入自愈（见迁移 docstring）。
- PG 枚举 `OTHER` 排序依赖「定义顺序 = 排序顺序」，已通过末尾追加保证；downgrade 对枚举值 **no-op**（PG 不支持 DROP VALUE）。
- 结论不构成生产环境保证；上线前仍须走项目既有 CI 闸门（覆盖率 / knip / import-linter / check_line_budget）。
- 本地提交未 push；如需推送，走 `dev-scripts/push-all.ps1` 或提供 `CNB_TOKEN`。
