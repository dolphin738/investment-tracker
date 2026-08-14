/**
 * components/security/security-search-combobox.tsx — 证券搜索选择框（§7 ④ / §10）
 *
 * 受控 Input：键入即防抖搜索系统主数据（GET /api/admin/securities/masters?q=，
 * 匹配 code / name / 拼音首字母），下拉候选点击选中后回调 onSelect(master)。
 * 当前选中项的展示文本由父级经 `value` 传入（如「贵州茅台（600519）」）；
 * 用户开始输入时切换为搜索态，输入框显示键入内容。
 *
 * ⚠️ 实现说明：设计稿建议 shadcn Command+Popover（依赖 cmdk 库）。当前采用
 * Input + 内联下拉实现（零新增依赖），功能契约一致：输入即搜、候选点击选中。
 * 后续如需虚拟滚动 / 键盘导航可平滑迁移到 Command。
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { listSecurityMasters, type SecurityMaster } from '@/api/security-master.api';

export interface SecuritySearchComboboxProps {
  /** 当前选中项的展示文本（编辑态回显，如「贵州茅台（600519）」） */
  value?: string;
  /** 选中系统主数据候选后回调（由调用方调 resolve 实例化为组合标的） */
  onSelect: (master: SecurityMaster) => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
}

const SEARCH_DEBOUNCE_MS = 250;

export function SecuritySearchCombobox({
  value,
  onSelect,
  disabled = false,
  placeholder = '搜索代码 / 名称 / 拼音首字母',
  id,
}: SecuritySearchComboboxProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [debouncedQ, setDebouncedQ] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // 防抖：键入 250ms 后触发搜索
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isFetching } = useQuery({
    queryKey: ['security-master', 'search', debouncedQ],
    queryFn: () => listSecurityMasters({ q: debouncedQ, pageSize: 20 }),
    enabled: open && debouncedQ.length > 0,
    staleTime: 30 * 1000,
  });

  const candidates: SecurityMaster[] = data?.items ?? [];
  const searching = open && debouncedQ.length > 0;

  const handlePick = (master: SecurityMaster): void => {
    onSelect(master);
    setQuery('');
    setDebouncedQ('');
    setOpen(false);
  };

  // 点击候选时容器 blur 可能先触发；用 mousedown 阻止默认，保证 click 可命中
  const handleContainerMouseDown = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('[data-security-candidate]')) {
      e.preventDefault();
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseDown={handleContainerMouseDown}
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={id}
          className="pl-8"
          placeholder={placeholder}
          disabled={disabled}
          value={searching ? query : (value ?? '')}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (query) setOpen(true);
          }}
          onBlur={() => {
            // 延迟关闭，保证候选点击先于 blur 触发
            setTimeout(() => setOpen(false), 150);
          }}
        />
      </div>

      {searching && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {isFetching && (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 搜索中…
            </div>
          )}
          {!isFetching && candidates.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">无匹配结果</p>
          )}
          {!isFetching &&
            candidates.map((s) => (
              <button
                key={s.id}
                type="button"
                data-security-candidate
                className="flex w-full items-center justify-between gap-2 rounded-sm px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => handlePick(s)}
              >
                <span className="truncate">
                  <span className="font-medium">{s.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {s.code}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {[s.exchange, s.assetClass].filter(Boolean).join(' · ') || '—'}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
