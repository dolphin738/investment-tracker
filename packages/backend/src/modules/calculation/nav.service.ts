/**
 * 净值计算服务 — 公募基金份额法
 *
 * 实现原理（参照 PRD 附录 B + 第 5.4 节 + ARCHITECTURE.md 第 7.2 节）：
 *
 * 成立日（prevNav = null）：
 *   unitNav = 1.0, cumulativeNav = 1.0, yearNav = 1.0
 *   shares = 当日买入金额之和, baseCumulativeNav = 1.0
 *
 * 非成立日：
 *   unitNav = 当日资产快照 / 上日末份额
 *   （PRD 第 5.4 节：nav_t = asset_t / shares_{t-1}；资产快照口径为「当日申赎发生前」
 *     的持仓总额，先按上日份额定价出当日单位净值，再按该净值处理当日申赎）
 *   cumulativeNav = unitNav（v1 无分红）
 *   处理申赎：shares = 上日份额 + 买入额/unitNav - 卖出额/unitNav
 *
 * 当年首日（当年首个有快照的交易日，即 date 年份 != prevNav 年份）：
 *   baseCumulativeNav = prevNav.cumulativeNav（上年末累计净值）
 *   yearNav = 1.0
 *
 * 当年非首日：
 *   baseCumulativeNav = prevNav.baseCumulativeNav（继承年内基准）
 *   yearNav = cumulativeNav / baseCumulativeNav
 *
 * 注意：净值计算有前日依赖（当日份额依赖上日份额），
 * 批量重算时必须按日期升序逐日计算。
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** 净值计算结果 */
export interface NavResult {
  /** 当日单位净值 */
  unitNav: number;
  /** 累计净值（v1 = 单位净值） */
  cumulativeNav: number;
  /** 当年净值 */
  yearNav: number;
  /** 当日末总份额 */
  shares: number;
  /** 当年基准累计净值（成立日 = 1.0） */
  baseCumulativeNav: number | null;
}

@Injectable()
export class NavService {
  private readonly logger = new Logger(NavService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 计算指定日期的净值
   *
   * @returns 净值计算结果；无当日快照时返回 null（不生成净值记录）
   * @throws BadRequestException 成立日无买入交易
   */
  async calculateNavForDate(portfolioId: string, date: Date): Promise<NavResult | null> {
    // 1. 查询当日资产快照
    const snapshot = await this.prisma.assetSnapshot.findUnique({
      where: { portfolioId_date: { portfolioId, date } },
    });
    if (!snapshot) {
      return null;
    }

    // 2. 查询前一日净值记录（最近的、日期 < 当日）
    const prevNav = await this.prisma.dailyNav.findFirst({
      where: { portfolioId, date: { lt: date } },
      orderBy: { date: 'desc' },
    });

    // 3. 查询当日交易
    const dayTransactions = await this.prisma.transaction.findMany({
      where: { portfolioId, date },
    });
    const buyAmount = dayTransactions
      .filter((t) => t.type === 'BUY')
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const sellAmount = dayTransactions
      .filter((t) => t.type === 'SELL')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    // ===== 成立日 =====
    if (!prevNav) {
      if (buyAmount <= 0) {
        throw new BadRequestException('首笔交易必须为买入（成立日需要有买入交易）');
      }
      return {
        unitNav: 1.0,
        cumulativeNav: 1.0,
        yearNav: 1.0,
        shares: buyAmount,
        baseCumulativeNav: 1.0,
      };
    }

    // ===== 非成立日 =====
    const prevShares = Number(prevNav.shares);
    if (prevShares <= 0) {
      this.logger.warn(
        `上日份额 <= 0，无法计算净值 portfolioId=${portfolioId} date=${date.toISOString().split('T')[0]}`,
      );
      return null;
    }

    // Step 1：按上日末份额对当日资产快照定价，得到当日单位净值
    // PRD 第 5.4 节：nav_t = asset_t / shares_{t-1}
    // （资产快照为当日申赎发生前的持仓总额，故此处不得再加减当日申赎金额）
    const unitNav = Number(snapshot.totalAsset) / prevShares;
    const cumulativeNav = unitNav;

    // 处理当日申赎（买入新增份额，卖出赎回份额）
    const newShares = buyAmount / unitNav - sellAmount / unitNav;
    const shares = prevShares + newShares;

    // 防御：份额不能为负（卖出金额超过当日持仓市值）
    if (shares < 0) {
      throw new BadRequestException(
        `卖出金额 ${sellAmount} 超过当日持仓市值 ${(prevShares * unitNav).toFixed(2)}（按单位净值 ${unitNav.toFixed(4)} 计算，最多可卖 ${(prevShares * unitNav).toFixed(2)}）`,
      );
    }

    // 当年净值计算
    let yearNav: number;
    let baseCumulativeNav: number | null;

    if (this.isYearFirstTradingDay(date, prevNav.date)) {
      // 当年首个有快照的交易日 → 重置
      baseCumulativeNav = Number(prevNav.cumulativeNav);
      yearNav = 1.0;
    } else {
      // 继承年内基准
      baseCumulativeNav = prevNav.baseCumulativeNav
        ? Number(prevNav.baseCumulativeNav)
        : null;
      yearNav = baseCumulativeNav !== null
        ? cumulativeNav / baseCumulativeNav
        : 1.0;
    }

    return { unitNav, cumulativeNav, yearNav, shares, baseCumulativeNav };
  }

  /**
   * 判断当前日期是否为当年首个有快照的交易日
   *
   * 逻辑：当前日期的年份 != 前一日净值记录的年份
   * （因为净值记录只在有快照的日期生成，所以 prevNav.date 就是上一个交易日）
   */
  private isYearFirstTradingDay(currentDate: Date, prevDate: Date): boolean {
    return currentDate.getFullYear() !== prevDate.getFullYear();
  }
}
