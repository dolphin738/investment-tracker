# 投资收益统计系统 — 架构设计文档修订史（Changelog）

> 本文件合并自 `docs/ARCHITECTURE.md` 顶部的「状态 / 修订」块。主 ARCHITECTURE 仅保留版本行 + 指针 + 一条「近期修订」，完整历史在此维护。
> 规则：每次 ARCHITECTURE 修订，本文件追加一条 `## vX.Y` 条目（变更说明）；主文档头部「近期修订」仅保留最新一条。

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
