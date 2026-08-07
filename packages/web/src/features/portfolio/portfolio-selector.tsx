/**
 * features/portfolio/portfolio-selector.tsx — 组合切换下拉
 *
 * 顶部导航栏使用，可切换当前组合。
 */

import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePortfolios } from '@/hooks/use-portfolios';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { ENTRY_BUTTON_LABELS } from '@/constants/entry-button-labels';

export interface PortfolioSelectorProps {
  /** 选择"创建新组合"时的回调 */
  onCreateClick?: () => void;
  className?: string;
}

export function PortfolioSelector({
  onCreateClick,
  className,
}: PortfolioSelectorProps): JSX.Element {
  const { data: portfolios = [], isLoading } = usePortfolios();
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const setCurrentPortfolio = usePortfolioStore((s) => s.setCurrentPortfolio);

  // 归档组合从选择器隐藏（SET-P1-04）：仅保留未归档组合可选
  const visiblePortfolios = portfolios.filter((p) => !p.archivedAt);

  return (
    <div className={className}>
      <Select
        value={currentPortfolioId ?? undefined}
        onValueChange={(value) => {
          if (value === '__create_new__') {
            onCreateClick?.();
            return;
          }
          setCurrentPortfolio(value);
        }}
        disabled={isLoading && portfolios.length === 0}
      >
        <SelectTrigger className="w-[220px]">
          <div className="flex items-center gap-2">
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
            <SelectValue placeholder={isLoading ? '加载中…' : '选择组合'} />
          </div>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>我的组合</SelectLabel>
            {visiblePortfolios.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex items-center gap-2">
                  {p.id === currentPortfolioId && (
                    <Check className="h-3 w-3" />
                  )}
                  {p.name}
                </span>
              </SelectItem>
            ))}
            {visiblePortfolios.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                暂无组合，请新建
              </div>
            )}
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value="__create_new__">
            <span className="flex items-center gap-2 text-primary">
              <Plus className="h-3 w-3" />
              {/* 决策 H：文案取统一字典（下拉内联入口，样式保持内联规格） */}
              {ENTRY_BUTTON_LABELS.portfolio}
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
