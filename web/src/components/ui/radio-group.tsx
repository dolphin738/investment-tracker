/**
 * components/ui/radio-group.tsx — 单选组组件
 *
 * 基于原生 radio input + Tailwind 实现，外观对齐 shadcn/ui。
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/*  RadioGroup 容器                                                     */
/* ------------------------------------------------------------------ */

export interface RadioGroupProps {
  /** 选中的值 */
  value?: string;
  /** 默认选中的值 */
  defaultValue?: string;
  /** 值变更回调 */
  onValueChange?: (value: string) => void;
  /** 排列方向 */
  orientation?: 'horizontal' | 'vertical';
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function RadioGroup({
  value,
  defaultValue,
  onValueChange,
  orientation = 'vertical',
  disabled = false,
  children,
  className,
}: RadioGroupProps): JSX.Element {
  const [internalValue, setInternalValue] = React.useState(defaultValue ?? '');
  const isControlled = value !== undefined;
  const currentValue = isControlled ? value : internalValue;

  const handleChange = (newValue: string) => {
    if (!isControlled) {
      setInternalValue(newValue);
    }
    onValueChange?.(newValue);
  };

  // 通过 context 将 value/onChange 传给子 RadioGroupItem
  const contextValue = React.useMemo(
    () => ({ value: currentValue, onChange: handleChange, disabled }),
    [currentValue, handleChange, disabled],
  );

  return (
    <RadioGroupContext.Provider value={contextValue}>
      <div
        role="radiogroup"
        className={cn(
          orientation === 'horizontal' ? 'flex flex-wrap gap-4' : 'flex flex-col gap-2',
          className,
        )}
      >
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Context                                                             */
/* ------------------------------------------------------------------ */

interface RadioGroupContextValue {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue>({
  value: '',
  onChange: () => {},
  disabled: false,
});

function useRadioGroupContext(): RadioGroupContextValue {
  return React.useContext(RadioGroupContext);
}

/* ------------------------------------------------------------------ */
/*  RadioGroupItem                                                      */
/* ------------------------------------------------------------------ */

export interface RadioGroupItemProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  /** 该项的值 */
  value: string;
  /** 标签文本（children 优先） */
  label?: string;
}

export function RadioGroupItem({
  value: itemValue,
  label,
  children,
  id,
  disabled: itemDisabled,
  className,
  ...props
}: RadioGroupItemProps): JSX.Element {
  const { value: groupValue, onChange, disabled: groupDisabled } = useRadioGroupContext();
  const isChecked = groupValue === itemValue;
  const isDisabled = groupDisabled || itemDisabled;

  const itemId = id ?? React.useId();

  return (
    <label
      htmlFor={itemId}
      className={cn(
        'inline-flex items-center gap-2 text-sm font-medium leading-none',
        isDisabled && 'cursor-not-allowed opacity-50',
        !isDisabled && 'cursor-pointer',
        className,
      )}
    >
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        <input
          type="radio"
          id={itemId}
          value={itemValue}
          checked={isChecked}
          disabled={isDisabled}
          onChange={() => onChange(itemValue)}
          className="sr-only"
          {...props}
        />
        {/* 外圈 */}
        <span
          className={cn(
            'absolute inset-0 rounded-full border',
            isChecked
              ? 'border-primary'
              : 'border-muted-foreground/40',
          )}
        />
        {/* 内点 */}
        {isChecked && (
          <span className="absolute inset-[3px] rounded-full bg-primary" />
        )}
      </span>
      {children ?? (label ? <span>{label}</span> : null)}
    </label>
  );
}
