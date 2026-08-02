/**
 * @investment-tracker/finance-core
 *
 * 纯金融算法核心：XIRR（Newton-Raphson）与净值（单位份额法）。
 *
 * 设计约束：
 * - 零运行时依赖：不引入 @prisma/client、@nestjs/*，可独立编译与独立测试。
 * - 全部导出均为纯函数：无 IO、无日志、无全局状态。
 *   数据库查询、事务编排、日志与 HTTP 异常映射一律由 backend 侧 adapter 承担。
 */

export { calculateXirr, buildCashflows } from './xirr';
export { computeNav, NavCalculationError } from './nav';

export type {
  Cashflow,
  CashflowTransaction,
  ComputeNavInput,
  DecimalLike,
  NavCalculationErrorCode,
  NavResult,
  PrevNav,
  TerminalSnapshot,
} from './types';
