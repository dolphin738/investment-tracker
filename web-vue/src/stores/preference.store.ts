/**
 * stores/preference.store.ts — 用户偏好本地缓存（Pinia）
 *
 * 与服务端 preference 互补：
 * - 首次加载从服务端获取并写入本地
 * - 离线时可读取本地缓存
 * - 切换偏好时立即更新本地（乐观），再异步写服务端
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { UserPreference } from '@/api/types';

/** 系统默认偏好 */
export const DEFAULT_PREFERENCES: Omit<
  UserPreference,
  'id' | 'userId' | 'createdAt' | 'updatedAt'
> = {
  defaultPortfolioId: null,
  defaultGranularity: 'month',
  defaultDateRange: '1y',
  aggregation: 'last',
  weekStartsOn: 1,
  navDecimals: 4,
  xirrDecimals: 2,
  theme: 'system',
  staleDays: 3,
  showLiquidated: false,
  cashHintOnCashflow: true,
  cashHintOnTrade: true,
  amountThousands: true,
  amountAbbrev: false,
};

export const usePreferenceStore = defineStore('preference', () => {
  /** 缓存的服务端偏好 */
  const preferences = ref<UserPreference | null>(null);
  /** 是否已从服务端加载 */
  const loaded = ref(false);

  /** 当前生效主题（带默认值回退，供 ThemeManager 使用） */
  const theme = computed(() => preferences.value?.theme ?? DEFAULT_PREFERENCES.theme);

  function setPreferences(pref: UserPreference): void {
    preferences.value = pref;
    loaded.value = true;
  }

  /** 获取单个偏好值（带默认值回退） */
  function getPreference<K extends keyof typeof DEFAULT_PREFERENCES>(
    key: K,
  ): (typeof DEFAULT_PREFERENCES)[K] {
    const pref = preferences.value;
    if (pref && pref[key] !== undefined && pref[key] !== null) {
      return pref[key] as (typeof DEFAULT_PREFERENCES)[K];
    }
    return DEFAULT_PREFERENCES[key];
  }

  function clear(): void {
    preferences.value = null;
    loaded.value = false;
  }

  return { preferences, loaded, theme, setPreferences, getPreference, clear };
});
