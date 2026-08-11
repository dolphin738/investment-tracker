# 出入金管理页 UI 修复与改版 — 交付概览（2026-08-11）

## TL;DR
三项需求（持仓类型筛选器生效、热力图月份轴修复、出入金页改版）已全部实现、本地提交，全量前端测试 **482 passed / 0 failed**。未 push（按约定改动完自动提交但不 push）。

## 交付清单

### ① 持仓页类型筛选器对买卖明细生效 — `c5fe770`
- 根因（上次 `038c71a` 没修好的原因）：
  1. `HoldingsPage` 原 `if (effectiveSecIds.length > 0)` 一刀切，空数组被当「不过滤」→ 用户选了类型却看到全部记录。
  2. `listSecurities` 从未传 `pageSize`，后端默认 20；标的 >20 的组合映射字典残缺。
- 修复：抽纯函数 `deriveTradeSecurityFilter`（ready/loading/empty 三态），`SecurityTradeList` 非 ready 传 `portfolioId=null` 关查询；`listSecurities` 改 `pageSize=500`。
- 文件：`web/src/features/holdings/trade-security-filter.ts`（新）· `web/src/features/security-trade/security-trade-list.tsx` · `web/src/api/security.api.ts` · `web/src/features/holdings/holdings-query-params.ts` 等。

### ② 净值分析收益热力图月份显示不全 — `b3c07da`
- 根因：月份轴由原数据推导（只显示有数据的月份）；`monthKey` 未补零致 `2026-10/11/12` 排到 `2026-2` 前，环比配对错乱、月度收益率算错。
- 修复：月份轴恒定 1–12 月，无数据留空；`monthKey` 补零；跨年首月 `year_nav` 基准取 1.0（对齐后端 `finance_core/nav.py:7`）。正红负绿配色保留。
- 文件：`web/src/components/charts/monthly-heatmap.tsx`（含 7 个单测已通过）。

### ③ 出入金管理页改版 — `7eca5af`
- 顶部**统一筛选器**：日期范围对「出入金流水」与「现金余额」同时生效，类型/排序标注「仅流水」。
- 两个块改为**持仓页同款 Tabs 分页切换**（cashflow / balance）。
- 现金余额 Tab 版式对齐「买卖明细」：上方当前余额 + ⓘ 提示 + 录入按钮，下方变更历史。
- 变更历史每条支持**编辑（复用弹窗）/ 删除（AlertDialog 二次确认，失败就地显示原因不吞错）**。
- 新增**现金余额录入弹窗** `CashBalanceForm`（react-hook-form+zod，新增/编辑复用，编辑锁生效日）+ `api-error-message`（异常→中文，不产生 toast 防双弹）。
- `FLOW-P0-06` 软提示改为「切到余额 Tab + 开录入弹窗」，未变死代码。
- 约束纠正：M1 首笔必须存入是 cashflow 的约束，对现金余额不适用，未误加校验。
- 文件：`web/src/pages/transactions.tsx` · `web/src/features/cashflow/cash-balance-history.tsx` · `web/src/features/cashflow/cash-balance-form.tsx`（新）· `web/src/lib/api-error-message.ts`（新）· `web/src/constants/entry-button-labels.ts`。

## 验证
- 全局 `tsc --noEmit`：本任务的改动文件 **零报错**。
- 全量 `vitest run`：**42 文件 / 482 测试全通过**。

## 遗留 / 待办
- **预存 tsc 错误（非本次引入）**：`src/features/transaction/transaction-list.tsx` 用到 `TransactionResponse` 缺失的 `securityName/quantity/price/fee`，疑为 §5.2b 共享类型收敛时遗留，本次未改（超出范围）。已 stash 验证：干净 HEAD 上同样报错，确认与本次无关。**建议另开任务修**，否则 `pnpm build` 会失败。
- 改动已本地提交（3 commits，author `senior-dev`），**未 push**。需要推送时告知（或按 `scripts/push-all.ps1`）。

## 用户下一步
1. 本地 `pnpm dev` 起前端，到「持仓页」切「买卖明细」验证类型筛选；到「净值分析」看热力图是否 1–12 月完整；到「出入金管理」验证统一筛选器 + Tab + 现金余额录入/编辑/删除。
2. 如确认无误，通知我执行 push。
3. 建议另排任务修复 `transaction-list.tsx` 的预存类型错误，使 `pnpm build` 可通过。
