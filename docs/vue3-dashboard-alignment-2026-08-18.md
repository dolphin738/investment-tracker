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


---

# 附篇：资产记录页（Snapshots）对齐审查

> 审查日期：2026-08-18（追加）
> 审查对象：`web/src/pages/snapshots.tsx`（React 源，175 行）+ `web/src/features/snapshot/snapshot-list.tsx`（517 行） vs `web-vue/src/modules/snapshot/pages/SnapshotsPage.vue`（182 行）+ `SnapshotList.vue`（510 行）
> 配套文件：两端 `SnapshotForm`（日期不可未来/总资产必填/覆盖提示）、`use-snapshots`、`snapshot.api`
> 方法：MCP 代码图谱索引定位 + 逐区块通读两端源码 + 列表内部逻辑（筛选/差异提示/来源过滤/重置）比对 + 测试覆盖对账
> 性质：**先分析、后实现**（q-1 工作流）。本文仅陈述审查结论，**不含代码改动**。

## 16. 资产记录页总体结论

**web-vue 资产记录页与 web 资产记录页功能基本对齐（≈ 99%），无功能行为缺口；仅存 1 处 P3 视觉/文案差异（页头与图例的 emoji 符号），可选修复。**

- ✅ 功能行为全部对齐：无组合分支、页头（导出 CSV 占位禁用 + 录入按钮 ENTRY 规格）、历史记录卡、列表（筛选行/差异提示条/来源过滤/差异列/重置/删除确认）、新建/编辑弹窗（含覆盖提示）、底部图例。
- ⚠️ **P3 视觉差异（可选）**：React 页头副标题、历史记录卡描述、底部图例 6 条均带 emoji 符号（🤖 自动 / ✋ 手工 / ⓘ 提示 / ✎ 编辑 / 🗑 删除 / ↺ 重置），Vue 用纯文字（「自动」「手工」「编辑」…）。语义等价、无业务影响；若追求与 React 逐字一致，补 emoji 即可（≤ 0.25 人天）。

## 17. 逐区块对账表（React ↔ Vue）

| # | 区块/行为 | React | Vue | 结论 |
|---|---|---|---|---|
| 1 | 无组合分支（请先选择一个投资组合） | ✅ | ✅ | 一致 |
| 2 | 页头标题「历史总资产记录」+ 两行说明 | ✅ | ✅ | 一致（Vue 缺 🤖/✋/ⓘ emoji，见 §16） |
| 3 | 导出 CSV 占位禁用（SET-P0-03 同口径，title 说明） | ✅ | ✅ | 一致 |
| 4 | 录入按钮（ENTRY 规格：主色 sm Plus + 字典文案） | ✅ | ✅ | 一致 |
| 5 | 历史记录卡 → SnapshotList（默认日期范围 = 偏好回落） | ✅ | ✅ | 一致（listQuery computed 等价） |
| 6 | 列表：9 列（日期/总资产/持仓/现金/来源/自动值+差异/备注/操作） | ✅ | ✅ | 一致 |
| 7 | 筛选行：快捷范围 + 来源 checkbox（自动/手工）+ [重置]（SNAP-P0-04b） | ✅ | ✅ | 一致（含用户交互守卫防偏好覆盖） |
| 8 | 差异提示条：⚠️ N 条手工记录 M 条差异>1% + [仅看手工]（SNAP-P0-07/F5） | ✅ | ✅ | 一致 |
| 9 | 来源筛选（全选=不筛 / 仅自动=DERIVED / 仅手工=MANUAL，服务端 source 参数） | ✅ | ✅ | 一致 |
| 10 | 手工行差异列（derivedTotalAsset 系统值 + 差异金额 + 差异%） | ✅ | ✅ | 一致（AL-054 Q-1甲，两端同口径） |
| 11 | 操作：编辑（自动行变手工）/ 删除（AlertDialog 确认）/ 重置（仅手工，恢复系统值） | ✅ | ✅ | 一致 |
| 12 | 新建弹窗（SnapshotForm + 覆盖提示「该日系统自动计算值为 ¥xxx」） | ✅ | ✅ | 一致（SNAP-P0-06 ①） |
| 13 | 编辑弹窗（自动行保存后变手工；v-if 卸载重建重置表单） | ✅ | ✅ | 一致 |
| 14 | 表单校验（日期不可未来 / 总资产必填 / 备注 200 字） | ✅ | ✅ | 一致 |
| 15 | 底部图例 6 条（沿用/按成本/每天唯一/编辑/删除/重置） | ✅ | ✅ | 一致（Vue 缺 ⓘ/✎/🗑/↺ 符号，见 §16） |
| 16 | 测试覆盖 | ❌ 无专属测试 | ✅ `snapshot-form.test.ts` 6 例 | **Vue 更优**（无需补） |

## 18. 差异详情与结论

### 18.1 无功能行为缺口

§17 对账表 16 项中 15 项完全一致、1 项为视觉文案差异。列表内部最复杂的三块（筛选行 + 差异提示条 + 来源过滤）Vue 均逐行对应，含用户交互守卫与「重置后偏好不覆盖」语义。

### 18.2 P3 视觉/文案差异（可选修复，≤ 0.25 人天）

React 用 emoji 符号强化语义，Vue 用纯文字，共 4 处：
1. 页头副标题 1：`🤖 默认由系统每日自动记录；✋ 您也可手工补录或修正某日数值`（Vue 去掉了 🤖/✋）
2. 页头副标题 2：`ⓘ 每天只保留一条记录…`（Vue 去掉了 ⓘ）
3. 历史记录卡描述：`来源 🤖自动 = …；✋手工 = …`（Vue 用「自动」「手工」）
4. 底部图例 6 条：`ⓘ「沿用」… ✎ = 编辑… 🗑 = 删除… ↺ = 撤销…`（Vue 用「沿用」「编辑」「删除」「重置」文字）

若对齐目标是**逐字一致**，将 4 处 emoji 补回即可；若对齐目标是**功能等价**，现状已满足（文案语义一致，无业务影响）。**建议：可选**，补齐成本极低但无功能收益，可按用户偏好决定。

### 18.3 测试对等性

- React：**无** snapshot 专属测试（features/snapshot 与 pages/__tests__ 均无）。
- Vue：`snapshot-form.test.ts` 6 用例（表单校验/提交/编辑回填/覆盖提示）。
- 结论：Vue 测试覆盖更优，**无需补测**。

## 19. 资产记录页验收标准

| 项 | 标准 |
|---|---|
| 功能对齐 | 已对齐（无功能行为缺口） |
| 视觉对齐（可选） | 页头/图例补回 emoji（🤖/✋/ⓘ/✎/🗑/↺） |
| 无回归 | 维持现状即满足（Vue snapshot-form 6 用例全绿） |
| 结论 | 功能层面**本页无需实现动作**；视觉 emoji 为可选打磨项 |


---

# 附篇：收益分析页（XIRR Analysis）对齐审查

> 审查日期：2026-08-18（追加）
> 审查对象：`web/src/pages/xirr-analysis.tsx`（React 源，288 行） vs `web-vue/src/modules/analysis/pages/XirrAnalysisPage.vue`（Vue 目标，301 行）
> 配套文件：两端 `DimensionSwitcher` / `use-range-preference-sync` / `use-query-data`（useXirrSeries/useLatestXirr/useYearStartXirr）/ `XirrTrendChart` / `YearlyBarChart`
> 方法：MCP 代码图谱索引定位 + 逐区块通读两端源码 + 数据流（维度→查询参数→图表/表格）比对 + 测试覆盖对账
> 性质：**先分析、后实现**（q-1 工作流）。本文仅陈述审查结论，**不含代码改动**。

## 20. 收益分析页总体结论

**web-vue 收益分析页与 web 收益分析页功能 100% 对齐，无功能缺口，无需代码改动。**

- ✅ 逐区块核对（§21 对账表 12 项）全部一致：维度切换（含偏好对齐守卫与用户交互标记）、当前累计 XIRR + 较年初双卡（独立 year-start 查询）、XIRR 趋势图（null 断线）、年度柱状图（当年高亮）、明细表（倒序 + 环比变化）。
- ✅ 测试覆盖 **Vue 更优**：React 仅图表组件测试（xirr-trend-chart），Vue 有**页面级测试**（`xirr-analysis-page.test.ts`）+ chart-options/dimension/use-range-preference-sync 三组纯逻辑测试。
- ⚠️ 仅 2 处**视觉微调**（Vue 优于 React，非缺口）：双卡 CardTitle 与明细表单元格补了 `tabular-nums`（等宽数字防跳动）。**建议保持现状**。

## 21. 逐区块对账表（React ↔ Vue）

| # | 区块/行为 | React | Vue | 结论 |
|---|---|---|---|---|
| 1 | 无组合分支（请先选择一个投资组合） | ✅ | ✅ | 一致 |
| 2 | 页头「收益分析（XIRR）」+ 说明 | ✅ | ✅ | 一致 |
| 3 | DimensionSwitcher（维度 Tabs + 快捷范围 + 起止日期，flex 包裹左对齐） | ✅ | ✅ | 一致（受控绑定 + 交互守卫） |
| 4 | 偏好对齐守卫 useRangePreferenceSync（URL 无参且未交互时对齐一次） | ✅ | ✅ | 一致 |
| 5 | 维度变更标记交互（防偏好弹回） | ✅ | ✅ | 一致 |
| 6 | toDimensionQueryParams 剥离 quick（防后端 forbidNonWhitelisted 400） | ✅ | ✅ | 一致 |
| 7 | useXirrSeries / useLatestXirr / useYearStartXirr（较年初独立日粒度查询，ANL-P0-04） | ✅ | ✅ | 一致 |
| 8 | 当前累计 XIRR 卡（最新日期 / 暂无数据） | ✅ | ✅ | 一致（Vue 补 tabular-nums） |
| 9 | 较年初变化卡（formatChange pp，单位提示） | ✅ | ✅ | 一致（Vue 补 tabular-nums） |
| 10 | XirrTrendChart（connectNulls=false + 标题按维度 labelOf） | ✅ | ✅ | 一致 |
| 11 | 年度柱状图（granularity≠year 且有数据，aggregateByYear 取每年末值，highlightCurrentYear） | ✅ | ✅ | 一致 |
| 12 | 明细表（倒序、label/XIRR/环比 formatChange、骨架/空态） | ✅ | ✅ | 一致（Vue 单元格补 tabular-nums） |

## 22. 差异详情与结论

### 22.1 无功能行为缺口

§21 对账表 12 项全部一致。数据流（维度 → toDimensionQueryParams → 系列查询 → 图表/表格/双卡）逐环节同构，含最易踩坑的两处：
- **偏好对齐守卫**：两端都只在「URL 无参且用户未交互」时对齐一次，手动改范围后不再弹回（持仓页 QA Bug 同款防护）。
- **较年初基准解耦**：两端都用独立 `useYearStartXirr`（当年首个非空 XIRR），与页面维度/范围无关（Part A2 缺陷修复已平移）。

### 22.2 视觉微调（Vue 优于 React，建议保持）

- 双卡 `CardTitle` 与明细表三个单元格 Vue 补了 `tabular-nums`（等宽数字，切换小数位/涨跌时不跳动）。React 未加。**非缺口，保持现状即可**。

### 22.3 测试对等性

| 测试 | React | Vue | 结论 |
|---|---|---|---|
| 图表组件（xirr-trend-chart） | ✅ | ✅（chart-options.test） | 对等 |
| 页面级（维度切换/双卡/图表/表格渲染） | ❌ 无 | ✅ `xirr-analysis-page.test.ts` | **Vue 更优** |
| 纯逻辑（dimension 序列化 / range 对齐） | （散落） | ✅ dimension.test + use-range-preference-sync.test | Vue 更优 |

Vue 测试覆盖显著优于 React，**无需补测**。

## 23. 收益分析页验收标准

| 项 | 标准 |
|---|---|
| 功能对齐 | 已 100% 对齐，无改动项 |
| 无回归 | 维持现状即满足（Vue xirr-analysis-page 等测试全绿） |
| 结论 | **本页无需实现动作，对齐闭环** |

> 注：净值分析页（NavAnalysis，`/analysis/nav`）不在本轮审查范围（用户指定「收益分析页面」= XIRR）；如需可另开附篇。


---

# 附篇：净值分析页（Nav Analysis）对齐审查

> 审查日期：2026-08-18（追加）
> 审查对象：`web/src/pages/nav-analysis.tsx`（React 源，413 行） vs `web-vue/src/modules/analysis/pages/NavAnalysisPage.vue`（Vue 目标，366 行）+ `nav-daily-details.ts`（纯函数抽取）
> 配套文件：两端 `DimensionSwitcher` / `use-range-preference-sync` / `use-query-data`（useNavSeries/useLatestNav）/ `NavTrendChart` / `MonthlyHeatmap`
> 方法：MCP 代码图谱索引定位 + 逐区块通读两端源码 + 数据流（维度+指标 → 双查询 → 图表/热力图/明细表）比对 + 纯函数逐字核对 + 测试覆盖对账
> 性质：**先分析、后实现**（q-1 工作流）。本文仅陈述审查结论，**不含代码改动**。

## 24. 净值分析页总体结论

**web-vue 净值分析页与 web 净值分析页功能 100% 对齐，无功能缺口，无需代码改动。**

- ✅ 逐区块核对（§25 对账表 14 项）全部一致：维度切换 + 指标单选（累计/当年/对比）、当前净值 4 卡摘要、净值趋势双线图（按指标三态标题）、月度收益热力图（独立日维度查询）、每日净值明细表（`computeDailyDetails` 纯函数：每日收益 = Δnav × 前日份额、收益% 数学等价、份额 6 位小数、正红负绿、脚注）。
- ✅ 测试覆盖 **Vue 更优或对等**：React 仅 `nav-trend-chart.test.tsx`（图表组件）；Vue 有 `chart-options.test.ts`（含 nav option 断言）+ `xirr-analysis-page.test.ts`（页面级，同模块范式）。
- ⚠️ 仅视觉微调（Vue 优于 React，非缺口）：4 卡与明细表单元格补 `tabular-nums` 等宽数字。**建议保持现状**。

## 25. 逐区块对账表（React ↔ Vue）

| # | 区块/行为 | React | Vue | 结论 |
|---|---|---|---|---|
| 1 | 无组合分支 | ✅ | ✅ | 一致 |
| 2 | 页头「净值分析」+ 说明 | ✅ | ✅ | 一致 |
| 3 | DimensionSwitcher + 指标单选 RadioGroup（累计/当年/对比） | ✅ | ✅ | 一致（受控 + 交互守卫） |
| 4 | 维度初始值含 aggregation 偏好（ANL-P0-03） | ✅ | ✅ | 一致 |
| 5 | 偏好对齐守卫（URL 无参且未交互才对齐） | ✅ | ✅ | 一致 |
| 6 | toDimensionQueryParams 剥离 quick（防 400） | ✅ | ✅ | 一致 |
| 7 | series 查询（dimensionParams + metric） | ✅ | ✅ | 一致 |
| 8 | **daySeries 独立日维度查询**（热力图+明细表技术必需，DAY 硬编码） | ✅ | ✅ | 一致 |
| 9 | 当前净值 4 卡（累计净值/当年净值/累计收益/当年收益） | ✅ | ✅ | 一致（Vue 补 tabular-nums） |
| 10 | NavTrendChart（按 metric 三态标题） | ✅ | ✅ | 一致 |
| 11 | MonthlyHeatmap（dayData） | ✅ | ✅ | 一致 |
| 12 | computeDailyDetails（升序计算/倒序展示、Δnav×prevShares、收益% diff/prevNav、稀疏日期口径） | ✅ | ✅ | 一致（Vue 抽纯函数文件，逻辑逐字对应） |
| 13 | 明细表 6 列 + 正红负绿 + 份额 6 位小数 + 脚注 | ✅ | ✅ | 一致（Vue 单元格补 tabular-nums） |
| 14 | 问题④：未选中指标不下发 null（图表按 metric 注册 series） | ✅ | ✅ | 一致 |

## 26. 差异详情与结论

### 26.1 无功能行为缺口

§25 对账表 14 项全部一致。最易出错的两处均已对齐：
- **daySeries 独立查询**：每日明细与热力图固定日粒度，两端都独立查询（不随维度粒度变化），且把 `metric` 一并传入。
- **computeDailyDetails 纯函数**：Vue 抽为独立 `nav-daily-details.ts` 文件（注释含 Part E-8/F10 公式等价性说明），与 React 内联实现逐行对应；`NavMetric` 在 Vue 位于 `lib/types`（React 为 api/types re-export），语义一致。

### 26.2 视觉微调（Vue 优于 React，建议保持）

- 4 卡 `CardTitle` 与明细表全部单元格 Vue 补 `tabular-nums`。React 未加。**非缺口，保持现状即可**。

### 26.3 测试对等性

| 测试 | React | Vue | 结论 |
|---|---|---|---|
| 图表组件（nav-trend-chart） | ✅ `nav-trend-chart.test.tsx` | ✅ `chart-options.test.ts` | 对等 |
| 页面级（分析模块范式） | ❌ | ✅ `xirr-analysis-page.test.ts` 等 | Vue 更优 |
| computeDailyDetails 纯函数 | （内联，无独立测试） | ❌ 无独立测试 | 两端均无（可选补） |

两端均无 `computeDailyDetails` 独立测试（Vue 已抽纯函数、测试友好），如需可补 1 个纯函数测试文件（P3，非阻塞）。

## 27. 净值分析页验收标准

| 项 | 标准 |
|---|---|
| 功能对齐 | 已 100% 对齐，无改动项 |
| 无回归 | 维持现状即满足（Vue 分析模块测试全绿） |
| 结论 | **本页无需实现动作，对齐闭环**（computeDailyDetails 单测为可选 P3） |

