/**
 * 净值计算服务 — Prisma IO 适配层（adapter）
 *
 * 【职责边界】
 * 金融算法本体已迁出至 @investment-tracker/finance-core（零依赖纯函数库）：
 * - computeNav({ totalAsset, prevNav, buyAmount, sellAmount, date }) → NavResult | null
 *
 * 本服务只保留三件事，不含任何金融数学：
 * 1. 三次 Prisma 查询（当日快照 / 上日净值 / 当日交易）并聚合买卖金额；
 * 2. 把「上日净值」这一状态自环作为显式入参喂给纯函数；
 * 3. 把 finance-core 的 NavCalculationError 原样包装回 NestJS BadRequestException
 *    （文案逐字不变，对外 HTTP 400 行为不变），并记录 prevShares <= 0 的告警日志。
 *
 * 【资产快照口径 — 读代码前必读】
 * AssetSnapshot.totalAsset = 当日「期末」账户总资产，即包含当日一切买入/卖出之后
 * 的最终金额（等同用户在券商 App 上直接看到的那个数字）。
 * 因此在计算单位净值前，必须先还原出「当日申赎发生前」的持仓资产：
 *   preAsset = totalAsset - 当日买入额 + 当日卖出额
 * 口径依据：用户决策 D-06（2026-08-01）。docs/PRD.md §3.3 示例与 §5.4 公式仍是旧口径，
 * 将在 PRD v1.2 同步修订。XirrService 终值直接取 totalAsset，与本口径互为前提，
 * 两处必须同时变更，不可单独修改其一。
 *
 * 完整的算法推导（成立日 / 非成立日 / 年度重置 / 不变量）见 finance-core/src/nav.ts。
 *
 * 注意：净值计算有前日依赖（当日份额依赖上日份额），
 * 批量重算时必须按日期升序逐日计算。
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { NavCalculationError, computeNav } from '@investment-tracker/finance-core';
import type { NavResult } from '@investment-tracker/finance-core';
import { PrismaService } from '../../prisma/prisma.service';

/** 净值计算结果（类型定义已迁至 finance-core，此处再导出以兼容既有引用） */
export type { NavResult } from '@investment-tracker/finance-core';

@Injectable()
export class NavService {
  private readonly logger = new Logger(NavService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 计算指定日期的净值
   *
   * @returns 净值计算结果；无当日快照 / 上日份额 <= 0 时返回 null（不生成净值记录）
   * @throws BadRequestException 成立日无买入交易
   * @throws BadRequestException 申赎前资产 <= 0（当日买入额超过当日期末资产，数据录入错误）
   */
  async calculateNavForDate(
    portfolioId: string,
    date: Date,
  ): Promise<NavResult | null> {
    // 1. 查询当日资产快照
    const snapshot = await this.prisma.assetSnapshot.findUnique({
      where: { portfolioId_date: { portfolioId, date } },
    });
    if (!snapshot) {
      return null;
    }

    // 2. 查询前一日净值记录（最近的、日期 < 当日）——状态自环，显式喂给纯函数
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

    // 日期字符串（用于日志；级联重算时必须让用户知道是哪一天出错）
    const dateStr = date.toISOString().split('T')[0];

    // 4. 纯函数计算
    let result: NavResult | null;
    try {
      result = computeNav({
        totalAsset: snapshot.totalAsset,
        // 直接透传 Prisma 行：baseCumulativeNav 的真值判断语义依赖 Decimal 对象本身，
        // 提前转成 number 会让 0 落入 falsy 分支，行为将发生改变。
        prevNav,
        buyAmount,
        sellAmount,
        date,
      });
    } catch (error) {
      // 纯函数不依赖 NestJS，业务校验错误在此还原为 BadRequestException（文案不变）
      if (error instanceof NavCalculationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    // 5. 告警日志：纯函数返回 null 的唯一原因是上日份额 <= 0（无快照已在第 1 步拦截）
    if (result === null) {
      this.logger.warn(
        `上日份额 <= 0，无法计算净值 portfolioId=${portfolioId} date=${dateStr}`,
      );
    }

    return result;
  }
}
