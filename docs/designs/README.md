# docs/designs/ — 增量设计文档索引

> 本目录收纳各轮**增量对齐设计 / 分析 / 任务书**文档（原 `docs/` 根目录，2026-08-06 v2.5 整理移入）。
> 真相源仍为 `docs/ARCHITECTURE.md`（Canonical）+ `docs/PRD.md`（权威）；本目录文档为**轮次性分析产物**，记录设计与拍板过程。

| 文档 | 主题 | 落地 commit 对照 |
|------|------|------------------|
| `incremental-account-v2.md` | 账户域对齐 v2：后端缺口补齐（Gap A/B/C + `UserPublic.createdAt`）+ 前端 4 项微调 | backend `376b153` / web `ff22d15` |
| `incremental-analysis-snapshots-v1.md` | 收益分析页 + 资产记录页 与 PRD 对齐（前端为主，后端缺口标注/占位） | backend `1804796` / web `d0cad00` |
| `incremental-analysis-cashflow-v1.md` | 净值分析页 + 出入金页 与 PRD 对齐（前端为主，后端缺口标注/占位） | backend `745a1f0` / web `b781fcc` |
| `incremental-pages-alignment-v1.md` | 「8 页 PRD 对齐」增量系统设计 + 任务列表（T01–T05） | `3873c3f`…`7209f67`（8 页对齐 T01–T05 落地） |
| `pages-alignment-task-order-v1.md` | 8 页对齐·执行任务书（T01 修复 + T02–T06 四段连打 + Excel 扩展） | 同上批（T01–T05 已落地，**状态：已执行完毕**） |
| `pages-prd-alignment.md` | 前端 8 页面 × PRD 需求/草图 全量对齐分析（纯分析） | `00b4b45`（Q 决策回填）+ `3bb89ff`（AL-082/083 回填） |
| `holdings-overview-alignment.md` | 概览页 + 持仓页 对齐分析（46 项 + 决策 Q-1~Q-8） | `d0b132d` / `3af48e8` / `465582b`（阶段 A/B/C） |
| `overview-fusion-2026-08-06.md` | 总资产概览融合到概览页：出入金页【A】块彻底移除 + 走势图接日期筛选 + 概览页 8 卡重排（T01–T05，**后端零改动**） | 待回填（**状态：设计完成，待工程实现**） |

## 未决项

- `incremental-account-v2.md` **E7「formatCurrency 全站接入」**为**独立 P1 排期项**（本轮未实施，待主理人排期）。
- `overview-fusion-2026-08-06.md` §13 U-1「持仓市值 / 现金余额两张新卡的 PRD 条目号」、U-3「手工标记 >200 的提示文案」待主理人定稿（不阻塞实现）。
