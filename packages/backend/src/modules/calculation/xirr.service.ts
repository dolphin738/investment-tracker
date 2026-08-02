/**
 * XIRR 计算服务 — Prisma IO 适配层（adapter）
 *
 * 【职责边界】
 * 金融算法本体已迁出至 @investment-tracker/finance-core（零依赖纯函数库）：
 * - calculateXirr(cashflows)          — Newton-Raphson 迭代求解
 * - buildCashflows(transactions, snapshot) — 同日合并 + 追加正终值
 *
 * 本服务只保留 Prisma 查询与日志，不含任何金融数学。
 * 算法口径（r₀=0.1 / maxIter=100 / tol=1e-7 / 全同号→null / 全同日→null /
 * dnpv=0→break / rate≤-0.999 钳制）请见 finance-core/src/xirr.ts，不要在此处重复实现。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  buildCashflows,
  calculateXirr as calculateXirrPure,
} from '@investment-tracker/finance-core';
import type { Cashflow } from '@investment-tracker/finance-core';
import { PrismaService } from '../../prisma/prisma.service';

/** 现金流条目（类型定义已迁至 finance-core，此处再导出以兼容既有引用） */
export type { Cashflow } from '@investment-tracker/finance-core';

@Injectable()
export class XirrService {
  private readonly logger = new Logger(XirrService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 计算 XIRR 年化收益率
   *
   * 薄壳：直接委托 finance-core 的纯函数，行为完全一致。
   *
   * @param cashflows 现金流序列（买入=负，卖出=正，终值=正）
   * @returns 年化收益率（小数形式，如 0.1234 = 12.34%），全同号返回 null
   */
  calculateXirr(cashflows: Cashflow[]): number | null {
    return calculateXirrPure(cashflows);
  }

  /**
   * 为指定日期构建现金流序列并计算累计 XIRR
   *
   * 现金流 = [成立日 ~ 当日的所有交易（同日合并为净现金流）] + [当日资产快照作为正终值]
   *
   * 【口径前提 — 修改前必读】
   * 本方法成立的前提是 AssetSnapshot.totalAsset 为「当日期末总资产」，即已包含
   * 当日一切买入/卖出之后的最终金额（用户决策 D-06，2026-08-01）。
   * 交易查询用 `lte: date`（含当日交易，当日买入记为负现金流），终值取 totalAsset —
   * 只有在期末口径下两者才自洽：当日买入的钱既作为流出出现在现金流里，
   * 也已经体现在终值资产里，不会凭空蒸发。
   * 若快照口径改为「申赎前资产」，则此处交易查询必须改为 `lt: date`，
   * 或终值改为 totalAsset + 当日买入 - 当日卖出，二者必须同步调整。
   * 同一口径同时约束 NavService.calculateNavForDate 与 finance-core 的 computeNav，
   * 三处不可单独修改其一。
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

    // 3. 构建现金流（同日合并 + 追加正终值）——纯函数
    // 终值的日期显式传入被查询的 date（而非 snapshot.date），
    // 与迁移前 `cashflows.push({ date, ... })` 的语义逐字保持一致。
    const cashflows = buildCashflows(transactions, {
      date,
      totalAsset: snapshot.totalAsset,
    });

    // 4. 计算 XIRR —— 纯函数
    const result = calculateXirrPure(cashflows);
    if (result === null) {
      this.logger.debug(
        `XIRR 为 null（全同号或数据不足）portfolioId=${portfolioId} date=${date.toISOString().split('T')[0]}`,
      );
    }

    return result;
  }
}
