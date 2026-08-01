/**
 * 净值计算服务 — 公募基金份额法
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
 * 实现原理（参照 PRD 附录 B + 第 5.4 节 + ARCHITECTURE.md 第 7.2 节）：
 *
 * 成立日（prevNav = null）：
 *   unitNav = 1.0, cumulativeNav = 1.0, yearNav = 1.0
 *   shares = 当日买入金额之和, baseCumulativeNav = 1.0
 *
 * 非成立日：
 *   preAsset      = totalAsset - buyAmount + sellAmount    （申赎前持仓资产）
 *   unitNav       = preAsset / shares_{t-1}                （先按上日份额定价）
 *   cumulativeNav = unitNav（v1 无分红）
 *   shares_t      = shares_{t-1} + (buyAmount - sellAmount) / unitNav
 *
 *   等价闭式：shares_t = shares_{t-1} × totalAsset / preAsset
 *   不变量　：totalAsset / shares_t === unitNav（期末资产 ÷ 期末份额 = 当日单位净值）
 *   推论　　：totalAsset > 0（DTO 约束 Min 0.01）且 shares_{t-1} > 0 且 preAsset > 0 时
 *             shares_t 恒为正，故无需再对 shares 做非负防御；真正需要拦截的是
 *             preAsset <= 0 —— 当日买入额超过当日期末资产，属于数据录入错误。
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
   * @throws BadRequestException 申赎前资产 <= 0（当日买入额超过当日期末资产，数据录入错误）
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

    // 日期字符串（用于日志与错误信息；级联重算时必须让用户知道是哪一天出错）
    const dateStr = date.toISOString().split('T')[0];

    // ===== 成立日 =====
    if (!prevNav) {
      if (buyAmount <= 0) {
        throw new BadRequestException(
          `首笔交易必须为买入（${dateStr} 为成立日，需要有买入交易）`,
        );
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
        `上日份额 <= 0，无法计算净值 portfolioId=${portfolioId} date=${dateStr}`,
      );
      return null;
    }

    const totalAsset = Number(snapshot.totalAsset);

    // Step 1：还原「当日申赎发生前」的持仓资产
    // 资产快照为当日期末总资产（已包含当日买入、已扣除当日卖出），
    // 故需减去当日买入额、加回当日卖出额，才能与上日末份额同口径比较。
    // 口径依据：用户决策 D-06（2026-08-01）。docs/PRD.md §3.3 示例与 §5.4 公式仍是旧口径，将在 PRD v1.2 同步修订。
    const preAsset = totalAsset - buyAmount + sellAmount;

    // 防御：申赎前资产必须为正
    // preAsset <= 0 等价于「当日买入额 >= 当日期末资产 + 当日卖出额」，
    // 现实中不可能发生（买进去的钱当天就必然计入期末资产），只可能是录入错误。
    // 若放行：preAsset = 0 会让 shares 变成 NaN，preAsset < 0 会算出负净值与负份额，
    // 两者都会静默污染后续所有日期的结转。
    if (preAsset <= 0) {
      // 带上日期：本方法可能在批量级联重算中被任意历史日期触发，
      // 不注明日期用户无从判断到底是哪一天录错了。
      throw new BadRequestException(
        `${dateStr} 当日买入金额 ${buyAmount.toFixed(2)} 超过当日期末资产 ${totalAsset.toFixed(2)}` +
          `（扣除当日卖出 ${sellAmount.toFixed(2)} 后，申赎前资产为 ${preAsset.toFixed(2)}，应大于 0），请检查录入`,
      );
    }

    // Step 2：按上日末份额对申赎前资产定价，得到当日单位净值
    const unitNav = preAsset / prevShares;
    const cumulativeNav = unitNav;

    // Step 3：处理当日申赎（买入新增份额，卖出赎回份额）
    // 等价于 shares = prevShares × totalAsset / preAsset，
    // 在 totalAsset > 0 / prevShares > 0 / preAsset > 0 下恒为正，故无需非负防御。
    // 不变量：totalAsset / shares === unitNav
    const newShares = buyAmount / unitNav - sellAmount / unitNav;
    const shares = prevShares + newShares;

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
