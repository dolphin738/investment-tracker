/**
 * components/LoadingSpinner.tsx — 加载态组件
 *
 * 提供 Spinner 和 Skeleton 两种加载态：
 * - LoadingSpinner: 居中旋转图标
 * - Skeleton: 骨架屏占位（复用 shadcn/ui Skeleton）
 * - PageSkeleton: 页面级骨架屏
 */

import { Loader2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface LoadingSpinnerProps {
  /** 提示文字 */
  text?: string;
  /** 尺寸 */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap = {
  sm: 'h-4 w-4',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
} as const;

export function LoadingSpinner({
  text,
  size = 'md',
  className,
}: LoadingSpinnerProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-16',
        className,
      )}
    >
      <Loader2
        className={cn('animate-spin text-muted-foreground', sizeMap[size])}
      />
      {text && (
        <p className="mt-3 text-sm text-muted-foreground">{text}</p>
      )}
    </div>
  );
}

/** 卡片骨架屏 */
export function CardSkeleton({ className }: { className?: string }): JSX.Element {
  return (
    <div className={cn('space-y-4 rounded-lg border p-6', className)}>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

/** 表格骨架屏 */
export function TableSkeleton({
  rows = 5,
  cols = 4,
  className,
}: {
  rows?: number;
  cols?: number;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('space-y-3', className)}>
      {/* 表头 */}
      <div className="flex gap-4 border-b pb-2">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={`h-${i}`} className="h-4 flex-1" />
        ))}
      </div>
      {/* 数据行 */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={`r-${r}`} className="flex gap-4 py-2">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={`c-${c}`} className="h-5 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** 页面级骨架屏（概览页等） */
export function PageSkeleton(): JSX.Element {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-60" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-80 w-full rounded-lg" />
        <Skeleton className="h-80 w-full rounded-lg" />
      </div>
    </div>
  );
}
