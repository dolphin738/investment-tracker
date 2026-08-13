/**
 * features/portfolio/price-freshness-badge.tsx — 行情数据新鲜度徽标（Q3）
 *
 * 依据后端 GET /portfolios/{id}/prices/sync-status 的最新 fetched_at 判断：
 * - 无数据（last_fetched_at 为 null）或距现在超过 STALE_HOURS(=8) → 红色圆点（数据缺失/陈旧）；
 * - 否则 → 绿色圆点 + 「数据截至 HH:MM · 来源」。
 *
 * 时间统一按北京时间（UTC+8）展示，与 lib/constants.nowInAppTzIso 同一不变式。
 * 组件自身消费 usePriceSyncStatus（按 portfolioId 轮询），调用方只需传入组合 id。
 */

import { usePriceSyncStatus } from '@/hooks/use-portfolio-price';

/** 行情数据陈旧阈值（小时）：超过即视为陈旧（ADR-002 Q3 验收口径） */
export const STALE_HOURS = 8;

/** 北京时间（UTC+8）下格式化时间：HH:mm */
function formatTimeInAppTz(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  // +8h 后取 UTC 渲染，结果只由物理时刻决定（无夏令时，恒定 +8h）
  const app = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return app.toISOString().slice(11, 16); // HH:mm
}

/** 是否陈旧：缺失或超过 STALE_HOURS 小时 */
export function isPriceDataStale(lastFetchedAt: string | null): boolean {
  if (!lastFetchedAt) return true;
  const d = new Date(lastFetchedAt);
  if (Number.isNaN(d.getTime())) return true;
  const diffHours = (Date.now() - d.getTime()) / (1000 * 60 * 60);
  return diffHours > STALE_HOURS;
}

export interface PriceFreshnessBadgeProps {
  /** 组合 id（null / 空时不发起请求，展示「暂无行情数据」） */
  portfolioId: string | null;
}

export function PriceFreshnessBadge({
  portfolioId,
}: PriceFreshnessBadgeProps): JSX.Element {
  const { data } = usePriceSyncStatus(portfolioId);
  const lastFetchedAt = data?.last_fetched_at ?? null;
  const source = data?.source ?? null;
  const stale = isPriceDataStale(lastFetchedAt);

  if (stale) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
        {lastFetchedAt
          ? `行情数据已超 ${STALE_HOURS} 小时未更新`
          : '暂无行情数据'}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
      数据截至 {formatTimeInAppTz(lastFetchedAt as string)} · {source ?? '-'}
    </span>
  );
}
