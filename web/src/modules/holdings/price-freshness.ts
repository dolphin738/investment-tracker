/**
 * modules/holdings/price-freshness.ts — 行情数据新鲜度判定（Q3）
 *
 * 平移自 React 版 web/src/features/portfolio/price-freshness-badge.tsx 中的
 * 纯函数部分（SFC 无法导出非组件成员，拆为同模块叶子文件，语义逐行一致）。
 */

/** 行情数据陈旧阈值（小时）：超过即视为陈旧（ADR-002 Q3 验收口径） */
export const STALE_HOURS = 8;

/** 北京时间（UTC+8）下格式化时间：HH:mm */
export function formatTimeInAppTz(iso: string): string {
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
