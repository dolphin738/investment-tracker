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

/** 单条价格记录（批量预取后按标的分组，asOf 升序） */
interface PricePoint {
  asOf: string;
  price: number;
}

/** 将 Date 归一化为 YYYY-MM-DD（DB @db.Date 一律 UTC 午夜，故按 UTC 取） */
function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class HoldingDerivationService {
  private readonly logger = new Logger(HoldingDerivationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 推导指定组合在指定日期的全部持仓
   *
   * 单日入口，内部直接委托 {@link deriveBatch}（**唯一一份回放算法**，
   * 避免单日/批量两套实现产生口径漂移）。查询次数与改造前一致（2 次）。
   *
   * @param portfolioId 组合 ID
   * @param date 目标日期
   * @param includeClosed 是否包含已清仓标的（qty === 0，字段归零），默认 false
   * @returns HoldingView[] 持仓列表（默认仅含 qty > 0 的标的）
   */
  async derive(
    portfolioId: string,
    date: Date,
    includeClosed = false,
  ): Promise<HoldingView[]> {
    const batch = await this.deriveBatch(portfolioId, [date], includeClosed);
    return batch.get(toDateKey(date)) ?? [];
  }

  /**
   * 【批量】一次预取、多日复用地推导持仓
   *
   * 🔴 存在意义：避免「N 个日期 → N 轮查库」的 N+1（快照列表 derivedTotalAsset
   * 场景一次要算 N 个日期）。无论 dates 有多少个，**查库次数恒为 2**：
   *   1) 一次取 ≤ max(dates) 的全部 SecurityTrade（按 date, createdAt 升序）；
   *   2) 一次取 ≤ max(dates) 的全部 SecurityPrice（按 security_id, asOf 升序）。
   * 随后在内存中按日期升序单调推进游标，逐个日期切片出当日状态。
   *
   * 算法与单日版完全一致（移动加权平均 + 卖出硬校验 + 价格向前沿用），
   * 因此 `derive(pid, d)` ≡ `deriveBatch(pid, [d]).get(key(d))`。
   *
   * @param portfolioId 组合 ID
   * @param dates 目标日期数组（可乱序、可重复，内部去重并升序处理）
   * @param includeClosed 是否包含已清仓标的，默认 false
   * @returns Map<YYYY-MM-DD, HoldingView[]>；每个入参日期都必有条目（可能为空数组）
   * @throws BadRequestException 回放过程中出现卖出量超过持仓量
   */
  async deriveBatch(
    portfolioId: string,
    dates: readonly Date[],
    includeClosed = false,
  ): Promise<Map<string, HoldingView[]>> {
    const result = new Map<string, HoldingView[]>();
    if (dates.length === 0) {
      return result;
    }

    // 去重 + 升序（游标单调推进的前提）
    const sortedKeys = Array.from(new Set(dates.map(toDateKey))).sort();
    for (const key of sortedKeys) {
      result.set(key, []);
    }
    const maxDate = new Date(`${sortedKeys[sortedKeys.length - 1]}T00:00:00.000Z`);

    // ── 查询 1/2：≤maxDate 的全部证券买卖流水（按 date, createdAt 升序）──
    const trades = await this.prisma.securityTrade.findMany({
      where: {
        portfolioId,
        date: { lte: maxDate },
      },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      include: {
        security: { select: { id: true, code: true, name: true, type: true } },
      },
    });

    if (trades.length === 0) {
      // 无任何交易 → 每个日期都是空持仓（与单日版 `return []` 等价）
      return result;
    }

    // ── 查询 2/2：≤maxDate 的全部价格记录（一次取全，内存里按日期切片）──
    const securityIds = Array.from(new Set(trades.map((t) => t.securityId)));
    const priceRows = await this.prisma.$queryRawUnsafe<
      { security_id: string; price: string; asOf: string }[]
    >(
      `SELECT sp.security_id, sp.price::text, sp."asOf"::text
         FROM security_prices sp
        WHERE sp.portfolio_id = $1
          AND sp.security_id = ANY($2::text[])
          AND sp."asOf" <= $3::date
        ORDER BY sp.security_id, sp."asOf" ASC`,
      portfolioId,
      securityIds,
      maxDate,
    );

    /** securityId → 该标的的价格序列（asOf 升序） */
    const pricesBySecurity = new Map<string, PricePoint[]>();
    for (const row of priceRows) {
      const list = pricesBySecurity.get(row.security_id);
      const point: PricePoint = {
        asOf: row.asOf.slice(0, 10),
        price: Number(row.price),
      };
      if (list) {
        list.push(point);
      } else {
        pricesBySecurity.set(row.security_id, [point]);
      }
    }

    // ── 内存回放：交易游标 + 每标的价格游标，随目标日期升序单调推进 ──
    const stateMap = new Map<string, DerivationState>();
    const securityMap = new Map<
      string,
      { code: string; name: string; type: string }
    >();
    /** securityId → 已消费到的价格下标（指向「最后一条 asOf ≤ 当前目标日」的下一位） */
    const priceCursor = new Map<string, number>();
    let tradeCursor = 0;

    for (const dateKey of sortedKeys) {
      // 1) 回放所有 date ≤ dateKey 的交易
      while (
        tradeCursor < trades.length &&
        toDateKey(trades[tradeCursor].date) <= dateKey
      ) {
        const t = trades[tradeCursor];
        const sid = t.securityId;
        const state = stateMap.get(sid) ?? { qty: 0, costTotal: 0, avgCost: 0 };
        const q = Number(t.quantity);
        // 含费单价（INC-03 由 price 重命名）；费用已并入含费单价，成本总额无需再加 feeTotal
        const p = Number(t.costPrice);

        if (t.side === 'BUY_SEC') {
          // 买入：成本总额 += q*含费单价（含费单价已含佣金/印花税/其他费用）
          state.costTotal += q * p;
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
        tradeCursor += 1;
      }

      // 2) 快照当日持仓视图
      const views: HoldingView[] = [];
      for (const [sid, state] of stateMap) {
        if (state.qty <= 0 && !includeClosed) continue; // 默认跳过已清仓

        const sec = securityMap.get(sid)!;
        const priceInfo = this.advancePrice(
          pricesBySecurity.get(sid),
          priceCursor,
          sid,
          dateKey,
        );

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

        views.push({
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

      result.set(dateKey, views);
    }

    return result;
  }

  /**
   * 将某标的的价格游标推进到「最后一条 asOf ≤ dateKey」并返回该点
   *
   * 目标日期按升序处理，故游标只前进不回退，整体摊还 O(价格条数)。
   *
   * @param points 该标的的价格序列（asOf 升序）；undefined = 从无报价
   * @param cursor 游标表（原地更新）
   * @param securityId 标的 ID
   * @param dateKey 目标日期 YYYY-MM-DD
   * @returns 向前沿用的价格点；无任何 asOf ≤ dateKey 的记录 → null
   */
  private advancePrice(
    points: PricePoint[] | undefined,
    cursor: Map<string, number>,
    securityId: string,
    dateKey: string,
  ): PricePoint | null {
    if (!points || points.length === 0) {
      return null;
    }
    let idx = cursor.get(securityId) ?? 0;
    while (idx < points.length && points[idx].asOf <= dateKey) {
      idx += 1;
    }
    cursor.set(securityId, idx);
    return idx > 0 ? points[idx - 1] : null;
  }
}
