/**
 * components/charts/nav-trend-chart.tsx — 累计净值 + 当年净值双线对比图（Recharts）
 */

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TooltipValueType } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDecimal } from '@/lib/utils';
import type { NavSeriesPoint } from '@investment-tracker/shared';

export interface NavTrendChartProps {
  data: NavSeriesPoint[];
  loading?: boolean;
  title?: string;
  className?: string;
}

export function NavTrendChart({
  data,
  loading,
  title = '净值趋势',
  className,
}: NavTrendChartProps): JSX.Element {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !data || data.length === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 12 }}
                className="text-muted-foreground"
              />
              <YAxis
                tick={{ fontSize: 12 }}
                className="text-muted-foreground"
                tickFormatter={(v: number) => v.toFixed(2)}
              />
              <Tooltip
                formatter={(
                  value: TooltipValueType | undefined,
                  name: number | string | undefined,
                ) => {
                  if (value === null || value === undefined) return ['数据不足', name ?? ''];
                  if (name === '累计净值' || name === '当年净值') {
                    return [formatDecimal(Number(value), 4), name];
                  }
                  return [String(value), name];
                }}
                labelClassName="text-foreground"
                contentStyle={{
                  backgroundColor: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '6px',
                  color: 'hsl(var(--popover-foreground))',
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="cumulativeNav"
                stroke="hsl(217 91% 60%)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
                name="累计净值"
              />
              <Line
                type="monotone"
                dataKey="yearNav"
                stroke="hsl(142 71% 45%)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
                name="当年净值"
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
      暂无数据
    </div>
  );
}
