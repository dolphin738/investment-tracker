/**
 * components/ui/switch.tsx — 开关组件
 *
 * 基于原生 checkbox + Tailwind 实现，外观对齐 shadcn/ui。
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SwitchProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** 受控值 */
  checked?: boolean;
  /** 默认值 */
  defaultChecked?: boolean;
  /** 值变更回调 */
  onCheckedChange?: (checked: boolean) => void;
}

const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, checked, defaultChecked, onCheckedChange, disabled, id, ...props }, ref) => {
    const innerRef = React.useRef<HTMLInputElement>(null);
    const resolvedRef = (ref as React.RefObject<HTMLInputElement>) || innerRef;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onCheckedChange?.(e.target.checked);
    };

    // 生成唯一 id（如果未提供）
    const switchId = React.useId();
    const resolvedId = id ?? switchId;

    return (
      <label
        htmlFor={resolvedId}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors',
          'focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
          disabled && 'cursor-not-allowed opacity-50',
          checked ? 'bg-primary' : 'bg-input',
          className,
        )}
      >
        <input
          ref={resolvedRef}
          type="checkbox"
          id={resolvedId}
          checked={checked}
          defaultChecked={defaultChecked}
          onChange={handleChange}
          disabled={disabled}
          className="sr-only"
          role="switch"
          aria-checked={checked}
          {...props}
        />
        <span
          className={cn(
            'pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
      </label>
    );
  },
);
Switch.displayName = 'Switch';

export { Switch };
