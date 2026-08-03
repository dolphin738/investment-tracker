/**
 * 内存版 Prisma 替身 —— 用于计算链路的集成级测试
 *
 * 为什么需要它：
 * NavService / XirrService 现有的单测都用 jest.fn() 逐个 mock 查询返回值，
 * 这种方式能验证「给定输入 → 输出」，但验证不了两件更重要的事：
 *   1. 两个引擎读同一份数据时口径是否自洽（跨引擎一致性）；
 *   2. 级联重算是否真的把后续日期的**数值**改对了（而不只是「被调用了」）。
 * 这两件事都要求「一份数据、多次真实查询、结果写回后被下一天读到」，
 * 用 mock 无法表达。本替身用最小实现覆盖计算链路实际用到的查询形态。
 *
 * 覆盖的查询（与 NavService / XirrService / RecalculationService /
 * CalculationService 的真实调用一一对应）：
 *   assetSnapshot.findUnique / findMany
 *   dailyNav.findFirst / upsert
 *   dailyXirr.upsert
 *   cashFlow.findMany / findFirst
 *   portfolio.findUnique / update
 */

/** 交易行 */
export interface TxRow {
  portfolioId: string;
  date: Date;
  type: 'BUY' | 'SELL';
  amount: number;
}

/** 资产快照行 */
export interface SnapRow {
  portfolioId: string;
  date: Date;
  totalAsset: number;
}

/** 每日净值行 */
export interface NavRow {
  portfolioId: string;
  date: Date;
  unitNav: number;
  cumulativeNav: number;
  yearNav: number;
  shares: number;
  baseCumulativeNav: number | null;
}

/** 每日 XIRR 行 */
export interface XirrRow {
  portfolioId: string;
  date: Date;
  xirrValue: number | null;
}

/** 数据库列精度（模拟 Prisma schema 的 Decimal 定义） */
export interface Precision {
  /** DailyNav.unitNav / cumulativeNav / yearNav → Decimal(12, 6) */
  nav: number;
  /** DailyNav.shares → Decimal(18, 6) */
  shares: number;
}

/** 生产库的真实精度，来自 prisma/schema.prisma */
export const DB_PRECISION: Precision = { nav: 6, shares: 6 };

/** 日期条件匹配：支持裸 Date（相等）与 { gte / lte / lt / gt } */
function matchDate(value: Date, cond: unknown): boolean {
  if (cond === undefined || cond === null) return true;
  if (cond instanceof Date) return value.getTime() === cond.getTime();

  const c = cond as { gte?: Date; lte?: Date; lt?: Date; gt?: Date };
  const t = value.getTime();
  if (c.gte && t < c.gte.getTime()) return false;
  if (c.lte && t > c.lte.getTime()) return false;
  if (c.lt && t >= c.lt.getTime()) return false;
  if (c.gt && t <= c.gt.getTime()) return false;
  return true;
}

/** 按小数位四舍五入（模拟数据库列精度截断） */
function roundTo(value: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

const keyOf = (portfolioId: string, date: Date) => `${portfolioId}|${date.getTime()}`;

/**
 * 内存 Prisma 替身
 *
 * 用法：
 *   const db = new InMemoryPrisma();
 *   db.seedPortfolio('p-1');
 *   db.seedTx('p-1', '2024-01-01', 'BUY', 10000);
 *   db.seedSnap('p-1', '2024-01-01', 10000);
 *   const nav = new NavService(db as any);
 */
export class InMemoryPrisma {
  transactions: TxRow[] = [];
  snapshots: SnapRow[] = [];
  navs = new Map<string, NavRow>();
  xirrs = new Map<string, XirrRow>();
  portfolios = new Map<string, { id: string; baseDate: Date | null }>();

  /**
   * 是否模拟数据库列精度。
   * 默认 null（不舍入）—— 先在无损条件下验证数学口径；
   * 设为 DB_PRECISION 可复现真实落库后的精度损失累积。
   */
  precision: Precision | null = null;

  /** 记录每次 dailyNav.upsert 的日期，用于断言「级联确实覆盖了哪些天」 */
  navUpsertLog: string[] = [];

  // ---------- 种子数据 ----------

  seedPortfolio(id: string, baseDate: Date | null = null): void {
    this.portfolios.set(id, { id, baseDate });
  }

  seedTx(portfolioId: string, dateStr: string, type: 'BUY' | 'SELL', amount: number): void {
    this.transactions.push({ portfolioId, date: utc(dateStr), type, amount });
  }

  seedSnap(portfolioId: string, dateStr: string, totalAsset: number): void {
    const date = utc(dateStr);
    const existing = this.snapshots.find(
      (s) => s.portfolioId === portfolioId && s.date.getTime() === date.getTime(),
    );
    if (existing) {
      existing.totalAsset = totalAsset;
    } else {
      this.snapshots.push({ portfolioId, date, totalAsset });
    }
  }

  /** 读取某日净值（测试断言用） */
  getNav(portfolioId: string, dateStr: string): NavRow | undefined {
    return this.navs.get(keyOf(portfolioId, utc(dateStr)));
  }

  /** 读取某日 XIRR（测试断言用） */
  getXirr(portfolioId: string, dateStr: string): XirrRow | undefined {
    return this.xirrs.get(keyOf(portfolioId, utc(dateStr)));
  }

  // ---------- Prisma 接口模拟 ----------

  assetSnapshot = {
    findUnique: async ({
      where,
    }: {
      where: { portfolioId_date: { portfolioId: string; date: Date } };
    }) => {
      const { portfolioId, date } = where.portfolioId_date;
      return (
        this.snapshots.find(
          (s) => s.portfolioId === portfolioId && s.date.getTime() === date.getTime(),
        ) ?? null
      );
    },

    findMany: async ({ where }: { where: { portfolioId: string; date?: unknown } }) => {
      return this.snapshots
        .filter((s) => s.portfolioId === where.portfolioId && matchDate(s.date, where.date))
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .map((s) => ({ ...s }));
    },
  };

  dailyNav = {
    findFirst: async ({ where }: { where: { portfolioId: string; date?: unknown } }) => {
      const rows = Array.from(this.navs.values())
        .filter((n) => n.portfolioId === where.portfolioId && matchDate(n.date, where.date))
        // 生产查询固定为 orderBy: { date: 'desc' }（取最近的上一日）
        .sort((a, b) => b.date.getTime() - a.date.getTime());
      return rows[0] ?? null;
    },

    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { portfolioId_date: { portfolioId: string; date: Date } };
      create: Omit<NavRow, 'portfolioId' | 'date'> & { portfolioId: string; date: Date };
      update: Omit<NavRow, 'portfolioId' | 'date'>;
    }) => {
      const { portfolioId, date } = where.portfolioId_date;
      const k = keyOf(portfolioId, date);
      const payload = this.navs.has(k) ? update : create;
      const row: NavRow = {
        portfolioId,
        date,
        unitNav: this.roundNav(payload.unitNav),
        cumulativeNav: this.roundNav(payload.cumulativeNav),
        yearNav: this.roundNav(payload.yearNav),
        shares: this.roundShares(payload.shares),
        baseCumulativeNav:
          payload.baseCumulativeNav === null || payload.baseCumulativeNav === undefined
            ? null
            : this.roundNav(payload.baseCumulativeNav),
      };
      this.navs.set(k, row);
      this.navUpsertLog.push(date.toISOString().split('T')[0]);
      return row;
    },
  };

  dailyXirr = {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { portfolioId_date: { portfolioId: string; date: Date } };
      create: { portfolioId: string; date: Date; xirrValue: number | null };
      update: { xirrValue: number | null };
    }) => {
      const { portfolioId, date } = where.portfolioId_date;
      const k = keyOf(portfolioId, date);
      const payload = this.xirrs.has(k) ? update : create;
      const row: XirrRow = { portfolioId, date, xirrValue: payload.xirrValue };
      this.xirrs.set(k, row);
      return row;
    },
  };

  cashFlow = {
    findMany: async ({
      where,
    }: {
      where: { portfolioId: string; date?: unknown; type?: 'BUY' | 'SELL' };
    }) => {
      return this.transactions
        .filter(
          (t) =>
            t.portfolioId === where.portfolioId &&
            matchDate(t.date, where.date) &&
            (where.type === undefined || t.type === where.type),
        )
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .map((t) => ({ ...t }));
    },

    findFirst: async ({
      where,
    }: {
      where: { portfolioId: string; date?: unknown; type?: 'BUY' | 'SELL' };
    }) => {
      const rows = this.transactions
        .filter(
          (t) =>
            t.portfolioId === where.portfolioId &&
            matchDate(t.date, where.date) &&
            (where.type === undefined || t.type === where.type),
        )
        // 生产查询固定为 orderBy: { date: 'asc' }（取首笔买入）
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      return rows[0] ? { ...rows[0] } : null;
    },
  };

  portfolio = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const p = this.portfolios.get(where.id);
      return p ? { ...p } : null;
    },

    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { baseDate?: Date };
    }) => {
      const p = this.portfolios.get(where.id);
      if (p && data.baseDate !== undefined) p.baseDate = data.baseDate;
      return p ? { ...p } : null;
    },
  };

  // ---------- 内部 ----------

  private roundNav(v: number): number {
    return this.precision ? roundTo(v, this.precision.nav) : v;
  }

  private roundShares(v: number): number {
    return this.precision ? roundTo(v, this.precision.shares) : v;
  }
}

/** 构造 UTC 午夜的 Date（与生产代码写库口径一致） */
export function utc(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00.000Z');
}

/** 两个日期相差的自然日数 */
export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
}
