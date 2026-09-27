/**
 * modules/dividend-yield/composables/use-yield-thresholds.ts — 阈值标色共享逻辑
 *
 * TopPage / RankingPage / 证券详情面板共用。
 *
 * 【阈值来源变更】原实现读「全局设置」（GET /dividend-yield/settings）并按 isAdmin
 * 门控——非 admin 不发请求 → 无阈值 → 榜单全灰、曲线参考线回退 5%。阈值迁至
 * **用户偏好**（user_preferences.green/red_threshold，见 0026 迁移）后：
 * - 偏好由 PreferenceBootstrap 首屏全局加载（GET /users/preferences，登录即可读、无 admin 门控）；
 * - 本 composable 直接取偏好 store，缺失时回退 DEFAULT_PREFERENCES（0.05 / 0.03）。
 *
 * 标色沿用 A 股「红涨绿跌」语义：≥ green_threshold → text-up(红)；
 * ≤ red_threshold → text-down(绿)；其余灰显。
 */
import { computed } from 'vue';
import { usePreferenceStore } from '@/stores/preference.store';

export function useYieldThresholds() {
  const prefStore = usePreferenceStore();

  /** 当前账号的高/低股息阈值（小数比率；始终有值，缺失时回退默认） */
  const thresholds = computed(() => ({
    green_threshold: prefStore.getPreference('greenThreshold'),
    red_threshold: prefStore.getPreference('redThreshold'),
  }));

  /**
   * 股息率标色：≥绿色阈值 text-up(红)；≤红色阈值 text-down(绿)；其余/无值 灰显。
   * wire 口径：dividend_yield 为 Decimal → str（生成契约 DividendYieldRankItemOut），
   * 统一 Number() 归一后再比较（NaN/非法串按无值灰显，与 null 同待遇）。
   */
  function yieldClass(item: {
    dividend_yield?: string | number | null;
  }): string {
    const raw = item.dividend_yield;
    if (raw === null || raw === undefined || raw === '') {
      return 'text-muted-foreground';
    }
    const y = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isFinite(y)) return 'text-muted-foreground';
    const { green_threshold: green, red_threshold: red } = thresholds.value;
    if (green !== null && y >= green) {
      return 'text-up';
    }
    if (red !== null && y <= red) {
      return 'text-down';
    }
    return 'text-muted-foreground';
  }

  return { thresholds, yieldClass };
}
