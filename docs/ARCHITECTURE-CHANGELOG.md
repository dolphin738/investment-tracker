# 投资收益统计系统 — 架构设计文档修订史（Changelog）

> 本文件合并自 `docs/ARCHITECTURE.md` 顶部的「状态 / 修订」块。主 ARCHITECTURE 仅保留版本行 + 指针 + 一条「近期修订」，完整历史在此维护。
> 规则：每次 ARCHITECTURE 修订，本文件追加一条 `## vX.Y` 条目（变更说明）；主文档头部「近期修订」仅保留最新一条。

## v2.8（2026-08-07）
**变更说明（并入增量 I-01~I-06 架构设计）**：将 `docs/ARCHITECTURE-incremental-2026-08-07.md` 以实际交付形态并入主文档（commit `79f5d12`/`7f84906` + 迁移 `20260808_add_fee_scenario`/`20260808_fee_scenario_enum`，QA 两轮 1080/1080 全绿，增量设计已随 PRD v3.3.0 归档至 `docs/archive/`）。**数据模型**：`FeeRecord` 新增 `scenario`（`FeeScenario{BUY,SELL}`，非空，`@default(BUY)`）+ `@@index([portfolioId, scenario, date])`，新增 `enum FeeScenario`；`DividendRecord`/`UserPreference`/`SecurityTrade` 零 schema 变更（补充：Canonical 原 `DividendRecord` 缺 `tax` 字段，已按代码补齐）。**接口契约**：`GET /fees` 支持 securityId 多值 / scenario / startDate / endDate 过滤 + `grouped=1` 应用层聚合（合并键 portfolioId+securityId+date+scenario+type，聚合行带 `transactionIds[]`）；新增 `PATCH /fees/:id`（全可选 DTO + 数据隔离双闸）；`UpdateDividendRecordDto` 补 `type?: DividendType` + `DividendService.update()` 落库分支；净额后端统一计算（K-2）；`PATCH /security-trades/:id` 支持 fee 落库；`UpdatePreferenceDto.defaultDateRange` `@IsIn` 7 项白名单；`GET /holdings` securityId 逗号多值 + `GET /dividends`/`GET /security-trades` 对应扩展。**前端架构**：`QUICK_RANGE_OPTIONS`（`features/query/dimension-switcher.tsx`）为快捷范围单一真相源（7 项）；新增 `features/query/use-default-date-range.ts`（优先级 URL > 偏好 > 系统默认 1y，含偏好异步到达对齐 effect）；`HoldingsToolbar` 原地升级为统一筛选器；`HoldingsPage` 单一 `useUrlState<HoldingsFilterState>` 驱动三板块联动（URL key：date/closed/types/sec/range/from/to/scenario）；`SecurityTradeForm` 录入/编辑共用单一 schema，编辑态重建关联 FeeRecord。**架构裁决**：Q-8 不采纳 DB 唯一约束、采用展示层聚合 + 明细行保留；Q-4 存量 scenario 回填策略；Q-5 defaultDateRange 保持 String + 服务端白名单（零迁移）；Q-6 as-of 与日期范围口径独立；Q-2 编辑买卖仅维护该笔 transactionId 关联费用。**反模式沉淀**：偏好对齐 effect 必须带用户交互守卫（`rangeInteractedRef`/`closedInteractedRef`），否则用户手动改 range 被弹回偏好默认（QA commit `7f84906` 修复，已写入 §10.1.8 / §16.9 / ADR-004）。**新增 ADR**：ADR-003（费用合并展示层聚合）、ADR-004（日期范围默认值单一真相源与优先级链）。**偏差登记**：费用导出 scenario 列未落地（`export-schemas.ts` 无 FEES 类别），标 P2·SET-P2-05（§3.2.5 / §4.2.19 / §17.1）。**文档-代码一致性修正**：① Canonical `DividendRecord` 补回 `tax` 字段；② `§4.2.18` 补 `PATCH /dividends/:id` 端点（代码早有、原式遗漏）；③ `§10.1.6` 持仓 schema 名 `HoldingsQueryState`→`HoldingsFilterState` 对齐代码。增量设计原文件已 `git mv` 至 `docs/archive/ARCHITECTURE-incremental-2026-08-07.md`。

## v2.7（2026-08-06）
**变更说明（概览融合收口）**：走势图卡头**合并为单一 `/snapshots` 入口**（移除 `?manage=1` 深链，`snapshot-list.tsx` 移除 `manageMode` prop 及管理模式提示条死代码）；`features/overview/asset-metrics.ts` 纯函数指标构造（`buildOverviewMetrics` 固定顺序产出 8 项 + `formatAmountOrEmpty`，修复金额 `0` 被 falsy 误判为「暂无数据」）；`date-range-quick-picker` 支持**可选受控 `quick` prop**（受控/非受控双模，既有 3 个调用方零影响）；布局打磨（筛选栏底边对齐 `sm:items-end`）与陈旧注释清理；确立 **Hooks 顺序约束约定**（`pages/dashboard.tsx` 的 `overviewMetrics` 中 `useMemo` 及派生变量须位于提前 `return` 之前，见 commit `5f6ae54`）。**后端零改动、URL schema 零改动**；§10.1.2 更新为单入口收口说明（分层方向不变）。

## v2.6（2026-08-06）
**变更说明（总资产概览融合到概览页）**：用户拍板「出入金页【A】总资产概览块彻底移除、总资产概览只存在于概览页、走势图加日期筛选」。§1.3 目录树 `features/overview/` 补 3 项：`asset-metrics.ts`（8 指标卡构造 + `formatAmountOrEmpty`，修「金额 `0` 被误判为『暂无数据』」）、`total-asset-trend-chart.tsx`（总资产走势图 + 手工记录标记，改用 `source=MANUAL` 服务端筛选替代旧 `pageSize:60` 前端过滤，修长区间标记截断）、`__tests__/`。日期筛选**复用既有 `overview-query-params.ts` 的 `custom/from/to`**（该 schema 早已就绪、仅 UI 未接线），URL schema 零改动；`DateRangeQuickPicker` 新增**可选受控 `quick` prop**（受控/非受控双模，既有 3 个调用方零影响），并**替换**（非并列）概览页原快捷范围 `Select`，保持页面单 combobox 以守住 `dashboard-alignment` A8 用例。概览页指标卡由 6 张扩为 **8 张并去重「当前总资产」**（资产构成 4 / 收益表现 4，`lg:grid-cols-4`）；`/snapshots?manage=1` 深链入口从出入金页迁至概览页走势图卡头，避免失联。**后端零改动**（已查证 `NavQueryDto extends DateRangeDto` + `buildDateRange` 原生支持任意起止区间，「近 30 天」限制仅存在于前端 `transactions.tsx` 的本地硬编码）；**§10.1.2 组件分层表零改动**（新增件均为概览页专属 features 零件，无跨领域复用，旧方案的分层纠结点随「两页共用」前提消失而消解）。增量设计与任务分解（T01–T05）见 `docs/designs/overview-fusion-2026-08-06.md`。

## v2.5（2026-08-06）
**变更说明（docs 整理）**：增量设计移入 `docs/designs/`（7 份已落地增量文档 + README 索引，含落地 commit 对照）；被取代产物 `system_design.md` 与账户域两份 mermaid 入 `docs/archive/`（改名 `*-account-v2.mermaid` 避免覆盖 archive 既有文件）；§1.3 目录树整体刷新后的引用同步、`docs/designs/README.md` 新建；**零删除、全 `git mv` 保留历史**。

## v2.4（2026-08-06）
**变更说明（四处文档陈旧收尾）**：§10.1.2 组件分层表 lib 工具函数修正（删不存在的 `format.ts`，改为 cn/utils、api-client、url-query、constants）；§5.2 代码块注释 shared 路径修正（single-file `enums.ts` 与根 `types.ts`）；§14 任务列表补 T05 条目（引用 `docs/designs/incremental-pages-alignment-v1.md` §5）；§4.2.18 新增分红记录契约、§4.2.19 新增费用记录契约（阶段 C 恢复模块）。

## v2.3（2026-08-06）
**变更说明（§1.3 目录树整体刷新）**：与真实代码结构对齐 —— `cashflow`（由 transaction 更名落位）/ `data-transfer` / `dividend` / `fee` / `overview` / `holding` / `valuation` 等模块落位；web `features`(13) / `api`(17) / `hooks`(15) / `lib` / `stores` / `components` 对齐；`shared/types` 按实况补齐（15 个类型文件）。删除目录树中不存在的目录/文件名。

## v2.2（2026-08-06）
**变更说明（8 页对齐增量 T01–T05 落地同步）**：新增 `data-transfer` 模块（§4.2.17，CSV/Excel 导入导出）；快照 A3 单条端点 `GET /snapshots/:date` 与 `derivedTotalAsset` 字段；overview `freshness` 契约（`DASH-P1-03`）；`computeDerivedBatch`/`deriveBatch` 批量派生（N+1 规避，N 日恒 3 次查库）；URL query 持久化（`lib/url-query.ts`）与前端新 feature；依赖 `xlsx@^0.18.5` / `papaparse@^5.4.1`。**Prisma schema 零变更**。

## v2.1（2026-08-06）
**变更说明（T5 手工总资产记录的计算层级联口径修正）**：§6 / §7.3.1 / §7.3.2 / §8.1 / §13 REG-06 修正「快照层仅当日」被误写为「计算层也仅当日」导致的静默数据错误风险；明确 T5（手工总资产记录增改删重置）触发**快照层仅当日 + 计算层级联 `[date, today]`**，严禁只写快照不重算净值。

## v2.0（2026-08-03）
**变更说明（重写发布）**：基于评审结论落地重写，确立方案 B（交易明细法）为 Canonical 数据架构，取代并吸收 `ARCHITECTURE-modules.md`（归档至 `docs/archive/`）。本档自此为唯一架构真相源。
