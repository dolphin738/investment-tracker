/**
 * 持仓推导服务（方案B · 交易明细法）
 *
 * 按 (date, createdAt) 升序回放 SecurityTrade 流水，
 * 推导任意日期的持仓状态。不落库、纯计算。
 *
 * 【成本口径】移动加权平均（与券商 App 一致）：
 *   - 买入：costTotal += q*p + fee, qty += q, avgCost = costTotal/qty
 *   - 卖出：qty -= q, avgCost 不变, costTotal = qty * avgCost
 *   - 清仓：qty === 0 → avgCost=0, costTotal=0
 *
 * 【卖出硬校验】卖出量 ≤ 当前持仓量，否则抛 400
 * 【估值规则】
 *   - 现价 = SecurityPrice 中 asOf ≤ date 的最后一条（向前沿用）
 *   - 无任何价格 → 回退用 avgCost 估值，valuationFlag=COST_BASED
 *
 * 详见 PRD §5.2.2 + ARCH §9
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** 持仓视图（单个标的在指定日期的持仓状态） */
export interface HoldingView {
  /** 标的 ID */
  securityId: string;
  /** 标的代码 */
  securityCode: string;
  /** 标的名称 */
  securityName: string;
  /** 标的类型 */
  securityType: string;
  /** 持仓数量 */
  quantity: number;
  /** 移动加权平均成本价 */
  avgCost: number;
  /** 成本总额 */
  costTotal: number;
  /** 现价（向前沿用） */
  marketPrice: number;
  /** 现价日期 YYYY-MM-DD，null = 无价格记录（回退成本估值） */
  priceAsOf: string | null;
  /** 持仓市值 = quantity * marketPrice */
  marketValue: number;
  /** 浮动盈亏 */
  pnl: number;
  /** 盈亏率 */
  pnlRate: number;
  /** 估值标识：EXACT（有现价）/ COST_BASED（回退成本） */
  flag: 'EXACT' | 'COST_BASED';
}

/** 单标的推导中间状态 */
interface DerivationState {
  qty: number;
  costTotal: number;
  avgCost: number;
}

@Injectable()
export class HoldingDerivationService {
  private readonly logger = new Logger(HoldingDerivationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 推导指定组合在指定日期的全部持仓
   *
   * 流程：
   * 1. 查该组合该日期的所有 SecurityTrade（按 date, createdAt 升序）
   * 2. 按标的分组回放，计算 avgCost/costTotal/qty
   * 3. 查每个标的在 ≤date 的最新价
   * 4. 计算市值/盈亏/占比
   *
   * @param portfolioId 组合 ID
   * @param date 目标日期
   * @returns HoldingView[] 持仓列表（仅含 qty > 0 的标的）
   */
  async derive(portfolioId: string, date: Date): Promise<HoldingView[]> {
    // 1. 查询 ≤date 的全部证券买卖流水（按 date, createdAt 升序）
    const trades = await this.prisma.securityTrade.findMany({
      where: {
        portfolioId,
        date: { lte: date },
      },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      include: {
        security: { select: { id: true, code: true, name: true, type: true } },
      },
    });

    if (trades.length === 0) {
      return [];
    }

    // 2. 按标的分组回放
    const stateMap = new Map<string, DerivationState>();
    const securityMap = new Map<
      string,
      { code: string; name: string; type: string }
    >();

    for (const t of trades) {
      const sid = t.securityId;
      let state = stateMap.get(sid) ?? { qty: 0, costTotal: 0, avgCost: 0 };
      const q = Number(t.quantity);
      const p = Number(t.price);
      const fee = Number(t.fee);

      if (t.side === 'BUY_SEC') {
        // 买入：成本总额 += q*p + fee, 数量 += q
        state.costTotal += q * p + fee;
        state.qty += q;
        state.avgCost = state.qty > 0 ? state.costTotal / state.qty : 0;
      } else if (t.side === 'SELL_SEC') {
        // 🔴 卖出硬校验：卖出量 ≤ 当前持仓量
        if (q > state.qty) {
          throw new BadRequestException(
            `卖出数量 ${q} 超过当前持仓 ${state.qty}，无法执行（标的: ${t.security.code ?? t.securityId}）`,
          );
        }
        state.qty -= q;
        // avgCost 不变；costTotal 随数量等比减少
        state.costTotal = state.qty * state.avgCost;
        // 清仓归零
        if (state.qty === 0) {
          state.avgCost = 0;
          state.costTotal = 0;
        }
      }

      stateMap.set(sid, state);
      securityMap.set(sid, {
        code: t.security.code,
        name: t.security.name,
        type: t.security.type,
      });
    }

    // 3. 查询每个标的最新价（asOf ≤ date 的最后一条）
    const securityIds = Array.from(stateMap.keys());
    const priceRows = await this.prisma.$queryRawUnsafe<
      { security_id: string; price: string; as_of: string }[]
    >(
      `SELECT DISTINCT ON (sp.security_id)
         sp.security_id, sp.price::text, sp.as_of::text
       FROM security_prices sp
       WHERE sp.portfolio_id = $1
         AND sp.security_id = ANY($2::uuid[])
         AND sp.as_of <= $3::date
       ORDER BY sp.security_id, sp.as_of DESC`,
      portfolioId,
      securityIds,
      date,
    );

    const priceMap = new Map<string, { price: number; asOf: string }>();
    for (const row of priceRows) {
      priceMap.set(row.security_id, {
        price: Number(row.price),
        asOf: row.as_of,
      });
    }

    // 4. 构建 HoldingView[]
    const results: HoldingView[] = [];

    for (const [sid, state] of stateMap) {
      if (state.qty <= 0) continue; // 跳过已清仓

      const sec = securityMap.get(sid)!;
      const priceInfo = priceMap.get(sid);

      let marketPrice: number;
      let flag: 'EXACT' | 'COST_BASED';
      let priceAsOf: string | null;

      if (priceInfo) {
        marketPrice = priceInfo.price;
        flag = 'EXACT';
        priceAsOf = priceInfo.asOf;
      } else {
        // 无现价 → 回退 avgCost 估值
        marketPrice = state.avgCost;
        flag = 'COST_BASED';
        priceAsOf = null;
      }

      const marketValue = state.qty * marketPrice;
      const pnl = marketValue - state.costTotal;
      const pnlRate = state.costTotal !== 0 ? pnl / state.costTotal : 0;

      results.push({
        securityId: sid,
        securityCode: sec.code,
        securityName: sec.name,
        securityType: sec.type,
        quantity: state.qty,
        avgCost: state.avgCost,
        costTotal: state.costTotal,
        marketPrice,
        priceAsOf,
        marketValue,
        pnl,
        pnlRate,
        flag,
      });
    }

    return results;
  }
}
