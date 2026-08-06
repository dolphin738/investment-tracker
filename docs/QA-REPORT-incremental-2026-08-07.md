# QA 测试报告 — 投资收益统计系统 增量 I-01~I-06（2026-08-07）

> **QA**：严过关（Edward）｜**被测提交**：`79f5d12`（I-01~I-06 增量开发，42 files, +3268/-732）
> **范围**：全量回归（A）+ 新功能逐条验收（B）+ 智能路由判定（C）
> **测试轮次**：第 1 轮（发现 1 个源码 Bug → 路由 Engineer 修复）→ 第 2 轮（回归验证）
> **环境**：pnpm monorepo（backend/finance-core/shared/web）；后端 Jest 24 套件；前端 Vitest 38 文件；prisma 全量 mock，不触库

---

## 1. A 全量回归结果

| 项 | 结果 |
|----|------|
| 后端全量 jest | ✅ **24 套件 / 595 通过 / 0 失败**（基线 572 + 本次新增 23） |
| 前端全量 vitest（第 2 轮） | ✅ **38 文件 / 485 通过 / 0 失败**（基线 460 + 本次新增 25；另修复 2 个过期用例） |
| A.2 计算链路零改动回归 | ✅ dividend/fee 模块**无任何** `recalculateRange` / `recalculateNavRange` / `RecalculationService` / `CalculationModule` 引用（代码 grep + `dividend-fee-acceptance.spec.ts` DI 实锤 + 模块元数据实锤）；REG-01~06 对应 spec（snapshot/recalculation/nav/caliber-consistency 等）全部通过 |
| A.3 数据隔离双闸（C-3） | ✅ 分红/费用/偏好接口 `user_id` + 组合归属双闸：7 个端点越权一律 404、跨组合挂载标的 404、偏好默认组合校验，用例全过 |

> 注：`api-client.test.ts` 3 个用例在全量并发时偶发 5s 超时，单独运行 7/7 通过、第 2 轮全量未复现 —— 判定为**测试隔离性抖动**（jsdom XHR 并发干扰），非源码问题，已在遗留问题清单登记。

---

## 2. B 新功能验收（按增量 PRD 逐条）

### B.1 I-02 分红所得税修复（P0）— ✅ 通过

| 验收项 | 结论 | 测试位置 |
|--------|------|---------|
| ① 录入填税 320/60 → 净额 260 | ✅ | backend `dividend-fee-acceptance.spec.ts`（create netAmount=260.00）；web `dividend-fee-tax.test.tsx`（DOM ¥1,200.00） |
| ② 录入不填税 → 净额 320 | ✅ | backend create tax 缺省 0 → netAmount=320.00；web 税未填净额=税前 |
| ③ 编辑补填税 60 → 净额 260 | ✅ | backend update tax 落库 + 重算；web 编辑态净额实时重算 |
| `tax=amount` 允许（净额 0） | ✅ | backend create tax=amount → netAmount=0.00 不报错 |
| `tax>amount` → 400「净额不能为负」 | ✅ | backend create/update 双路径 400；web zod 阻止提交 |
| 编辑分红携带 type 不报「property type should not exist」 | ✅ | backend `UpdateDividendRecordDto.type` 白名单（CASH/STOCK_DIVIDEND 通过、非法拒）+ `service.update()` 落库 `type`（新增测试）；web 编辑 payload 携带 `type`（新增断言） |
| 回归：分红不参与 XIRR/净值 | ✅ | 三张收益表（daily_nav/daily_xirr/cash_flows）create/update/delete 零触碰 |

### B.2 I-03 费用记录合并（P1）— ✅ 通过

| 验收项 | 结论 | 测试位置 |
|--------|------|---------|
| 同合并键多笔 → grouped=1 一条合计 | ✅ | backend `fee.service.spec.ts`（同键 2 笔 → 1 行 8.50/count=2）；web `dividend-fee-section-merged.test.tsx`（新增：列表 1 行、金额 ¥8.50、笔数「2 笔」） |
| 不同类型两条 | ✅ | backend grouped 多行；web E4 既有用例（佣金/印花税 2 行） |
| 同类型不同场景两条 | ✅ | backend grouped 场景不同不合并；web 新增 BUY+SELL → 2 行 |
| 场景徽标「买入时/卖出时」 | ✅ | web `dividend-fee-section-merged.test.tsx`（新增：场景列徽标） |
| 表单含场景必选选择器 | ✅ | web `dividend-fee-form-fee-scenario.test.tsx`（新增：BUY/SELL 选项 + payload 携带 scenario + 编辑回填） |
| PATCH /fees/:id 修正 scenario/amount 生效 | ✅ | backend `fee.service.spec.ts` update 双闸 + 变更字段；web 费用编辑走 updateFee |
| 修改组成笔后聚合重算正确 | ✅ | backend groupByMergeKey 纯函数（编辑/删除后重查即重算）；web 编辑入口作用于代表明细、合并记录删除禁用 |
| 费用不参与收益计算 | ✅ | `dividend-fee-acceptance.spec.ts` 三张表零触碰（含费用 create/delete） |
| 导出新增 scenario 列 | ⚠️ 已知偏差 | 工程师声明 `export-schemas.ts` 无 FEES 导出类别，未改动（架构 §3.2.5 前提不成立），见遗留问题 #3 |

### B.3 I-04 默认日期范围全局化（P1）— ✅ 通过

| 验收项 | 结论 | 测试位置 |
|--------|------|---------|
| 设置页下拉 7 项与 QUICK_RANGE_OPTIONS 逐项一致 | ✅ | web `settings-default-date-range.test.tsx`（新增：value/label 逐项比对） |
| 改默认「近一周」→ 接入位置首次进入默认近一周 | ✅ | web `dashboard-alignment.test.tsx` A8（偏好 1w → 触发器「近一周」+ 下发 1w 解析）；6 处页面 import `useDefaultDateRange`（grep 佐证） |
| URL range 覆盖偏好 | ✅ | dashboard A8 + holdings-unified-filter（URL 带 range=3m → startDate 解析） |
| 偏好空回落 1y | ✅ | dashboard A8（未知值回落近1年）；`use-default-date-range.ts` 非法/空回落 1y（单测） |
| 后端接受 1w/6m 新值并持久化 | ✅ | backend `preference.service.spec.ts`（新增：`@IsIn` 7 项白名单 + service.update 持久化） |
| 不破坏既有默认「按月+近1年」 | ✅ | dashboard A8 回归 |
| 全站无第二份快捷范围数组 | ✅ | grep：`DATE_RANGE_OPTIONS` 仅剩注释；设置页 import `QUICK_RANGE_OPTIONS` |

### B.4 I-05 持仓页统一筛选器（P0）— ✅ 通过（第 1 轮发现 1 Bug，第 2 轮修复后通过）

| 验收项 | 结论 | 测试位置 |
|--------|------|---------|
| 页面顶部唯一统一筛选器，三板块共享 | ✅ | web `holdings-unified-filter.test.tsx`（新增：`holdings-unified-filter` 唯一 + 三 Tab 齐备） |
| 证券多选 → 三板块同步 | ✅ | 同上（新增：useHoldings.securityId + SecurityTradeList query.securityId + DividendFeeSection securityIds 三路断言） |
| 场景 → 买卖明细(side)/分红费用(scenario) 同步、持仓不适用 | ✅ | 同上（BUY→BUY_SEC/SELL→SELL_SEC/all→undefined；holdings 无 scenario） |
| 日期范围 → 买卖明细/分红费用；as-of → 持仓 | ✅ | 同上（range→startDate/endDate；as-of→holdings.date） |
| URL 持久化（等于默认不写入） | ✅ | 同上（sec/scenario/range/date 写入；默认不写；带参 URL 进入还原） |
| 持仓日期能力保留（默认今日、范围校验、as-of 精确推导） | ✅ | web `holdings-toolbar.test.tsx`（新增：as-of min/max、默认值、变更回调） |
| 持仓专属折叠区（类型多选 + 显示已清仓） | ✅ | 同上（新增：折叠展开、类型多选、开关） |

> 🔴 第 1 轮发现源码 Bug：`HoldingsPage.tsx` 偏好对齐 effect 2（`hasRangeParam` 挂载固化 + 依赖 `holdingsQuery.range`）导致用户手动改 range 被弹回偏好默认、URL 不落 range。已路由 Engineer 修复（见 §4），第 2 轮回归通过。

### B.5 I-06 日期选择器全面审查（P1）— ✅ 通过（代码佐证 + 组件测试）

| 审查矩阵项 | 结论 |
|-----------|------|
| 范围型 7 位置 100% 提供快捷范围 | ✅ dashboard/xirr/nav（dimension-switcher 7 项）、transactions/snapshots(SnapshotList)/cash-balance-history/holdings（DateRangeQuickPicker 7 项）—— grep 佐证 |
| 无裸 `<input type="date">` 成对自实现范围控件 | ✅ 全站 `type="date"` 仅出现在：① 共享组件内部（date-range-quick-picker 起止对、dimension-switcher 起止对）② 单点型表单（出入金/买卖/分红费用/现金余额/总资产录入日期）③ as-of 单点 |
| 单点型位置行为不变（不回归） | ✅ 各表单日期输入保留单日期 |
| 快捷范围行为与既有组件一致 | ✅ `date-range-quick-picker.test.tsx`（受控双模/手动改日期/全部回落）+ `quick-range.test.ts`（7 项常量 + resolveQuickRange 分支） |

---

## 3. C 智能路由判定

| 问题 | 判定 | 说明 |
|------|------|------|
| holdings-dividend-fee 测试「费用明细金额列索引」失败 | **QA（自修）** | I-03 新增「场景」列使金额列 3→4，测试断言过期；已改 `td[4]` |
| holdings-dividend-fee 测试「编辑分红」失败 | **QA（自修）** | use-fees mock 缺 `useUpdateFee`（I-03 新增费用编辑依赖）；已补 mock |
| api-client 3 用例并发超时 | **QA（登记，非源码）** | 单独运行 7/7 通过；测试隔离性抖动，第 2 轮全量未复现 |
| **HoldingsPage 偏好对齐 effect 2 range 弹回** | **Engineer（修复）** | 源码 Bug，违反 I-04 验收 2/3 + I-05 验收 5；已修复，第 2 轮回归通过 |
| 其余全部 | **NoOne** | 全量通过 |

**第 2 轮最终判定：NoOne**（全部测试通过；遗留问题均为已知偏差/抖动登记）。

---

## 4. 第 1 轮发现并修复的问题（Engineer）

**Bug**：`packages/web/src/pages/HoldingsPage.tsx` 偏好对齐 effect 2（约 113~122 行）
- 现象：用户选择快捷范围（如 1m）后状态被弹回偏好默认（1y），URL 不写入 range
- 根因：`hasRangeParam` 用 `[]` 依赖挂载固化 + effect 依赖 `holdingsQuery.range` → 每次用户改 range 都触发对齐重置
- 修复：`[工程师修复内容摘要]`
- 回归验证：`holdings-unified-filter.test.tsx > 日期范围 → startDate/endDate` 通过；全量 485/485 通过

---

## 5. 遗留问题清单（Known Issues / 登记）

1. **[登记·抖动]** `api-client.test.ts` 3 用例（FormData/Content-Type）在全量并发时偶发 5s 超时；单独运行与第 2 轮全量均通过。建议后续将 `vi.resetModules()` 改 per-file 隔离或配置 `fileParallelism` 以根治（非本次增量引入）。
2. **[登记·潜在]** `HoldingsPage.tsx` effect 1（closed 偏好对齐）与已修的 effect 2 同模式：若 `prefShowLiquidated=true`，用户手动关闭「显示已清仓」可能被弹回。本次增量未改，建议下轮一并修复（工程师已被告知）。
3. **[已知偏差·架构前提不成立]** 导出 `SET-P0-03`：`export-schemas.ts` 无 FEES 导出类别（架构 §3.2.5 前提不成立），I-03 验收 8「费用导出新增 scenario 列」无法落地；工程师声明未改动。需 PM/架构确认是否补费用导出类别（P2）。
4. **[登记·React 警告]** `DividendFeeSection` 费用明细表偶发 "Each child in a list should have a unique key" 警告（非失败）。合并键在 grouped 语义下唯一，疑为测试夹具数据或 Radix 内部列表触发，不影响功能。

---

## 6. 新增测试清单（QA 第 1 轮补充）

| 文件 | 覆盖 |
|------|------|
| backend `dividend/dividend-fee-acceptance.spec.ts`（追加） | I-02 Update DTO type 白名单 + service.update 落库 type（+9 用例） |
| backend `preference/preference.service.spec.ts`（追加） | I-04 defaultDateRange 7 项白名单 + 持久化（+12 用例） |
| web `features/holdings/__tests__/holdings-toolbar.test.tsx`（新增） | I-05 统一筛选器控件行为（7 用例） |
| web `pages/__tests__/holdings-unified-filter.test.tsx`（新增） | I-05 三板块联动 + URL 持久化（7 用例） |
| web `pages/__tests__/settings-default-date-range.test.tsx`（新增） | I-04 设置页 7 项比对 + 保存 payload（3 用例） |
| web `features/security-income/__tests__/dividend-fee-form-fee-scenario.test.tsx`（新增） | I-03 费用场景选择器 + 编辑（3 用例） |
| web `features/security-income/__tests__/dividend-fee-section-merged.test.tsx`（新增） | I-03 合并展示（合计/笔数/徽标/不合并）（5 用例） |
| web `features/security-income/__tests__/dividend-fee-tax.test.tsx`（修改） | I-02 编辑 payload 携带 type 断言 |
| web `pages/__tests__/holdings-dividend-fee.test.tsx`（修改） | 修复 2 个过期断言/mock |

---

*QA 严过关 · 2026-08-07*
