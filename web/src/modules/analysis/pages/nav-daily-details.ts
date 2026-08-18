/**
 * modules/analysis/pages/nav-daily-details.ts — 每日净值明细计算纯函数
 *
 * 平移自 React 版 web/src/pages/nav-analysis.tsx 内的 computeDailyDetails
 * （抽为独立纯函数文件，便于单测）。
 *
 * 由日维度净值序列计算每日明细（按日期升序计算收益，展示倒序）：
 * - 每日收益 =（当日累计净值 - 前日累计净值）x 前日份额
 * - 收益百分比 =（当日累计净值 - 前日累计净值）/ 前日累计净值
 */

import type { NavSeriesPoint } from '@/lib/types';

/** 每日明细行（含每日收益/收益百分比） */
export interface DailyDetailRow {
  date: string;
  label: string;
  cumulativeNav: number | null;
  yearNav: number | null;
  shares: number | null;
  /** 每日收益 =（当日累计净值 - 前日累计净值）x 前日份额 */
  dailyReturn: number | null;
  /** 收益百分比 =（当日累计净值 - 前日累计净值）/ 前日累计净值 */
  returnRate: number | null;
}

/** 由日维度净值序列计算每日明细（按日期升序计算收益，展示倒序） */
export function computeDailyDetails(data: NavSeriesPoint[]): DailyDetailRow[] {
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));
  const rows: DailyDetailRow[] = [];
  let prev: NavSeriesPoint | null = null;
  for (const p of sorted) {
    let dailyReturn: number | null = null;
    let returnRate: number | null = null;
    if (
      prev &&
      p.cumulativeNav !== null &&
      prev.cumulativeNav !== null &&
      prev.shares !== null &&
      Number.isFinite(prev.shares)
    ) {
      const diff = p.cumulativeNav - prev.cumulativeNav;
      dailyReturn = diff * prev.shares;
      if (prev.cumulativeNav !== 0) {
        // 收益%公式等价性（Part E-8 / F10）：
        // PRD「每日收益 / 前一日总资产」= (Δnav x prevShares) / (prevNav x prevShares) = Δnav / prevNav，
        // 与现有 diff / prev.cumulativeNav 数学等价，无需改逻辑。
        // 「前一日」= 前一个有记录的计算日（稀疏日期下的金融口径近似，F10 已确认维持现状）。
        returnRate = diff / prev.cumulativeNav;
      }
    }
    rows.push({
      date: p.date,
      label: p.label,
      cumulativeNav: p.cumulativeNav,
      yearNav: p.yearNav,
      shares: p.shares,
      dailyReturn,
      returnRate,
    });
    prev = p;
  }
  return rows.reverse();
}
