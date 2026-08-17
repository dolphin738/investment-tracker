/**
 * modules/overview/features/asset-metrics.ts — 概览页 8 张指标卡的构造口径（纯函数）
 *
 * 平移自 React 版 web/src/features/overview/asset-metrics.ts。
 *
 * 【背景】总资产概览由出入金页融合进概览页后，指标卡由 6 张扩为 8 张。
 * 若继续沿用页面内散装的三元表达式，8 张卡就是 8 套「格式化 + 空态文案 +
 * 涨跌方向」的私有实现，改一处忘一处必然漂移。
 *
 * 【方案】把「原始值 → 展示模型」这条链路收敛到本模块：
 * - formatAmountOrEmpty：金额格式化 + 空值兜底的唯一口径；
 * - buildOverviewMetrics：按固定顺序产出 8 项 OverviewMetric。
 *
 * 【为何是纯函数模块（.ts 而非 .vue）】不依赖组件运行时，测试可直接断言
 * 返回值，无需 render，也就不会被 jsdom / ECharts 的环境问题拖累。
 */

import type { SnapshotSource } from '@/lib/types';
import { formatCurrency, formatDecimal, formatPercent } from '@/lib/utils';

/** 金额为空时的统一占位文案 */
export const EMPTY_AMOUNT_TEXT = '暂无数据';

/** 金额格式化选项（与 formatCurrency 第三参一致） */
export interface AmountFormatOptions {
  /** 千分位（缺省跟随 formatCurrency 默认 true） */
  thousands?: boolean;
  /** 万 / 亿缩写（缺省跟随 formatCurrency 默认 false） */
  abbreviate?: boolean;
}

/**
 * 金额格式化 + 空值兜底（唯一口径）。
 *
 * `null` / `undefined` / `''` → EMPTY_AMOUNT_TEXT；
 * 但 `0` 与 `'0'` 是合法金额，必须照常格式化为 `¥0.00`。
 * 绝不可退回 `value ? format(value) : '暂无数据'` 这种 falsy 判断 ——
 * 那会把「余额恰好为 0」误显示成「暂无数据」（本函数存在的唯一理由）。
 */
export function formatAmountOrEmpty(
  value: string | number | null | undefined,
  format?: AmountFormatOptions,
): string {
  if (value === null || value === undefined || value === '') {
    return EMPTY_AMOUNT_TEXT;
  }
  return formatCurrency(value, 2, {
    thousands: format?.thousands,
    abbreviate: format?.abbreviate,
  });
}

/** 指标分组：'asset' = 资产构成行；'return' = 收益表现行 */
export type OverviewMetricGroup = 'asset' | 'return';

/** 单张指标卡的展示模型 */
export interface OverviewMetric {
  /** 渲染 key，同时作为测试定位标识 */
  key: string;
  /** 卡片标题（页面上唯一，「当前总资产」只出现 1 次） */
  title: string;
  /** 已格式化的展示值（含空值兜底） */
  value: string;
  /** 辅助描述（口径说明，如「截至 2026-06-15」「存入 - 取出」） */
  description?: string;
  /** 涨跌方向（PRD §9.5 正红负绿；金额类恒 neutral） */
  trend: 'up' | 'down' | 'neutral';
  /** 所属分组 */
  group: OverviewMetricGroup;
}

/** buildOverviewMetrics 入参 */
export interface BuildOverviewMetricsInput {
  /* —— 资产构成（4 张） —— */
  /** 当前总资产 */
  totalAsset?: string | number | null;
  /** 总资产数据截止日 */
  latestDate?: string | null;
  /** 最新快照来源，'MANUAL' 时「当前总资产」描述追加「· 手工」（Q-2 乙） */
  latestSource?: SnapshotSource | null;
  /** 持仓市值 */
  marketValue?: string | number | null;
  /** 现金余额（手工维护） */
  cashBalance?: string | number | null;
  /** 现金余额生效日 */
  cashAsOf?: string | null;
  /** 净投入（存入 - 取出） */
  netInvested?: string | number | null;
  /* —— 收益表现（4 张） —— */
  /** 累计收益率（比率，非百分数） */
  totalReturnRate?: string | number | null;
  /** 当年收益率（比率，非百分数） */
  yearReturnRate?: string | number | null;
  /** 年化 XIRR（比率，非百分数） */
  xirr?: string | number | null;
  /** 累计净值 */
  cumulativeNav?: string | number | null;
  /** 当年净值（仅用于「当年收益率」卡的描述行） */
  yearNav?: string | number | null;
  /* —— 格式化偏好 —— */
  /** 金额千分位 / 缩写 */
  format?: AmountFormatOptions;
  /** 净值小数位（偏好 navDecimals，缺省 4） */
  navDecimals?: number;
  /** 比率小数位（偏好 xirrDecimals，缺省 2） */
  xirrDecimals?: number;
}

/** 比率类涨跌方向：>=0 红涨 / <0 绿跌 / 空值中性 */
function rateTrend(
  value: string | number | null | undefined,
): OverviewMetric['trend'] {
  if (value === null || value === undefined || value === '') return 'neutral';
  const num = Number(value);
  if (!Number.isFinite(num)) return 'neutral';
  return num >= 0 ? 'up' : 'down';
}

/** 净值涨跌方向：>=1 红涨 / <1 绿跌 / 空值中性（与改造前 dashboard 口径一致） */
function navTrend(
  value: string | number | null | undefined,
): OverviewMetric['trend'] {
  if (value === null || value === undefined || value === '') return 'neutral';
  const num = Number(value);
  if (!Number.isFinite(num)) return 'neutral';
  return num >= 1 ? 'up' : 'down';
}

/** 净值描述行：「净值 1.2345」；无值时回落占位 */
function navDescription(
  value: string | number | null | undefined,
  decimals: number,
): string {
  if (value === null || value === undefined || value === '') {
    return EMPTY_AMOUNT_TEXT;
  }
  return `净值 ${formatDecimal(value, decimals)}`;
}

/**
 * 构造概览页 8 张指标卡（固定顺序，融合去重后「当前总资产」只出现 1 次）。
 *
 * 顺序：
 * - asset  : total-asset / market-value / cash-balance / net-invested
 * - return : total-return-rate / year-return-rate / xirr / cumulative-nav
 *
 * 空值口径：
 * - 金额类走 formatAmountOrEmpty → 「暂无数据」（0 照常显示）；
 * - 比率类走 formatPercent → '-'（保持改造前概览页行为，避免回归）。
 */
export function buildOverviewMetrics(
  input: BuildOverviewMetricsInput,
): OverviewMetric[] {
  const {
    totalAsset = null,
    latestDate = null,
    latestSource = null,
    marketValue = null,
    cashBalance = null,
    cashAsOf = null,
    netInvested = null,
    totalReturnRate = null,
    yearReturnRate = null,
    xirr = null,
    cumulativeNav = null,
    yearNav = null,
    format,
    navDecimals = 4,
    xirrDecimals = 2,
  } = input;

  // Q-2 乙：最新快照为手工录入时，在数据截止日后追加「手工」标注
  const totalAssetBase = latestDate ? `截至 ${latestDate}` : '数据截止日未知';
  const totalAssetDescription =
    latestSource === 'MANUAL' ? `${totalAssetBase} · 手工` : totalAssetBase;

  return [
    // ===== 资产构成（我有多少） =====
    {
      key: 'total-asset',
      title: '当前总资产',
      value: formatAmountOrEmpty(totalAsset, format),
      description: totalAssetDescription,
      trend: 'neutral',
      group: 'asset',
    },
    {
      key: 'market-value',
      title: '持仓市值',
      value: formatAmountOrEmpty(marketValue, format),
      description: '由买卖流水推导',
      trend: 'neutral',
      group: 'asset',
    },
    {
      key: 'cash-balance',
      title: '现金余额',
      value: formatAmountOrEmpty(cashBalance, format),
      description: cashAsOf ? `生效日 ${cashAsOf}` : '未维护，可在出入金页录入',
      trend: 'neutral',
      group: 'asset',
    },
    {
      key: 'net-invested',
      title: '净投入',
      value: formatAmountOrEmpty(netInvested, format),
      description: '存入 - 取出',
      trend: 'neutral',
      group: 'asset',
    },
    // ===== 收益表现（赚了多少） =====
    {
      key: 'total-return-rate',
      title: '累计收益率',
      value: formatPercent(totalReturnRate, 2, { decimals: xirrDecimals }),
      description: navDescription(cumulativeNav, navDecimals),
      trend: rateTrend(totalReturnRate),
      group: 'return',
    },
    {
      key: 'year-return-rate',
      title: '当年收益率',
      value: formatPercent(yearReturnRate, 2, { decimals: xirrDecimals }),
      description: navDescription(yearNav, navDecimals),
      trend: rateTrend(yearReturnRate),
      group: 'return',
    },
    {
      key: 'xirr',
      title: '年化 XIRR',
      value: formatPercent(xirr, 2, { decimals: xirrDecimals }),
      description: '累计年化',
      trend: rateTrend(xirr),
      group: 'return',
    },
    {
      key: 'cumulative-nav',
      title: '累计净值',
      value:
        cumulativeNav === null || cumulativeNav === undefined || cumulativeNav === ''
          ? EMPTY_AMOUNT_TEXT
          : formatDecimal(cumulativeNav, navDecimals),
      description: '单位净值',
      trend: navTrend(cumulativeNav),
      group: 'return',
    },
  ];
}
