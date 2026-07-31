/**
 * components/charts/xirr-trend-chart.tsx — XIRR 趋势折线图（Recharts）
 *
 * 展示累计 XIRR 随时间变化趋势，支持空数据展示。
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPercent } from '@/lib/utils';
import type { XirrSeriesPoint } from '@investment-tracker/shared';

export interface XirrTrendChartProps {
  data: XirrSeriesPoint[];
  loading?: boolean;
  title?: string;
  className?: string;
}

export function XirrTrendChart({
  data,
  loading,
  title = 'XIRR 趋势',
  className,
}: XirrTrendChartProps): JSX.Element {
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
                tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
              />
              <Tooltip
                formatter={(value: number | string) => [
                  value === null || value === undefined
                    ? '数据不足'
                    : formatPercent(Number(value)),
                  'XIRR',
                ]}
                labelClassName="text-foreground"
                contentStyle={{
                  backgroundColor: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '6px',
                  color: 'hsl(var(--popover-foreground))',
                }}
              />
              <Line
                type="monotone"
                dataKey="xirrValue"
                stroke="hsl(217 91% 60%)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
                name="XIRR"
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
