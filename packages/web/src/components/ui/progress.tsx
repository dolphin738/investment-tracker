/**
 * components/ui/progress.tsx — shadcn/ui Progress（横向进度条）
 *
 * 决策 Q-8 甲：补齐设计系统缺失的基础组件。
 *
 * 实现说明：
 *   本仓库环境未安装 @radix-ui/react-progress（pnpm shim 损坏，工作区为扁平 npm 安装，
 *   贸然 install 会重排 node_modules），因此沿用仓库既有做法（见 dropdown-menu.tsx /
 *   radio-group.tsx 的「无 radix 依赖」实现），基于原生 div + Tailwind 实现，
 *   对外 API 与 shadcn/ui 官方 Progress 完全兼容，后续若补装 radix 可无痛替换：
 *
 *     <Progress value={42} />                       // 0 ~ 100
 *     <Progress value={7} max={10} />               // 自定义上限
 *     <Progress value={null} />                     // 不确定态，渲染空进度
 *     <Progress value={30} indicatorClassName="bg-up" />  // 自定义填充色
 *
 * 无障碍：role="progressbar" + aria-valuemin/max/now，与 Radix 输出语义一致。
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ProgressProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 当前进度值；null / undefined 视为不确定态（indeterminate），渲染为 0 */
  value?: number | null;
  /** 进度上限，默认 100 */
  max?: number;
  /** 填充条（indicator）额外类名，用于覆盖颜色等 */
  indicatorClassName?: string;
}

/** 将输入夹在 [0, max] 区间内；null / 非有限数按 0 处理 */
function clampProgress(value: number | null | undefined, max: number): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), max);
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  (
    { className, value = null, max = 100, indicatorClassName, ...props },
    ref,
  ) => {
    // max 非法（0 / 负数 / NaN）时回落到 100，避免除零产生 NaN 宽度
    const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
    const current = clampProgress(value, safeMax);
    const percent = (current / safeMax) * 100;
    const isIndeterminate = value === null || value === undefined;

    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={isIndeterminate ? undefined : current}
        className={cn(
          'relative h-2 w-full overflow-hidden rounded-full bg-secondary',
          className,
        )}
        {...props}
      >
        <div
          className={cn(
            'h-full w-full flex-1 bg-primary transition-all',
            indicatorClassName,
          )}
          style={{ transform: `translateX(-${100 - percent}%)` }}
        />
      </div>
    );
  },
);
Progress.displayName = 'Progress';

export { Progress };
