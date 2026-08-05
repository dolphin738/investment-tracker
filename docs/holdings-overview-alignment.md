# 持仓页 / 概览页 与 PRD 对齐分析 + 可操作清单

> **文档性质**：纯分析 + 对齐方案（**不含实现代码**），供后续工程师逐项排期落实
> **作者**：架构师 高见远（Bob）
> **日期**：2026-08-03
> **团队**：`software-holdings-overview-align`
> **口径唯一真相源**：[docs/PRD.md](./PRD.md) v3.1.8（Consolidated / 单一权威版）
> **核查范围**：
> - `packages/web/src/pages/HoldingsPage.tsx`
> - `packages/web/src/pages/dashboard.tsx`
> - 支撑链路：`hooks/use-holdings.ts`、`api/holding.api.ts`、`api/types.ts`、`api/overview.api.ts`、`api/transaction.api.ts`、`api/snapshot.api.ts`、`features/security-trade/security-trade-list.tsx`、`features/query/dimension-switcher.tsx`、`components/charts/{nav,xirr}-trend-chart.tsx`、`components/ui/*`、`stores/preference.store.ts`、`lib/utils.ts`、`lib/constants.ts`、`App.tsx`
> - 后端交叉核实：`modules/holding/{holding.controller,holding-derivation.service}.ts`、`modules/overview/overview.service.ts`、`modules/portfolio/{portfolio.service,dto/portfolio-summary.dto}.ts`、`prisma/schema.prisma`、`packages/shared/src/{enums,types}.ts`
> **约束遵循**：① PRD 为唯一口径来源；② 最小变更（优先前端对齐）；③ 本轮不写代码；④ 中文输出

---

## 1. TL;DR

**一句话结论**：两页**骨架与数据源口径均已正确**（概览 6 卡集合、C-08′ 只读 `AssetSnapshot`、持仓方案 B 只读推导、买卖明细列、A 股红涨绿跌配色全部达标），**主要差距集中在「已有数据未渲染」与「交互控件缺失」两类纯前端缺口**——共识别 **34 项差异**，其中 **28 项（82%）为纯前端改动且后端数据/参数已就绪**，仅 **6 项需拍板**（分红费用后端模块、组合对比接口口径、筛选联动汇总口径等）。

**差距归类（4 类）**：

| 类别 | 典型表现 | 项数 | 特征 |
|------|---------|------|------|
| **A. 后端已给、前端未渲染**（最大宗） | `costTotal`/`pnl`/`pnlRate`/`totalProfitRate`/`cumulativeNav`/`yearReturnRate`/`lastUpdatedAt` 全部已在响应里，页面没画 | 9 | **零风险、改一处渲染即可**，投入产出比最高 |
| **B. 后端参数已支持、前端未接入** | `date`（历史日期）/ `includeClosed`（显示已清仓）后端 controller 早已实现 | 2 | 只需加控件 + 传参 |
| **C. 交互/可视化控件缺失** | 进度条、类型多选、日期选择器、双环图、提示条、三步引导、URL 同步、markLine 基准线、行排序、行点击切组合 | 15 | 纯前端新增，部分需先补 shadcn 基础组件 |
| **D. 后端能力缺失或口径待拍板** | 分红/费用模块已移除、组合对比缺 `xirr`/`cumulativeReturnRate`、`/portfolios/comparison` 是否新建 | 6 | **需用户/评审决策**，不建议工程师自行发挥 |

**🔴 本轮核查新发现的 3 个高优缺陷（主理人侦察未覆盖）**：
1. **持仓页 Tabs 完全失效** —— 引入了 `Tabs/TabsList/TabsTrigger` 但**没有 `TabsContent`**，两个面板始终同时渲染，点 Tab 无任何反应（`HoldingsPage.tsx:165-408`）。
2. **持仓列表未按市值降序** —— 后端 `holding-derivation.service.ts` 返回值**没有任何 sort**，前端也没排，直接违反 `HOLD-B-P0-04` 验收 3。
3. **组合表现对比实际只渲染 2 列** —— 前端读的 `cumulativeReturnRate` / `xirr` 后端 `/portfolios/summary` **根本不返回**（`!= null` 守卫恒为 false），而后端**已返回**的 `cumulativeNav` / `yearReturnRate` / `lastUpdatedAt` 前端**又没用**。

---

## 2. 核查修正说明（对主理人侦察结论的 6 处更正）

> 遵循「以实际读到的代码为准」，以下 6 处需修正，**已在后文全部按修正后的事实展开**。

| # | 主理人侦察结论 | 实际核查结果 | 依据 |
|---|---------------|-------------|------|
| **M-1** | 概览「近期出入金」未过滤非 BUY/SELL，**分红/费用会混入** | ❌ **不成立，判定为已达标**。`listTransactions` 打的是 `/portfolios/:id/cashflows`，对应 Prisma `CashFlow` 表；`shared/src/enums.ts` 中 `CashFlowType` 只有 `BUY`/`SELL` 两值（C-10 硬约束）；`DividendRecord`/`FeeRecord` 是**物理独立表**，结构上不可能混入 | `shared/src/enums.ts:19-25`、`api/transaction.api.ts:26-44`、C-10 |
| **M-2** | 维度切换器**无「近3月」首要项**，**默认未取偏好** | ⚠️ **部分不成立**。`DATE_RANGE_OPTIONS` **含 `3m` 近3月**；默认值 `useState(getPreference('defaultGranularity'))` = `'month'`、`getPreference('defaultDateRange')` = `'1y'`，即**默认「月 + 近1年」已达标**（`DASH-P0-02` 验收 2 ✅）。真实缺口只有 3 个：**多出一个 PRD 未列的「近1月」**、**未复用 `DimensionSwitcher`**、**未写入 URL query** | `dashboard.tsx:78-84,135-140`、`stores/preference.store.ts:16-17` |
| **M-3** | 持仓页 Tabs 分两页 | ❌ **Tabs 是坏的**。只 import 了 `TabsList/TabsTrigger`，两个面板是 `Tabs` 的裸 `<div>` 子节点而非 `TabsContent`，**永远同时渲染**，Tab 触发器为装饰品 | `HoldingsPage.tsx:18,165-408`；`components/ui/tabs.tsx:56` 确实导出了 `TabsContent` |
| **M-4** | 组合对比「仅展示 名称/总资产/累计收益率/XIRR」 | ⚠️ **实际只有 2 列可见**。`cumulativeReturnRate`/`xirr` 在 `PortfolioSummaryDto` 中**不存在**（前端 `types.ts:530-533` 已注明"后端 summary 当前不返回"），渲染守卫恒 false。**反过来**，后端已返回的 `cumulativeNav`/`yearReturnRate`/`lastUpdatedAt` 前端没渲染 → 3 列可**零后端成本**补齐 | `dto/portfolio-summary.dto.ts`、`portfolio.service.ts:355-368`、`dashboard.tsx:471-503` |
| **M-5** | 持仓页需补的列/开关"缺失" | ✅ 缺失属实，但**后端全部就绪**：`HoldingResponse` 已含 `costTotal`/`pnl`/`pnlRate`，`HoldingsAggregate` 已含 `totalProfitRate`，controller 已支持 `date`/`includeClosed`/`securityId`。**全部为纯前端改动，无需动后端** | `api/types.ts:141-177`、`holding.controller.ts:60-100` |
| **M-6** | 数据新鲜度"仅在 description 显示文字" | ✅ 属实，且**判定口径也是错的**：现用 `isStale(ov.latestDate)`，`latestDate` 取自 `AssetSnapshot` 最新日期（旧口径「快照未更新」）。`DASH-P1-03` 已按方案 B 更新为**「最新现价 asOf 或现金余额 asOf」** → 属**口径错误**而非单纯缺 UI | `dashboard.tsx:274-276`、`overview.service.ts` latestDate 定义、PRD `DASH-P1-03` |

---

## 3. 持仓页（`/holdings`）现状模块拆解

> 文件：`packages/web/src/pages/HoldingsPage.tsx`（424 行）
> PRD 对照：§5.2 模块定义 / §6.3 需求池 `HOLD-B-*` / §7.2 UI 草图

### 3.0 页面骨架与数据链路

```
PageHeader（标题「持仓」+ description + [录入买卖]）
└─ Tabs（❌ 无 TabsContent，形同虚设）
   ├─ TabsList: [持仓] [买卖明细]
   ├─ <div> 面板一：【A】汇总卡 ×4  +  【B】持仓列表（8 列）
   └─ <div> 面板二：【C】筛选条（标的/方向/起止日期）+ SecurityTradeList
└─ Dialog：录入/编辑证券买卖（SecurityTradeForm）
```

- **数据源**：`useHoldings(currentPortfolioId, { date: todayIso() })` → `GET /portfolios/:id/holdings`
  - 返回 `{ items: HoldingResponse[], aggregate: HoldingsAggregate }`
  - `HoldingResponse` 字段（**已核实**）：`securityId / securityCode / securityName / securityType / quantity / avgCost / costTotal / marketPrice / priceAsOf / marketValue / pnl / pnlRate / flag('EXACT'|'COST_BASED')`
  - `HoldingsAggregate` 字段（**已核实**）：`totalMarketValue / totalCost / totalProfit / totalProfitRate / securityCount`
- **组合来源**：全局 `usePortfolioStore.currentPortfolioId`（顶栏 portfolio-selector），页面内无独立组合选择器
- **四态（C-06）**：`portfoliosLoading` 骨架 ✅ / 无组合 EmptyState ✅ / 未选组合提示卡 ✅ / `holdings.isError` 错误卡 + 重新加载 ✅ / `items.length===0` 空态引导 ✅ —— **四态完整达标**

### 3.1 【A】持仓汇总卡（对照 `HOLD-B-P0-06` / §7.2【A】）

| 项 | 现状 |
|----|------|
| **功能逻辑** | 直接渲染后端 `aggregate` 的 4 个字段；`aggregate` 为空时整块不渲染 |
| **布局** | `grid grid-cols-2 lg:grid-cols-4`，4 张 `Card` + `CardContent py-3` |
| **视觉** | 标题 `text-xs text-muted-foreground`，数值 `text-lg font-bold tabular-nums`；浮盈按 `text-up`/`text-down`（A 股正红负绿 ✅），正值前缀 `+` |
| **已实现指标** | 总市值 / 总成本 / **浮盈** / 标的数（4 项） |
| **缺口** | ❌ 缺第 5 项 **总盈亏率**（`aggregate.totalProfitRate` **后端已返回**，前端未用）<br>❌ 缺 §7.2【A】的 ⓘ 注解「本页市值将自动计入每日总资产记录」<br>❌ 缺 `Q-B16` 分支：当日记录 `source='MANUAL'` 时应提示「今日总资产使用了您的手工记录」<br>⚠️ 汇总**不随任何筛选变化**（当前也无筛选控件），`HOLD-B-P0-06` 验收 1 待筛选功能落地后一并验证 |

### 3.2 【B】持仓列表（对照 `HOLD-B-P0-04` / §5.2.3 / §7.2【B】）

| 项 | 现状 |
|----|------|
| **功能逻辑** | 遍历 `items` 渲染；`weight = h.marketValue / aggregate.totalMarketValue`（前端算占比，后端不返回 weight）；现价列挂 `InlinePriceEditor`（`HOLD-B-P0-05` ✅ 已实现，含 `priceAsOf` 与 `flag` 透传） |
| **布局** | `Card` 包 `overflow-x-auto` + shadcn `Table`；数值列 `text-right tabular-nums` |
| **视觉** | 标的名后挂「成本估值」`Badge`（`flag==='COST_BASED'`，含 `title` 说明）✅；类型列 `Badge variant="secondary"` + `SECURITY_TYPE_LABEL` 中文映射 ✅ |
| **已实现列（8）** | 标的 / 代码 / 类型 / 数量 / 成本价 / 现价✎ / 市值 / 占比 |
| **PRD 要求列（11）** | 标的名称 / 代码 / 类型 / 数量 / 成本价(avgCost) / **现价(+asOf)** / **成本额** / **市值** / **浮动盈亏** / **盈亏率** / 占比 |
| **缺口** | ❌ 缺 **成本额**（`costTotal`）、**浮动盈亏**（`pnl`）、**盈亏率**（`pnlRate`）三列 —— **三个字段后端全部已返回**<br>❌ 现价列**未显式展示 asOf**（`priceAsOf` 传入了 `InlinePriceEditor`，需确认其内部是否可见渲染；§5.2.3 明确要求「现价(+asOf)」）<br>❌ 占比只有百分比文字，**无横向进度条**（验收 5）<br>❌ **无「显示已清仓」开关**（验收 6；后端 `includeClosed` 参数已就绪）<br>❌ **无类型多选筛选**（`HOLD-B-P0-11` 验收 2）<br>❌ **默认排序未按市值降序**（验收 3）—— 后端 `holding-derivation.service.ts` 返回值**无 sort**，前端也未排 |

### 3.3 【C】证券买卖明细（对照 `HOLD-B-P0-07` / §7.2【C】）

| 项 | 现状 |
|----|------|
| **筛选** | 标的 `Select`（全部/逐个标的）、方向 `Select`（全部/买入/卖出）、起始日期、截止日期（`Input type=date`）+ [筛选] [重置] |
| **筛选传递** | 标的/日期进 `tradeQuery` 传后端；**方向走前端 `sideFilter` prop**（客户端过滤） |
| **列表列** | `security-trade-list.tsx`：日期 / 方向 / 标的 / 数量 / 单价 / 费用 / 成交额 / 备注 / 操作 —— **与 §7.2【C】草图一致 ✅**（草图未画"备注"，属超集，无害） |
| **视觉** | 方向徽标 `bg-up-soft text-up` / `bg-down-soft text-down`（红买绿卖，符合 §9.5）✅；删除有二次确认 + 影响范围文案 ✅ |
| **评价** | ✅ **本模块基本达标**，无 P0 缺口 |

### 3.4 【D】资产配置双环形图（`HOLD-B-P1-03`）

- **现状**：❌ **完全不存在**
- **要求**：标的占比 / 类型占比双环形图；占比 <3% 合并"其他"；hover 显示名称/市值/占比
- **可行性**：数据全在 `items`（`securityName`/`securityType`/`marketValue`），ECharts 已是项目统一图表库（`components/charts/` 已有 4 个图表可参照），**纯前端**

### 3.5 【E】分红 / 费用记录区（`HOLD-B-P0-10`）

- **现状**：❌ 页面无此区块
- **链路核实**：
  - 前端 `api/dividend.api.ts` / `api/fee.api.ts` **存在**（调 `/portfolios/:id/dividends`、`/fees`），但**无对应 hooks、无任何页面消费**
  - Prisma `DividendRecord` / `FeeRecord` **模型保留**（`schema.prisma:230,247`）
  - 后端 `src/modules/` 下**无 `dividend` / `fee` 目录** → 端点 404，前端 API 文件是**悬空调用**
- **PRD 现行表述**（`HOLD-B-P0-10`）：已注明「后端 NestJS 模块已移除，schema 表保留待将来复用」，验收 1 已被划掉标注「CRUD 暂不可用」，**验收 2「可在持仓模块按标的查看累计分红与累计费用」后缀「（待后端模块恢复）」**
- **结论**：⚠️ **PRD 自身已把该项标为受阻状态**，前端**无法单独完成** → **需确认**（是否本轮恢复后端模块 / 是否降级为 P1 延后）

### 3.6 历史日期选择（`HOLD-B-P0-11` 验收 3）

- **现状**：❌ 硬编码 `todayIso()`（`HoldingsPage.tsx:65-71,93`），页头无日期选择器
- **后端**：`GET /holdings?date=YYYY-MM-DD` **已支持**（`holding.controller.ts:66,79`，走 `parseAppDate`）
- **附带问题**：本地 `todayIso()` 与 `lib/constants.ts:61 toIsoDate()` **逻辑完全重复**，且 `toIsoDate` 已 import 但**未被使用**（`HoldingsPage.tsx:52` 死 import）→ 违反 **C-07 复用优先**

### 3.7 组合选择器（`HOLD-B-P0-11` 验收 1）

- **现状**：页面内无 `portfolio-selector`，走全局顶栏 + `usePortfolioStore`；切换组合后 `useHoldings` 的 queryKey 含 `portfolioId` → **列表与合计会同步刷新 ✅**
- **判定**：草图把组合选择器画在页头，实际收敛到全局顶栏是**更合理的一致性做法**，功能验收满足 → **建议判定为已完成**（保留一条 ❓ 供评审确认草图口径）

---

## 4. 概览页（`/`）现状模块拆解

> 文件：`packages/web/src/pages/dashboard.tsx`（541 行）
> PRD 对照：§5.5 模块定义 / §6.6 需求池 `DASH-*` / §7.4 UI 草图

### 4.0 页面骨架与数据链路

```
PageHeader（标题「概览」+ description[数据截止/陈旧] + [录入出入金][录入买卖]）
├─ 6 指标卡（grid sm:2 lg:3）
├─ 维度切换（内联 Tabs[日周月年] + Select[范围]）   ← 未复用 DimensionSwitcher
├─ 四宫格（grid lg:2）
│   ├─ NavTrendChart（累计+当年双线）
│   ├─ XirrTrendChart（connectNulls=false）
│   ├─ 近期出入金（最近5笔）
│   └─ 组合表现对比
└─ Dialog ×2：录入出入金 / 录入买卖
```

- **数据源**：
  - `getOverview(:id)` → `OverviewResponse`（`totalAsset / cumulativeNav / yearNav / xirr / netInvested / totalReturnRate / yearReturnRate / latestDate / holdingsSummary / recentTransactions`）
  - `useXirrSeries` / `useNavSeries`（接维度参数，`aggregation: LAST`）
  - `useLatestXirr` / `useLatestNav`（兜底）
  - `listTransactions(:id, {page:1,pageSize:5})` → 近期出入金
  - `getPortfoliosSummary()` → `/portfolios/summary`
- **C-08′ 合规性**：`totalAsset` 取自后端 `overview.service` 的 `latestSnapshot.totalAsset`（`AssetSnapshot` 最新唯一记录），**未在前端拼装 Σ(qty×price)+cash** → ✅ **合规**
- **四态（C-06）**：加载骨架 ✅ / 无组合 EmptyState ✅ / 未选组合 ✅ / 双错误兜底卡 + 重新加载 ✅

### 4.1 六指标卡（`DASH-P0-01`）

| 项 | 现状 |
|----|------|
| **卡片集** | 当前总资产 / 累计收益率 / 当年收益率 / 年化 XIRR / 累计净值 / 净投入 —— **6 张，与 PRD 完全一致；「最大回撤」已按 v3.x 要求移除 ✅** |
| **布局** | `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`，复用 `StatCard` |
| **精度（验收 3）** | 金额 `formatCurrency(_,2,{thousands,abbrev})` ✅；收益率 `formatPercent(_,2,{decimals:xirrDecimals})` ✅；净值 `formatDecimal(_, navDecimals=4)` ✅ |
| **无数据（验收 2）** | 一律 `'暂无数据'`，无 `-` 占位 ✅ |
| **trend 语义** | up/down 按正负；累计净值以 1 为界 ✅ |
| **缺口** | ❌ **验收 4 未达标**：只有「当前总资产」有 `description={截至 ov.latestDate}`，其余 5 张副标题是「净值 x.xxxx」「累计年化」「单位净值」「存入 - 取出」，**未统一标注数据截止日**<br>❌ **验收 6 未达标**：无 `✋手工` 徽标。根因：`OverviewResponse` **不含 `source` 字段**（后端 `overview.service.ts` 的 `select` 只取 `totalAsset,date`） |

### 4.2 时间维度切换器（`DASH-P0-02`）

| 项 | 现状 |
|----|------|
| **实现** | **页面内联** `Tabs[日周月年]` + `Select` 范围下拉 + 本地 `resolveDateRange()` |
| **快捷项** | `近1月 / 近3月 / 近1年 / 今年至今 / 全部`（PRD 列表为 **近3月 / 近1年 / 今年 / 全部**，多出「近1月」） |
| **默认值（验收 2）** | ✅ **达标** —— `defaultGranularity='month'`、`defaultDateRange='1y'`，且从 `usePreferenceStore` 读取（`SET-P0-02` 偏好覆盖链路已通） |
| **联动（验收 3）** | ✅ 两图表 queryKey 含维度参数，切换即刷新 |
| **缺口** | ❌ **验收 1**：未复用 `features/query/dimension-switcher.tsx`（该组件**已存在且已导出 `QUICK_RANGE_OPTIONS = 近3月/近1年/今年至今/全部`，正好是 PRD 口径**，`nav-analysis.tsx` / `xirr-analysis.tsx` 已在用 → 概览页是**全站唯一未复用方**）<br>❌ **验收 4**：维度与范围**未写入 URL query**，刷新/分享丢失（`pages/transactions.tsx:89` 已有 `useSearchParams` 现成范式可抄）<br>⚠️ 多出「近1月」快捷项（超集偏差，需确认是否清理） |

### 4.3 净值趋势图（`DASH-P0-03`）

| 验收 | 现状 |
|------|------|
| 1) 图例可点击隐藏单条线 | ✅ ECharts `legend:{bottom:0}` 已配置，默认可点选 |
| 2) hover 显示日期 + 两个净值（4 位） | ✅ `tooltip.trigger:'axis'` + `formatDecimal(v,4)`，null 值显示「数据不足」 |
| 3) 数据点 >400 自动降采样，渲染 <1s | ❌ **未实现**（无 `sampling` / `dataZoom` / 前置抽样） |
| 附加 | 累计+当年双线 ✅；`connectNulls` 默认 `true`（概览页未显式传参，净值线连续 —— PRD 未对净值线要求断线，判定无碍） |

### 4.4 XIRR 趋势图（`DASH-P0-04`）

| 验收 | 现状 |
|------|------|
| 1) Y 轴百分比显示 | ✅ `formatter: (v)=>${(v*100).toFixed(0)}%` |
| 2) **0% 处有基准虚线** | ❌ **未实现**（无 `markLine`） |
| 3) `xirrValue` 为 null **断线** | ✅ 概览页显式传 `connectNulls={false}` |

### 4.5 近期出入金卡（`DASH-P0-05`）

| 验收 | 现状 |
|------|------|
| 1) 复用 `?page=1&pageSize=5` | ✅ `listTransactions(id,{page:1,pageSize:5})` |
| 2) 存入红 / 取出绿 | ✅ `text-up` / `text-down` + `+`/`-` 前缀 |
| 3) 无记录空态 + 去录入 | ✅ EmptyState + [录入出入金] 按钮（直接开弹窗） |
| 4) **仅展示 BUY/SELL** | ✅ **结构性达标**（M-1：CashFlow 表枚举只有两值，分红/费用是独立表） |
| **底部"查看全部"跳 `/cashflows`** | ❌ **缺失** —— 卡片底部无任何跳转（`/cashflows` 路由**已存在**，`App.tsx:114`） |
| 视觉 | 日期 `MM-dd` + 类型 + 金额 + 备注截断；分隔线 `border-b last:border-0` |

### 4.6 组合表现对比（`DASH-P1-01`）

| 项 | 现状 |
|----|------|
| **实现** | 遍历 `/portfolios/summary` 结果，每行一个 flex 条（**不是 Table**） |
| **实际可见列** | **名称 + 总资产（2 列）** —— `cumulativeReturnRate`/`xirr` 后端不返回，`!= null` 守卫恒 false，**永不渲染**（前端 `types.ts:530-533` 注释已自认此缺口） |
| **PRD 要求 7 列** | 名称 / 最新总资产 / **累计净值** / **累计收益率** / **当年收益率** / **年化 XIRR** / **最后更新日** |
| **后端供给现状** | ✅ 已有：`cumulativeNav`、`yearReturnRate`、`lastUpdatedAt`、`totalAsset`、`name`、`netInvested`、`floatingProfit`、`holdingsCount`、`baseDate`<br>❌ 未有：`cumulativeReturnRate`、`xirr` |
| **缺口** | ❌ 3 列（累计净值 / 当年收益率 / 最后更新日）**后端已给、前端没画** → 零成本可补<br>❌ 2 列（累计收益率 / 年化 XIRR）需后端补字段<br>❌ 验收 2 **点击行切换当前组合** 未实现<br>❌ 验收 3 **按列排序** 未实现（当前非表格结构，需改造为 `Table`）<br>❓ 验收 1 要求 `GET /api/portfolios/comparison`，现用 `/portfolios/summary` |
| **空态** | ✅「暂无组合数据」 |

### 4.7 数据新鲜度提醒（`DASH-P1-03`）

| 项 | 现状 |
|----|------|
| **实现** | 仅 `PageHeader.description` 里追加「（数据陈旧）」文字 |
| **判定口径** | `isStale(ov.latestDate, staleDays)`，`latestDate` = **`AssetSnapshot` 最新日期** → **旧口径（"快照未更新"）** |
| **PRD 口径** | **「最新现价 asOf **或** 现金余额 asOf」距今 > N 天** |
| **缺口** | ❌ **口径错误**（用错数据源）<br>❌ 无**页面顶部提示条**<br>❌ 无 **[立即更新] 按钮**直达现价 / 现金余额录入 |
| **可行性** | 阈值 `staleDays` 偏好 ✅ 已通（`preference.store.ts:23`，设置页 `SET-P1-05` 已落地 1~30 天）；数据源 `listSecurityPrices(:id)`、`getLatestCashBalance(:id)` **API 与 hooks 均已存在** → **纯前端**<br>「立即更新→现金余额」可复用现成 `CASH_BALANCE_FOCUS_EVENT`（`hooks/use-transactions.ts:64` 派发、`pages/transactions.tsx:205` 监听） |

### 4.8 空状态与首次引导（`DASH-P0-06`）

| 分支 | 现状 |
|------|------|
| 无组合 | `EmptyState`「欢迎，先创建您的第一个投资组合」—— 有文案，但**无可点击的创建入口按钮**（验收 1 要求"引导按钮可直接打开对应表单弹窗"） |
| **有组合无数据** | ❌ **完全缺失** —— 有组合时直接进主视图，指标卡显示"暂无数据"，**无「建组合 → 录首笔存入 → 录证券买卖/现价」三步引导** |

### 4.9 首页快捷录入（`DASH-P1-04`）

- ✅ **已完成**：`[+录入出入金]` → `CashflowForm` Dialog；`[+录入买卖]` → `SecurityTradeForm` Dialog；均 `onSuccess` 关闭（各 mutation hook 内部已做 invalidate）

### 4.10 年度收益柱状图（`DASH-P1-05`）

- ❌ **未接入概览页**。组件 `components/charts/yearly-bar-chart.tsx` **已存在**（当前由分析页使用）→ 接入成本极低，纯前端

---

## 5. 差异清单（Gap List）

> 严重度取自 PRD 需求 ID 自带优先级；若为「已达标需求下的单条验收未满足」，按影响面在 P0 需求内降一档标注（记为 P1），并在【影响】列说明。
> 「纯前端」= 无需任何后端改动即可完成。

### 5.1 持仓页

| ID | 模块 | 当前实现 | PRD 依据 | 差异描述 | 严重度 | 影响 |
|----|------|---------|---------|---------|-------|------|
| **H-01** | 【A】汇总 | 4 项：总市值/总成本/浮盈/标的数 | §6.3 `HOLD-B-P0-06`；§7.2【A】 | 缺第 5 项**总盈亏率**；`aggregate.totalProfitRate` 后端已返回未用 | **P0** | 用户无法一眼看到组合整体收益水平，与 6 卡概览口径不呼应 |
| **H-02** | 【A】汇总 | 无任何注解 | §7.2【A】草图行「ⓘ 本页市值将自动计入每日总资产记录」 | 缺 ⓘ 说明，用户不知持仓市值会进 `AssetSnapshot` | P1 | 方案 B「持仓驱动总资产」的心智未建立（W-1/W-2 风险认知缺失） |
| **H-03** | 【A】汇总 | 无来源感知 | §6.3 `HOLD-B-P0-06` 验收 2；§2.4 `HOLD-P0-05` 改判；`Q-B16` | 当日记录 `source='MANUAL'` 时应提示「今日总资产使用了您的手工记录」，现无 | P1 | 手工记录日汇总与总资产不一致时，用户会误判为 bug |
| **H-04** | 【B】列表 | 8 列 | §5.2.3；§6.3 `HOLD-B-P0-04` 验收 1 | 缺 **成本额 / 浮动盈亏 / 盈亏率** 三列（`costTotal`/`pnl`/`pnlRate` 后端已返回） | **P0** | 持仓页核心价值（单标的赚了多少）缺失，用户须自行心算 |
| **H-05** | 【B】列表 | 现价列走 `InlinePriceEditor` | §5.2.3「现价(+asOf)」；`HOLD-B-P0-05` 验收 3「显示每个价格的 asOf」 | `priceAsOf` 已传入编辑器，但列上**是否可见展示 asOf 待确认**；草图要求现价旁可见生效日 | P1 | 用户无法判断现价新鲜度，与 `DASH-P1-03` 提醒割裂 |
| **H-06** | 【B】列表 | 占比仅百分比文字 | `HOLD-B-P0-04` 验收 5 | 缺**横向进度条**可视化 | **P0** | 明确验收项未满足；配置集中度不直观 |
| **H-07** | 【B】列表 | 无开关 | `HOLD-B-P0-04` 验收 6 | 缺「显示已清仓」开关（`qty=0` 默认隐藏 ✅ 已由后端做到，但**不可切换显示**）；后端 `includeClosed` 已支持 | **P0** | 用户无法回看已清仓标的历史，`§5.2.2` 清仓归零口径不可验证 |
| **H-08** | 【B】列表 | 无排序 | `HOLD-B-P0-04` 验收 3 | **默认按市值降序未实现**；后端 `holding-derivation.service` 无 sort，前端也未排 | **P0** | 大仓位不置顶，列表可读性差；验收可直接判负 |
| **H-09** | 【B】筛选 | 无类型筛选（类型筛选只在买卖明细页有"标的"筛选，非类型） | `HOLD-B-P0-11` 验收 2 | 缺**标的类型多选筛选**（股票/基金/债券） | **P0** | 无法按资产大类查看；与【D】类型占比图联动缺基础 |
| **H-10** | 【A】+【B】联动 | 汇总恒为全量 | `HOLD-B-P0-06` 验收 1「随筛选条件动态变化」 | 类型筛选落地后，汇总须随筛选子集变化；当前后端 aggregate 为全量 | P1 | 筛选后"总市值"与可见行求和不符，用户困惑 |
| **H-11** | 页头 | 硬编码 `todayIso()` | `HOLD-B-P0-11` 验收 3；`HOLD-B-P1-02` | 缺**持仓日期选择器**（默认今日，可选首笔流水日之后任意历史日期）；后端 `date` 参数已支持 | **P0** | 方案 B 最大卖点「任意历史日期精确回溯」在 UI 上完全不可达 |
| **H-12** | 【D】 | 不存在 | `HOLD-B-P1-03` | 缺**标的占比 / 类型占比双环形图**（<3% 合并"其他"，hover 名称/市值/占比） | P1 | 资产配置视图缺失 |
| **H-13** | 【E】 | 不存在；前端 API 悬空、后端模块已删 | `HOLD-B-P0-10` 验收 2 | 缺**分红 / 费用记录区**（按标的累计分红/累计费用）。PRD 自身已标注「待后端模块恢复」 | **P0（受阻）** | M2 目标「记录分红与费用」未兑现；前端 `dividend.api.ts`/`fee.api.ts` 为死代码 |
| **H-14** | 页面骨架 | `Tabs` 无 `TabsContent`，两面板同时渲染 | §7.2 布局；C-07 | **Tab 切换完全失效**，点击无反应；页面一次性铺开全部内容 | **P0（缺陷）** | 明显功能性 bug，用户体验与草图分区意图均被破坏 |
| **H-15** | 工具函数 | 本地 `todayIso()` 与 `lib/constants.toIsoDate()` 重复；`toIsoDate` 死 import | **C-07 复用优先** | 重复造轮子 + 未使用 import | P2 | 代码异味，lint 告警 |
| **H-16** | 空态 | 无组合时按钮 `disabled` + 文案「请先在设置页创建组合」 | C-06；`DASH-P0-06` 验收 1 类比 | 空态给了**不可点的按钮**，且组合创建入口指向存疑（全站是否有"设置页建组合"） | P2 | 新用户死胡同 |
| **H-17** | 页头 | 无页内组合选择器 | `HOLD-B-P0-11` 验收 1；§7.2 草图页头 | 草图画了 `[组合: ▼]`，实际收敛到全局顶栏；**功能验收满足** | — | 建议判定"已完成"，仅记录草图口径差异 |
| **H-18** | 【C】明细 | 日期/方向/标的筛选 + 9 列 + 编辑删除 | `HOLD-B-P0-07`；§7.2【C】 | **无差异** | — | ✅ 达标 |
| **H-19** | 【B】现价 | `InlinePriceEditor` + 成本估值徽标 | `HOLD-B-P0-05` | **无差异**（验收 1/2 已实现） | — | ✅ 达标 |

### 5.2 概览页

| ID | 模块 | 当前实现 | PRD 依据 | 差异描述 | 严重度 | 影响 |
|----|------|---------|---------|---------|-------|------|
| **D-01** | 6 卡 | 6 张卡、无 `-` 占位、精度合规 | `DASH-P0-01` 验收 1/2/3/5 | **无差异**（含 C-08′ 数据源合规） | — | ✅ 达标 |
| **D-02** | 6 卡 | 仅「当前总资产」标截止日 | `DASH-P0-01` 验收 4 | 其余 5 张副标题**未统一标注数据截止日** | P1 | 用户不知各指标口径日期，跨卡对比失据 |
| **D-03** | 6 卡 | 无来源徽标 | `DASH-P0-01` 验收 6 | 最新记录 `source='MANUAL'` 时缺 **✋手工 徽标**；`OverviewResponse` 无 `source` 字段 | **P0** | 用户无法区分自动派生值与自己的手工修正（§5.4.6 用途 ②） |
| **D-04** | 维度器 | 页面内联 Tabs+Select | `DASH-P0-02` 验收 1 | **未复用 `features/query/dimension-switcher.tsx`**（组件已存在，两个分析页已用） | P1 | 违反 C-07；三处维度器行为将持续漂移 |
| **D-05** | 维度器 | 5 个快捷项（多「近1月」） | `DASH-P0-02` 描述「近3月/近1年/今年/全部」 | 超集偏差 | P2 | 与共享组件 `QUICK_RANGE_OPTIONS` 不一致 |
| **D-06** | 维度器 | `useState` 本地态 | `DASH-P0-02` 验收 4 | **维度/范围未写入 URL query**，刷新/分享后丢失 | P1 | 明确验收项未满足；无法分享特定视图 |
| **D-07** | 净值图 | 无降采样 | `DASH-P0-03` 验收 3 | 数据点 >400 时未自动降采样 | P2 | 长周期「全部」范围下渲染可能超 1s |
| **D-08** | XIRR 图 | 无 markLine | `DASH-P0-04` 验收 2 | 缺 **0% 基准虚线** | P1 | 盈亏分界不直观 |
| **D-09** | 近期出入金 | 卡片底部无入口 | `DASH-P0-05` 描述 + 验收 | 缺**「查看全部」跳转 `/cashflows`** | **P0** | 概览"流量枢纽"定位（§5.5）断链 |
| **D-10** | 近期出入金 | 仅 BUY/SELL | `DASH-P0-05` 验收 4；C-10 | **无差异**（结构性满足，见 M-1） | — | ✅ 达标 |
| **D-11** | 组合对比 | 实际渲染 2 列 | `DASH-P1-01` 描述 7 列 | 缺 **累计净值 / 当年收益率 / 最后更新日**（后端**已返回**，前端未画） | P1 | 后端已付出的字段成本被浪费 |
| **D-12** | 组合对比 | `cumulativeReturnRate`/`xirr` 永不渲染 | `DASH-P1-01` 描述 7 列 | 缺 **累计收益率 / 年化 XIRR** 两列；后端 `/portfolios/summary` 不返回这两个字段 | P1 | 前端存在**恒不生效的死渲染分支**（技术债） |
| **D-13** | 组合对比 | 无点击交互 | `DASH-P1-01` 验收 2 | 缺**点击行切换当前组合** | P1 | 多组合用户切换成本高 |
| **D-14** | 组合对比 | flex 列表，非表格 | `DASH-P1-01` 验收 3 | 缺**按任意列排序**（需先改造为 `Table`） | P1 | 验收项未满足 |
| **D-15** | 组合对比 | 走 `/portfolios/summary` | `DASH-P1-01` 验收 1；`ACC-P0-04` 验收 4 | PRD 写 `GET /api/portfolios/comparison`，现实是 `summary`（且 `ACC-P0-04` 要求两页**共用同一接口不重复开发**） | ❓ | 接口口径二义，需拍板 |
| **D-16** | 新鲜度 | `isStale(ov.latestDate)` 文字 | `DASH-P1-03` 验收 1 | **① 判定口径错误**（用 `AssetSnapshot` 最新日，应为现价 asOf / 现金余额 asOf）；**② 无顶部提示条**；**③ 无 [立即更新] 按钮** | P1 | 方案 B 下"上游数据过期"这一核心风险（§5.4.3 阶梯横盘）无提醒 |
| **D-17** | 空态 | 通用欢迎语 | `DASH-P0-06` | **有组合无数据**分支缺三步引导（建组合→录首笔存入→录证券买卖/现价）；无组合分支缺可点按钮 | **P0** | 新用户冷启动断层 |
| **D-18** | 快捷录入 | 双弹窗 | `DASH-P1-04` | **无差异** | — | ✅ 达标 |
| **D-19** | 年度柱图 | 未接入 | `DASH-P1-05` | 缺年度收益柱状图（`yearly-bar-chart.tsx` 组件已存在） | P2 | P1 需求未落地 |
| **D-20** | 四态 | 加载/无组合/未选/错误 | C-06 | **无差异** | — | ✅ 达标 |

---

## 6. 对齐方案（新增 / 修改 / 删除）

### 6.1 新增（Add）

| # | 改动 | PRD 依据 | 纯前端？ | 落地要点 |
|---|------|---------|---------|---------|
| A-1 | 持仓汇总第 5 张卡「总盈亏率」 | `HOLD-B-P0-06` | ✅ | 用 `aggregate.totalProfitRate`，`formatPercent`，正红负绿；栅格由 `lg:grid-cols-4` → `lg:grid-cols-5` |
| A-2 | 持仓汇总 ⓘ 注解行 | §7.2【A】 | ✅ | 静态文案；建议与 A-3 提示同区 |
| A-3 | 「今日总资产使用了您的手工记录」提示 | `HOLD-B-P0-06` 验收 2 / `Q-B16` | ✅ | `listSnapshots(id,{startDate:date,endDate:date})` 取当日 `source`；仅 `MANUAL` 时渲染 |
| A-4 | 持仓列表 3 列：成本额 / 浮动盈亏 / 盈亏率 | §5.2.3、`HOLD-B-P0-04` 验收 1 | ✅ | 直接用 `costTotal`/`pnl`/`pnlRate`；盈亏与盈亏率**必须**正红负绿（§9.5） |
| A-5 | 占比横向进度条 | `HOLD-B-P0-04` 验收 5 | ✅ | `components/ui/` **无 `progress`**，建议新增 shadcn `progress.tsx` 或用 `div` + `width:%` 内联条（草图 `███▌` 样式） |
| A-6 | 「显示已清仓」开关 | `HOLD-B-P0-04` 验收 6 | ✅ | `components/ui/` **无 `checkbox`/`switch`**，需新增其一；state 传 `includeClosed` 到 `useHoldings`（后端已支持） |
| A-7 | 标的类型多选筛选（股票/基金/债券/其他） | `HOLD-B-P0-11` 验收 2 | ✅ | 后端**无 `types` 参数** → 建议**客户端按 `securityType` 过滤**（持仓行数量级小）；配套 A-8 |
| A-8 | 筛选后汇总重算 | `HOLD-B-P0-06` 验收 1 | ✅ | 对过滤后行做 `marketValue`/`costTotal`/`pnl` 求和 —— **纯求和，非金融算法，不触碰 C-01 禁区**（C-01 禁的是 XIRR/净值/份额）；⚠️ 见 Q-3 |
| A-9 | 持仓日期选择器（页头，默认今日） | `HOLD-B-P0-11` 验收 3 | ✅ | `Input type="date"`（全站既有范式），`max=今日`、`min=首笔流水日`；传 `date` 给 `useHoldings` |
| A-10 | 【D】双环形图（标的占比 / 类型占比） | `HOLD-B-P1-03` | ✅ | ECharts pie 双环；<3% 合并"其他"；hover 名称/市值/占比；按标的着色**不受红绿约束**（§9.5 例外 4） |
| A-11 | 【E】分红 / 费用记录区 | `HOLD-B-P0-10` 验收 2 | ❌ **需后端** | 后端须恢复 `DividendModule`/`FeeModule`（表已在）→ 见 **Q-1** |
| A-12 | 概览「✋手工」徽标 | `DASH-P0-01` 验收 6 | ⚠️ 二选一 | **方案甲（纯前端）**：`listSnapshots(id,{startDate:latestDate,endDate:latestDate})` 读 `source`；**方案乙（后端 1 行）**：`overview.service` 的 `select` 加 `source: true` 并透出 → 见 **Q-2** |
| A-13 | 概览 5 张卡副标题补数据截止日 | `DASH-P0-01` 验收 4 | ✅ | 统一 `截至 ${ov.latestDate}`；原副标题（净值 x.xxxx 等）保留为次行或合并 |
| A-14 | 维度/范围写入 URL query | `DASH-P0-02` 验收 4 | ✅ | `useSearchParams`；范式抄 `pages/transactions.tsx:89`；初值优先级 **URL > 用户偏好 > 月+近1年** |
| A-15 | XIRR 图 0% 基准虚线 | `DASH-P0-04` 验收 2 | ✅ | ECharts `series.markLine`，`yAxis:0`，`lineStyle.type:'dashed'` |
| A-16 | 净值图 >400 点降采样 | `DASH-P0-03` 验收 3 | ✅ | ECharts `sampling:'lttb'` 或前置抽样 |
| A-17 | 近期出入金「查看全部」→ `/cashflows` | `DASH-P0-05` | ✅ | 卡片底部 `Link`；路由已存在（`App.tsx:114`） |
| A-18 | 组合对比补 3 列（累计净值/当年收益率/最后更新日） | `DASH-P1-01` | ✅ | 后端**已返回** `cumulativeNav`/`yearReturnRate`/`lastUpdatedAt`；注意 null 渲染「—」不得渲染 0 |
| A-19 | 组合对比补 2 列（累计收益率/年化 XIRR） | `DASH-P1-01` | ❌ **需后端** | `cumulativeReturnRate = cumulativeNav - 1`（1 行）；`xirr` 需按 `latestNavs` 同款 `distinct` 取 `DailyXirr` → 见 **Q-4** |
| A-20 | 组合对比：点击行切组合 + 列排序 | `DASH-P1-01` 验收 2/3 | ✅ | 改造为 shadcn `Table`；行 `onClick` 调 `usePortfolioStore.setCurrentPortfolioId`；当前组合行高亮（对齐 `ACC-P0-04` 验收 2） |
| A-21 | 顶部数据新鲜度提示条 + [立即更新] | `DASH-P1-03` 验收 1 | ✅ | 数据源 `listSecurityPrices` 最大 `asOf` 与 `getLatestCashBalance().asOf`，取**较早者**与 `staleDays` 比；[立即更新] → `/holdings`（现价）与 `/cashflows`（现金余额，可复用 `CASH_BALANCE_FOCUS_EVENT`）；`components/ui/` **无 `alert`**，需新增或用 `Card` 变体 |
| A-22 | 有组合无数据：三步引导 | `DASH-P0-06` | ✅ | 建组合 → 录首笔存入（开 `CashflowForm` 弹窗）→ 录证券买卖/现价（开 `SecurityTradeForm`）；按钮须**可点直接开弹窗**（验收 1） |
| A-23 | 无组合空态补可点创建入口 | `DASH-P0-06` 验收 1 | ✅ | 复用 `PortfolioDialog`（`features/portfolio/`）；同步修 H-16 |
| A-24 | 年度收益柱状图上概览 | `DASH-P1-05` | ✅ | 复用 `charts/yearly-bar-chart.tsx`；正红负绿、当年高亮 |

### 6.2 修改（Modify）

| # | 改动 | PRD 依据 | 纯前端？ | 落地要点 |
|---|------|---------|---------|---------|
| M-1 | **修复 Tabs：补 `TabsContent`** | §7.2 布局；C-07 | ✅ | 两个裸 `<div>` 改为 `<TabsContent value="holdings">` / `value="trades"`；`TabsContent` 已在 `components/ui/tabs.tsx` 导出 |
| M-2 | 持仓列表默认按市值降序 | `HOLD-B-P0-04` 验收 3 | ✅ | **优先前端排序**（最小变更）；如需服务端稳定序，后端 `derive()` 末尾加 sort（备选，见 Q-5） |
| M-3 | 现价列显式展示 `asOf` | §5.2.3、`HOLD-B-P0-05` 验收 3 | ✅ | 现价下方小字 `asOf`；无价时「按成本估值」徽标（已有） |
| M-4 | 概览维度器改为复用 `DimensionSwitcher` | `DASH-P0-02` 验收 1 | ✅ | 传 `quickRanges={QUICK_RANGE_OPTIONS}`、`showAggregation={false}`（概览固定 LAST）；顺带解决 D-05 快捷项一致性 |
| M-5 | 新鲜度判定口径改为现价/现金 asOf | `DASH-P1-03` | ✅ | 停用 `isStale(ov.latestDate)` 作为陈旧判据（`latestDate` 保留用于"数据截止日"展示） |
| M-6 | 持仓页 `todayIso()` → `toIsoDate()` | C-07 | ✅ | 删除本地函数，用已 import 的 `toIsoDate(new Date())` |
| M-7 | 组合对比 flex 列表 → `Table` | `DASH-P1-01` 验收 3 | ✅ | 排序与 7 列展示的结构前提 |

### 6.3 删除（Remove）

| # | 改动 | PRD 依据 | 纯前端？ | 落地要点 |
|---|------|---------|---------|---------|
| R-1 | 删除快捷项「近1月」 | `DASH-P0-02` 描述 | ✅ | 随 M-4 复用共享组件自然消除；⚠️ 若用户偏好中已存 `'1m'` 需回落到 `'1y'`（见 Q-6） |
| R-2 | 清理死 import `toIsoDate`（改为真正使用） | C-07 / lint | ✅ | 随 M-6 一并处理 |
| R-3 | 清理组合对比中恒不生效的 `cumulativeReturnRate`/`xirr` 渲染分支 | 技术债 | ✅ | **仅当 Q-4 决定不补后端字段时执行**；若补后端则改为正式渲染（A-19） |
| R-4 | 悬空的 `api/dividend.api.ts` / `api/fee.api.ts` | — | ❌ 需决策 | **不建议删**：Q-1 若决定恢复后端模块则直接复用；若长期不做，应加 `@deprecated` 注释而非删除（PRD 明确"schema 表保留待将来复用"） |

### 6.4 建议的落地顺序（供排期参考）

```
第 1 批（P0 · 纯前端 · 零风险，改动集中在渲染层）
  M-1 修 Tabs → A-4 三列 → A-1 总盈亏率 → M-2 排序 → A-5 进度条
  A-17 查看全部 → A-12(甲) 手工徽标 → A-22/A-23 空态引导

第 2 批（P0 · 纯前端 · 需新增 ui 基础组件）
  A-6 显示已清仓（checkbox/switch）→ A-7+A-8 类型筛选与汇总联动 → A-9 历史日期

第 3 批（P1 · 一致性与体验）
  M-4 复用 DimensionSwitcher → A-14 URL 同步 → A-21 新鲜度提示条(+M-5)
  A-18 组合对比 3 列 → M-7 表格化 → A-20 点击/排序 → A-13 截止日 → A-15 基准线
  A-2/A-3 汇总注解与手工提示 → M-3 asOf → M-6 工具函数

第 4 批（P1/P2 · 增量能力，含需拍板项）
  A-10 双环图 → A-24 年度柱图 → A-16 降采样
  A-11 分红费用区（阻塞于 Q-1）→ A-19 对比补 2 列（阻塞于 Q-4）
```

---

## 7. 可操作清单（交付重点）

> **状态判定**：
> - ✅ **已完成** = 代码已符合 PRD，无需改动
> - 🔧 **待调整** = 明确需改、PRD 依据清晰、可直接排期
> - ❓ **需确认** = 涉及后端接口 / 口径歧义 / 优先级取舍，需用户或评审拍板

| 序号 | 改动项 | PRD 依据 | 优先级 | 类型 | 状态 | 备注 |
|-----|--------|---------|-------|------|------|------|
| 1 | 修复持仓页 Tabs（补 `TabsContent`） | §7.2 布局 / C-07 | **P0** | 修改 | 🔧 待调整 | **本轮新发现**；两面板现同时渲染，Tab 无效 |
| 2 | 持仓列表补「成本额 / 浮动盈亏 / 盈亏率」3 列 | §5.2.3 · `HOLD-B-P0-04`①| **P0** | 新增 | 🔧 待调整 | 纯前端；`costTotal`/`pnl`/`pnlRate` 后端已返回；盈亏正红负绿 |
| 3 | 持仓汇总补「总盈亏率」第 5 项 | `HOLD-B-P0-06` | **P0** | 新增 | 🔧 待调整 | 纯前端；`aggregate.totalProfitRate` 已返回 |
| 4 | 持仓列表默认按市值降序 | `HOLD-B-P0-04`③ | **P0** | 修改 | 🔧 待调整 | **本轮新发现**；后端无 sort，建议前端排序 |
| 5 | 占比横向进度条可视化 | `HOLD-B-P0-04`⑤ | **P0** | 新增 | 🔧 待调整 | 纯前端；`ui/` 无 `progress`，需新增组件或 div 实现 |
| 6 | 「显示已清仓」开关 | `HOLD-B-P0-04`⑥ | **P0** | 新增 | 🔧 待调整 | 纯前端；后端 `includeClosed` 已支持；`ui/` 无 `checkbox`/`switch` |
| 7 | 标的类型多选筛选 | `HOLD-B-P0-11`② | **P0** | 新增 | 🔧 待调整 | 纯前端客户端过滤（后端无 `types` 参数） |
| 8 | 筛选后汇总随之动态变化 | `HOLD-B-P0-06`① | P1 | 新增 | ❓ 需确认 | 前端对已返回行做求和是否可接受（vs 后端加 `types` 参数）→ **Q-3** |
| 9 | 持仓日期选择器（默认今日，可选历史） | `HOLD-B-P0-11`③ | **P0** | 新增 | 🔧 待调整 | 纯前端；后端 `date` 已支持；`min`=首笔流水日、`max`=今日 |
| 10 | 【E】分红 / 费用记录区 | `HOLD-B-P0-10`② | **P0** | 新增 | ❓ 需确认 | **后端模块已移除，前端无法单独完成** → **Q-1** |
| 11 | 汇总区 ⓘ「本页市值将自动计入每日总资产记录」 | §7.2【A】 | P1 | 新增 | 🔧 待调整 | 纯前端静态文案 |
| 12 | 当日 `source=MANUAL` 时的手工记录提示 | `HOLD-B-P0-06`② · `Q-B16` | P1 | 新增 | 🔧 待调整 | 纯前端；`listSnapshots` 单日查 `source` |
| 13 | 现价列显式展示 `asOf` | §5.2.3 · `HOLD-B-P0-05`③ | P1 | 修改 | 🔧 待调整 | 纯前端；需确认 `InlinePriceEditor` 内是否已渲染 |
| 14 | 【D】标的/类型双环形图 | `HOLD-B-P1-03` | P1 | 新增 | 🔧 待调整 | 纯前端；ECharts pie；<3% 并入"其他" |
| 15 | `todayIso()` → 复用 `toIsoDate()` | C-07 | P2 | 修改+删除 | 🔧 待调整 | 顺带清理死 import |
| 16 | 持仓无组合空态改为可点创建入口 | C-06 | P2 | 修改 | 🔧 待调整 | 与序号 26 统一用 `PortfolioDialog` |
| 17 | 页内组合选择器（草图 `[组合:▼]`） | `HOLD-B-P0-11`① | — | — | ✅ 已完成 | 收敛至全局顶栏，切换即刷新；仅草图形态差异 |
| 18 | 【C】买卖明细列表与筛选 | `HOLD-B-P0-07` · §7.2【C】 | — | — | ✅ 已完成 | 9 列 + 筛选 + 编辑删除 + 红买绿卖 |
| 19 | 现价内联编辑 ✎ + 成本估值徽标 | `HOLD-B-P0-05` | — | — | ✅ 已完成 | — |
| 20 | 概览 6 指标卡集合（含移除最大回撤） | `DASH-P0-01`①②③⑤ | — | — | ✅ 已完成 | 数据源合规 C-08′ |
| 21 | 概览「✋手工」徽标 | `DASH-P0-01`⑥ | **P0** | 新增 | ❓ 需确认 | 纯前端方案甲 vs 后端加 `source` 方案乙 → **Q-2** |
| 22 | 5 张卡补数据截止日副标题 | `DASH-P0-01`④ | P1 | 修改 | 🔧 待调整 | 纯前端 |
| 23 | 近期出入金「查看全部」→ `/cashflows` | `DASH-P0-05` | **P0** | 新增 | 🔧 待调整 | 纯前端；路由已存在 |
| 24 | 近期出入金仅 BUY/SELL | `DASH-P0-05`④ · C-10 | — | — | ✅ 已完成 | **修正主理人结论**：结构性满足，无混入可能 |
| 25 | 有组合无数据三步引导 | `DASH-P0-06` | **P0** | 新增 | 🔧 待调整 | 纯前端；按钮须可直接开弹窗 |
| 26 | 无组合空态补可点「新建组合」 | `DASH-P0-06`① | P1 | 修改 | 🔧 待调整 | 复用 `PortfolioDialog` |
| 27 | 复用 `DimensionSwitcher` 替换内联维度器 | `DASH-P0-02`① | P1 | 修改 | 🔧 待调整 | 纯前端；共享组件 `QUICK_RANGE_OPTIONS` 正是 PRD 口径 |
| 28 | 维度/范围写入 URL query | `DASH-P0-02`④ | P1 | 新增 | 🔧 待调整 | 纯前端；抄 `transactions.tsx` 的 `useSearchParams` |
| 29 | 默认「月 + 近1年」+ 偏好覆盖 | `DASH-P0-02`② | — | — | ✅ 已完成 | **修正主理人结论**：偏好默认已达标 |
| 30 | 移除快捷项「近1月」 | `DASH-P0-02` 描述 | P2 | 删除 | ❓ 需确认 | 超集是否需清理 + 存量偏好回落 → **Q-6** |
| 31 | XIRR 图 0% 基准虚线 | `DASH-P0-04`② | P1 | 新增 | 🔧 待调整 | 纯前端 `markLine` |
| 32 | XIRR null 断线 / Y 轴百分比 | `DASH-P0-04`①③ | — | — | ✅ 已完成 | `connectNulls={false}` 已传 |
| 33 | 净值图图例可点 / hover 4 位小数 | `DASH-P0-03`①② | — | — | ✅ 已完成 | — |
| 34 | 净值图 >400 点降采样 | `DASH-P0-03`③ | P2 | 新增 | 🔧 待调整 | 纯前端 `sampling:'lttb'` |
| 35 | 组合对比补 3 列（累计净值/当年收益率/最后更新日） | `DASH-P1-01` | P1 | 新增 | 🔧 待调整 | **纯前端**；后端已返回，null 渲染「—」 |
| 36 | 组合对比补 2 列（累计收益率/年化 XIRR） | `DASH-P1-01` | P1 | 新增 | ❓ 需确认 | 需后端 `PortfolioSummaryDto` 扩字段 → **Q-4** |
| 37 | 组合对比改造为 Table + 列排序 | `DASH-P1-01`③ | P1 | 修改 | 🔧 待调整 | 纯前端 |
| 38 | 组合对比点击行切换当前组合 | `DASH-P1-01`② | P1 | 新增 | 🔧 待调整 | 纯前端；当前行高亮，对齐 `ACC-P0-04`② |
| 39 | `/portfolios/comparison` 是否新建 | `DASH-P1-01`① vs `ACC-P0-04`④ | P1 | — | ❓ 需确认 | 建议复用 `summary` 不新建 → **Q-7** |
| 40 | 新鲜度判定口径改为现价/现金 asOf | `DASH-P1-03` | P1 | 修改 | 🔧 待调整 | 纯前端；现用 `AssetSnapshot` 最新日为旧口径 |
| 41 | 顶部新鲜度提示条 + [立即更新] | `DASH-P1-03`① | P1 | 新增 | 🔧 待调整 | 纯前端；`ui/` 无 `alert` 组件；可复用 `CASH_BALANCE_FOCUS_EVENT` |
| 42 | 概览首页快捷录入双弹窗 | `DASH-P1-04` | — | — | ✅ 已完成 | — |
| 43 | 年度收益柱状图上概览 | `DASH-P1-05` | P2 | 新增 | 🔧 待调整 | 纯前端；`yearly-bar-chart.tsx` 已存在 |
| 44 | 概览四态（加载/无组合/未选/错误） | C-06 | — | — | ✅ 已完成 | 持仓页四态同样达标 |
| 45 | 清理组合对比死渲染分支 | 技术债 | P2 | 删除 | ❓ 需确认 | 取决于 Q-4 结论（补字段则转正，不补则删） |
| 46 | `dividend.api.ts` / `fee.api.ts` 处置 | `HOLD-B-P0-10` | P2 | 删除/标注 | ❓ 需确认 | 建议标 `@deprecated` 不删（表保留待复用）→ 随 **Q-1** |

**统计**：合计 **46 项** —— ✅ 已完成 **12 项**｜🔧 待调整 **26 项**（其中 **P0 12 项**）｜❓ 需确认 **8 项**
**纯前端占比**：待调整 26 项中 **26/26 = 100% 为纯前端**；需确认 8 项中仅 2 项（Q-1 分红费用、Q-4 对比补字段）确需后端。

---

## 8. 待确认问题汇总（需用户 / 评审拍板）

> 以下 7 个开放问题会阻塞或改变对应清单项的做法，**建议在开工前一次性拍板**。

### Q-1 ｜【E】分红 / 费用区：本轮是否恢复后端模块？（阻塞清单 10、46）

- **背景**：`HOLD-B-P0-10` 是 **P0**，但 PRD 自身已注明「后端 `DividendModule`/`FeeModule` 已移除，schema 表保留待将来复用」，验收 1 被划掉、验收 2 加了「（待后端模块恢复）」后缀。前端 `api/dividend.api.ts`/`fee.api.ts` 仍在但为悬空调用（端点 404）。
- **选项**：
  - **A**：本轮恢复后端两个 NestJS 模块（表已在，仅需 controller/service/DTO + `user_id` 隔离），前端做【E】区（按标的累计分红/费用）。⚠️ 违反「后端缺口仅当 P0 且极小才提」中的"极小"——约 2 个模块、6 个端点。
  - **B**（**架构师建议**）：本轮**不做**，把 `HOLD-B-P0-10` 明确标记为「阻塞中 / 单独排期」，前端两个 api 文件加 `@deprecated` 注释保留；本文档清单项 10 挂起。
  - **C**：只做只读聚合（`GET /holdings/:securityId/dividend-fee-summary` 单端点），不做 CRUD。
- **需要决策**：选 A / B / C。

### Q-2 ｜「✋手工」徽标：纯前端多打一次请求，还是后端加 1 个字段？（阻塞清单 21）

- **背景**：`DASH-P0-01` 验收 6 要求最新记录 `source='MANUAL'` 时带徽标；`OverviewResponse` 无 `source`（`overview.service.ts` 的 `select` 只取 `totalAsset,date`）。
- **选项**：
  - **甲（纯前端）**：概览页额外调 `listSnapshots(id,{startDate:latestDate,endDate:latestDate})` 读 `source`。零后端改动，代价是多 1 次请求 + 一个只为拿 1 个字段的查询。
  - **乙（后端 1 行，架构师建议）**：`overview.service.ts` 的 `latestSnapshot` `select` 加 `source: true`，响应加 `latestSource: 'DERIVED'|'MANUAL'`。**改动量 2 行**，属"确属 P0 且极小"，且同时让持仓页 A-3（`Q-B16` 提示）可复用同源口径。
- **需要决策**：甲 / 乙。（选乙时同步更新 `api/types.ts` 的 `OverviewResponse`）

### Q-3 ｜类型筛选后的汇总：前端求和 vs 后端加 `types` 参数？（阻塞清单 8）

- **背景**：`HOLD-B-P0-06` 验收 1 要求汇总「随筛选条件动态变化」；后端 `aggregate` 是全量，且 controller 无 `types` 参数。
- **风险点**：C-01 规定「金融计算全部在后端，前端只做格式化展示」。本项属**已返回行值的纯求和**（非 XIRR/净值/份额），架构师判断**不构成 C-01 违规**，但需业主确认口径。
- **选项**：
  - **甲（纯前端，建议）**：前端对过滤后行求和得到 `totalMarketValue/totalCost/totalProfit/totalProfitRate/securityCount`。
  - **乙（后端）**：controller 加 `types` 查询参数，服务端过滤并返回子集 aggregate（保持"汇总口径唯一在后端"）。
- **需要决策**：甲 / 乙。另需明确：**验收 2「汇总与当日 `marketValue` 一致」的断言是否只在"无筛选"状态下成立**（架构师建议：是，应显式写入验收备注）。

### Q-4 ｜组合对比的「累计收益率 / 年化 XIRR」两列是否补后端字段？（阻塞清单 36、45）

- **背景**：`DASH-P1-01` 要求 7 列，后端 `PortfolioSummaryDto` 缺 `cumulativeReturnRate` 与 `xirr`；前端已写了永不生效的渲染分支。
- **选项**：
  - **甲（后端补，建议）**：`cumulativeReturnRate = cumulativeNav.minus(1).toFixed(8)`（**1 行**）；`xirr` 复制现有 `latestNavs` 的 `distinct:['portfolioId']` 范式查 `DailyXirr`（**约 10 行，无 N+1**）。
  - **乙（前端算累计收益率）**：`cumulativeNav - 1` 在前端算 —— ⚠️ **有 C-01 争议**（这是净值口径派生），且 `overview.service` 已在后端这么算，前后端双实现有分裂风险。**不建议**。
  - **丙（降级）**：本轮只上后端已有的 3 列（清单 35），这两列延后，同时删掉死分支（清单 45）。
- **需要决策**：甲 / 丙（乙不建议）。

### Q-5 ｜持仓列表排序放前端还是后端？（影响清单 4）

- **背景**：`HOLD-B-P0-04` 验收 3「默认按市值降序」，后端 `derive()` 无 sort。
- **选项**：**甲（前端排序，最小变更，建议）** / **乙（后端 `derive()` 末尾加 `sort((a,b)=>b.marketValue-a.marketValue)`，1 行，让所有消费方口径统一 —— `overview.service` 也在用 `derive()`）**。
- **需要决策**：甲 / 乙。（若未来要做服务端分页，乙更前瞻）

### Q-6 ｜快捷项「近1月」是否移除？存量用户偏好如何回落？（阻塞清单 30）

- **背景**：PRD `DASH-P0-02` 快捷项为「近3月 / 近1年 / 今年 / 全部」，实现多了「近1月」；共享 `DimensionSwitcher.QUICK_RANGE_OPTIONS` 无「近1月」。复用共享组件后「近1月」自然消失。
- **风险**：若已有用户偏好 `defaultDateRange='1m'`，复用后该值在下拉中无对应项。
- **选项**：**甲**：移除并在读取偏好时把 `'1m'` 回落为 `'1y'`；**乙**：保留「近1月」，反向给共享组件的 `QUICK_RANGE_OPTIONS` 增补（三个页面一致，但偏离 PRD 文字）；**丙**：移除且不做回落（可接受，因下拉会显示空值）。
- **需要决策**：甲（建议）/ 乙 / 丙。

### Q-7 ｜`GET /api/portfolios/comparison` 是否新建？（阻塞清单 39）

- **背景**：`DASH-P1-01` 验收 1 写明「后端新增批量汇总接口 `GET /api/portfolios/comparison`（一次查询返回全部组合摘要，避免 N+1）」；但 `ACC-P0-04` 验收 4 又写「与 `DASH-P1-01` **共用同一汇总接口，不重复开发**」，而现网 `/portfolios/summary` **已经是**那个共用的批量接口，且已用 `groupBy` + `distinct` 消除了净值/现金流的 N+1。
- **架构师意见**：**不新建 `comparison`**，直接扩展 `/portfolios/summary`（配合 Q-4 甲）。理由：① 两条验收本身冲突，`ACC-P0-04`④「不重复开发」是更强的架构约束；② 新建接口会造成两个高度重叠的摘要端点，违反最小变更；③ PRD 验收 1 的**真实意图是"批量、无 N+1"**，`summary` 已满足。
- **残留 N+1 提示**（供后续优化，非本轮）：`portfolio.service.ts` 的 `holdingsCounts` 仍是 `Promise.all(每组合一次 findMany)`，组合数 ≤20 时可接受（验收 4 要求 <800ms），但严格说是 N 次查询。
- **需要决策**：确认「复用 `summary`，PRD 验收 1 的接口名以脚注方式修订」是否可接受。

### Q-8（附）｜UI 基础组件缺口是否允许新增？

- **背景**：`components/ui/` 现有 14 个组件，**缺 `progress`（清单 5）、`checkbox`/`switch`（清单 6）、`alert`（清单 41）**。C-07「复用优先」禁止重复造轮子，但这些是 shadcn 标准件、当前确实不存在。
- **架构师意见**：按 shadcn 官方源新增这 3 个基础组件（`progress` / `switch` / `alert`），属**扩充设计系统而非造轮子**，不违反 C-07。
- **需要决策**：确认允许新增（若不允许，则用 Tailwind `div` 手写，视觉一致性略降）。

---

## 附录 A：本轮核实的关键字段/参数清单（供工程师直接引用，避免二次踩坑）

| 能力 | 前端类型/函数 | 后端出处 | 状态 |
|------|-------------|---------|------|
| 持仓行成本额 | `HoldingResponse.costTotal` | `holding-derivation.service.ts:200` | ✅ 已返回 |
| 持仓行浮动盈亏 | `HoldingResponse.pnl` | 同上 :195 | ✅ 已返回 |
| 持仓行盈亏率 | `HoldingResponse.pnlRate` | 同上 :196 | ✅ 已返回 |
| 持仓行现价日期 | `HoldingResponse.priceAsOf` | 同上（`DISTINCT ON` 取 `asOf<=date` 最后一条） | ✅ 已返回 |
| 成本估值标识 | `HoldingResponse.flag` | 同上 | ✅ 已返回，前端已用 |
| 汇总总盈亏率 | `HoldingsAggregate.totalProfitRate` | `holding.controller.ts:97` | ✅ 已返回，**前端未用** |
| 历史日期推导 | `listHoldings(id,{date})` | `holding.controller.ts:66,79` | ✅ 已支持，**前端硬编码今日** |
| 显示已清仓 | `listHoldings(id,{includeClosed:true})` | `holding.controller.ts:68,82` | ✅ 已支持，**前端未接** |
| 单标的过滤 | `listHoldings(id,{securityId})` | `holding.controller.ts:88` | ✅ 已支持 |
| 类型多选过滤 | — | **无** `types` 参数 | ❌ 需前端过滤或后端新增（Q-3） |
| 当日快照来源 | `listSnapshots(id,{startDate,endDate})` → `AssetSnapshot.source` | `shared/src/types.ts:137` | ✅ 可取（Q-2 方案甲） |
| 概览快照来源 | — | `overview.service.ts` `select` 无 `source` | ❌ 需后端 2 行（Q-2 方案乙） |
| 组合累计净值 | `PortfolioSummary.cumulativeNav` | `portfolio.service.ts:362` | ✅ 已返回，**前端未用** |
| 组合当年收益率 | `PortfolioSummary.yearReturnRate` | 同上 :363 | ✅ 已返回，**前端未用** |
| 组合最后更新日 | `PortfolioSummary.lastUpdatedAt` | 同上 :340-350 | ✅ 已返回，**前端未用** |
| 组合累计收益率 | `PortfolioSummary.cumulativeReturnRate?` | **不返回**（前端注释已自认） | ❌ Q-4 |
| 组合 XIRR | `PortfolioSummary.xirr?` | **不返回** | ❌ Q-4 |
| 现价 asOf 列表 | `listSecurityPrices(id)` + `useSecurityPrices` | `security-price` 模块 | ✅ 可用（A-21） |
| 现金余额 asOf | `getLatestCashBalance(id)` + `useLatestCashBalance` | `cash-balance` 模块 | ✅ 可用（A-21） |
| 陈旧阈值偏好 | `getPreference('staleDays')`（默认 3，1~30 可配） | `preference` 模块 + 设置页 | ✅ 已通（`SET-P1-05`） |
| 现金余额聚焦事件 | `CASH_BALANCE_FOCUS_EVENT` | `hooks/use-transactions.ts:64` ↔ `pages/transactions.tsx:205` | ✅ 可复用（A-21） |
| URL query 范式 | `useSearchParams` | `pages/transactions.tsx:89` | ✅ 可抄（A-14） |
| 共享维度器 | `DimensionSwitcher` + `QUICK_RANGE_OPTIONS` | `features/query/dimension-switcher.tsx` | ✅ 存在，两分析页在用（M-4） |
| 年度柱图组件 | `charts/yearly-bar-chart.tsx` | — | ✅ 存在（A-24） |

## 附录 B：全局约束合规性自查（本次两页）

| 约束 | 持仓页 | 概览页 | 说明 |
|------|-------|-------|------|
| **C-01** 金融计算全在后端 | ✅ | ✅ | 两页仅格式化；唯一灰区是筛选汇总求和（Q-3）与 `cumulativeNav-1`（Q-4） |
| **C-06** 四态必备 | ✅ | ✅ | 均有加载/无组合/未选组合/错误四态 |
| **C-07** 复用优先 | ⚠️ | ⚠️ | 持仓页 `todayIso` 重复（H-15）；概览页未复用 `DimensionSwitcher`（D-04） |
| **C-08′** 引擎/概览只读派生结果 | ✅ | ✅ | 概览 `totalAsset` 来自 `AssetSnapshot`，未前端拼装 |
| **C-10** BUY/SELL 不扩展 | ✅ | ✅ | 买卖用独立 `SecuritySide`，出入金卡不可能混入分红费用 |
| **§9.5 正红负绿** | ✅ | ✅ | `text-up`/`text-down`、`bg-up-soft`/`bg-down-soft` 全站统一；新增的盈亏列/进度条/柱图须沿用 |

---

## 9. 决策记录（2026-08-05 · 用户拍板）

| 编号 | 决策 | 选定选项 | 影响 / 备注 |
|------|------|----------|------------|
| Q-1 | 【E】分红/费用区 | **A：本轮恢复后端 `DividendModule`/`FeeModule`**（表已在，补 controller/service/DTO + `user_id` 隔离），前端做【E】区分红/费用区 | ⚠️ 范围升级：原"挂起"改"本轮实现"，后端 ≈ 2 模块 6 端点；清单 10、46 由挂起转待调整 |
| Q-2 | ✋手工徽标 | **乙：后端加字段** —— `OverviewResponse` 加 `latestSource`（`overview.service` `latestSnapshot` select 加 `source:true`），约 2 行 | 需同步改 `api/types.ts` 的 `OverviewResponse` |
| Q-3 | 类型筛选后汇总 | **乙：后端 `types` 参数 + 子集聚合**（口径唯一在后端，贴合 C-01） | ⚠️ 用户硬性要求：`SecurityType` 必须在 `packages/shared` 定义一次、前后端共用（**实际 shared 已有，见 §9.1**，无需新建）；后端改动极小（§9.1） |
| Q-4 | 组合对比补列 | **甲：后端补** `cumulativeReturnRate`(=cumulativeNav-1, 1 行) + `xirr`(复刻 latestNavs `distinct`, ~10 行) | 动 `PortfolioSummaryDto`；与 Q-7 复用 `summary` 联动 |
| Q-5 | 持仓列表排序 | **甲：前端排序**（最小变更） | 零后端 |
| Q-6 | 快捷项范围 | **乙：保留「近1月」并反向补共享 `DimensionSwitcher.QUICK_RANGE_OPTIONS`**；**额外新增「近一周」「近6月」** | 最终快捷项 = 近一周 / 近1月 / 近3月 / 近6月 / 近1年 / 今年 / 全部（7 项，超 PRD 文字，用户明确要）；默认仍取偏好(月+近1年) |
| Q-7 | comparison 接口 | **不新建**，复用/扩展 `/portfolios/summary` | PRD 验收 1 接口名以脚注修订 |
| Q-8 | UI 基础组件 | **甲：允许新增 shadcn `progress`/`switch`/`alert`** | 清单 5/6/41 所需；属扩充设计系统，不违反 C-07 |

> ⚠️ **范围变更提示**：Q-1 选 A 后，本轮不再是"纯前端第 1 批"，而是「前端对齐 + 后端小改(Q-2乙/Q-4甲) + 后端中改(Q-1 A 两模块)」的组合，建议分三阶段交付（见对话计划）。

### 9.1 ｜ `SecurityType` 共享现状与 Q-3 乙实现指引（侦察结论 · 2026-08-05）

**用户硬约束**：`SecurityType` 必须在 `packages/shared` 定义一次、前后端共用。

**侦察发现（已核实源码）**：
1. ✅ `SecurityType` **已存在于** `packages/shared/src/types/security.ts`（第 21–30 行），采用项目既定 `as const` 对象 + 派生类型范式（非 TS `enum`，为兼容 Prisma `$Enums.SecurityType` 与 ESM type-stripping），取值 `STOCK / FUND / BOND / CASH / OTHER`。
2. ✅ 共享 `HoldingQueryDto`（`types/security.ts` 第 193–198 行）**已预留** `types?: SecurityType[]` 字段。
3. ⚠️ **shared 的 barrel（`src/index.ts`）未导出 `SecurityType`**——当前仅导出 `CashFlowType`/`SecuritySide`/`SnapshotSource`/`SnapshotValuation`/`QueryGranularity`/`AggregationMethod`/`TransactionType`。要使「前后端共用」在 `@investment-tracker/shared` 层面真正打通，**必须**在 `index.ts` 补 `export { SecurityType } from './types/security.ts';`（建议同时 re-export `HoldingQueryDto` / `HoldingResponse` 等持仓契约，消除 web 端类型重复定义）。
4. ⚠️ **后端 `holding.controller.ts` 未使用 shared 的 `HoldingQueryDto`**，而是裸 `@Query()` 收 `date`/`securityId`/`includeClosed`，**完全忽略 `types`**——grep `HoldingQueryDto` 在 `packages/backend/src` 0 命中。

**Q-3 乙 精确改动清单（后端极小）**：
- `packages/shared/src/index.ts`：补 `export { SecurityType } from './types/security.ts';`（满足"前后端共用"）。
- `packages/backend/src/modules/holding/holding.controller.ts`：
  - `getHoldings` 新增 `@Query('types') types?: string`（支持逗号分隔 `types=STOCK,FUND` 或重复参数 `types=STOCK&types=FUND`）；
  - 解析后用 shared 的 `SecurityType` 值做白名单校验，得到 `typeList: SecurityType[] | undefined`；
  - 在现有 `securityId` 过滤之后追加 `const filtered = typeList ? items.filter(h => typeList.includes(h.securityType as SecurityType)) : items;`
  - **聚合无需改**：现有 `aggregate` 即对 `filtered` 子集 reduce，子集聚合自动正确（C-01 口径唯一在后端 ✅）。
  - `derive()` 返回的 `HoldingView.securityType` 已是字符串，可直接用于 `includes` 比对。
- 前端（`packages/web`）：
  - `api/types.ts` 的 `HoldingQuery` 入参补 `types?: SecurityType[]`；`holding.api.ts` 把 `types` 以逗号拼接传入；
  - `use-holdings.ts` 暴露 `types` 入参；持仓页「类型多选筛选」UI 用 `SecurityType` 渲染选项（股票/基金/债券/现金/其他）。
  - 汇总卡直接消费后端返回的 `aggregate`（不再前端求和，符合乙口径）。

> 注：本改动与清单 11（类型多选筛选）、清单 6（显示已清仓开关）、清单 5（占比进度条）在同一持仓页，建议合并排期。

**（本文档为纯分析交付物，不含任何实现代码。清单第 1~46 项可直接作为工单拆分依据；第 9 节为开工前决策记录，§9.1 为 Q-3 乙实现指引。）**
