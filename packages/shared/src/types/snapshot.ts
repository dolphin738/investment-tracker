/**
 * AssetSnapshot（总资产每日唯一记录）类型 —— **归并转发模块**（T01 共享类型去重）
 *
 * 【为什么只剩转发】
 * `AssetSnapshot` 曾在 `packages/shared/src/types.ts`（包入口 `src/index.ts`
 * re-export 的那份）与本文件各写一份。本次统一以 `../types.ts` 为**唯一真相源**，
 * 本文件退化为 type-only 转发，`src/types/index.ts` 的
 * `export * from './snapshot.ts'` 行为完全不变。
 *
 * 【语义备忘（原文档保留）】
 * 每个组合每天最多一条记录（唯一约束 portfolioId + date）；
 * source = DERIVED（系统按交易/余额推导）/ MANUAL（用户手工录入，取代当日自动值）；
 * valuationFlag 标注估值口径（正常 / 沿用前值 / 按成本估值）。
 *
 * ⚠️ 请勿在此新增声明；新增/修改一律去 `packages/shared/src/types.ts`。
 */

export type {
  /** 总资产每日唯一记录实体（对应 Prisma model AssetSnapshot） */
  AssetSnapshot,
} from '../types.ts';
