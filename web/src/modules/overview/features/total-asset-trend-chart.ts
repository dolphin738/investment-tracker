/**
 * modules/overview/features/total-asset-trend-chart.ts — 总资产走势图纯函数集
 *
 * 平移自 React 版 web/src/features/overview/total-asset-trend-chart.tsx 中的
 * 可测导出（组件渲染部分见同目录 TotalAssetTrendChart.vue）。
 *
 * 【总资产口径】totalAsset(t) = cumulativeNav(t) × shares(t)，任一为 null 丢弃该点。
 * 前提：聚合方式必须是 AggregationMethod.LAST（期末值）。
 */

import { SnapshotSource } from '@/lib/types';
import type { NavSeriesPoint } from '@/lib/types';
import { type AxisTooltipParam } from '@/components/charts/chart-tooltip';

/** 手工记录标记的单页上限（后端 SnapshotQueryDto @Max(200)） */
export const MANUAL_MARK_PAGE_SIZE = 200;

/** 单个走势点 */
export interface TotalAssetTrendPoint {
  /** 日期 YYYY-MM-DD（与快照 date 对齐，用于匹配手工记录） */
  date: string;
  /** x 轴展示标签（如 2026-06 / 2026-W12） */
  label: string;
  /** 总资产 = cumulativeNav × shares */
  totalAsset: number;
}

/** tooltip 行渲染依赖的金额格式器（组件内用 formatCurrency 闭包注入） */
export type TooltipMoneyFormatter = (v: number) => string;

/**
 * 渲染 axis tooltip 单行文本：`marker系列名: 值`。
 *
 * 兼容散点 series 的数组值：折线 series 的 value 是 number，散点 series 的
 * value 是 [走势点下标, 总资产]，必须取 [1] 才是金额 —— 直接把数组交给
 * formatCurrency 会对非有限值返回 '-'。
 */
export function formatAxisTooltipLine(
  p: AxisTooltipParam,
  money: TooltipMoneyFormatter,
): string {
  const raw = p.value;
  // 共享 AxisTooltipParam.value 含 string 分支（本图不产生），收窄为 number 再交给 money
  const arrVal = Array.isArray(raw) ? raw[1] : raw;
  const v = typeof arrVal === 'number' ? arrVal : null;
  const text = v === null ? '数据不足' : money(v);
  return `${p.marker ?? ''}${p.seriesName ?? ''}: ${text}`;
}

/**
 * 渲染 axis tooltip 完整 HTML：头部 axisValueLabel + 每系列一行，<br/> 分隔。
 * 输出格式与修复前保持一致：`[头部]<br/>marker系列名: 值<br/>…`。
 */
export function formatAxisTooltip(
  params: AxisTooltipParam | AxisTooltipParam[],
  money: TooltipMoneyFormatter,
): string {
  const arr = Array.isArray(params) ? params : [params];
  const head = arr[0]?.axisValueLabel ?? '';
  const lines = arr.map((p) => formatAxisTooltipLine(p, money));
  return [head, ...lines].join('<br/>');
}

/**
 * 净值序列 → 总资产走势点。
 *
 * cumulativeNav 或 shares 任一为 null 的点直接丢弃（无法计算总资产），
 * 与迁移前 transactions.tsx 的口径逐字一致。
 */
export function buildTrendPoints(
  data: ReadonlyArray<NavSeriesPoint> | null | undefined,
): TotalAssetTrendPoint[] {
  const points = data ?? [];
  const result: TotalAssetTrendPoint[] = [];
  for (const p of points) {
    if (p.cumulativeNav === null || p.shares === null) continue;
    result.push({
      date: p.date,
      label: p.label,
      totalAsset: p.cumulativeNav * p.shares,
    });
  }
  return result;
}

/** 快照列表项中本组件用到的字段（结构化子集，避免与后端全量类型耦合） */
export interface ManualSnapshotLike {
  date: string;
  source: string;
}

/**
 * 收集手工记录日期集合。
 *
 * 服务端已按 source=MANUAL 筛选，此处再判一次是纵深防御：
 * 后端 DTO 未落盘 / 旧版本忽略该参数时，前端不至于把自动派生点标成手工。
 */
export function collectManualDates(
  items: ReadonlyArray<ManualSnapshotLike> | null | undefined,
): Set<string> {
  const set = new Set<string>();
  for (const s of items ?? []) {
    if (s.source === SnapshotSource.MANUAL) set.add(s.date);
  }
  return set;
}

/**
 * 手工记录散点数据：[走势点下标, 总资产]。
 *
 * 只有当手工记录日期恰好落在走势点上才出标记 —— 月/年粒度下多数手工日期不是
 * 期末点，自然不出标记，这与「散点必须落在折线上」的视觉约束一致。
 */
export function buildManualScatter(
  points: ReadonlyArray<TotalAssetTrendPoint>,
  manualDates: ReadonlySet<string>,
): Array<[number, number]> {
  const scatter: Array<[number, number]> = [];
  points.forEach((p, idx) => {
    if (manualDates.has(p.date)) scatter.push([idx, p.totalAsset]);
  });
  return scatter;
}
