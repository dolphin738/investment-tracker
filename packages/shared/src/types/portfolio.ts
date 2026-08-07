/**
 * Portfolio（投资组合）类型 —— **归并转发模块**（T01 共享类型去重）
 *
 * 【为什么只剩转发】
 * `Portfolio` 曾在 `packages/shared/src/types.ts`（包入口 `src/index.ts`
 * re-export 的那份）与本文件各写一份。本次统一以 `../types.ts` 为**唯一真相源**，
 * 本文件退化为 type-only 转发，`src/types/index.ts` 的
 * `export * from './portfolio.ts'` 行为完全不变。
 *
 * 【语义备忘（原文档保留）】
 * baseDate = 成立日（首笔存入日，FIN-D6），设定后不可修改；null = 组合尚未成立。
 * archivedAt 非空表示已归档（列表默认隐藏，不参与计算链路）。
 *
 * ⚠️ 请勿在此新增声明；新增/修改一律去 `packages/shared/src/types.ts`。
 */

export type {
  /** 投资组合实体（对应 Prisma model Portfolio） */
  Portfolio,
} from '../types.ts';
