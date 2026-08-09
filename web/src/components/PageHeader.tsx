/**
 * components/PageHeader.tsx — 页面标题栏
 *
 * 统一页面标题 + 副描述 + 右侧操作区布局。
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  /** 页面标题 */
  title: string;
  /** 副描述 */
  description?: string;
  /** 右侧操作区 */
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3',
        className,
      )}
    >
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}
