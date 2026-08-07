> 本文档已落地·只读，作为架构决策记录（ADR），不再更新

# 架构决策记录：费用记录合并采用展示层聚合而非数据库物理合并（ADR-003 · I-03 / 裁决 Q-8）

> 架构师：高见远（Gao）
> 上游输入：增量 PRD I-03（费用记录合并）+ QA 报告（commit `79f5d12` / `7f84906`，两轮 1080/1080 全绿）
> 关联裁决：§11 Q-8；关联契约 §3.2.5 / §4.2.19；关联代码 `fee.service.ts` `groupByMergeKey` / `FeeGroupedRow`
> 状态：已落地（v2.8 并入主文档 `ARCHITECTURE.md`）

---

## 1. 背景与问题

费用记录（`FeeRecord`）在「持仓维度 → 分红/费用」区块展示时，同一组合下常出现**同一合并键**的多笔费用：同一标的、同一日期、同一场景（买入时/卖出时）、同一费用类型（佣金/印花税/其他），可能因分次录入、编辑重建而拆成多行。I-03 需求要求列表「合并展示为一行（合计金额 + 笔数）」，同时保留可编辑/可删除单笔的能力。

核心张力：**合并在「哪一层」做**。
- 若在**数据库层**物理合并（唯一约束 + upsert 累加），查询天然聚合，但会丢失单笔明细、破坏编辑语义与审计。
- 若在**展示层**聚合（先查明细、再按合并键 `groupBy` 内存聚合），明细行完整保留，编辑/删除单笔即重算，代价是应用层多一次聚合计算。

## 2. 候选方案

### 2.1 方案 A：数据库物理合并（`@@unique` + upsert 累加）

- Schema：`@@unique([portfolioId, securityId, date, scenario, type])`，`amount` 为累加列。
- 写入：`feeRecord.upsert({ where:{mergeKey}, create, update:{ amount:{ increment } } })`。
- 编辑单笔：必须先知道「该笔对合并行的贡献」才能反向 decrement，否则无法定位。
- 并发：累加需 `Serializable` 事务 + 捕获 P2002 重试一次，避免唯一冲突。

### 2.2 方案 B（采纳）：展示层聚合 + 明细行保留

- Schema：`FeeRecord` 无唯一约束，逐笔存储，`scenario` 为普通非空列。
- 读取：`GET /fees?grouped=1` → 先 `findMany`（先过滤 securityId/scenario/日期范围），再服务层 `groupByMergeKey` 按 `(portfolioId, securityId, date, scenario, type)` 聚合成 `FeeGroupedRow`（`mergeKey` / `amount`(Σ) / `count` / `transactionIds[]` 全量去重）。
- 编辑/删除：直接操作单笔 `FeeRecord`，下一查询即重新聚合，天然一致。
- 排序：`date desc → scenario → type → securityCode asc`（稳定）。

## 3. 决策

**采纳方案 B（展示层聚合 + 明细行保留）。不采纳方案 A 的数据库物理合并（裁决 Q-8）。**

合并键固定为 `(portfolioId, securityId, date, scenario, type)`；底层明细行**不物理合并**，`transactionId` 保留精确关联，聚合行携带 `transactionIds[]`（Q-3 语义自动消解：无需「保留某一笔」，全量去重即可）。

## 4. 后果

### 4.1 正向

- **编辑语义完整**：I-01 编辑买卖流水时按 `transactionId` 精确重建关联 FeeRecord（删旧插新），物理合并会破坏该语义。
- **金融审计友好**：个人投资应用要求保留每笔费用明细，便于追溯与纠错。
- **实现简单、易单测**：`groupByMergeKey` 为纯函数，复用既有 `toResponse` 与排序逻辑，无事务/并发复杂度。
- **性能可忽略**：个人应用费用表典型 < 千行，应用层聚合开销可忽略（仅在 > 10⁴ 行时才需考虑下推）。

### 4.2 负向 / 代价

- 每次 `grouped=1` 查询多一次内存聚合（已评估可忽略）。
- 无法在 SQL 层直接 `GROUP BY`（因需 `join` security 名称且保留 `transactionIds[]`），采用「先查后聚」而非 `prisma.groupBy`。

## 5. 备选方案为何被否（方案 A）

1. **破坏 I-01 编辑语义**：物理合并后无法定位「该笔对合并行的贡献」，编辑单笔费用需逆向 decrement，极易出错。
2. **过度设计**：累加 upsert 在「编辑单笔」时需知该笔贡献，必须引入组成明细表，复杂度激增，收益仅并发合并的极小收益（个人应用写入并发极低）。
3. **审计损失**：金融数据要求保留明细，物理合并直接抹除可追溯性。
4. **迁移与并发成本**：`@@unique` 需 `ALTER TYPE`/建唯一索引 + `Serializable` 事务 + P2002 重试，与本应用规模不匹配。

> 备选（不推荐）若未来坚持采纳：`prisma.feeRecord.upsert({ where:{mergeKey}, create, update:{ amount:{ increment } } })` + 捕获 P2002 重试一次 + `$transaction`（Serializable），但编辑语义需重构。

## 6. 参考

- 主文档 §3.2.5（I-03 数据模型变更）、§4.2.19（费用记录契约 `grouped=1` / `FeeGroupedRow`）、§11 Q-8（裁决）、§16.9（费用合并语义约定）。
- QA 报告 B.2（I-03 验收全绿）、增量设计 `docs/archive/ARCHITECTURE-incremental-2026-08-07.md` §3.2.3 / §9.1 Q-8。
