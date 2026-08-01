/**
 * components/charts/yearly-bar-chart.tsx — 年度收益柱状图（Recharts）
 *
 * 输入 XirrSeriesPoint[]（按年聚合），展示各年度收益率对比柱状图。
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TooltipValueType } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPercent } from '@/lib/utils';
import type { XirrSeriesPoint } from '@investment-tracker/shared';

export interface YearlyBarChartProps {
  data: XirrSeriesPoint[];
  loading?: boolean;
  title?: string;
  className?: string;
}

const POSITIVE_COLOR = 'hsl(142 71% 45%)';
const NEGATIVE_COLOR = 'hsl(0 84% 60%)';

export function YearlyBarChart({
  data,
  loading,
  title = '年度 XIRR 对比',
  className,
}: YearlyBarChartProps): JSX.Element {
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
            <BarChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
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
                formatter={(value: TooltipValueType | undefined) => [
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
              <Bar dataKey="xirrValue" name="XIRR" radius={[4, 4, 0, 0]}>
                {data.map((entry, idx) => {
                  const v = entry.xirrValue;
                  const color = v === null ? 'hsl(var(--muted-foreground))' : v >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR;
                  return <Cell key={`cell-${idx}`} fill={color} />;
                })}
              </Bar>
            </BarChart>
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
