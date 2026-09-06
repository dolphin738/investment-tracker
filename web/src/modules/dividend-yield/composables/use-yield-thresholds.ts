/**
 * modules/dividend-yield/composables/use-yield-thresholds.ts — 阈值标色共享逻辑
 *
 * TopPage / RankingPage 共用：admin 拉取全局阈值（非 admin 无阈值 → 全部灰显），
 * yieldClass 按 A 股「红涨绿跌」语义映射（≥ 绿色阈值 → text-up(红)、
 * ≤ 红色阈值 → text-down(绿)，字段名沿用服务端契约 green/red_threshold）。
 */
import { computed } from 'vue';
import { useDividendYieldSettings } from './use-dividend-yield';

export function useYieldThresholds(isAdmin: () => boolean) {
  const settingsQuery = useDividendYieldSettings(computed(isAdmin));
  const thresholds = computed(() => settingsQuery.data.value);

  /** 股息率标色：≥绿色阈值 text-up(红)；≤红色阈值 text-down(绿)；其余/无阈值 灰显 */
  function yieldClass(item: { dividend_yield: number | null }): string {
    const t = thresholds.value;
    if (!t || item.dividend_yield === null) return 'text-muted-foreground';
    if (t.green_threshold !== null && item.dividend_yield >= t.green_threshold) {
      return 'text-up';
    }
    if (t.red_threshold !== null && item.dividend_yield <= t.red_threshold) {
      return 'text-down';
    }
    return 'text-muted-foreground';
  }

  return { settingsQuery, thresholds, yieldClass };
}
