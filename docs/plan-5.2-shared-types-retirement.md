# 计划：§5.2 共享 TypeScript 类型垫片退役

> 状态：**已执行（2026-08-09，数值策略 A）**。代码改动已全部落地并提交（见 `docs/ARCHITECTURE.md §5.2` 与 commit `52e21ef` / `b47db7a`）。
> 依据：`docs/ARCHITECTURE.md §5.2` + 前端实际代码核查（2026-08-09）。
> 实际提交与原 §8 三阶段拆分不同：因 `web/` 此前从未入库，退役改动随「前端初始提交」一并落地为单个 `feat(web)` commit，另加两笔 `chore` 清理/忽略提交。

## 1. 现状（已核实，非文档推断）

| 核查项 | 结果 |
|--------|------|
| `web/src/shared/index.ts`（垫片） | 仍存在，是事实上的类型真相源 |
| 引用 `@investment-tracker/shared` 的站点 | **约 60+ 处**（pages / features / components / lib / hooks / stores / api） |
| `tsconfig.json` + `vite.config.ts` paths | `@investment-tracker/shared` → `./src/shared/index.ts`（外部包已移除 ✓） |
| `web/src/types/api.ts`（OpenAPI 生成） | 已含 `UserPublicOut` 等后端 schema，但前端几乎未消费 |
| `web/src/api/types.ts` | 手写 api-client 层，**已部分用 `string`**（如 `cumulativeNav: string`，L510/583），并 re-export 自 `shared` |
| 数值漂移 | 垫片 `NavSeriesPoint.cumulativeNav: number`；`api/types.ts` 已是 `string`（后端 Decimal→str，C-02） |

## 2. 问题本质

1. **双真相源漂移风险**：后端改字段/枚举后，`types/api.ts` 随 `generate:api` 更新，但手写垫片 `shared/index.ts` 不会自动同步。
2. **number/string duality 被隐式兜住**：图表消费垫片 `number` 版，`api-client` 用后端 `string` 版，中间靠散落的 `Number(...)` 转换（`nav-trend-chart.tsx:129`、`use-query-data.ts:95` 等）。能跑，但是隐式契约。
3. **垫片混入了"永无后端对应"的类型**：纯前端概念（见 §3 Group 2）不可能来自 OpenAPI，因此"删垫片 + 全指向 api.ts"不可行，必须分类处理。

## 3. 垫片导出分类与处置映射

### Group 1 — 后端有对应 → 薄重导出 `components['schemas']['XOut']`（来自 `types/api.ts`）

| 垫片导出 | 后端来源 | 处置 |
|----------|----------|------|
| `CashFlowType` / `SecuritySide` / `SnapshotSource` / `SnapshotValuation` / `SecurityType` | `models/enums.py` 6 枚举 | `export type/const X = ...XOut` 或对齐后 re-export |
| `BUSINESS_ERROR_CODE` / `SUCCESS_CODE` / `SUCCESS_MESSAGE` | `core/enums.py` `BusinessErrorCode` + 信封常量 | re-export / 对齐 |
| `Portfolio` / `UserPublic` / `AssetSnapshot` / `CashFlow` | `schemas_resp.py` `*Out` | `export type X = components['schemas']['XOut']` |
| `ExportType` / `ImportType` / `ImportErrorCode` / `ImportRowError` / `ImportPreviewResult` / `ImportCommitResult` / `RecalcSummary` / `ImportRow` | OpenAPI DTO schema | 对齐后 re-export（需核实 OpenAPI 是否含对应 `*Out`） |

> ⚠️ **枚举值形态逐对校验**：shim 源自 `app/`（对齐 Prisma），后端枚举值预期一致，但退役前须逐字段比对，防止值漂移（如 `BUY_SEC` vs `BUY`）。

### Group 2 — 前端独有 → 迁入 `web/src/lib/`（永无后端对应）

| 导出 | 性质 |
|------|------|
| `QueryGranularity` / `AggregationMethod` / `NavMetric` | 查询 UI 概念，非后端枚举 |
| `FreshnessKind` / `FreshnessReason` / `FreshnessInfo` | 概览新鲜度，前端计算 |
| `MONEY_RE` / `isMoneyString` / `computeNetAmount` / `sumMoney` / `MoneyOptions` | 纯前端金额工具（Python 侧一律 Decimal，无对应物） |
| `PaginationQuery` / `Paginated` / `DateRangeQuery` | 前端分页/查询参数（非后端 schema） |
| `ApiResponse<T>` | 信封泛型——后端契约（C-01）但作为 TS 泛型属前端层；若 `types/api.ts` 已生成信封类型则 re-export，否则留 `lib/` |

### Group 3 — 数值 divergent → **待决策**（见 §4）

`NavSeriesPoint` / `XirrSeriesPoint`（`number` vs 后端 `string`）。

## 4. 数值策略（待用户拍板）

- **A. 边界转 number（推荐）**：后端保持 `string`；在取数边界（建议 `use-query-data.ts` 或 `query.api.ts`）统一 `string→number` 一次，图表零改。ECharts 本就只画 `number`，当前图表仅做展示（`formatPercent/formatDecimal`），无累积运算 → 无浮点误差，改动最小。
- **B. 图表全量 Decimal 化**：图表消费 `string` + decimal.js。代价大（5 图表 + 测试 + 依赖），但 ECharts 渲染前仍需转 `number`，故"彻底单一真相源"在图表层不成立，属过度设计。
- **C. 暂不动数值**：本次只收敛 Group 1/2，number/string duality 维持现状。

> 推荐 **A**：把散落各处的 `Number(...)` 收口到单一转换函数，既对齐后端又不动图表。

## 5. 执行步骤（对齐 → 过渡 → 清除，落地版）

**阶段一 · 对齐（先解决 Group 3 决策 + 枚举校验）**
1. 确认数值策略（A/B/C）。
2. 逐对校验 Group 1 枚举值形态与后端一致。
3. 补 `types/api.ts` 与图表/导入层的字段差异（若 A 则仅需在边界做 string→number）。

**阶段二 · 过渡（切换真相源，web 代码无需大改）**
4. 在 `web/src/lib/` 新建 `types.ts`（或 `contracts.ts`）：
   - re-export Group 1 后端类型：`export type Portfolio = components['schemas']['PortfolioOut']` 等。
   - 迁入 Group 2 前端独有枚举/工具/契约。
   - Group 3：定义单一 `NavSeriesPoint`/`XirrSeriesPoint`，由边界转换函数产出 `number` 版（策略 A）。
5. 将 `shared/index.ts` 内每个导出改为薄重导出指向 `lib/` 或 `types/api.ts`（**保留文件+别名**，web 代码暂不改动即可切换）。

**阶段三 · 清除**
6. 全量改写 `~60` 处 `import ... from '@investment-tracker/shared'` → `from '@/lib'` / `from '@/types/api'`。
7. 删除 `shared/index.ts`，撤掉 `tsconfig.json` + `vite.config.ts` 的 `@investment-tracker/shared` 别名。
8. 跑 `npm run build` + `npm run generate:api` 验证无类型错误、无残留引用。

## 6. import 站点清单（按模块，约 60+ 处）

- **lib/**：`constants.ts`、`api-client.ts`、`__tests__/shared-money-utils.test.ts`
- **api/**：`types.ts`、`query.api.ts`
- **features/**：`auth/login-form.tsx`；`transaction/transaction-list.tsx`；`snapshot/snapshot-list.tsx`、`snapshot/snapshot-form.tsx`；`portfolio/portfolio-dialog.tsx`；`security-trade/security-trade-form.tsx`、`security-trade-list.tsx` + `__tests__/*`；`overview/asset-metrics.ts`、`overview/total-asset-trend-chart.tsx`、`overview/freshness-banner.tsx` + `__tests__/*`；`holdings/holdings-query-params.ts`、`holdings/holdings-toolbar.tsx` + `__tests__/*`；`cashflow/cashflow-form.tsx`、`cashflow-list.tsx`；`query/dimension-switcher.tsx`；`security-income/dividend-fee-form.tsx`
- **stores/**：`portfolio.store.ts`
- **hooks/**：`use-query-data.ts`
- **pages/**：`nav-analysis.tsx`、`xirr-analysis.tsx`、`snapshots.tsx`、`settings.tsx`、`dashboard.tsx`、`HoldingsPage.tsx` + `__tests__/*`（settings / dashboard-* / holdings-*）
- **components/charts/**：`nav-trend-chart.tsx`、`xirr-trend-chart.tsx`、`monthly-heatmap.tsx`、`yearly-bar-chart.tsx` + `__tests__/*`

## 7. 风险与验证

- **回归面**：类型变更波及全前端，必须 `npm run build` 全绿 + 现有前端测试（`vitest`）全绿。
- **枚举值漂移**：Group 1 枚举退役前逐对校验，避免运行时值不匹配（如 `BUY_SEC` vs `BUY`）。
- **边界转换遗漏**：策略 A 下，须确认所有 `NavSeriesPoint`/`XirrSeriesPoint` 消费方都走统一转换函数，无残留裸 `Number()` 直接读后端 `string`。
- **OpenAPI 覆盖缺口**：若 `ImportPreviewResult` 等 DTO 在 `types/api.ts` 无对应 `*Out`，则该类型归入 Group 2（留 `lib/`），不可强行 re-export。

## 8. 交付与 commit 建议

- 分阶段提交，每阶段独立可回退：
  1. `feat(web): 建 lib/types 收敛后端类型 + 迁前端独有类型`
  2. `refactor(web): shared 垫片改为薄重导出（过渡）`
  3. `refactor(web): 清除 shared 垫片与 paths 别名`
- 同步更新 `docs/ARCHITECTURE.md §5.2`：标记退役完成、真相源唯一收敛到 Python OpenAPI。
- 不改动后端；不改动 `app/` 参考源。
