/**
 * XIRR 计算 — Newton-Raphson 迭代法（纯函数，无副作用、无 IO）
 *
 * 实现原理（参照 PRD 附录 A）：
 * 1. 现金流 NPV 公式：Σ CF_i / (1+r)^((d_i - d_0)/365)
 * 2. 牛顿迭代：r_{n+1} = r_n - NPV(r_n) / NPV'(r_n)
 * 3. 初始猜测 r_0 = 0.1（10%），最大迭代 100 次，收敛阈值 |NPV| < 1e-7
 *
 * 边界处理：
 * - 现金流 < 2 条 → 返回 null
 * - 全同号现金流（全正或全负）→ 返回 null（无解）
 * - 导数为 0（无法迭代）→ 返回当前 rate
 * - rate ≤ -0.999 → 钳制为 -0.999（防止 (1+r)^t 溢出）
 * - 迭代 100 次未收敛 → 返回当前 rate（精度可能不足但仍可用）
 *
 * 同日多笔交易处理：
 * - buildCashflows 会将同日多笔交易合并为净现金流后再计算
 *
 * 【本文件由 backend/src/modules/calculation/xirr.service.ts 原样迁出】
 * 迁移仅改变代码归属与 import，数学实现逐字节等价：
 * 常量由类的 readonly 字段改为模块级常量（值不变），私有方法改为模块级函数。
 */

import type { Cashflow, CashflowTransaction, TerminalSnapshot } from './types';

/** 毫秒/年的转换常数 */
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** 初始猜测收益率 10% */
const INITIAL_RATE = 0.1;
/** 最大迭代次数 */
const MAX_ITERATIONS = 100;
/** 收敛阈值 |NPV| < 1e-7 */
const TOLERANCE = 1e-7;
/** 防止 (1+r) <= 0 溢出的下限 */
const MIN_RATE = -0.999;

/**
 * 计算 NPV（净现值）
 *
 * NPV(r) = Σ CF_i / (1+r)^((d_i - d_0)/365)
 */
function calculateNpv(rate: number, cashflows: Cashflow[], firstDate: Date): number {
  return cashflows.reduce((sum, cf) => {
    const yearFraction = (cf.date.getTime() - firstDate.getTime()) / MS_PER_YEAR;
    return sum + cf.amount / Math.pow(1 + rate, yearFraction);
  }, 0);
}

/**
 * 计算 NPV 的导数（用于牛顿迭代）
 *
 * NPV'(r) = Σ -CF_i * t_i / ((1+r)^(t_i+1))
 * 其中 t_i = (d_i - d_0)/365
 */
function calculateDerivative(rate: number, cashflows: Cashflow[], firstDate: Date): number {
  return cashflows.reduce((sum, cf) => {
    const yearFraction = (cf.date.getTime() - firstDate.getTime()) / MS_PER_YEAR;
    const base = Math.pow(1 + rate, yearFraction);
    return sum - (cf.amount * yearFraction) / (base * (1 + rate));
  }, 0);
}

/**
 * 计算 XIRR 年化收益率（纯函数，无副作用）
 *
 * @param cashflows 现金流序列（买入=负，卖出=正，终值=正）
 * @returns 年化收益率（小数形式，如 0.1234 = 12.34%），全同号返回 null
 */
export function calculateXirr(cashflows: Cashflow[]): number | null {
  if (cashflows.length < 2) {
    return null;
  }

  // 防御：非法金额输入返回 null
  // Cashflow.amount 虽然类型为 number，但上游 buildCashflows 对 DecimalLike 做 Number()
  // 转换，若 DB 或 DTO 传入非数字字符串（如 "abc"），Number("abc") = NaN 会一路传播
  // 到牛顿迭代，最终静默返回 NaN。此处做纯函数自身的防御性校验。
  // 生产路径有 DTO @IsNumber + DB Decimal 类型挡，这里是最后一道防线。
  if (cashflows.some((cf) => !Number.isFinite(cf.amount))) {
    return null;
  }

  // 边界检查：全同号现金流无法求解
  const allPositive = cashflows.every((cf) => cf.amount > 0);
  const allNegative = cashflows.every((cf) => cf.amount < 0);
  if (allPositive || allNegative) {
    return null;
  }

  // 按日期升序排序
  const sorted = [...cashflows].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const firstDate = sorted[0].date;

  // 所有现金流同一天时 XIRR 无意义（持有期 0，任何 rate 都满足 NPV=0），返回 null
  const firstDateMs = firstDate.getTime();
  const allSameDay = sorted.every((cf) => cf.date.getTime() === firstDateMs);
  if (allSameDay) {
    return null;
  }

  let rate = INITIAL_RATE;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const npv = calculateNpv(rate, sorted, firstDate);
    if (Math.abs(npv) < TOLERANCE) {
      return rate;
    }

    const derivative = calculateDerivative(rate, sorted, firstDate);
    if (derivative === 0) {
      break;
    }

    rate = rate - npv / derivative;

    // 钳制防止溢出
    if (rate <= MIN_RATE) {
      rate = MIN_RATE;
    }
  }

  // 迭代结束未完全收敛，返回当前值
  return rate;
}

/**
 * 由交易序列 + 当日资产快照构建 XIRR 现金流（纯函数）
 *
 * 现金流 = [成立日 ~ 当日的所有交易（同日合并为净现金流）] + [当日资产快照作为正终值]
 *
 * 【口径前提 — 修改前必读】
 * 本函数成立的前提是 snapshot.totalAsset 为「当日期末总资产」，即已包含
 * 当日一切买入/卖出之后的最终金额（用户决策 D-06，2026-08-01）。
 * 调用方的交易查询必须用 `lte: date`（含当日交易，当日买入记为负现金流），
 * 终值取 totalAsset —— 只有在期末口径下两者才自洽：当日买入的钱既作为流出
 * 出现在现金流里，也已经体现在终值资产里，不会凭空蒸发。
 * 若快照口径改为「申赎前资产」，则调用方的交易查询必须改为 `lt: date`，
 * 或终值改为 totalAsset + 当日买入 - 当日卖出，二者必须同步调整。
 * 同一口径同时约束 computeNav，两处不可单独修改其一。
 *
 * @param transactions 成立日 ~ 当日的全部交易（调用方负责查询与排序）
 * @param snapshot 估值日期 + 当日期末总资产
 * @returns 现金流序列（同日已合并，末位为正终值）
 */
export function buildCashflows(
  transactions: readonly CashflowTransaction[],
  snapshot: TerminalSnapshot,
): Cashflow[] {
  // 构建现金流，同日多笔交易合并为净现金流
  const cashflowsByDate = new Map<string, Cashflow>();
  for (const tx of transactions) {
    const dateKey = tx.date.toISOString().split('T')[0];
    const signedAmount = tx.type === 'BUY' ? -Number(tx.amount) : Number(tx.amount);
    const existing = cashflowsByDate.get(dateKey);
    if (existing) {
      existing.amount += signedAmount;
    } else {
      cashflowsByDate.set(dateKey, { date: tx.date, amount: signedAmount });
    }
  }

  // 同日买卖恰好对冲为 0 时，该日净现金流无实际经济意义，
  // 放入数组会导致 NPV 无根、迭代向 +∞ 漂移（仅靠调用方 1e11 兜底）。
  // 故合并后净额为 0 的日期直接跳过，不放入现金流数组。
  const cashflows: Cashflow[] = Array.from(cashflowsByDate.values())
    .filter((cf) => cf.amount !== 0);

  // 加入当日资产额作为正终值
  // ⚠️ 终值直接取 totalAsset 成立的前提是「快照为当日期末总资产（含当日申赎）」。
  // 调用方的交易查询用了 lte（含当日买入，记为负现金流），若快照改为申赎前口径，
  // 当日买入会被算作流出却不体现在终值中 → 该笔资金凭空蒸发，XIRR 严重虚高。
  cashflows.push({ date: snapshot.date, amount: Number(snapshot.totalAsset) });

  return cashflows;
}
