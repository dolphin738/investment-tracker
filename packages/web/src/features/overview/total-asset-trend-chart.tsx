/**
 * features/overview/total-asset-trend-chart.tsx — 总资产走势图（含手工记录标记）
 *
 * 【来历】原在出入金页【A】块（固定近 30 天），按
 * `docs/designs/overview-fusion-2026-08-06.md` 迁至概览页，区间改为跟随页面
 * 的日期筛选（快捷范围 + 起止日期）。出入金页对应代码已整块删除。
 *
 * 【数据获取分工（混合式，设计 §4.2）】
 * - 净值序列 `data` 由**页面传入** —— 概览页已为「净值趋势」调用 `useNavSeries`，
 *   复用同一份数据 ⇒ 零额外请求，且两张图的点严格同源、不会互相打架。
 * - 手工记录标记由**组件内** `useSnapshots` 自取 —— 只有本图需要，内聚在此，
 *   不污染页面。走服务端 `source=MANUAL` 筛选（旧实现 `pageSize:60` 且前端
 *   过滤，在长区间必然截断，属缺陷修复）。
 *
 * 【总资产口径】`totalAsset(t) = cumulativeNav(t) × shares(t)`，任一为 null 丢弃该点。
 * ⚠️ **前提：聚合方式必须是 `AggregationMethod.LAST`（期末值）**。概览页当前
 * 硬编码 LAST，成立；若future 引入 AVG 开关，
 * `avg(nav) × avg(shares) ≠ avg(nav × shares)`，届时必须改为后端直出总资产序列。
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import { ChevronRight, Settings2 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { chartGrid } from '@/components/charts/chart-grid';
import { useSnapshots } from '@/hooks/use-snapshots';
import { ROUTE_PATH } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';
import { SnapshotSource } from '@investment-tracker/shared';
import type { NavSeriesPoint } from '@investment-tracker/shared';

/** 手工记录标记的单页上限（后端 SnapshotQueryDto `@Max(200)`） */
export const MANUAL_MARK_PAGE_SIZE = 200;

/**
 * 图表高度 px（概览页全宽单栏，比出入金页旧版 220px 略高）。
 * ⚠️ 骨架屏/空态的 `h-[260px]` 是 Tailwind 字面量类，改这里须同步改那两处。
 */
const CHART_HEIGHT = 260;

/** 主线色（与「净值趋势」累计线同色系） */
const COLOR_LINE = 'hsl(217, 91%, 60%)';
/** 手工记录散点色 */
const COLOR_MANUAL = 'hsl(0, 84%, 48%)';
/** 网格线 / 轴标签色（与其它图表一致） */
const GRID_COLOR = '#ccc';
const AXIS_COLOR = '#666';

/** 单个走势点 */
export interface TotalAssetTrendPoint {
  /** 日期 YYYY-MM-DD（与快照 date 对齐，用于匹配手工记录） */
  date: string;
  /** x 轴展示标签（如 2026-06 / 2026-W12） */
  label: string;
  /** 总资产 = cumulativeNav × shares */
  totalAsset: number;
}

/** ECharts `trigger: 'axis'` tooltip 回调入参（仅声明用到的字段） */
interface AxisTooltipParam {
  axisValueLabel?: string;
  seriesName?: string;
  marker?: string;
  value?: number | null;
  dataIndex: number;
}

/**
 * 净值序列 → 总资产走势点。
 *
 * `cumulativeNav` 或 `shares` 任一为 null 的点直接丢弃（无法计算总资产），
 * 与迁移前 `transactions.tsx` 的口径逐字一致。
 *
 * @param data 净值序列（LAST 聚合）
 * @returns 可绘制的走势点，顺序与入参一致
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
 * 服务端已按 `source=MANUAL` 筛选，此处再判一次是**纵深防御**：
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
 * 手工记录散点数据：`[走势点下标, 总资产]`。
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

export interface TotalAssetTrendChartProps {
  /** 净值序列（由页面传入，与「净值趋势」共用同一份数据） */
  data: NavSeriesPoint[];
  /** 序列加载中 */
  loading?: boolean;
  /** 当前组合 ID —— 组件内自取手工记录标记所需的快照 */
  portfolioId: string | null;
  /** 图表区间起（仅用于查询手工记录快照，与 data 的区间保持一致） */
  startDate: string;
  /** 图表区间止 */
  endDate: string;
  /** 金额千分位偏好 */
  amountThousands?: boolean;
  /** 金额缩写偏好 */
  amountAbbrev?: boolean;
  title?: string;
  className?: string;
}

/**
 * 总资产走势图卡片。
 *
 * 卡头承载从出入金页迁移过来的两个 `/snapshots` 入口 ——
 * 其中「⚙ 管理历史记录」的 `?manage=1` 深链是全站唯一入口，不可再丢。
 */
export function TotalAssetTrendChart({
  data,
  loading = false,
  portfolioId,
  startDate,
  endDate,
  amountThousands,
  amountAbbrev,
  title = '总资产走势',
  className,
}: TotalAssetTrendChartProps): JSX.Element {
  const trendPoints = useMemo(() => buildTrendPoints(data), [data]);

  /**
   * 手工记录快照（服务端 source=MANUAL 筛选）。
   *
   * 无走势点时传 null 关闭查询：此时图表进空态、标记无处可落，
   * 发这个请求纯属浪费（也让首屏/空组合少一次网络往返）。
   */
  const manualSnapshots = useSnapshots(trendPoints.length > 0 ? portfolioId : null, {
    startDate,
    endDate,
    page: 1,
    pageSize: MANUAL_MARK_PAGE_SIZE,
    source: SnapshotSource.MANUAL,
  });

  const manualDates = useMemo(
    () => collectManualDates(manualSnapshots.data?.items),
    [manualSnapshots.data],
  );

  /** 手工记录数超出单页上限 → 给灰字提示，不阻塞主线 */
  const manualTruncated = (manualSnapshots.data?.total ?? 0) > MANUAL_MARK_PAGE_SIZE;

  const option = useMemo(() => {
    const labels = trendPoints.map((p) => p.label);
    const values = trendPoints.map((p) => p.totalAsset);
    const manualPoints = buildManualScatter(trendPoints, manualDates);
    const money = (v: number): string =>
      formatCurrency(v, 2, {
        thousands: amountThousands,
        abbreviate: amountAbbrev,
      });

    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: AxisTooltipParam | AxisTooltipParam[]): string => {
          const arr = Array.isArray(params) ? params : [params];
          const head = arr[0]?.axisValueLabel ?? '';
          const lines = arr.map((p) => {
            const v = p.value;
            const text = v === null || v === undefined ? '数据不足' : money(v);
            return `${p.marker ?? ''}${p.seriesName ?? ''}: ${text}`;
          });
          return [head, ...lines].join('<br/>');
        },
      },
      legend: { bottom: 0, textStyle: { fontSize: 12 } },
      // 右侧留白由 chart-grid 统一给足，避免末位日期被裁切（问题①）
      grid: chartGrid(),
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: labels,
        axisLabel: { fontSize: 11, color: AXIS_COLOR },
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          fontSize: 11,
          color: AXIS_COLOR,
          formatter: (v: number): string => `${(v / 10000).toFixed(1)}万`,
        },
        splitLine: { show: true, lineStyle: { type: [3, 3], color: GRID_COLOR } },
      },
      series: [
        {
          name: '总资产',
          type: 'line',
          smooth: true,
          connectNulls: true,
          showSymbol: false,
          lineStyle: { width: 2, color: COLOR_LINE },
          itemStyle: { color: COLOR_LINE },
          data: values,
        },
        {
          name: '手工记录',
          type: 'scatter',
          symbolSize: 8,
          itemStyle: { color: COLOR_MANUAL },
          data: manualPoints,
          tooltip: {
            formatter: (p: { value: [number, number] }): string =>
              `手工记录：${money(p.value[1])}`,
          },
        },
      ],
    };
  }, [trendPoints, manualDates, amountThousands, amountAbbrev]);

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        {/* 从出入金页迁移过来的两个入口；manage=1 是全站唯一深链入口 */}
        <div className="flex items-center gap-3 text-xs">
          <Link
            to={ROUTE_PATH.SNAPSHOTS}
            className="flex items-center text-muted-foreground hover:underline"
          >
            查看全部历史
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
          <Link
            to={`${ROUTE_PATH.SNAPSHOTS}?manage=1`}
            className="flex items-center text-muted-foreground hover:underline"
          >
            <Settings2 className="mr-1 h-3.5 w-3.5" />
            管理历史记录
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* 高度类必须是字面量 —— Tailwind 静态扫描不认模板串拼接的任意值类 */}
        {loading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : trendPoints.length === 0 ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
            当前范围暂无资产数据
          </div>
        ) : (
          <>
            <ReactECharts
              option={option}
              style={{ height: CHART_HEIGHT, width: '100%' }}
            />
            {manualTruncated && (
              <p className="text-right text-xs text-muted-foreground">
                仅显示前 {MANUAL_MARK_PAGE_SIZE} 个手工记录标记
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
