/**
 * 金融核心公共类型
 *
 * 本包零运行时依赖，**不得** import @prisma/client 或任何 NestJS 符号。
 * 因此凡是来自数据库的数值列（Prisma Decimal）在此一律以 `DecimalLike` 表达：
 * 调用方直接把 Prisma 行对象传进来即可，纯函数内部沿用与原实现完全相同的
 * `Number(x)` 转换语义，不做任何额外规整。
 */

/**
 * 数据库数值列的结构化替身。
 *
 * Prisma 的 Decimal 是对象（带 toString/valueOf），`Number(decimal)` 可正确取值。
 * 保留 object 分支而非直接收 number，是为了让「原样透传 Prisma 行」成为可能
 * ——调用方直接把 Prisma 行对象传进来即可，纯函数内部沿用与原实现完全相同的
 * `Number(x)` 转换语义，不做任何额外规整。
 */
export type DecimalLike = number | string | { toString(): string };

/** 现金流条目 */
export interface Cashflow {
  /** 现金流日期 */
  date: Date;
  /** 金额：买入为负，卖出为正，终值（当日资产额）为正 */
  amount: number;
}

/** 构建现金流所需的交易行（Prisma Transaction 的结构子集） */
export interface CashflowTransaction {
  /** 交易日期 */
  date: Date;
  /** 交易方向 */
  type: 'BUY' | 'SELL';
  /** 交易金额（恒为正数，方向由 type 决定） */
  amount: DecimalLike;
}

/** 作为 XIRR 终值使用的当日资产快照 */
export interface TerminalSnapshot {
  /**
   * 估值日期。
   *
   * 由 adapter 显式传入「被查询的那一天」，而非快照行自带的 date —— 与原
   * XirrService.calculateXirrForDate 中 `cashflows.push({ date, ... })` 的
   * `date` 形参保持逐字节一致的语义。
   */
  date: Date;
  /** 当日期末总资产（口径见 nav.ts 顶部说明） */
  totalAsset: DecimalLike;
}

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

/**
 * 前一日净值记录（Prisma DailyNav 的结构子集）。
 *
 * 这是原 NavService 里的「状态自环」——当日份额依赖上日份额。
 * 抽成纯函数后它被提为显式入参，由 adapter 负责从库里取。
 */
export interface PrevNav {
  /** 前一条净值记录的日期（用于年度重置判定） */
  date: Date;
  /** 上日末总份额 */
  shares: DecimalLike;
  /** 上日累计净值 */
  cumulativeNav: DecimalLike;
  /**
   * 上日的当年基准累计净值。
   *
   * 纯函数内部用 `Number(prevNav.baseCumulativeNav) > 0` 做数值判断
   * （而非真值判断），避免 Prisma Decimal(0) 作为 truthy 对象导致除零。
   * 保留 DecimalLike 而不是提前转成 number，是为了让「原样透传 Prisma 行」
   * 成为可能，同时保证 Number() 转换语义与原实现完全一致。
   */
  baseCumulativeNav: DecimalLike | null;
}

/** computeNav 的入参 */
export interface ComputeNavInput {
  /** 当日期末总资产（含当日一切买入/卖出之后的最终金额） */
  totalAsset: DecimalLike;
  /** 前一日净值记录；null 表示成立日 */
  prevNav: PrevNav | null;
  /** 当日买入金额合计 */
  buyAmount: number;
  /** 当日卖出金额合计 */
  sellAmount: number;
  /** 计算日期 */
  date: Date;
}

/** 净值计算错误码 */
export type NavCalculationErrorCode =
  /** 成立日无买入交易 */
  | 'INCEPTION_WITHOUT_BUY'
  /** 申赎前资产 <= 0（当日买入额超过当日期末资产，数据录入错误） */
  | 'NON_POSITIVE_PRE_ASSET';
