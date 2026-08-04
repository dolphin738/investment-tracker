# 净值分析页 + 出入金页 增量对齐设计 v1（前端为主 · 后端缺口标注/占位）

> 架构师：高见远（software-architect）
> 上游：`docs/PRD.md` v3.1.8（§7.1 / §7.6 / §6.2 FLOW- / §6.4 CASH- / §6.7 ANL- / §5.1 / §5.6 / §6.9 SET-P0-07 / §8）+ 任务书（主理人已知差距线索）
> 参考模式：`docs/incremental-analysis-snapshots-v1.md`（上一轮分析/资产记录域对齐：前端对齐为主、后端缺字段标注/占位、Gap D 占位口径、Part F 候选修复待主理人拍板）
> 核查方式：逐文件实读 PRD 相关章节 + 前端 10 个文件（transactions / nav-analysis / cashflow-form / cashflow-list / dimension-switcher / use-query-data / use-cash-balances / use-transactions / use-snapshots / api types+transaction+cash-balance / preference.store / App.tsx / constants）+ 后端 3 个模块（cashflow / cash-balance / recalculation）+ main.ts ValidationPipe，结论以源码为准
> 轮次约束：最小变更、不重构无关代码；后端缺口只标注，极小且当前页必需的在 Part F 单独列出供主理人决策

---

## 0. 结论速览（对任务书差距线索的验证 / 补全 / 纠正）

| # | 任务书线索 | 验证结论 |
|---|---|---|
| ① | 【C】类型筛选 checkbox 多选（FLOW-P0-02 验收1） | **确认差距**。现状 `transactions.tsx:114,421-430` 为单值 Select（全部/存入/取出）；PRD §7.1 L1031 为 `类型[✓存入 ✓取出]` checkbox 多选。**后端 DTO 亦只支持单值**：`CashFlowQueryDto.type`（`cashflow.dto.ts:90-93` `@IsEnum`）→ 多选需后端极小修复（**Part F-F2**）或前端近似（客户端过滤，见 Part B-1）。 |
| ② | FLOW-P0-02 验收2：筛选+排序写入 URL query | **确认差距**。`transactions.tsx:114-117` 的 `filterType/filterStartDate/filterEndDate/query` 均为本地 useState，无 `useSearchParams`；**排序**前后端均无（后端 `findAll` 硬编码 `orderBy: { date: 'desc' }`，`cashflow.service.ts:136`）。URL 透传可行性：后端白名单（`ValidationPipe forbidNonWhitelisted: true`，`main.ts:44-45`）已含 `startDate/endDate/type/page/pageSize`，axios `params` 直传 → **白名单内参数 URL 透传可行**；`types/sortBy/sortOrder` 需 Part F 扩 DTO。 |
| ③ | FLOW-P0-04：增删改后 toast 重算反馈（`{fromDate, affectedDays}` + 手工跳过提示） | **确认差距（双重）**。前端：`use-transactions.ts:58,81,101` 三个 mutation 的 toast 仅为「交易已录入/已更新/已删除」。后端：`recalculationService.recalculateRange` **已返回** `{ recalculatedDays, fromDate, toDate }`（`recalculation.service.ts:64-115`），但 `cashflow.service` 的 create/update/remove **丢弃返回值**，响应仅 `CashFlowResponse`/`null`（`cashflow.service.ts:82-105,170-207,214-235`）→ **后端极小修复（Part F-F3）**：把 recalc 结果并入响应。**手工跳过数** `recalculateRange` 亦未统计 → **Part F-F4**。前端 fallback：无字段时 toast 只显示「已重算（自 YYYY-MM-DD 起）」天数位 `-`，注释说明（沿用 use-snapshots 既有近似模式）。 |
| ④ | FLOW-P0-06 + SET-P0-07：保存出入金后「是否同步调整现金余额？[去更新]」软提示 | **确认差距**。SET-P0-07 开关**已完整落地**：`settings.tsx:616-630` 两开关 + `preference.store.ts:24-25` 默认 true + `api/types.ts:72-74` 字段 + `UserPreference` 服务端持久化 ✅。但 **`cashHintOnCashflow` 全仓无任何运行时消费**（grep 仅命中 settings/store/types）→ 出入金保存后软提示未接线（**前端可算**，无需后端）。 |
| ⑤ | 【B】现金余额区：CASH-P0-02 验收1「当前余额 ¥X（自 YYYY-MM-DD 起沿用）」 | **部分满足**。数据可用：`useLatestCashBalance`（`cash-balance.api.ts:56-62` asOf 倒序 pageSize=1）返回 `amount+asOf`，【A】卡已展示「现金余额 + 生效日」（`transactions.tsx:325-337`）。但 **【B】区无当前余额展示行**（PRD §7.1 L1023 要求置于输入框上方）；ⓘ 两条提示文案缺失（L1025-1027）；`[查看变更历史 ▾]`（CASH-P1-01，P1）缺失。判定：**部分**（【B】补展示行+提示，变更历史 P1 标注）。 |
| ⑥ | 页头 [组合: 我的组合▼] | **确认不重复加**：顶栏 `AppLayout` 全局 `PortfolioSelector` 已提供（上轮结论一致），PRD 草图为示意。 |
| — | 净值页快捷范围下拉未启用 | **确认差距**：`xirr-analysis.tsx:104` 已 `quickRanges={QUICK_RANGE_OPTIONS}`；`nav-analysis.tsx:179` 未传。`dimension-switcher.tsx:146-173` 已实现可选 `quickRanges` prop（`resolveQuickRange` 支持 3m/1y/ytd/all）。→ 一行开启 + 常量（**前端可算**）。 |
| — | 净值页 ANL-P0-05 逐条核对 | **基本齐全**：维度 Tab/指标单选/4 摘要卡/双线趋势（`NavTrendChart` legend 默认可点击隐藏单条线 ✅ DASH-P0-03 验收1）/热力图/每日明细表均在。**细节差异 2 处**：① 份额列显示 2 位小数（`nav-analysis.tsx:329-334` `minimumFractionDigits:2 maximumFractionDigits:2`），PRD ANL-P0-06 验收3 要求**份额 6 位**；② 收益% 公式当前为 `diff / prev.cumulativeNav`（`nav-analysis.tsx:84-86`），PRD 为 `每日收益 / 前一日总资产` —— **数学等价**（前一日总资产 = prevNav × prevShares，与分子 diff × prevShares 约分），无需改逻辑，仅注释澄清。 |
| — | 净值页「← 返回」页头 | **不新增**（侧栏已提供导航，沿用上轮 F7 口径，见 Part F-F7）。 |

---

## Part A · 两页差距清单（PRD 需求/草图 ↔ 现状 → 缺口判定）

### A1. 出入金管理页 `/cashflows`（PRD §7.1 + §6.2 FLOW- + §6.4 CASH- + §5.1）

| # | PRD 项（位置/ID） | PRD 要求 | 现状（文件:行） | 缺口判定 |
|---|---|---|---|---|
| C1 | §7.1 页头 / FLOW-P0-01 验收4 | 标题「出入金管理」+「[+ 新增出入金]」；路由 `/transactions` → `/cashflows` 301 | `transactions.tsx:271-282` 标题「出入金」+「录入出入金」✅；`App.tsx:113-120` 仅注册 `cashflows`，**无 `/transactions` 301**（访问 `/transactions` 走 404） | **部分**：文案小差异（可对齐「出入金管理」「+ 新增出入金」）；**301 路由缺失** → 前端补 `<Navigate>`（低成本） |
| C2 | §7.1【A】 / FLOW-P0-03 验收1-2 | 总资产展示卡：总额 + 拆解（持仓/现金 + 各自 asOf）+ 卡片主体无输入控件 + 「管理历史记录 →」 | `transactions.tsx:285-354`：三格展示 ✅、纯展示无输入 ✅、「查看全部历史」「⚙ 管理历史记录 →」双入口 ✅（`?manage=1` 已由 snapshots 页消费，`snapshots.tsx:35-36`） | **已满足**（asOf：总资产用 `overview.latestDate`、现金用 `latestBalance.asOf`；PRD 草图另列持仓估值日，可后续增强，非阻塞） |
| C3 | §7.1【A】 / FLOW-P0-03 验收5-6 | 常驻文案「由系统每日自动记录；如需补录或修正历史，请前往「管理历史记录」」；`source='MANUAL'` 显示 `✋手工` 徽标 + 「系统自动计算值为 ¥X」 | `transactions.tsx:289` 说明为「纯展示 · 近 30 日走势与手工记录标记」≠ PRD 文案；手工日仅在走势图有散点标记（`:134-140,194-202`），**无 ✋ 徽标**、无「系统自动计算值」（`derivedTotalAsset` 后端未暴露，见 Part B-3） | **部分**：文案需对齐 + ✋ 徽标需补；「系统自动计算值为 ¥X」依赖后端 `derivedTotalAsset` → **后端缺口（非本轮，F5 口径）**，前端以 `cumulativeNav×shares` 近似 + 注释 |
| C4 | §7.1【A】走势图 / SNAP-P0-04b | 近 30 日迷你曲线 + ⓘ 平直段/✋ 说明 | `transactions.tsx:96-106,120-204`：30 日曲线 ✅（`cumulativeNav × shares` 还原总资产）、手工散点 ✅；ⓘ 说明文字缺失 | **部分**：可补 ⓘ 图例说明（低成本） |
| C5 | §7.1【B】 / CASH-P0-02 验收1 | 「当前余额 ¥100,000.00（自 2026-08-02 起沿用）」+ 金额输入 + 生效日期 + 保存 | `transactions.tsx:356-408`：输入框+日期+保存 ✅；**无当前余额展示行**（【A】卡有「现金余额+生效日」）；无「自 X 起沿用」文案 | **部分**：**【B】补展示行**（数据已有：`latestBalance.data.amount/asOf`） |
| C6 | §7.1【B】 / CASH-P0-03 | ⓘ「存取与证券买卖不会自动调整此值…」+ ⓘ「修改后自该日起的自动总资产记录将重新计算（您手工记录的日期会被跳过）」+ toast 重算范围 | `transactions.tsx:360-362` 说明为「维护组合现金余额，生效日起前向沿用；保存后触发净值/XIRR 重算」；`use-cash-balances.ts:70` toast「现金余额已保存」无重算范围 | **部分**：ⓘ 两条提示文案需补（含「手工记录跳过」口径）；toast 重算范围依赖后端 recalc 返回（Part F-F3 通用修复后一并受益） |
| C7 | §7.1【B】 / CASH-P1-01 | [查看变更历史 ▾]：历次变更（日期/金额/备注）可编辑删除 | **全缺**。后端 `GET /cash-balances` 列表接口已有（`cash-balance.controller.ts:40-46`，分页+日期范围）→ **前端可算**，但 **P1 项** | **缺失（P1）**：本轮默认不做，列入 Part F-F8 待主理人拍板；若做则复用 `useCashBalances` + 折叠区 |
| C8 | §7.1【C】 / FLOW-P0-02 验收1 | 类型筛选 checkbox 多选（✓存入 ✓取出） | `transactions.tsx:421-430` 单值 Select | **缺失** → 改多选 checkbox；后端 `type` 单值 → **Part F-F2** |
| C9 | §7.1【C】 / FLOW-P0-02 验收2 | 筛选与排序写入 URL query，刷新/分享保持 | `transactions.tsx:114-117,223-235` 全本地 state，无 URL | **缺失** → 前端 `useSearchParams` 读写（白名单参数直接透传；types/sort 依赖 Part F） |
| C10 | §7.1【C】 / FLOW-P0-02 | 排序（日期·金额，升降序）；分页 20/50/100 | 排序：前后端均无（后端硬编码 date desc，`cashflow.service.ts:136`）；分页：`cashflow-list.tsx:54` `PAGE_SIZE=20` 固定，无切换 | **缺失**：排序需 Part F-F5（后端 DTO+service 加 sortBy/sortOrder，极小）；分页大小切换纯前端 |
| C11 | §7.1【C】 / FLOW-P0-02 验收5 | 结果为空时显示空状态 + 清除筛选按钮 | `cashflow-list.tsx:100-103` 有空状态文案（`emptyText`），**无清除筛选按钮** | **部分** → 补「清除筛选」按钮（前端） |
| C12 | §7.1【C】 / FLOW-P0-07 | 空值 `-`；移动端折叠卡片；金额右对齐等宽；存入红取出绿 | `cashflow-list.tsx:117-147`：`note || '-'` ✅、金额右对齐 tabular-nums ✅、Badge 红/绿 ✅（`bg-up-soft text-up`/`bg-down-soft text-down`）；**无 <768px 卡片式折叠** | **部分**：移动端布局缺失（低成本 CSS，P0-07 验收2） |
| C13 | §7.1 弹窗 / FLOW-P0-05 | 类型/日期/金额/备注，不含证券字段；`amount>0`、日期不可未来、首笔必须为存入 | `cashflow-form.tsx:29-40` zod：amount>0 ✅、日期不可未来 ✅；字段集 ✅ 无证券字段；**「首笔必须为存入」未校验**（前端无、后端 service 也无） | **部分**：首笔校验缺失（低优先，标注；需后端查询首笔或前端先查列表，建议 Part F 或明确不做） |
| C14 | FLOW-P0-04 验收4-5 | 重算 toast 反映被重写自动记录条数 + 「其中 N 天为您的手工记录，已跳过」 | 前端 toast 无；后端 `recalculateRange` 返回 `recalculatedDays`（= NAV 重算天数，非自动记录条数）且未统计手工跳过天数 | **后端缺口**：需拆分「更新 X 条自动记录 / 跳过 Z 条手工记录」→ **Part F-F4**；前端 fallback 近似 |
| C15 | FLOW-P0-06 / SET-P0-07 | 保存成功后 toast +「是否同步调整现金余额？[去更新]」；可设置关闭 | **全缺**：`cashHintOnCashflow` 无消费点 | **缺失** → 前端接线（读偏好 → 弹软提示 → 「去更新」跳转锚点/聚焦【B】输入框）；无需后端 |
| C16 | §7.1 L1055-1058 交互边界 | 【A】卡主体禁输入 + 必须提供「⚙ 管理历史记录 →」 | `transactions.tsx:292-302` ✅（双入口均跳 /snapshots，后者带 `?manage=1`） | **已满足** |

### A2. 净值分析页 `/analysis/nav`（PRD §7.6 + §6.7 ANL- + §5.6 + DASH- 复用）

| # | PRD 项（位置/ID） | PRD 要求 | 现状（文件:行） | 缺口判定 |
|---|---|---|---|---|
| N1 | §7.6 页头 | 「← 返回」「净值分析」「[组合: ▼]」 | `nav-analysis.tsx:171-176` 仅标题；组合选择全局已有 ✅；返回按钮无（同 XIRR 页，不新增，F7） | **已满足**（组合选择全局；返回不新增） |
| N2 | §7.6 维度行 / DASH-P0-02 | 维度[日][周][月][年] + 范围（快捷项：近3月/近1年/今年/全部）；默认「月+近1年」可被偏好覆盖 | `nav-analysis.tsx:179` `DimensionSwitcher`（Tab ✅ 起止日期 ✅ 聚合 ✅ 默认维度读偏好 ✅ `:113`）；**未传 `quickRanges`** | **缺失**：传 `quickRanges={QUICK_RANGE_OPTIONS}`（一行）+ 常量（可复用 XIRR 页常量，抽到共享处） |
| N3 | §7.6 指标单选 / DASH-P0-03 | (●)累计净值 ( )当年净值 ( )对比 | `nav-analysis.tsx:48-52,181-191` RadioGroup 三选项 ✅ | **已满足** |
| N4 | §7.6 摘要卡 / ANL-P0-05 | 当前累计净值/当年净值/累计收益/当年收益 4 卡 | `nav-analysis.tsx:194-242` 4 卡 ✅（`useLatestNav` + 净值-1 算收益） | **已满足** |
| N5 | §7.6 双线趋势 / DASH-P0-03 | 累计+当年双线对比；图例可点击；hover 日期+两净值 4 位 | `NavTrendChart`（`nav-trend-chart.tsx:91-94` legend 可点选 ✅；tooltip 4 位 ✅ `:85`）；指标过滤 `nav-analysis.tsx:152-160`（单选时置空另一条线）✅ | **已满足** |
| N6 | §7.6 月度热力图 / DASH-P2-03 | 年份×月份，正红负绿色阶 | `monthly-heatmap.tsx` 按 (年,月) 末 yearNav 环比、visualMap 绿→红 ✅（`monthly-heatmap.tsx:126-138`）；数据来自日维度 `daySeries` ✅ | **已满足** |
| N7 | §7.6 每日净值明细表 / ANL-P0-06 | 列：日期/累计净值/当年净值/每日收益/收益百分比/份额；每日收益=(当日净值−前日净值)×前日份额；收益%=每日收益/前一日总资产；净值 4 位、**份额 6 位**；正红负绿 | `nav-analysis.tsx:265-343` 6 列 ✅；`computeDailyDetails` `:68-100` 公式 ✅（收益%用 diff/prevNav，数学等价见 §0）；正红负绿 ✅（`text-up/text-down`）；**份额列显示 2 位**（`:329-334`） | **部分**：份额改 6 位（`maximumFractionDigits:6`）；表头「收益%」→ 可对齐「收益百分比」（低成本）；公式加注释澄清 |
| N8 | §7.6 明细表脚注 | 口径说明（* 每日收益 = …；* 收益百分比 = …；* 正红负绿） | `nav-analysis.tsx:268-270` CardDescription 有「每日收益 =（当日累计净值 − 前日累计净值）× 前日份额；正红负绿」✅，缺「收益百分比 = 每日收益 / 前一日总资产」一句 | **部分**：补脚注（低成本） |
| N9 | ANL-P0-03 周期聚合 | 默认取各周期最后一个计算日，可在设置切换平均值 | `nav-analysis.tsx:116` 聚合默认硬编码 `LAST`（未读偏好 `aggregation`）；DimensionSwitcher 有聚合切换 UI | **部分**：默认聚合读偏好（`getPreference('aggregation')`，一行，同 XIRR 页现状一致，可一并修） |
| N10 | ANL-P0-01/02 | 多维度查询 + 折线图渲染 | 后端 `NavQueryDto` 支持 granularity/aggregation/metric/日期范围 ✅（`query.dto.ts:42-69`）；前端图表 ✅ | **已满足** |
| N11 | 范围联动（热力图/明细表） | 热力图与明细表随范围变化 | `nav-analysis.tsx:129-136` `dayParams` 继承 `dimension` 的 startDate/endDate，仅强制 DAY 粒度 ✅ | **已满足**（技术必需，注释已说明） |
| N12 | 空态 | 无数据不白屏 | 摘要卡 `暂无数据` ✅；明细表 `暂无数据` ✅（`:276-278`）；图表空态由 Chart 组件处理 ✅ | **已满足** |

---

## Part B · 数据可用性核查结论（逐项：已有 / 前端可算 / 后端缺口）

| # | 能力 | 现状核查 | 判定 | 建议（若后端缺口） |
|---|---|---|---|---|
| B1 | **类型多选（types: BUY/SELL 数组）** | 前端 `TransactionQuery.type?` 单值（`api/types.ts:357`）；后端 `CashFlowQueryDto.type` 单值 `@IsEnum`（`cashflow.dto.ts:90-93`）+ `forbidNonWhitelisted` → 发送 `types[]` 即 400 | **后端缺口（极小且当前页必需，P0）** | `CashFlowQueryDto` += `@IsOptional() @IsEnum(CashFlowType, { each: true }) types?: CashFlowType[]`（class-validator 用 `@IsEnum(..., { each: true })`，Swagger 用 `type: [String]`）；`cashflow.service.findAll` where `type: { in: query.types }`。**候选修复见 Part F-F2**。前端 fallback：多选后取交集页内过滤不可行（服务端分页），故**推荐批准 F2**；不批准则 UI 仍为多选但仅单选生效 + 注释 |
| B2 | **URL query 透传** | 前端 axios `params` 直传；后端白名单已有 `startDate/endDate/type/page/pageSize`（`cashflow.dto.ts:79-109`）→ 白名单内参数**可直接写 URL** 并由后端消费 | **已有（白名单内）** | 前端 `useSearchParams` 读写；`types/sortBy/sortOrder` 待 Part F 扩白名单 |
| B3 | **重算反馈 {fromDate, affectedDays}** | `recalculationService.recalculateRange` 返回 `{ recalculatedDays, fromDate, toDate }`（`recalculation.service.ts:64-115`）；**cashflow.service create/update/remove 丢弃返回值**（`cashflow.service.ts:102,204,232` 仅 `await`）→ API 响应无该结构；`remove` 返回 `null` | **后端缺口（极小，P0）** | create/update 响应 `{ ...CashFlowResponse, recalculation: { fromDate, affectedDays } }`；remove 返回 `{ recalculation }`。**候选修复见 Part F-F3**。前端 fallback：mutation `onSuccess(data)` 读取 `data?.recalculation`，缺失时 toast「已重算（自 YYYY-MM-DD 起）」天数位 `-` + 注释 |
| B4 | **手工记录被跳过提示（N 天）** | `recalculateRange` 的 `getEventDates` 未统计 MANUAL 日期；`persistDerived` 遇 MANUAL 跳过但不计数 | **后端缺口（极小，P0 验收5）** | `recalculateRange` 返回值 += `skippedManualDays`（统计 eventDates 中 `source='MANUAL'` 的日期数，1 次 `findMany` 查询）。**候选修复见 Part F-F4**。前端 fallback：用 `useSnapshots` 查 `[fromDate, today]` 区间 MANUAL 行数近似 + 注释，或仅显示主文案 |
| B5 | **现金余额「当前余额+沿用日」展示** | `useLatestCashBalance` → `{ amount, asOf }`（`cash-balance.api.ts:56-62`）✅；【A】卡已展示；【B】需补展示行 | **前端可算**（无需后端） | — |
| B6 | **现金余额变更历史（CASH-P1-01）** | 后端 `GET /cash-balances` 列表已有（分页+日期范围，`cash-balance.controller.ts:40-46`）；前端 `useCashBalances` 已有（`use-cash-balances.ts:34-46`） | **已有（P1 项）** | 本轮默认不做 UI（Part F-F8）；若做：`useCashBalances` + 折叠区（日期/金额/备注/删除），删除复用 `useDeleteCashBalance` |
| B7 | **快捷范围下拉（净值页）** | `dimension-switcher.tsx:146-173` 已实现可选 `quickRanges` + `resolveQuickRange`（3m/1y/ytd/all）；XIRR 页已启用 | **前端可算**（无需后端） | nav 页传 `quickRanges`；常量抽共享避免两页重复定义 |
| B8 | **软提示偏好接线（cashHintOnCashflow）** | 偏好字段 + settings 开关 + store `getPreference` 全部就绪；**无运行时消费** | **前端可算**（无需后端） | cashflow 保存成功回调读 `getPreference('cashHintOnCashflow')` → `toast('是否同步调整现金余额？', { action: '去更新' })` 或 `sonner` action；`false` 时不弹 |
| B9 | **当日「系统自动计算值」（FLOW-P0-03 验收6）** | 后端 `AssetValuationService.computeDerived` 存在但未在总资产卡接口暴露（同上一轮 F5）；前端可 `cumulativeNav × shares` 近似（`transactions.tsx:128` 已在走势图用此还原） | **后端缺口（非本轮）** | 沿用上一轮 F5 口径：`OverviewResponse` 或快照列表加 `derivedTotalAsset`；本轮前端近似 + 注释，不阻塞 |
| B10 | **排序（sortBy/sortOrder）** | 后端 `findAll` 硬编码 `orderBy: { date: 'desc' }`；DTO 无 sort 字段 | **后端缺口（极小，P0 验收「排序」）** | `CashFlowQueryDto` += `sortBy?: 'date' \| 'amount'`、`sortOrder?: 'asc' \| 'desc'`；service 构造 orderBy。**候选修复见 Part F-F5**。前端 fallback：先做日期升降序（前端对当前页排序不可靠，建议批准 F5） |
| B11 | **「首笔必须为存入」校验（FLOW-P0-05 验收3）** | 前后端均未实现 | **后端缺口（低优先）** | `cashflow.service.create`：当组合无任何 CashFlow 且 `type !== 'BUY'` → 400「首笔必须为存入」。**候选修复见 Part F-F6**（极小，3 行）；不做则标注 |

---

## Part C · 文件清单（仅前端改动/新增；后端缺口见 Part B / Part F，本轮不实现）

| 文件 | 端 | 改动点 |
|---|---|---|
| `packages/web/src/api/types.ts` | 前端 | `TransactionQuery` 补 `types?: ('BUY'\|'SELL')[]`（F2 获批后发送，否则注释禁发）、`sortBy?/sortOrder?`（F5 获批后发送）、`pageSize` 注释 20/50/100；`TransactionResponse` 预留可选 `recalculation?: { fromDate: string; affectedDays: number }`（F3 获批后后端返回，缺失即 undefined） |
| `packages/web/src/api/transaction.api.ts` | 前端 | 无需大改（axios `params` 直传，新参数随类型透传）；仅补注释「URL query 透传白名单：startDate/endDate/type/types/page/pageSize/sortBy/sortOrder（后者待 F2/F5）」 |
| `packages/web/src/hooks/use-transactions.ts` | 前端 | 三个 mutation `onSuccess(_data, variables)`：① toast 升级为重算反馈（读 `data?.recalculation`，缺失走 fallback 近似 + 注释）；② FLOW-P0-06 软提示（读 `getPreference('cashHintOnCashflow')`，`true` 时 toast +「去更新」action）；③ invalidate 不变；`transactionsKey` 依赖 query 对象含新字段自动生效 |
| `packages/web/src/hooks/use-cash-balances.ts` | 前端 | （可选，随 F3 通用修复）`useUpsertCashBalance` toast 升级「现金余额已保存 · 已重算自 {asOf} 起」；默认保持现状 + 注释（CASH-P0-03 范围反馈依赖后端 recalc 并入） |
| `packages/web/src/features/cashflow/cashflow-list.tsx` | 前端 | `CashflowListProps.typeFilter` 改为 `types?: ('BUY'\|'SELL')[]`（空数组=全部；F2 获批后透传 `types`，否则降级单值 `type` + 注释）；分页条加 pageSize 选择（20/50/100）；空态加「清除筛选」按钮（回调 prop `onClearFilter?`）；编辑/删除 onSuccess 复用 T01 的 toast 升级（经 `use-transactions` 自动生效） |
| `packages/web/src/features/cashflow/cashflow-form.tsx` | 前端 | `onSuccess` 签名扩展 `onSuccess?: (result?: TransactionResponse) => void`（把 mutation 响应回传页面，供软提示/关闭弹窗）；「首笔必须为存入」提示（若 F6 未获批则仅后端报错透传） |
| `packages/web/src/pages/transactions.tsx` | 前端 | 【C】筛选改 checkbox 多选（存入/取出 + 全选语义）；筛选/分页/排序写 `useSearchParams`（刷新保持）；pageSize 状态；【B】补「当前余额 ¥X（自 YYYY-MM-DD 起沿用）」展示行 + 两条 ⓘ 提示 + 「查看变更历史 ▾」折叠（P1，见 Part F-F8）；FLOW-P0-06 软提示「去更新」→ 滚动/聚焦【B】金额输入框；页头文案对齐「出入金管理」「+ 新增出入金」（低成本） |
| `packages/web/src/App.tsx` | 前端 | 补 `/transactions` → `/cashflows` 301：`{ path: 'transactions', element: <Navigate to="/cashflows" replace /> }`（React Router 内 replace 即 301 语义；若需真实 301 由部署层配置，见 Part F-F9） |
| `packages/web/src/pages/nav-analysis.tsx` | 前端 | `DimensionSwitcher` 传 `quickRanges`（常量从共享处 import）；份额列显示 6 位；表头「收益百分比」+ 脚注补「收益百分比 = 每日收益 / 前一日总资产」；`returnRate` 公式加等价注释；聚合默认读 `getPreference('aggregation')`（N9，一行） |
| `packages/web/src/features/query/dimension-switcher.tsx` | 前端 | 导出共享 `QUICK_RANGE_OPTIONS`（从 xirr-analysis 挪入，两页复用；`resolveQuickRange` 已支持） |
| `packages/web/src/pages/xirr-analysis.tsx` | 前端 | 改用共享 `QUICK_RANGE_OPTIONS`（去重，行为不变） |

> 不改动：`app-layout.tsx` / `portfolio-selector.tsx`（组合选择全局已有）；`lib/utils.ts`（格式化工具足够）；后端模块本轮零改动（除 Part F 候选修复待主理人决策）。

---

## Part D · 任务列表（按实现顺序，≤5 任务，依赖最小化）

| Task | 名称 | 源文件 | 依赖 | 优先级 | PRD ID |
|---|---|---|---|---|---|
| **T01** | 数据契约 + 基建：类型扩展 + mutation toast/软提示 + 301 路由 | `api/types.ts`、`hooks/use-transactions.ts`、`api/transaction.api.ts`、`App.tsx` | — | P0 | FLOW-P0-04 / FLOW-P0-06 / FLOW-P0-01 / SET-P0-07 |
| **T02** | 出入金页【C】流水区：多选筛选 + URL query + 分页大小 + 空态清除 | `pages/transactions.tsx`（筛选/URL/分页）、`features/cashflow/cashflow-list.tsx`（types 透传/分页/空态按钮）、`features/cashflow/cashflow-form.tsx`（onSuccess 回传） | T01 | P0 | FLOW-P0-02 / §7.1 L1031 |
| **T03** | 出入金页【B】现金余额区 + 软提示联动：当前余额展示行 + ⓘ 提示 + 「去更新」 | `pages/transactions.tsx`（【B】区 + 软提示聚焦）、`hooks/use-cash-balances.ts`（toast 增强注释）、`features/cashflow/cashflow-form.tsx`（软提示触发参数，与 T02 合并提交防冲突） | T01 | P0 | CASH-P0-02 / CASH-P0-03 / FLOW-P0-06 |
| **T04** | 净值分析页：快捷范围 + 份额 6 位 + 口径脚注 + 聚合默认读偏好 | `pages/nav-analysis.tsx`、`features/query/dimension-switcher.tsx`（共享常量）、`pages/xirr-analysis.tsx`（去重引用） | — | P0 | DASH-P0-02 / ANL-P0-05 / ANL-P0-06 / ANL-P0-03 |
| **T05** | 联调验收 + 文档收口 | `docs/incremental-analysis-cashflow-v1.md`（复核）、回归清单（出入金 CRUD / 多选筛选 / URL 刷新保持 / 软提示开关 / 净值页快捷范围 / 双页组合联动） | T02, T03, T04 | P1 | 全局一致性 |

**执行建议**：T01 → T02/T03 与 T04 可并行（T02/T03 都碰 `pages/transactions.tsx`，建议串行或约定 T02 只动【C】区、T03 只动【B】区，最后统一提交）；T05 收口。若 Part F 后端候选修复（F2-F5）获批，应先行落地后端再进 T02/T03，前端 types/sort 改为服务端传参（Part E-3 注释同步解除）。

---

## Part E · 共享知识（跨文件口径约定）

1. **类型筛选多选语义**：UI 为 checkbox「✓存入 ✓取出」；**空数组（全不勾）= 全部**（与「重置」一致，避免歧义）；勾选一个 = 仅该类；勾选两个 = 全部（后端传 `types=['BUY','SELL']` 与不传等价）。F2 获批前前端降级为单值 `type` 透传 + 注释（多选 UI 仍可勾选但仅单选生效，避免静默 400）。
2. **URL query 参数名**（对齐后端 DTO 白名单，避免 `forbidNonWhitelisted` 400）：`startDate`/`endDate`（日期 YYYY-MM-DD，已支持）、`type`（单值，已支持）、`types`（F2 后，逗号分隔 `types=BUY,SELL`）、`sortBy=date|amount` + `sortOrder=asc|desc`（F5 后）、`page`/`pageSize`（已支持）。前端 `useSearchParams` 读写，`pageSize` 默认 20。
3. **toast 文案（FLOW-P0-04 / CASH-P0-03）**：主文案「已重算 {fromDate} 起 {N} 天的净值与 XIRR」；N = `recalculation.affectedDays`（后端 F3 返回）；缺失时显示「已重算（自 {fromDate} 起）」+ 注释（沿用 use-snapshots 既有近似模式）。F4 获批后追加「＋ 更新 {M} 条自动总资产记录，跳过 {Z} 条手工记录」（后端拆分返回值）；未获批时手工跳过提示省略 + 注释。
4. **软提示开关读取**：`usePreferenceStore((s) => s.getPreference)('cashHintOnCashflow')`（默认 true）；`true` → toast「是否同步调整现金余额？」+ action「去更新」（滚动/聚焦【B】金额输入框）；`false` → 不弹软提示，**重算 toast 仍保留**。绝不自动修改 `CashBalance`（FLOW-P0-06 验收2）。
5. **现金余额沿用展示**：「当前余额 ¥X（自 YYYY-MM-DD 起沿用）」= `useLatestCashBalance`（asOf 倒序第一条）的 `amount` + `asOf`；无记录显示「未维护，可在下方录入」（现状【A】卡已有同口径，【B】复用）。
6. **重算反馈字段命名**：前端统一读 `response.recalculation = { fromDate: string; affectedDays: number }`（create/update）；`delete` 返回 `{ recalculation }`；`fromDate` 为 YYYY-MM-DD 字符串。F4 扩展 `updatedAutoDays` / `skippedManualDays` 时沿用驼峰。
7. **金额/百分比/份额跨网约定**：沿用账户域口径 —— 金额 string 2 位、净值 4 位、**份额 6 位**（ANL-P0-06 验收3）、收益% 2 位；「无数据」渲染 `-`，禁止渲染 0；正红负绿（§9.5）。
8. **净值页收益%等价口径**：`每日收益 / 前一日总资产 = (Δnav × prevShares) / (prevNav × prevShares) = Δnav / prevNav`，故 `nav-analysis.tsx` 现有 `diff / prev.cumulativeNav` 与 PRD 公式数学等价，**不改逻辑**，仅补注释说明；「前一日」语义 = 前一个**有记录**的计算日（与 PRD「前一日」在稀疏日期下的可接受近似，待主理人确认，Part F-F10）。

---

## Part F · 待明确事项 / 风险登记（需主理人/用户拍板）

| # | 事项 | 现状结论 | 建议 | 需谁确认 |
|---|---|---|---|---|
| F1 | **类型多选 UI 形态** | PRD 草图 checkbox 多选；现状单值 Select | 本轮改 checkbox 多选；**后端 F2 未批准前仅单选生效**（多选 UI + 降级透传 + 注释） | 主理人 |
| F2 | **后端极小修复①：类型多选**（约 5 行） | `CashFlowQueryDto` 加 `types` 数组 + `findAll` where `type: { in }`；不改 schema、无迁移 | **建议批准**（FLOW-P0-02 P0 验收1 硬性要求；不批准则多选功能不完整） | 主理人 |
| F3 | **后端极小修复②：重算反馈透出**（约 6 行） | `cashflow.service` create/update 响应并入 `recalculation: { fromDate, affectedDays }`（`recalculateRange` 已返回，仅未透出）；remove 返回 `{ recalculation }` | **建议批准**（FLOW-P0-04 P0 验收1；不批准则前端 fallback 近似天数） | 主理人 |
| F4 | **后端极小修复③：手工跳过统计**（约 5 行） | `recalculateRange` 返回值 += `skippedManualDays`（事件日中 MANUAL 日期数） | **建议批准**（FLOW-P0-04 验收5；不批准则前端用 snapshots 区间 MANUAL 数近似或省略） | 主理人 |
| F5 | **后端极小修复④：排序参数**（约 6 行） | `CashFlowQueryDto` 加 `sortBy/sortOrder` + service 构造 orderBy | **建议批准**（FLOW-P0-02 验收2 含排序；不批准则本轮只做日期降序现状 + 前端排序 UI 占位） | 主理人 |
| F6 | **后端极小修复⑤：首笔必须为存入**（约 3 行） | `cashflow.service.create` 组合无任何 CashFlow 且 `type!=='BUY'` → 400 | **可选批准**（FLOW-P0-05 验收3；不批准则标注为已知缺口） | 主理人 |
| F7 | **「← 返回」按钮** | 侧栏已提供导航（上轮 F7 已决） | **不加**（保持全局一致性）；若坚持草图，加 `navigate(-1)` 轻量实现 | 主理人/用户 |
| F8 | **【B】「查看变更历史 ▾」（CASH-P1-01，P1）** | 后端列表接口已有，前端 `useCashBalances` 已有 | **本轮默认不做**（P1 项，避免扩大改动）；若做：折叠区 + 删除按钮，删走 `useDeleteCashBalance` | 主理人 |
| F9 | **/transactions 301 语义** | 前端 `Navigate replace` 为 SPA 内重定向；真实 HTTP 301 需部署层（Nginx/Vite preview）配置 | 本轮前端 `Navigate replace` 满足路由可达；部署层 301 列为后续运维项 | 主理人 |
| F10 | **净值页「前一日」语义（稀疏日期）** | PRD「前一日」字面为日历日；当前实现 = 前一个**有记录**计算日 | 维持现状（有记录日，金融口径常见）+ 注释；若产品要求严格日历日，需后端补全日期序列（成本高，不推荐） | 主理人/用户 |
| F11 | **净投入本金/累计收益口径**（净值页摘要卡副文案） | 摘要卡已用 `latestNav - 1` 计算收益，无独立净投入卡（PRD §7.6 4 卡已满足） | 维持现状；无需动作 | — |

---

## Part G · 任务验收清单（T05 用，逐条可勾）

1. 出入金页：页头「出入金管理」+「+ 新增出入金」；【A】卡纯展示 + 双跳转入口 + ⓘ/✋ 说明（近似口径注释）。
2. 【C】类型筛选为 checkbox 多选（存入/取出，全不勾=全部）；日期范围筛选；筛选/分页/排序写入 URL query，刷新/分享后保持。
3. 分页支持 20/50/100 切换；空结果显示空状态 + 「清除筛选」按钮；移动端 <768px 折叠卡片布局。
4. 出入金增/改/删后 toast 显示重算反馈：F3 获批 =「已重算 {fromDate} 起 {N} 天」+（F4）「更新 {M} 条自动记录，跳过 {Z} 条手工」；未获批 = fallback「已重算（自 {fromDate} 起）」+ 注释。
5. FLOW-P0-06 软提示：保存后按 `cashHintOnCashflow` 决定是否弹「是否同步调整现金余额？[去更新]」；「去更新」聚焦【B】输入框；设置页开关关闭后不再弹；重算 toast 不受开关影响。
6. 【B】现金余额区：输入框上方显示「当前余额 ¥X（自 YYYY-MM-DD 起沿用）」+ 两条 ⓘ 提示（含手工记录跳过口径）；保存后 toast 反馈（CASH-P0-03）。
7. 净值分析页：快捷范围下拉（近3月/近1年/今年至今/全部）可用；份额列 6 位；明细表头/脚注对齐 PRD；聚合默认读偏好。
8. `/transactions` 访问重定向至 `/cashflows`；侧栏「出入金」「净值分析」入口正常。
9. 组合切换（顶栏）后两页数据联动刷新；无数据/加载失败四态不白屏；全仓无新增后端改动（除非 Part F 候选获批）。
