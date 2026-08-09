/**
 * components/charts/stat-card.tsx — 指标卡片组件
 *
 * 用于 Dashboard 顶部展示关键指标：累计 XIRR / 总收益率 / 当年收益率 / 最大回撤。
 */

import { ArrowDown, ArrowUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface StatCardProps {
  title: string;
  value: string;
  /** 较前值变化（已格式化字符串，如 "+2.1pp"），可选 */
  change?: string;
  /** 变化方向，决定图标颜色（PRD §9.5: 正红负绿） */
  trend?: 'up' | 'down' | 'neutral';
  /** 数值颜色覆盖（用于负值显示红色等） */
  valueClassName?: string;
  /** 辅助描述 */
  description?: string;
  className?: string;
}

export function StatCard({
  title,
  value,
  change,
  trend = 'neutral',
  valueClassName,
  description,
  className,
}: StatCardProps): JSX.Element {
  const trendColor =
    trend === 'up'
      ? 'text-up'
      : trend === 'down'
        ? 'text-down'
        : 'text-muted-foreground';
  const TrendIcon = trend === 'up' ? ArrowUp : trend === 'down' ? ArrowDown : null;

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        {TrendIcon && (
          <TrendIcon className={cn('h-4 w-4', trendColor)} />
        )}
      </CardHeader>
      <CardContent>
        <div className={cn('text-2xl font-bold', valueClassName)}>{value}</div>
        {(change || description) && (
          <div className="mt-1 flex items-center text-xs">
            {change && <span className={cn('font-medium', trendColor)}>{change}</span>}
            {change && description && <span className="mx-1 text-muted-foreground">·</span>}
            {description && <span className="text-muted-foreground">{description}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
