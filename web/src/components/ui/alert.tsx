/**
 * components/ui/alert.tsx — shadcn/ui Alert（提示条）
 *
 * 决策 Q-8 甲：补齐设计系统缺失的基础组件。
 * 标准 shadcn 实现（cva variants，无 radix 依赖）。
 *
 * 后续阶段用途：概览页数据新鲜度提示条（DASH-P1-03）、资产记录页差异提示条等。
 *
 *   <Alert>
 *     <AlertTitle>数据陈旧</AlertTitle>
 *     <AlertDescription>最新净值日期距今已超过 3 天。</AlertDescription>
 *   </Alert>
 *   <Alert variant="destructive"> ... </Alert>
 */

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive:
          'border-destructive/50 text-destructive [&>svg]:text-destructive',
        warning:
          'border-amber-500/50 bg-amber-50 text-amber-900 [&>svg]:text-amber-600 dark:bg-amber-950/30 dark:text-amber-200',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  ),
);
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn('mb-1 font-medium leading-none tracking-tight', className)}
    {...props}
  />
));
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('text-sm [&_p]:leading-relaxed', className)}
    {...props}
  />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription, alertVariants };
