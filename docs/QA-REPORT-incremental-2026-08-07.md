# QA 测试报告 — 投资收益统计系统 增量 I-01~I-06（2026-08-07）

> **QA**：严过关（Edward）｜**被测提交**：`79f5d12`（I-01~I-06 增量开发，42 files, +3268/-732）+ `7f84906`（QA 第 1 轮 Bug 修复）
> **范围**：全量回归（A）+ 新功能逐条验收（B）+ 智能路由判定（C）
> **测试轮次**：第 1 轮（发现 1 个源码 Bug → 路由 Engineer，提交 7f84906 修复）→ 第 2 轮（全量回归验证）
> **最终判定**：✅ **NoOne**（两轮收敛，全量通过）
> **环境**：pnpm monorepo（backend/finance-core/shared/web）；后端 Jest 24 套件；前端 Vitest 38 文件；prisma 全量 mock，不触库

---

## 1. A 全量回归结果

| 项 | 结果 |
|----|------|
| 后端全量 jest | ✅ **24 套件 / 595 通过 / 0 失败**（基线 572 + 本次新增 23） |
| 前端全量 vitest（第 2 轮） | ✅ **38 文件 / 485 通过 / 0 失败**（基线 460 + 本次新增 25；另修复 2 个过期用例） |
| A.2 计算链路零改动回归 | ✅ dividend/fee 模块**无任何** `recalculateRange` / `recalculateNavRange` / `RecalculationService` / `CalculationModule` 引用（代码 grep + `dividend-fee-acceptance.spec.ts` DI 实锤 + 模块元数据实锤）；REG-01~06 对应 spec（snapshot/recalculation/nav/caliber-consistency 等）全部通过 |
| A.3 数据隔离双闸（C-3） | ✅ 分红/费用/偏好接口 `user_id` + 组合归属双闸：7 个端点越权一律 404、跨组合挂载标的 404、偏好默认组合校验，用例全过 |

> 注：`api-client.test.ts` 3 个用例在第 1 轮全量并发时偶发 5s 超时，单独运行 7/7 通过、第 2 轮全量 7/7 通过且未复现 —— 判定为**测试隔离性抖动**（jsdom XHR 并发干扰），非源码问题，见遗留问题 #1。

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
| **HoldingsPage 偏好对齐 effect 2 range 弹回** | **Engineer（已修复 7f84906）** | 源码 Bug，违反 I-04 验收 2/3 + I-05 验收 5；第 2 轮全量回归通过 |
| 其余全部 | **NoOne** | 全量通过 |

**第 2 轮最终判定：NoOne**（后端 595/595 + 前端 485/485 全部通过；遗留问题均为已知偏差/抖动登记）。

---

## 4. 第 1 轮发现并修复的问题（Engineer · commit 7f84906）

**Bug**：`packages/web/src/pages/HoldingsPage.tsx` 偏好对齐 effect 2（约 113~122 行）
- 现象：用户在统一筛选器选择快捷范围（如 1m）后状态被弹回偏好默认（1y），URL 不写入 range
- 根因：`hasRangeParam` 用 `[]` 依赖挂载固化 + effect 依赖 `holdingsQuery.range` → 每次用户改 range 都触发对齐重置
- 修复：新增 `rangeInteractedRef` / `closedInteractedRef` 用户交互守卫；统一筛选器变更统一走 `handleFilterChange(patch)`（凡含 `range/from/to` 或 `closed` 即置对应 ref）；偏好对齐 effect 加 `if (hasRangeParam || rangeInteractedRef.current) return;` → 只在「偏好异步到达、URL 无对应参数、用户尚未主动操作」时执行一次。**顺带修复同型隐患 closed（显示已清仓）**（QA 第 1 轮提醒的潜在模式）
- 回归验证：`holdings-unified-filter.test.tsx` 7/7 通过（含「用户选择 1m → URL 写入 range=1m 不被弹回」断言）；第 2 轮全量 485/485 通过

---

## 5. 遗留问题清单（Known Issues / 登记）

1. **[登记·抖动]** `api-client.test.ts` 3 用例（FormData/Content-Type）在第 1 轮全量并发时偶发 5s 超时；单独运行 7/7、第 2 轮全量 7/7 均通过。建议后续将 `vi.resetModules()` 改 per-file 隔离或配置 `fileParallelism` 以根治（非本次增量引入）。
2. **[已修复]** `HoldingsPage.tsx` closed（显示已清仓）偏好对齐潜在弹回 —— 工程师在 7f84906 中用 `closedInteractedRef` 一并修复，已闭环。
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

> 说明：`holdings-unified-filter.test.tsx` 为 QA 维护的验收测试文件（7 用例覆盖 B.4 全部验收维度）。工程师在修复提交中以 2 用例版本覆盖了该文件，QA 已恢复 7 用例综合版本（工作区未提交变更，含 Bug 回归断言），两者语义一致、均通过。

---

## 第 3 轮：遗留修复与文档归并验证（2026-08-07）

> **被测提交**：`cb889e9`（遗留#1 api-client 并发抖动根治 + 遗留#3 React key 警告）+ `159ba63`（增量 PRD 并入主 PRD v3.3.0 + 新登记 SET-P2-05）+ `65dda5a`（增量架构并入主架构 v2.8 + ADR-003/004 + 修正 3 处文档-代码不一致）
> **范围**：A 遗留修复有效性（含独立复现）+ B 文档归并一致性抽查 + C 路由判定
> **最终判定**：✅ **NoOne**（遗留 #1/#3 已闭环）｜附 1 项新登记观察项（**Engineer · P2 非阻塞**）+ 3 项 **Doc** 级溯源勘误

### 7.1 A.1 遗留#1 修复方案代码审查（是否根治 vs 掩盖）

| 审查项 | 结论 | 证据 |
|--------|------|------|
| 是否存在 skip / todo / only / 删用例掩盖 | ✅ **无** | 全仓 grep `.skip`/`.todo`/`.only`/`xit(`/`xdescribe(` 于 `packages/web/src/**/*.{test,spec}.{ts,tsx}` **命中 0**；`git show cb889e9 -- api-client.test.ts` 仅改 `send()` 与 `afterEach/afterAll`，**7 个用例一个未删、断言未弱化** |
| 微任务改造是否真正去除定时器依赖 | ✅ **是** | `api-client.test.ts:79` `void Promise.resolve().then(() => this.onloadend?.())` 取代 `setTimeout(...,0)`；FakeXHR 内已无任何定时器 |
| `testTimeout: 10000` 是否属于掩盖 | ✅ **否，仅保险** | **决定性实验**：以修复前原始条件 `--pool=threads --testTimeout=5000`（默认全并发 + 原 5s 超时）跑全量 → **485/485 通过、超时失败 0**，`api-client.test.ts` 7/7（文件合计 4857ms）。**在原始超时值下即已通过**，故 10s 非掩盖 |
| `singleFork` 串行是否才是"藏住"抖动的原因 | ✅ **否** | 同上实验在 **threads 全并发**下 api-client 7/7 通过（10s 档 6582ms / 5s 档 4857ms，均无超时），说明微任务改造**本身**已根治，不依赖串行 |
| `singleFork` 串行耗时是否可接受 | ✅ **可接受（反而更快）** | forks+singleFork 实测 20.67~33.98s；threads 全并发实测 32.57~36.01s。本机串行**不劣于**并行，无不可接受的耗时代价 |
| 隔离性还原是否完整 | ✅ **完整** | `afterEach` 用 `try/finally` 还原全局 XHR + 置空 `restoreXHR` + `vi.useRealTimers()` + `vi.clearAllMocks()`；`afterAll` 兜底 double-check 全局 XHR 已还原 |

> **A.1 结论：遗留#1 属于「真正根治」，非掩盖。** 根因定位（真实定时器被并发事件循环饿死）与修复手段（改微任务，完成时机确定）逻辑自洽，并已由「原始条件复现实验」实证。

### 7.2 A.2 独立复现验证（web 全量 · 5 次运行）

| # | 配置 | 测试文件 | 通过数 | vitest 耗时 | 失败/超时 |
|---|------|---------|--------|------------|-----------|
| 1 | 仓库配置（forks + singleFork + 10s） | 38 | **485/485** | **22.13s**（wall 47.4s） | 0 / 0 |
| 2 | 同上 | 38 | **485/485** | **20.67s** | 0 / 0 |
| 3 | 同上 | 38 | **485/485** | **33.98s** | 0 / 0 |
| D1 | `--pool=threads`（对照） | 38 | **485/485** | **36.01s** | 0 / 0 |
| D2 | `--pool=threads --testTimeout=5000`（**还原修复前原始条件**） | 38 | **485/485** | **32.57s** | 0 / 0 |

- **5 次全绿、0 失败、0 超时、0 抖动**，工程师所报 485/485 与 16~28s 量级**核实属实**（本机 20.67~33.98s，波动来自机器负载）。
- `api-client.test.ts` 三档配置均 7/7：forks 197ms / threads-10s 6582ms / threads-5s **4857ms**。

### 7.3 A.3 后端全量回归（595 基线）

| 项 | 结果 |
|----|------|
| `npx jest` 全量 | ✅ **24 套件 / 595 通过 / 0 失败**，49.4s，退出码 0 |
| 与第 2 轮基线对比 | ✅ **595 → 595，零退化** |

### 7.4 A.4 遗留#3（React key 警告）验证

| 项 | 结果 |
|----|------|
| 修复位置 | `packages/web/src/features/security-income/dividend-fee-section.tsx:572` —— 聚合明细行改用本地复合 key `${securityId}-${date}-${scenario}-${type}`，不再依赖后端 `mergeKey` |
| 警告检索 | ✅ **5 份完整运行日志合计命中 0 次** `Each child in a list should have a unique "key"` |
| 相关测试 | ✅ `dividend-fee-section-merged`(5) / `dividend-fee-form-fee-scenario`(3) / `dividend-fee-tax`(11) / `dividend-fee-acceptance`(18) / `holdings-dividend-fee`(28) / `dividend-fee-no-recalc`(7) **全部通过** |
| 残留 console 警告 | 仅 2 条 React Router v7 future-flag 提示（既有、与本次无关） |

> **A.4 结论：遗留#3 已闭环。**

### 7.5 B 文档归并一致性抽查

**B.1 架构师自称修正的 3 处不一致 —— 逐项核对（均属实）**

| # | 修正项 | 文档 | 代码实况 | 结论 |
|---|--------|------|---------|------|
| 1 | `DividendRecord.tax` 补回 | ARCH §3.1 schema 含 `tax Decimal @default(0) @db.Decimal(18,2)` | `prisma/schema.prisma:237` 完全一致；`shared/types/dividend.ts:41` `tax: string` | ✅ 属实 |
| 2 | `PATCH /dividends/:id` 补回 | ARCH §4.2.18 新增该行 | `dividend.controller.ts:70` `@Patch(':id')` 存在 | ✅ 属实 |
| 3 | `HoldingsQueryState`→`HoldingsFilterState` 改名 | ARCH §10.1.6 已改名 | 全仓 grep：`HoldingsFilterState` 13 处，**`HoldingsQueryState` 0 残留** | ✅ 属实 |

**B.1 续：§4.2.19 费用记录 与 §10.1.8 前端架构要点 抽查**

| 抽查点 | 文档主张 | 代码实况 | 结论 |
|--------|---------|---------|------|
| §4.2.19 GET /fees 参数 | `securityId`多值 / `scenario` / `startDate` / `endDate` / `grouped=1` | `fee.controller.ts:53-72` 五参数齐备且语义一致 | ✅ |
| §4.2.19 PATCH /fees/:id | 可改 `securityId/date/amount/type/scenario/note`，双闸 | `fee.controller.ts:85` + `fee.service.ts:338-343` 一致 | ✅ |
| §4.2.19 展示层聚合（非物理合并） | 合并键聚合、`transactionIds[]`、明细行保留 | `fee.service.ts:203-239` `groupByMergeKey` 纯函数；schema **无 `@@unique`** | ✅ |
| §3.2.5 `FeeScenario` + 索引 | `enum{BUY,SELL}`、`@default(BUY)`、`@@index([portfolioId,scenario,date])` | `schema.prisma:259/266-269/273-276` 全部一致 | ✅ |
| §10.1.8(a) `QUICK_RANGE_OPTIONS` 单一真相源 | 全站唯一、7 项、无第二份数组 | 唯一定义 `dimension-switcher.tsx:49`；`DATE_RANGE_OPTIONS` 仅剩注释 | ✅ |
| §10.1.8(a) 反模式守卫 | `rangeInteractedRef`/`closedInteractedRef` + effect 守卫 | `HoldingsPage.tsx:102,103,112,115,126,138` 与文档描述**逐行吻合** | ✅ |
| §10.1.8(b) 统一筛选器 | `HoldingsToolbar` 原地升级、`useUrlState` 单一来源、不新增 store | `HoldingsPage.tsx:94-95` + `holdings-toolbar.tsx` 一致 | ✅ |

**B.2 PRD v3.3.0 验收标准 vs 实际交付形态（4 个重点口径）**

| 口径 | PRD 表述 | 结论 |
|------|---------|------|
| I-03 展示层聚合 | `HOLD-B-P0-10` 验收 10：🔴「**费用合并 = 展示层聚合，非物理合并**」「不建数据库唯一约束、不做累加 upsert」 | ✅ **正确**，与交付形态一致 |
| I-02 净额后端计算 | 验收 5：「净额 = 金额 − 所得税，**由后端 `toResponse()` 统一计算**并随响应返回、不落库」 | ✅ **正确**（`dividend.service.ts` netAmount 后端算） |
| I-04 优先级链 | `SET-P0-02` 验收 9：「**URL 参数 > 用户偏好 > 系统默认 `1y`**」 | ✅ **正确** |
| I-05 as-of 与日期范围口径独立 | `HOLD-B-P0-11`：🔴「**as-of 与日期范围为两套独立口径，互不换算**」+ 验收 6 三板块联动表 | ✅ **正确** |

**B.3 归档状态**

| 项 | 结论 |
|----|------|
| `docs/archive/PRD-incremental-2026-08-07.md` | ✅ 存在（`git mv` 保留历史） |
| `docs/archive/ARCHITECTURE-incremental-2026-08-07.md` | ✅ 存在 |
| `docs/` 根目录不再有这两个文件 | ✅ 已确认（根目录仅余 ARCHITECTURE / PRD / 两份 CHANGELOG / COVERAGE-MATRIX / ENVIRONMENT-SETUP / 本报告） |

**B.4 新增 ADR 与实际决策一致性**

| ADR | 抽查结论 |
|-----|---------|
| ADR-003 费用合并=展示层聚合 | ✅ **一致**。方案 B 描述的合并键、`FeeGroupedRow` 字段、排序 `date desc→scenario→type→securityCode` 与 `fee.service.ts:203-238` 完全对应；"否决方案 A"与 schema 无 `@@unique` 互证 |
| ADR-004 日期范围默认值 + **偏好对齐守卫反模式警示** | ✅ **一致且准确**。§2.3「错误做法（第 1 轮 Bug）」对 `hasRangeParam` 挂载固化 + 依赖 `holdingsQuery.range` 的描述，与我第 1 轮所报 Bug（本报告 §4）**完全吻合**；§2.3「正确做法」代码片段与 `HoldingsPage.tsx:138` 实现一致。SET-P2-05 前提亦核实属实（`ExportType` 确为 7 类、无 FEES） |

### 7.6 剩余遗留清单（更新）

> ⚠️ **编号口径说明**：本报告 §5 原始编号为 #1 抖动 / #2 closed已修复 / #3 导出无FEES / #4 React key；下游（commit message、PRD-CHANGELOG）使用的是**剔除已修复项后的重编号**（#1 抖动 / #2 导出→SET-P2-05 / #3 React key）。下表按**下游编号**登记并标注原编号，避免歧义。

| 下游编号 | 原编号 | 问题 | 状态 |
|---------|--------|------|------|
| **#1** | §5-1 | `api-client.test.ts` 3 用例全量并发偶发 5s 超时 | ✅ **已闭环**（`cb889e9` 微任务改造；5 次独立复现全绿，含还原原始条件的决定性实验） |
| **#2** | §5-3 | 费用导出缺 `scenario` 列（`ExportType` 无 FEES 类别） | 🔁 **已转 P2 需求 `SET-P2-05`**，由产品侧跟进（PRD.md:900 / COVERAGE-MATRIX:343 已落位登记）；QA 不再跟踪 |
| **#3** | §5-4 | `DividendFeeSection` React key 警告 | ✅ **已闭环**（`cb889e9` 本地复合 key；5 份日志 0 命中） |
| — | §5-2 | `closed` 偏好对齐潜在弹回 | ✅ 已闭环（`7f84906`，本轮 `closedInteractedRef` 复核仍在位） |
| **#4** | 🆕 本轮新登记 | **web 全量测试「测试全绿但进程不退出」** | ⚠️ **观察项（P2，非本次引入）**，详见 §7.7 |

### 7.7 🆕 遗留#4：web 测试进程退出挂起（新登记 · 非本次引入）

- **现象**：`vitest run` 全部用例跑完并打印 `485 passed (485)` 后，**进程不退出**，需外部终止。本轮 5 次运行中 **4 次复现**（仅第 1 次正常退出，wall 47.4s）。
- **影响**：本地/CI 会一直挂到作业超时；**不影响测试结论**（结果已完整落盘，通过数与耗时均可读取）。
- **归因（已排除本次修复）**：以 `--pool=threads`（即 `cb889e9` 之前的默认池）复现**同样挂起** → **与 `pool:'forks'` / `singleFork` 无关，非 `cb889e9` 引入**，属既有环境/teardown 特性（本机另有 Node 22 spawn EPERM 历史，见 revert commits `b6ba113`/`0472356`）。后端 Jest 退出正常，backend 不受影响。
- **建议（非阻塞）**：Engineer 可评估在 `vitest.config.ts` 增加 `teardownTimeout` 或 CI 层加 `--bail`/超时兜底；或排查持有句柄的用例（日志中 `Not implemented: navigation` 提示部分用例触发 jsdom 导航）。

### 7.8 C 智能路由判定（第 3 轮）

| 事项 | 判定 | 说明 |
|------|------|------|
| 遗留#1 api-client 并发抖动 | **NoOne** | 已根治并经 5 次独立复现 + 原始条件决定性实验验证 |
| 遗留#3 React key 警告 | **NoOne** | 已闭环，0 命中 |
| 后端 595 基线 | **NoOne** | 595/595 零退化 |
| 文档 3 处修正 + §4.2.19 + §10.1.8 + PRD 4 口径 + 归档 + ADR-003/004 | **NoOne** | 抽查项**全部属实**，无实质性文档-实现不符 |
| **web 测试进程退出挂起（遗留#4）** | **Engineer（P2 · 非阻塞 · 非本次引入）** | 见 §7.7；不阻塞交付 |
| **文档溯源勘误 3 项（不影响行为）** | **Doc** | 见下表 |

**Doc 级勘误（均为路径/措辞溯源问题，不影响任何功能与验收结论）**

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| D-1 | `docs/PRD.md:900`（SET-P2-05） | 引用路径 `packages/backend/src/modules/export/export-schemas.ts` **不存在**；且 `ExportType` 实际定义在 `packages/shared/src/types/data-transfer.ts:22`，并非 `export-schemas.ts` | 改为 `packages/backend/src/modules/data-transfer/csv/export-schemas.ts`，并注明 `ExportType` 定义于 shared |
| D-2 | `docs/ARCHITECTURE.md:1079` | 引用 `data-transfer/export-schemas.ts`，**缺 `/csv/` 层级** | 补为 `data-transfer/csv/export-schemas.ts` |
| D-3 | `docs/ARCHITECTURE.md` §10.1.8(a) | 称"各页将其（`use-default-date-range`）作为 `useUrlState` 默认值"，但**概览页 `dashboard.tsx` 未用该 hook**，走 `usePreferenceStore.getPreference('defaultDateRange')`（:238）。实际 hook 接入 6 处 + dashboard 1 处 = **7 处**，文档"8 处"中第 8 处为前瞻性占位 | 措辞补一句"概览页经 `preference.store` 直接取值，等价生效" |

> 附：ADR-003 / ARCH §4.2.19 称合并键含 `portfolioId`，实现 `fee.service.ts:207` 的 key 串为 `securityId|date|scenario|type`（`portfolioId` 由查询作用域隐含）—— **语义等价**，仅作说明，无需修改。

### 7.9 第 3 轮结论

✅ **NoOne** —— 遗留 **#1 / #3 已闭环**，**#2 已转 P2 需求 `SET-P2-05`** 由产品侧跟进；后端 595/595、前端 485/485 五次全绿零抖动；文档归并抽查全部属实。另附 1 项非阻塞观察项（遗留#4，Engineer P2）与 3 项 Doc 级溯源勘误，**均不影响本次交付验收**。

---

*QA 严过关 · 2026-08-07（第 3 轮收尾验证）*
