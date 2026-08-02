/**
 * @investment-tracker/finance-core/testing
 *
 * 测试基础设施子入口（不进生产运行时路径）。
 * 通过独立子路径导出，避免内存 Prisma 替身被误引入生产代码。
 */

export {
  InMemoryPrisma,
  DB_PRECISION,
  daysBetween,
  utc,
} from './in-memory-prisma';

export type {
  NavRow,
  Precision,
  SnapRow,
  TxRow,
  XirrRow,
} from './in-memory-prisma';
