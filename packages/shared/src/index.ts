/**
 * @investment-tracker/shared — 统一导出入口
 *
 * 三端（backend / web / harmonyos）共享的 TypeScript 类型定义与 API 契约。
 * 所有 Decimal 类型在 TS 中以 string 表示，避免 JSON 序列化精度丢失。
 */

// ===== 核心数据类型 =====
export * from './types/user.js';
export * from './types/portfolio.js';
export * from './types/transaction.js';
export * from './types/snapshot.js';
export * from './types/nav.js';
export * from './types/xirr.js';

// ===== 通用 API 类型 =====
export * from './types/api.js';
export * from './types/query.js';
