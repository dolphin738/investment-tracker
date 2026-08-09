/**
 * features/overview/freshness-banner.tsx — 数据新鲜度提示条（T03 · DASH-P1-03 / AL-015）
 *
 * - `freshness.isStale === true` 时渲染 warning banner；否则**返回 null**（不占位、无布局跳动）。
 * - 文案列出后端已本地化的全部 `reasons`（如「行情已 4 天未更新」）。
 * - 操作按钮按 reason.kind 出现：
 *   - PRICE → 「去更新行情」（跳 /holdings）
 *   - CASH  → 「去更新现金余额」（跳 /cashflows）
 *   - 「本次会话不再提示」→ sessionStorage（O-7 默认），关闭本次会话内不再提示。
 *
 * 🔴 判定只在后端完成（阈值 / 滞后天数 / 文案），本组件只渲染。
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FreshnessInfo } from '@/lib/types';

/** sessionStorage key（会话级，O-7 默认），按组合隔离 */
function dismissKey(portfolioId: string): string {
  return `freshness_dismissed_${portfolioId}`;
}

export interface FreshnessBannerProps {
  portfolioId: string;
  freshness: FreshnessInfo;
}

export function FreshnessBanner({
  portfolioId,
  freshness,
}: FreshnessBannerProps): JSX.Element | null {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(dismissKey(portfolioId)) === '1';
    } catch {
      return false;
    }
  });

  if (!freshness.isStale || dismissed) return null;

  // 空组合（未录入任何行情与现金余额记录）：latestPriceAsOf / latestCashAsOf 均为 null，
  // 此时仅产生「无现金余额记录」类噪声提示且无任何有效操作入口，按「无数据」隐藏（需求项7）。
  if (freshness.latestPriceAsOf === null && freshness.latestCashAsOf === null) {
    return null;
  }

  const hasPriceReason = freshness.reasons.some((r) => r.kind === 'PRICE');
  const hasCashReason = freshness.reasons.some((r) => r.kind === 'CASH');

  const dismissForSession = () => {
    try {
      sessionStorage.setItem(dismissKey(portfolioId), '1');
    } catch {
      // 隐私模式等 sessionStorage 不可用场景：仅本次渲染收起，不阻断
    }
    setDismissed(true);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {freshness.reasons.length > 0
          ? freshness.reasons.map((r) => r.label).join('；')
          : '部分数据已超过预设的更新阈值'}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {hasPriceReason && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() => navigate('/holdings')}
          >
            去更新行情
          </Button>
        )}
        {hasCashReason && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() => navigate('/cashflows')}
          >
            去更新现金余额
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={dismissForSession}
        >
          本次会话不再提示
        </Button>
      </div>
    </div>
  );
}
