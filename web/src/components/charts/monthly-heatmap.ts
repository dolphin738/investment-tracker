/**
 * components/charts/monthly-heatmap.ts — 月度收益热力图纯函数
 *
 * 平移自 React 版 web/src/components/charts/monthly-heatmap.tsx
 * （computeMonthlyReturns + useMemo 内 option 构造抽为纯函数，便于单测；
 * 组件见 MonthlyHeatmap.vue）。
 *
 * 横轴恒定 1-12 月，纵轴年份，颜色映射月度收益率（PRD §9.5 正红负绿）。
 * 数据来源：日维度 NavSeriesPoint，按 (年, 月) 聚合计算
 * 月度收益率 = 月末当年净值 - 同年上月末当年净值（年内首月的基准取年初 1.0）。
 *
 * 月份轴恒定，不随数据收敛：只有 8 月有数据时，仍完整渲染 1-12 月，
 * 无数据月份留空（不着色、无 tooltip），避免出现「整张图只有一列 8 月」。
 */

import type { EChartsOption } from 'echarts';
import { chartGrid } from '@/components/charts/chart-grid';
import type { NavSeriesPoint } from '@/lib/types';

/** 热力图单元格（年 / 月 / 月度收益率） */
export interface HeatCell {
  year: number;
  month: number;
  rate: number | null;
}

/** 月份轴：恒定 1-12，不由数据推导（导出供测试与调用方复用） */
export const HEATMAP_MONTHS: readonly number[] = Array.from(
  { length: 12 },
  (_, i) => i + 1,
);

/**
 * 年初基准「当年净值」。
 *
 * 后端 `finance_core/nav.py` 约定：跨年首个交易日 `year_nav` 重置为 1.0，
 * 当年其余交易日 `year_nav = cumulative_nav / 上年末累计净值`。
 * 因此「年内首个有数据月份」的月度收益应以 1.0 为基准，而不是拿上一年 12 月的
 * `year_nav`（那会把整年累计涨幅当成 1 月的跌幅）。
 */
const YEAR_START_NAV = 1;

/** 分组键：月份必须补零，否则 '2025-10' 会字典序排在 '2025-2' 之前，环比配对整体错位 */
function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** 从日维度净值序列计算月度收益率（年份轴由数据推导，月份轴恒定 1-12） */
export function computeMonthlyReturns(data: NavSeriesPoint[]): {
  years: number[];
  cells: HeatCell[];
} {
  if (!data || data.length === 0) {
    return { years: [], cells: [] };
  }
  // 按日期排序
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));

  // 按 (year, month) 分组，取该月最后一条记录的 yearNav
  const monthlyMap = new Map<
    string,
    { year: number; month: number; yearNav: number | null }
  >();
  for (const point of sorted) {
    const d = new Date(point.date);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    monthlyMap.set(monthKey(year, month), { year, month, yearNav: point.yearNav });
  }

  const yearsSet = new Set<number>();
  const cells: HeatCell[] = [];

  // 按 (year, month) 顺序计算环比
  const sortedKeys = Array.from(monthlyMap.keys()).sort();
  let prev: { year: number; month: number; yearNav: number | null } | null = null;
  for (const key of sortedKeys) {
    const cur = monthlyMap.get(key)!;
    yearsSet.add(cur.year);
    // 基准：同年上一个有数据的月末 year_nav；年内首月（含跨年）回落到年初基准 1.0
    const base =
      prev !== null && prev.year === cur.year ? prev.yearNav : YEAR_START_NAV;
    const rate =
      cur.yearNav !== null && base !== null ? cur.yearNav - base : null;
    cells.push({ year: cur.year, month: cur.month, rate });
    prev = cur;
  }

  const years = Array.from(yearsSet).sort((a, b) => a - b);
  return { years, cells };
}

/**
 * 从 CSS 变量读取主题色（PRD §9.5: 正红负绿）。
 *
 * ECharts canvas 不支持 CSS 变量，须在运行时从 computedStyle 读取。
 * 注意：CSS 变量中 HSL 分量以空格分隔（如 `0 84% 48%`），而 ECharts/zrender
 * 的颜色解析器不支持 CSS Color Level 4 的空格语法，须转为逗号分隔。
 */
function getThemeColors() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const upHsl = style.getPropertyValue('--color-up').trim();
  const downHsl = style.getPropertyValue('--color-down').trim();
  return {
    up: `hsl(${upHsl.replace(/\s+/g, ', ')})`,
    down: `hsl(${downHsl.replace(/\s+/g, ', ')})`,
  };
}

/** option 构造入参（computeMonthlyReturns 的输出） */
export interface MonthlyHeatmapOptionInput {
  years: number[];
  cells: HeatCell[];
}

/** 构建月度热力图 option（与 React 版 useMemo 内构造逐字一致） */
export function buildMonthlyHeatmapOption(
  input: MonthlyHeatmapOptionInput,
): EChartsOption {
  const { years, cells } = input;
  const monthLabels = HEATMAP_MONTHS.map((m) => `${m}月`);
  const yearLabels = years.map((y) => y.toString());
  const seriesData: [number, number, number | string][] = [];
  let maxAbs = 0;
  cells.forEach((cell) => {
    // 月份轴恒定 1-12，x 由月份直接定位，不再 indexOf 有数据月份集合
    const x = cell.month - 1;
    const y = years.indexOf(cell.year);
    if (x >= 0 && x < HEATMAP_MONTHS.length && y >= 0) {
      if (cell.rate !== null) {
        maxAbs = Math.max(maxAbs, Math.abs(cell.rate));
        seriesData.push([x, y, cell.rate]);
      } else {
        seriesData.push([x, y, '-']);
      }
    }
  });

  const themeColors = getThemeColors();

  return {
    tooltip: {
      position: 'top',
      formatter: (params: unknown) => {
        // echarts 的 CallbackDataParams.value 为宽联合类型，
        // 此处用 unknown 承接后收窄为热力图三元组（value: [x, y, v]）
        const { value } = params as { value: [number, number, number | string] };
        const [x, y, v] = value;
        const year = years[y];
        const month = HEATMAP_MONTHS[x];
        if (v === '-' || v === null || typeof v !== 'number') {
          return `${year}年 ${month}月: 数据不足`;
        }
        return `${year}年 ${month}月: ${(v * 100).toFixed(2)}%`;
      },
    },
    // 左侧留给年份类目标签；右侧沿用统一留白（问题①）
    grid: chartGrid({ top: 30, bottom: 40, left: 60 }),
    xAxis: {
      type: 'category',
      data: monthLabels,
      splitArea: { show: true },
      // interval: 0 强制 12 个月标签全显示，禁止 ECharts 因宽度紧张自动隔项抽稀
      axisLabel: { fontSize: 11, interval: 0 },
    },
    yAxis: {
      type: 'category',
      data: yearLabels,
      splitArea: { show: true },
      axisLabel: { fontSize: 11 },
    },
    visualMap: {
      min: -maxAbs || -0.1,
      max: maxAbs || 0.1,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      textStyle: { fontSize: 11 },
      inRange: {
        // PRD §9.5: 正红负绿 — min(最负) → 绿色, max(最正) → 红色
        // 两端使用主题变量色，中间保留渐变色形成平滑过渡
        color: [themeColors.down, '#22c55e', '#86efac', '#fde68a', '#fca5a5', '#f87171', themeColors.up],
      },
    },
    series: [
      {
        type: 'heatmap',
        data: seriesData,
        label: { show: false },
        emphasis: {
          itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0, 0, 0, 0.5)' },
        },
      },
    ],
  };
}
