# 股息率排名 实施审查报告（第二轮）

- **日期**：2026-09-07
- **审查范围**：`cnb/main..main` 的 21 个未推送提交（~6650 行新增），对照《股息率排名管理方案》（`docs/股息率排名管理方案.md`，14 章 + 附录 A1–A15）逐项核对
- **验证方式**：取证式审查——逐文件读真实代码、`git diff` 核对、后端 5 个测试文件实测运行（**63 passed**，含工作树未提交的 P2-6 新测试）
- **关联文档**：第一轮审查 `docs/review-dividend-yield-implementation-2026-09-06.md`（HEAD 中存在，工作树已删除）

---

## TL;DR

1. **第一轮 26 项问题（5 P0 / 9 P1 / 12 P2）已验证修复 25 项**——后续 10 个修复提交真实落地，非纸面声明；复用红线（方案 §11.3）全部遵守，**未发现重复造轮子**。
2. 唯一例外：P2-6 的修复（排序扩 5 列）写在工作树**尚未提交**（`router.py` + `test_dividend_yield_api.py`）。
3. 本次深查新发现 **1 个 P0**（前后端路径不一致 → 曲线/反推价格必 404）、**4 个 P1**、7 项 P2，多数无测试守护。

---

## 新发现问题清单

### 🔴 P0-1｜曲线与反推价格前后端路径段序相反 → 必 404

- **前端** `web/src/api/dividend-yield.api.ts:59,70`：`/dividend-yield/curve/${masterId}`、`/dividend-yield/implied-price/${masterId}`
- **后端** `backend/app/modules/dividend_yield/router.py:252,315`：`/{master_id}/curve`、`/{master_id}/implied-price`（段序相反）
- **佐证**：前端文件头注释（L7-8）写的是**正确**路径，实现却写反——"裁决落地"声称已 grep 核验前端路径，实际核验失效。
- **守护缺失**：后端 `test_dividend_yield_api.py` 对 curve/implied **零覆盖**；前端测试 mock 的是 api 函数，两侧测试都拦不住。
- **修复建议**：前端 api 改为 `/dividend-yield/${masterId}/curve|implied-price`（与后端一致、与文件头注释一致），并补后端 curve/implied 路由测试 + 前端路径契约测试（一条测试即可拦住回归）。

### 🟡 P1-1｜`GET /settings` 收紧为 admin-only，偏离方案且致非 admin 标色全灰显

- `router.py:444` 用了 `require_admin`；方案 §9 表格明确 GET 用 `get_current_user`（仅 PUT 需 admin）。
- **后果**：`web/src/modules/dividend-yield/composables/use-yield-thresholds.ts:4` 自述"非 admin 无阈值 → 全部灰显"，方案 §10.2 阈值标色对普通用户整体失效。前端"自洽降级"掩盖了偏离。
- **修复建议**：GET 回 `get_current_user`（PUT 保持 admin），前端灰显逻辑随阈值可得自然恢复。

### 🟡 P1-2｜季末 guard 挡住手动触发，冷启动路径不可用

- `backend/app/services/dividend_sync.py:341`：季末 guard 对**所有触发源**生效，非季末日手动 trigger 直接跳过。
- 方案 §7 冷启动要求"首次上线手动 trigger 回补 5 年股息"——**方案与实现自相矛盾**（方案缺陷，实现照抄放大）。
- **修复建议**：`JobTriggerSource` 为手动时跳过 guard（或 cfg 加 `force` 标志）。

### 🟡 P1-3｜历史回补无生产入口 + 断点判定逻辑缺陷

- `backfill_historical` 全仓仅测试引用，无任务/端点调用：方案 §6.2 的"失败日补抓（扫描近 N 日缺失 trade_date）"**未实现**。
- 断点判定 `backend/app/services/market_daily_price_sync.py:275` 用 `max(trade_date) >= start_date` 跳过——若日线任务先跑了 30 天再想回补历史，每只证券 latest=today ≥ start_date → **全部误跳过**，中间历史空洞永不回填。
- **修复建议**：改为 `min(trade_date) <= start_date` 或按缺失日扫描。

### 🟡 P1-4｜`_mark_failure` 告警链路对 3/4 个采集源断裂

- raw 链路（`_call_interface_raw` → `_fetch_https_raw/_fetch_sdk_raw`）只含 `_guarded_fetch`（限速+重试）；`_mark_failure` 仅在 `_call_interface`（`market_data_sync.py:363`）调用。
- 四个新任务中**仅** notice_scan 公告源显式调了 `_mark_failure`（`dividend_notice_scan.py:114`）；东财主源、新浪补充源、行情源连续失败不累计 `consecutive_failures` → 方案 §6.5 要求的"≥3 发站内信"失效。

### 💭 P2 清单

| # | 问题 | 证据 |
|---|---|---|
| 1 | 东向去重是"二选一"而非方案 §6.1 的 OR 语义：SPECIAL 行 ex_date 不同但 (y,q,cash) 全等时漏删 | `dividend_sync.py:489-506`（西向 `_westward_dup` 两查并查是对的，两侧不一致） |
| 2 | 同格多行静默覆盖，方案 §12 要求"多行须告警"未实现 | `dividend_sync.py:426-481` 逐行 upsert |
| 3 | `curve` 的 `days` 无上限，可拉全量日线 | `router.py:257` `Query(365, ge=1)` 缺 `le` |
| 4 | `refresh_yields_for_masters` 每证券 3 查（N+1）；且无条件 `stale=False`，06:00 公告扫描重算会清掉 stale 直到 15:05 再判 | `dividend_sync.py:165-212` |
| 5 | 跨服务私有导入未收敛：router 导入 `dividend_sync._to_cell` | `router.py:41`（历史建议上提纯函数模块） |
| 6 | 行数超标：`dividend_sync.py` 606、`SettingsPage.vue` 920（>800 CI 硬线）、scheduler 443、notice_scan 441 | `wc -l` 实测 |
| 7 | `_parse_date` 与 `data_transfer.py` 仍重复 | 历史已知遗留 |

---

## 第一轮问题修复核验（抽样证据）

| 项 | 结论 | 证据 |
|---|---|---|
| P0-5 曲线末点契约 | ✓ | `dividend_yield.py:166-183` 锚点 `COALESCE(ex_date, announcement, 期末日)`，与快照同口径；d7903dd + 1aff14d 方案回修一致 |
| P0-2/3/4 五过滤参数 + 榜单规则 | ✓ | `router.py:116-249` 五过滤参数 + 过滤态现算（`filtered` 标注）、top20 剔近两年无分红 + suspicious、连续榜 `>=2` + 三元组 + `limit(20)` |
| P1-2 stale / P1-3 时区 / P1-9 NULLS LAST | ✓ | `update_stale_flags`（日历基准+降级+日志）、`APP_TZ` 四处接线、`0005` 迁移重建 DESC NULLS LAST 索引 |
| P2-1 防线二 | ✓ | 收紧为 `dates != {today}` 整批跳过（`market_daily_price_sync.py:178-188`）；seed 已配 `resp_date_field="30"` |
| P2-6 排序扩 5 列 | ⚠️ 已写未提交 | 工作树 `router.py` + `test_dividend_yield_api.py` 的未提交 diff |
| 测试 | ✓ | 5 文件 63 passed（含工作树未提交的 P2-6 新测试） |

---

## 建议修复顺序

1. **P0-1**：前端 api 改为 `/dividend-yield/${masterId}/curve|implied-price`，补后端 curve/implied 路由测试 + 前端路径契约测试。
2. **P1-2 + P1-3**：guard 放行手动触发；backfill 补生产入口 + 修断点判定。
3. **P1-1**：GET settings 回 `get_current_user`（PUT 保持 admin）。
4. **P1-4 + P2 清单**：三个源补 `_mark_failure`；其余按表清理。
5. 工作树的 P2-6 修复尽快提交（`fix(dividend-yield): 可排序列扩 5 列（P2-6）`），避免长期游离在版本控制外。
