/**
 * components/EmptyState.tsx — 空数据占位组件
 *
 * 用于列表/卡片无数据时的友好提示 + 引导操作。
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  /** 图标（lucide-react 组件） */
  icon?: ReactNode;
  /** 主标题 */
  title: string;
  /** 副描述 */
  description?: string;
  /** 操作按钮 */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-16 text-center',
        className,
      )}
    >
      {icon && (
        <div className="mb-4 text-muted-foreground/60">{icon}</div>
      )}
      <h3 className="text-lg font-medium text-muted-foreground">{title}</h3>
      {description && (
        <p className="mt-2 max-w-sm text-sm text-muted-foreground/70">
          {description}
        </p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
