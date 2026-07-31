/**
 * XIRR 计算服务 — Newton-Raphson 迭代法
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
 * - rate ≤ -1 → 钳制为 -0.999（防止 (1+r)^t 溢出）
 * - 迭代 100 次未收敛 → 返回当前 rate（精度可能不足但仍可用）
 *
 * 同日多笔交易处理：
 * - calculateXirrForDate 会将同日多笔交易合并为净现金流后再计算
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** 现金流条目 */
export interface Cashflow {
  /** 现金流日期 */
  date: Date;
  /** 金额：买入为负，卖出为正，终值（当日资产额）为正 */
  amount: number;
}

/** 毫秒/年的转换常数 */
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

@Injectable()
export class XirrService {
  private readonly logger = new Logger(XirrService.name);

  /** 初始猜测收益率 10% */
  private readonly INITIAL_RATE = 0.1;
  /** 最大迭代次数 */
  private readonly MAX_ITERATIONS = 100;
  /** 收敛阈值 |NPV| < 1e-7 */
  private readonly TOLERANCE = 1e-7;
  /** 防止 (1+r) <= 0 溢出的下限 */
  private readonly MIN_RATE = -0.999;

  /**
   * 计算 XIRR 年化收益率（纯函数，无副作用）
   *
   * @param cashflows 现金流序列（买入=负，卖出=正，终值=正）
   * @returns 年化收益率（小数形式，如 0.1234 = 12.34%），全同号返回 null
   */
  calculateXirr(cashflows: Cashflow[]): number | null {
    if (cashflows.length < 2) {
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

    let rate = this.INITIAL_RATE;

    for (let i = 0; i < this.MAX_ITERATIONS; i++) {
      const npv = this.calculateNpv(rate, sorted, firstDate);
      if (Math.abs(npv) < this.TOLERANCE) {
        return rate;
      }

      const derivative = this.calculateDerivative(rate, sorted, firstDate);
      if (derivative === 0) {
        break;
      }

      rate = rate - npv / derivative;

      // 钳制防止溢出
      if (rate <= this.MIN_RATE) {
        rate = this.MIN_RATE;
      }
    }

    // 迭代结束未完全收敛，返回当前值
    return rate;
  }

  /**
   * 计算 NPV（净现值）
   *
   * NPV(r) = Σ CF_i / (1+r)^((d_i - d_0)/365)
   */
  private calculateNpv(rate: number, cashflows: Cashflow[], firstDate: Date): number {
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
  private calculateDerivative(rate: number, cashflows: Cashflow[], firstDate: Date): number {
    return cashflows.reduce((sum, cf) => {
      const yearFraction = (cf.date.getTime() - firstDate.getTime()) / MS_PER_YEAR;
      const base = Math.pow(1 + rate, yearFraction);
      return sum - (cf.amount * yearFraction) / (base * (1 + rate));
    }, 0);
  }

  /**
   * 为指定日期构建现金流序列并计算累计 XIRR
   *
   * 现金流 = [成立日 ~ 当日的所有交易（同日合并为净现金流）] + [当日资产快照作为正终值]
   *
   * @returns XIRR 值（小数形式），无快照或数据不足返回 null
   */
  async calculateXirrForDate(portfolioId: string, date: Date): Promise<number | null> {
    // 1. 查询从成立日到当日的所有交易
    const transactions = await this.prisma.transaction.findMany({
      where: { portfolioId, date: { lte: date } },
      orderBy: { date: 'asc' },
    });

    // 2. 查询当日资产快照（作为终值）
    const snapshot = await this.prisma.assetSnapshot.findUnique({
      where: { portfolioId_date: { portfolioId, date } },
    });
    if (!snapshot) {
      return null;
    }

    // 3. 构建现金流，同日多笔交易合并为净现金流
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

    const cashflows: Cashflow[] = Array.from(cashflowsByDate.values());

    // 4. 加入当日资产额作为正终值
    cashflows.push({ date, amount: Number(snapshot.totalAsset) });

    // 5. 计算 XIRR
    const result = this.calculateXirr(cashflows);
    if (result === null) {
      this.logger.debug(
        `XIRR 为 null（全同号或数据不足）portfolioId=${portfolioId} date=${date.toISOString().split('T')[0]}`,
      );
    }

    return result;
  }

  constructor(private readonly prisma: PrismaService) {}
}
