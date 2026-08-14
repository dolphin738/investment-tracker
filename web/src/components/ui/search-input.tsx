/**
 * components/ui/search-input.tsx — 带「清空小叉」的搜索输入框
 *
 * 在 shadcn Input 基础上包一层：左侧可选搜索图标、右側有值的搜索框显示
 * 一个小叉（X）按钮，点击即清空文本。受控用法传 value + onChange + onClear；
 * 未传 onClear 时回退为派发空值 change 事件，兼容非受控场景。
 */

import * as React from 'react';
import { Search, X } from 'lucide-react';
import { Input } from './input';
import { cn } from '@/lib/utils';

export interface SearchInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  /** 清空回调（受控清空首选路径） */
  onClear?: () => void;
  /** 是否在左侧显示搜索图标（默认 true） */
  withIcon?: boolean;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, value, onChange, onClear, withIcon = true, ...props }, ref) => {
    const hasValue = value != null && String(value).length > 0;
    const handleClear = (): void => {
      onClear?.();
      // 兜底：未提供 onClear 时，派发空值 change 让非受控输入也清空
      if (!onClear && onChange) {
        const ev = {
          target: { value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>;
        onChange(ev);
      }
    };
    return (
      <div className="relative">
        {withIcon && (
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        )}
        <Input
          ref={ref}
          className={cn(withIcon && 'pl-8', hasValue && 'pr-8', className)}
          value={value}
          onChange={onChange}
          {...props}
        />
        {hasValue && (
          <button
            type="button"
            aria-label="清除"
            onClick={handleClear}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  },
);
SearchInput.displayName = 'SearchInput';

export { SearchInput as default };
