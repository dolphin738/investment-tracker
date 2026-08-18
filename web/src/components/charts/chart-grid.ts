/**
 * components/charts/chart-grid.ts — ECharts grid 统一口径（问题①）
 *
 * 【问题】x 轴末位日期被裁切。
 *
 * 【根因】折线/柱状图 x 轴为 category 轴，`boundaryGap: false` 时**最后一个刻度
 * 恰好落在 grid 右边界上**，而 ECharts 的类目轴标签是「以刻度为中心」绘制的，
 * 于是标签有大约一半宽度溢出到 grid 之外。
 *
 * `containLabel: true` 只保证坐标轴标签的整体包围盒不超出 **容器**，它是按
 * 「轴标签所需空间」反推 grid 内缩的，对末位标签这种**单侧半宽溢出**补偿不足
 * ——尤其当 `right` 本身只有 8~20px、而 `YYYY-MM-DD` 文案在 12px 字号下宽约
 * 70px（半宽 ≈ 35px）时，必然出现右侧截断。
 *
 * 【方案】把右侧留白统一提到 {@link AXIS_LABEL_HALF_WIDTH}(40px) ≥ 日期标签半宽，
 * 使末位标签有足够空间完整绘制；同时把各图分散的 grid 字面量收敛到本模块，
 * 避免后续再次各改各的、重新漂移。
 */

import type { EChartsOption } from 'echarts';

/** ECharts grid 配置类型（从 EChartsOption 收窄出对象形态，排除数组多 grid 用法） */
export type ChartGrid = Exclude<
  NonNullable<EChartsOption['grid']>,
  readonly unknown[]
>;

/**
 * 末位类目标签的半宽预留（px）。
 *
 * 取值依据：`YYYY-MM-DD` 在 12px 字号下宽约 70px，半宽 35px，取 40 留 5px 余量。
 * 这是修复问题①的关键数值 —— 小于 35 会重新出现末位日期裁切。
 */
export const AXIS_LABEL_HALF_WIDTH = 40;

/**
 * 时序图表的基础 grid（折线 / 柱状 / 面积图通用）。
 *
 * 各图若需微调，请用 {@link chartGrid} 传 overrides，不要就地写字面量，
 * 否则 `right` 又会被改小、问题①复发。
 */
export const BASE_GRID: ChartGrid = {
  left: 8,
  right: AXIS_LABEL_HALF_WIDTH,
  top: 10,
  bottom: 28,
  containLabel: true,
};

/**
 * 基于 {@link BASE_GRID} 派生 grid 配置。
 *
 * @param overrides 需要覆盖的字段（如 heatmap 的 left/bottom）
 * @returns 合并后的 grid 对象（浅合并，overrides 优先）
 *
 * @example
 * ```ts
 * grid: chartGrid({ bottom: 5 })          // 无 x 轴标题的紧凑图
 * grid: chartGrid({ left: 60, top: 30 })  // 热力图：左侧要放年份标签
 * ```
 */
export function chartGrid(overrides: ChartGrid = {}): ChartGrid {
  return { ...BASE_GRID, ...overrides };
}
