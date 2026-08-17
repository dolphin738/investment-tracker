# Vue3 迁移对齐审查：概览页（Dashboard）

> 审查日期：2026-08-18
> 审查对象：`web/src/pages/dashboard.tsx`（React 源，799 行） vs `web-vue/src/modules/overview/pages/DashboardPage.vue`（Vue 目标，776 行）
> 配套文件：两端 `overview-query-params.ts`（各 72 行，逐字对齐）、`asset-metrics.ts` / `features/asset-metrics.ts`（8 卡构造器）、React 5 个 dashboard 测试 vs Vue 1 个 dashboard 测试
> 方法：逐区块通读两端源码 + 接口比对（子组件 props/emits、composable 签名、API 契约）+ 测试覆盖对账
> 性质：**先分析、后实现**（q-1 工作流）。本文档仅陈述审查结论与对齐方案，**不含代码改动**。

---

## 1. 总体结论

**web-vue 概览页与 web 概览页功能已高度对齐（≈ 98%），仅存 1 处实质功能缺口 + 1 处测试覆盖缺口。**

- ✅ **功能主体全部对齐**：版面骨架、8 指标卡（资产构成/收益表现分组）、趋势分析区（筛选栏 → 总资产 hero 图 → 四宫格）、全部早退分支、URL 持久化、偏好对齐守卫、ENTRY 录入按钮规格、新鲜度组件 —— 逐行核对一致（见 §3 对账表）。
- ⚠️ **1 处功能缺口（P1，改动极小）**：「录入买卖」弹窗在 Vue 中是**占位提示**（`证券买卖录入表单将在后续批次迁移`），React 挂载真实 `SecurityTradeForm`。**Vue 的 `SecurityTradeForm.vue` 早已存在**（`66313be` 起被证券买卖列表页编辑弹窗使用），接口 `portfolioId` prop + `success` emit 与 React 用法完全兼容 —— 只需在 DashboardPage 挂载即可闭合。
- ⚠️ **1 处测试覆盖缺口（P2）**：React 5 个测试文件（~40 用例）锁死概览页行为，Vue 仅 1 个测试文件 4 用例，关键行为（引导卡失败不伪装空态、快捷范围解析、组合对比 NaN 防护等）无回归保障。

---

## 2. React 概览页功能清单（目标契约）

数据与状态（全部经 URL `g/range/from/to` 持久化）：
| 数据源 | 用途 |
|---|---|
| `usePortfolios()` | 组合列表 + loading（无组合 → 欢迎空态） |
| `useUrlState(createOverviewSchema(默认粒度, 默认范围))` | g/range/from/to URL 状态 |
| `resolveQuickRange(range, { allRangeStart: baseDate })` | startDate/endDate；custom 用 from/to；all 以组合首日起点，无首日回落兜底 |
| `useRangePreferenceSync` | URL 无参且未交互时补齐偏好默认范围 |
| `getOverview`（`['overview', id]`） | 概览聚合（总资产/净值/XIRR/收益率/freshness/holdingsSummary） |
| `useXirrSeries / useNavSeries`（维度+范围+LAST；nav 用 `NavMetric.BOTH` 双线） | 趋势序列 |
| `useLatestXirr / useLatestNav` | 最新值兜底 |
| `useLatestCashBalance` | 现金余额卡 |
| `listTransactions(pageSize=5)` | 近期出入金（最近 5 笔） |
| `getPortfoliosSummary`（`['portfolios','summary']`） | 组合表现对比 |
| `buildOverviewMetrics`（8 卡，group: asset/return） | 指标卡展示模型（金额/比率/涨跌/空态口径统一） |

版面与交互：
1. **早退分支**（按序）：组合 loading 骨架 → 无组合欢迎 EmptyState → 未选组合提示卡 → overview+latestNav 双 loading 骨架 → 双 error 失败重试（重新加载按钮）。
2. **页头**：title「概览」；description = 有 `latestDate` 显「数据截止 X」否则「最近 12 个月收益概览」；actions = `PriceFreshnessBadge` + 「+录入出入金」「+录入买卖」（ENTRY 规格：主色 sm Plus）。
3. **FreshnessBanner**：`ov.freshness` 存在才渲染（DASH-P1-03）。
4. **区一「关键指标」**：Section（资产家底与收益表现一眼看全）→ `资产构成` 4 卡（当前总资产/持仓市值/现金余额/净投入，首卡 `border-primary/30`）→ `收益表现` 4 卡（累计收益率/当年收益率/年化XIRR/累计净值）；网格 `grid-cols-1 sm:2 md:4`。
5. **区二「趋势分析」**：筛选栏（Tabs 日/周/月/年 + 共享 DateRangeQuickPicker 受控回显 URL range，`markRangeInteracted`）→ `TotalAssetTrendChart` hero → `hasNoData`（`!isLoading && !isError && !data`）时渲染三步引导卡（DASH-P0-06，替代四宫格）→ 四宫格：
   - `NavTrendChart`（净值趋势 累计+当年）
   - `XirrTrendChart`（XIRR 趋势，connectNulls=false）
   - **近期出入金**卡：标题 + 「查看全部 → /cashflows」（DASH-P0-05）+ 5 笔列表（MM-dd、存入/取出着色 + /-、note 截断 120px）+ 空态 EmptyState（「还没有出入金记录」+ 录入按钮）
   - **组合表现对比**卡：名称 + 总资产 + 累计收益率（`!= null` 判空，正红负绿）+ XIRR（小字前缀「XIRR」）+ 空态「暂无组合数据」
6. **录入弹窗**：`Dialog` + `CashflowForm`（onSuccess 关闭）/ `Dialog` + `SecurityTradeForm`（onSuccess 关闭）。

---

## 3. 逐区块对账表（React ↔ Vue）

| # | 区块/行为 | React | Vue | 结论 |
|---|---|---|---|---|
| 1 | 版面骨架（页头+新鲜度 → 关键指标 → 趋势分析，space-y-8） | ✅ | ✅ | 一致 |
| 2 | 早退分支四态（loading/无组合/未选/双 loading/双 error） | ✅ | ✅ | 一致（含错误重试按钮） |
| 3 | URL 状态 g/range/from/to + schema 由偏好构建 | ✅ | ✅ | 一致（`useUrlState` 双侧同源） |
| 4 | resolveQuickRange + custom/all 语义 | ✅ | ✅ | 一致 |
| 5 | useRangePreferenceSync 偏好对齐守卫 | ✅ | ✅ | 一致（`modules/analysis/composables/use-range-preference-sync`） |
| 6 | overview/xirrSeries/navSeries(BOTH)/latestXirr/latestNav/latestBalance/recent/portfolioSummary 查询 | ✅ | ✅ | 一致（queryKey/参数逐项同构） |
| 7 | buildOverviewMetrics 8 卡 + asset/return 分组 | ✅ | ✅ | 一致（含 total-asset 描边） |
| 8 | 页头 actions：PriceFreshnessBadge + 两个录入按钮（ENTRY 规格） | ✅ | ✅ | 一致 |
| 9 | FreshnessBanner 条件渲染 | ✅ | ✅ | 一致 |
| 10 | 筛选栏：Tabs 粒度 + DateRangeQuickPicker + markRangeInteracted | ✅ | ✅ | 一致 |
| 11 | TotalAssetTrendChart hero（含手工记录标记） | ✅ | ✅ | 一致（props 逐项） |
| 12 | hasNoData 判定 + 三步引导卡（DASH-P0-06） | ✅ | ✅ | 一致（Vue 内联，React 独立组件，结构相同） |
| 13 | 四宫格：NavTrendChart / XirrTrendChart(connectNulls=false) | ✅ | ✅ | 一致 |
| 14 | 近期出入金卡（查看全部链接/5 笔/着色/空态+录入按钮） | ✅ | ✅ | 一致 |
| 15 | 组合表现对比卡（累计收益率 != null 判空/涨跌色/XIRR/空态） | ✅ | ✅ | 一致 |
| 16 | 录入出入金弹窗（CashflowForm） | ✅ | ✅ | 一致 |
| 17 | **录入买卖弹窗（SecurityTradeForm）** | ✅ 真实表单 | ⚠️ **占位提示** | **缺口（P1）** |
| 18 | 测试覆盖 | 5 文件 ~40 用例 | 1 文件 4 用例 | **缺口（P2）** |

---

## 4. 差异详情与对齐方案

### 4.1 【P1 功能缺口】录入买卖弹窗占位 → 挂载真实 SecurityTradeForm

- **现状**：`DashboardPage.vue` 765-771 行渲染「证券买卖录入表单将在后续批次迁移」占位。
- **事实核查**：Vue `modules/security-trade/components/SecurityTradeForm.vue` **已存在**（651 行，Task #20 后已被 `SecurityTradeList.vue` 编辑弹窗使用）；接口 `defineProps<{ portfolioId: string }>` + `defineEmits<{ success: [] }>`，与 React `SecurityTradeForm portfolioId onSuccess` 用法完全兼容。
- **改动点（1 处）**：
  1. `DashboardPage.vue` script：`import SecurityTradeForm from '@/modules/security-trade/components/SecurityTradeForm.vue'`
  2. 模板：占位 div 替换为 `<SecurityTradeForm :portfolio-id="currentPortfolioId" @success="tradeOpen = false" />`
- **风险**：极低 —— 复用既有组件，无新依赖；`SecurityTradeForm` 内部 `useSecurities`/mutation 均已在列表页验证。
- **工作量**：≤ 0.25 人天。

### 4.2 【P2 测试覆盖缺口】按 React 语义补 dashboard 测试

- **现状**：`web-vue/src/modules/overview/__tests__/dashboard-page.test.ts` 仅 4 用例（无组合空态 / 未选组合 / 有数据渲染 / 引导卡渲染）。
- **React 侧 5 文件锁死的行为**（Vue 无对等覆盖）：
  - `dashboard-alignment`（A6 查看全部链接位置 / A7 引导卡：空态 8 卡照常、行动按钮开弹窗、有数据不出现、**overview 失败不伪装空态** / A8 快捷范围 7 项文案、all 回落、维度粒度下发）
  - `dashboard-comparison`（组合对比两列渲染 / **NaN 防护**（字符串比率、null/undefined 判空）/ 涨跌色 / xirrDecimals 联动）
  - `dashboard-fusion`（8 卡与 buildOverviewMetrics 一致）
  - `dashboard-hooks-order` / `dashboard-layout`（结构性守卫）
- **建议补 2 个测试文件（约 12-14 用例）**：
  1. `dashboard-guide-range.test.ts`：对等 A7/A8 —— 引导卡四态（含失败不伪装空态）、快捷范围解析下发、all 回落、维度粒度。
  2. `dashboard-comparison.test.ts`：对等组合对比 —— 两列渲染、NaN 防护、涨跌色边界（-0.00000001）、xirrDecimals 联动。
- **工作量**：0.5–1 人天。非阻塞（功能已对齐，属回归保障）。

### 4.3 已确认无差异（无需改动）

§3 对账表 #1–16 全部一致，**不做任何改动**（避免无谓 diff）。

---

## 5. 验收标准

| 项 | 标准 |
|---|---|
| 功能对齐 | 「录入买卖」弹窗打开真实 SecurityTradeForm，录入成功后关闭并关闭弹窗 |
| 无回归 | `vue-tsc --noEmit` 0 错误；`vitest run` 全绿（含既有 dashboard-page.test.ts 4 例） |
| E2E | 既有 Playwright 9 例全绿（概览 spec 不受影响） |
| 测试对等（可选 P2） | 新增 2 个测试文件全部通过 |

---

## 6. 结论

- **概览页功能对齐度 ≈ 98%**：唯一实质缺口为「录入买卖弹窗占位」，替换为既有 `SecurityTradeForm` 即可闭合（≤ 0.25 人天）。
- 测试覆盖缺口（P2）建议同步补齐，但**不阻塞**功能对齐。
- 建议评审后：先做 §4.1（P1 功能对齐）→ 视需要做 §4.2（P2 测试补强）→ 按项目约定提交（不 push）。

---

# 附篇：持仓页（Holdings）对齐审查

> 审查日期：2026-08-18（追加）
> 审查对象：`web/src/pages/HoldingsPage.tsx`（React 源，603 行） vs `web-vue/src/modules/holdings/pages/HoldingsPage.vue`（Vue 目标，580 行）
> 配套文件：两端 `HoldingsToolbar` / `trade-security-filter` / `query-params` / `use-holdings`；React `DividendFeeSection` vs Vue `DividendList`（分红板块）；两端测试文件
> 方法：MCP 代码图谱索引定位 + 逐区块通读两端源码 + 子组件/查询参数接口比对 + 测试覆盖对账
> 性质：**先分析、后实现**（q-1 工作流）。本文仅陈述审查结论，**不含代码改动**。

## 7. 持仓页总体结论

**web-vue 持仓页与 web 持仓页功能基本对齐（≈ 97%），存在 1 处实质功能缺口（scenario→side 传导缺失）+ 1 处测试覆盖缺口（P2）。**

- ✅ **主体全部对齐**：早退分支、页头（PriceFreshnessBadge + 录入买卖）、I-05 统一筛选器、三 Tab（持仓/买卖明细/分红）、【A】汇总 5 卡、【B】持仓列表 11 列（徽标/InlinePriceEditor/占比进度条）、排序（市值降序 + 已清仓垫底）、错误重试/骨架/空态、录入买卖弹窗（SecurityTradeForm 已挂载）、买卖明细 Tab（SecurityTradeList，Task #20 已实现）、分红 Tab（DividendList = React DividendFeeSection 忠实平移）。
- ⚠️ **1 处功能缺口（P1，改动极小）**：`scenario`（买入/卖出/全部）筛选**未传导到「买卖明细」的后端查询** —— React 将 `scenario=BUY/SELL` 映射为 `tradeQuery.side`（`BUY_SEC/SELL_SEC`），Vue 的 `tradeQuery` 只含 `securityId + startDate + endDate`，无 `side`。HoldingsToolbar 的 scenario 控件照常渲染并写 URL，但「买卖明细」列表不按场景过滤（行为与 React 不一致）。
- ⚠️ **1 处测试覆盖缺口（P2）**：React `holdings-page.test.tsx` ~20+ 用例 + `holdings-unified-filter.test.tsx`，Vue `holdings-page.test.ts` 仅 4 用例；关键行为（Tabs 互斥、红涨绿跌边界、占比 NaN 防护、xirrDecimals 联动、scenario 传导）无回归保障。

## 8. 逐区块对账表（React ↔ Vue）

| # | 区块/行为 | React | Vue | 结论 |
|---|---|---|---|---|
| 1 | 早退分支（组合 loading / 无组合 / 未选组合） | ✅ | ✅ | 一致 |
| 2 | 页头：PriceFreshnessBadge + 「+录入买卖」（ENTRY 规格） | ✅ | ✅ | 一致 |
| 3 | I-05 统一筛选器（HoldingsToolbar：range/date/sec/scenario/types/closed，URL 单一来源 + 用户交互守卫 + 偏好对齐 watch） | ✅ | ✅ | 一致 |
| 4 | as-of 下限 minDate（baseDate → 首笔交易 → 创建日 → 今天） | ✅ | ✅ | 一致 |
| 5 | 日期范围解析（custom 用 from/to；否则 resolveQuickRange + all 以 baseDate 起） | ✅ | ✅ | 一致 |
| 6 | tradeSecurityFilter 三态派生（deriveTradeSecurityFilter 纯函数） | ✅ | ✅ | 一致 |
| 7 | **tradeQuery：scenario → side 传导** | ✅ `scenario=BUY→side=BUY_SEC / SELL→side=SELL_SEC` | ⚠️ **无 side 字段** | **缺口（P1）** |
| 8 | 持仓排序（市值降序 + 正常在前已清仓垫底） | ✅ | ✅ | 一致（quantity 两端同为 number，Vue 直接比较无碍） |
| 9 | 三 Tab（持仓/买卖明细/分红）+ 默认持仓 | ✅ | ✅ | 一致 |
| 10 | 【A】汇总 5 卡（总市值/总成本/浮盈/总盈亏率/标的数，红涨绿跌） | ✅ | ✅ | 一致 |
| 11 | 【B】持仓列表 11 列（标的+已清仓/成本估值徽标、类型徽标、数量、成本价、现价 InlinePriceEditor、成本额、市值、浮动盈亏±着色、盈亏率、占比+进度条） | ✅ | ✅ | 一致（表头顺序逐项对齐） |
| 12 | 列表错误态（重试）/ 骨架 / 空态（两种描述 + 录入按钮） | ✅ | ✅ | 一致 |
| 13 | 买卖明细 Tab → SecurityTradeList（筛选由统一筛选器派生） | ✅ | ✅ | 一致（Task #20 已落地） |
| 14 | 分红 Tab → DividendList（= React DividendFeeSection 平移，含汇总/按标的表/明细 CRUD/税后净额口径） | ✅ | ✅ | 一致 |
| 15 | 录入买卖弹窗（SecurityTradeForm + success 关闭） | ✅ | ✅ | 一致 |
| 16 | 测试覆盖 | 2 页级文件 ~20+ 用例 | 1 文件 4 用例 | **缺口（P2）** |

## 9. 差异详情与对齐方案

### 9.1 【P1 功能缺口】tradeQuery 补 scenario → side 传导

- **现状**：`HoldingsPage.vue` 231-238 行 `tradeQuery` 只含 `securityId / startDate / endDate`；React 226-240 行含 `q.side = BUY_SEC / SELL_SEC` 映射。
- **影响**：用户在统一筛选器选「场景=买入/卖出」后，「买卖明细」Tab 仍显示全部流水（后端查询无 side 参数），与 React 行为不一致。
- **改动点（1 处，约 5 行）**：
  ```ts
  const tradeQuery = computed<SecurityTradeQuery>(() => {
    const q: SecurityTradeQuery = {
      securityId: tradeSecurityFilter.value.ids.length > 0
        ? tradeSecurityFilter.value.ids.join(',') : undefined,
      startDate: startDate.value,
      endDate: endDate.value,
    };
    if (holdingsQuery.scenario === 'BUY') q.side = SecuritySide.BUY_SEC;
    if (holdingsQuery.scenario === 'SELL') q.side = SecuritySide.SELL_SEC;
    return q;
  });
  ```
  需补 `import { SecuritySide } from '@/lib/types'`（页面当前未导入）。
- **风险**：极低 —— 与 React 逐字对齐，SecurityTradeList 已按 query 传参。
- **工作量**：≤ 0.25 人天。

### 9.2 【P2 测试覆盖缺口】按 React 语义补 holdings 测试

- **React `holdings-page.test.tsx` 锁死的行为**（Vue 无对等覆盖）：
  - A1 Tabs 互斥（切 Tab 后旧面板卸载）
  - A2 11 列 + 红涨绿跌边界（盈利/亏损/持平 `pnl=0 → text-up`）
  - A3 汇总 5 项 + `lg:grid-cols-5` + 负盈亏率 text-down
  - A4 市值降序 + 不污染缓存
  - A5 占比进度条（aria-valuenow、NaN 边界 `totalMarketValue=0`、aggregate 缺失时占比归 0 且汇总卡不渲染）
  - 偏好 xirrDecimals 联动（盈亏率/总盈亏率跟随、占比固定 2 位）
- **React `holdings-unified-filter.test.tsx`**：统一筛选器 URL 联动（Vue `holdings-page.test.ts` 仅 1 例 as-of 变更覆盖该域）
- **建议补 1 个测试文件（约 8-10 用例）**：`holdings-page-alignment.test.ts` —— Tabs 互斥、红涨绿跌三态、占比 NaN/aggregate 缺失边界、xirrDecimals 联动、scenario→side 传导（新增 §9.1 后钉死）。
- **工作量**：0.5–1 人天。非阻塞。

### 9.3 已确认无差异（无需改动）

§8 对账表 #1–6、#8–15 全部一致，不做任何改动。其中：
- 分红板块：Vue `DividendList` 注释明示「平移自 React `dividend-fee-section.tsx`，行为契约一致」，含税后净额口径与「分红不参与 XIRR/净值」提示，无差异。
- 排序数量比较：两端 `HoldingResponse.quantity` 类型均为 `number`，Vue 直接 `a.quantity > 0` 与 React `Number(a.quantity) > 0` 语义等价，无需改动。

## 10. 持仓页验收标准

| 项 | 标准 |
|---|---|
| 功能对齐 | 统一筛选器「场景=买入/卖出」→ 买卖明细列表按 side 过滤（与 React 一致） |
| 无回归 | `vue-tsc --noEmit` 0 错误；`vitest run` 全绿（含既有 holdings 测试） |
| E2E | 既有 Playwright 9 例全绿（holdings spec 含买卖明细 Tab） |
| 测试对等（可选 P2） | 新增 holdings 对齐测试全部通过 |

## 11. 持仓页结论

- **持仓页功能对齐度 ≈ 97%**：唯一实质缺口为 `tradeQuery` 缺 scenario→side 传导，按 React 逐字对齐补 5 行即可闭合（≤ 0.25 人天）。
- 测试覆盖缺口（P2）建议同步补齐，**不阻塞**功能对齐。
- 建议评审后：先做 §9.1（P1）→ 视需要做 §9.2（P2）→ 按项目约定提交（不 push）。

---

# 附篇：出入金页（Transactions / Cashflow）对齐审查

> 审查日期：2026-08-18（追加）
> 审查对象：`web/src/pages/transactions.tsx`（React 源，505 行） vs `web-vue/src/modules/cashflow/pages/TransactionsPage.vue`（Vue 目标，516 行）
> 配套文件：两端 `CashflowList` / `CashBalanceForm` / `CashBalanceHistory` / `query-params` / `use-transactions` / `use-cash-balances`（Vue 组件位于 `modules/cash-balance/`）
> 方法：MCP 代码图谱索引定位 + 逐区块通读两端源码 + 子组件/回调接口比对 + 测试覆盖对账
> 性质：**先分析、后实现**（q-1 工作流）。本文仅陈述审查结论，**不含代码改动**。

## 12. 出入金页总体结论

**web-vue 出入金页与 web 出入金页功能 100% 对齐，无功能缺口，无需代码改动。**

- ✅ 逐区块核对（§13 对账表 16 项）全部一致：早退分支、页头双录入按钮、统一筛选器（类型/日期/排序/重置）、两 Tab、出入金流水列表、现金余额板块（当前余额/提示/变更历史）、录入/编辑弹窗、FLOW-P0-06 软提示程序化切换。
- ✅ 测试覆盖对等且 Vue 更优：`query-params.test` 两端 8 用例**完全一致**；Vue 另有 `cashflow-form.test`（5 用例）与 `cashflow-list.test`（3 用例），React 侧对应断言散落在 features 测试中。
- ⚠️ 仅 1 处**非功能差异**（展示样式，语义等价，无需改动）：无组合 / 未选组合空态，React 用纯文本 Card，Vue 用 `EmptyState` 组件包裹，文案一致。

## 13. 逐区块对账表（React ↔ Vue）

| # | 区块/行为 | React | Vue | 结论 |
|---|---|---|---|---|
| 1 | 早退分支（组合 loading / 无组合 / 未选组合） | ✅ | ✅ | 一致（空态 Vue 用 EmptyState 包裹，文案一致） |
| 2 | 页头：录入现金余额 + 录入出入金（ENTRY 规格，水平并排） | ✅ | ✅ | 一致 |
| 3 | 统一筛选器 Card：类型多选（不勾选=全部，仅流水）/ DateRangeQuickPicker / 排序（仅流水）/ 重置 | ✅ | ✅ | 一致（Label 并入「不勾选=全部」的等高布局同款） |
| 4 | URL query 单一来源（types/range/startDate/endDate/sortBy/sortOrder/page/pageSize） | ✅ | ✅ | 一致（Vue 用 vue-router query 等价实现） |
| 5 | 快捷范围受控回显（URL range 唯一真相源 + 偏好回落，派生式非 effect） | ✅ | ✅ | 一致 |
| 6 | 类型切换 / 排序切换 / 分页（page/pageSize 变更重置 page） | ✅ | ✅ | 一致 |
| 7 | 重置：清空全部 query（回落 全部 + date desc + 第 1 页 + 20 条） | ✅ | ✅ | 一致 |
| 8 | listQuery：日期范围 + 仅非默认排序透传（F5 白名单 400 防护） | ✅ | ✅ | 一致 |
| 9 | 两 Tab（出入金流水/现金余额），受控 + 软提示程序化切换 | ✅ | ✅ | 一致 |
| 10 | 出入金流水卡 → CashflowList（query/types/page/pageSize + 分页回调 + onClearFilter） | ✅ | ✅ | 一致 |
| 11 | 现金余额卡：当前余额（未维护提示 / 自 X 起沿用） | ✅ | ✅ | 一致 |
| 12 | CASH-P0-03 两条 ⓘ 提示 | ✅ | ✅ | 一致 |
| 13 | 余额变更历史 → CashBalanceHistory（受日期范围约束 + onEdit/onClearFilter） | ✅ | ✅ | 一致 |
| 14 | 录入/编辑出入金弹窗（CashflowForm + onSuccess 关闭） | ✅ | ✅ | 一致 |
| 15 | 录入/编辑现金余额弹窗（CashBalanceForm 双模式，编辑标题区分） | ✅ | ✅ | 一致 |
| 16 | FLOW-P0-06 软提示监听（CASH_BALANCE_FOCUS_EVENT → 切 tab + 开弹窗） | ✅ | ✅ | 一致（onMounted/onBeforeUnmount 对称） |

## 14. 差异详情与结论

### 14.1 无功能缺口

§13 对账表 16 项全部一致，**无需任何代码改动**。出入金页是继概览页（98%）、持仓页（97%）之后**完全对齐**的一页 —— 该页在早期批次已整体平移且测试覆盖充分（Vue `cashflow-form.test`/`cashflow-list.test`/`query-params.test` 三文件 16 用例，含表单校验/提交/编辑回填/列表渲染/空态清除筛选/URL 编解码）。

### 14.2 非功能差异（可选，不改）

- **无组合/未选组合空态**：React `Card + 纯文本`；Vue `Card + EmptyState`（title/description 拆行）。文案语义一致（「暂无投资组合，请先在账户页『我的组合』创建组合」），仅呈现结构不同。若追求像素级一致可改用纯文本，但**无业务影响，建议保持现状**（EmptyState 是 Vue 统一空态组件，符合项目规范）。

### 14.3 测试对等性

| 测试文件 | React | Vue | 结论 |
|---|---|---|---|
| query-params URL 编解码 | ✅ 8 用例 | ✅ 8 用例 | **完全一致** |
| 表单（CashflowForm） | （散落） | ✅ 5 用例 | Vue 更全 |
| 列表（CashflowList 渲染/空态） | （散落） | ✅ 3 用例 | Vue 更全 |
| 页面级（transactions.tsx） | ❌ 无 | ❌ 无 | 两端一致（无页面级测试） |

两端均无页面级测试，但核心行为（URL 编解码/表单/列表）均有对等或更优覆盖；**无需补测**。

## 15. 出入金页验收标准

| 项 | 标准 |
|---|---|
| 功能对齐 | 已 100% 对齐，无改动项 |
| 无回归 | 维持现状即满足（既有 Vue 测试 16 用例全绿） |
| 结论 | **本页无需实现动作，对齐闭环** |

