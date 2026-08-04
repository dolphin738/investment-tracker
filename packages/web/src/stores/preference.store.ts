/**
 * stores/preference.store.ts — 用户偏好本地缓存（Zustand）
 *
 * 与服务端 preference 互补：
 * - 首次加载从服务端获取并写入本地
 * - 离线时可读取本地缓存
 * - 切换偏好时立即更新本地（乐观），再异步写服务端
 */

import { create } from 'zustand';
import type { UserPreference } from '@/api/types';

/** 系统默认偏好 */
export const DEFAULT_PREFERENCES: Omit<UserPreference, 'id' | 'userId' | 'createdAt' | 'updatedAt'> = {
  defaultPortfolioId: null,
  defaultGranularity: 'month',
  defaultDateRange: '1y',
  aggregation: 'last',
  weekStartsOn: 1,
  navDecimals: 4,
  xirrDecimals: 2,
  theme: 'system',
  staleDays: 3,
  cashHintOnCashflow: true,
  cashHintOnTrade: true,
  amountThousands: true,
  amountAbbrev: false,
};

interface PreferenceState {
  /** 缓存的服务端偏好 */
  preferences: UserPreference | null;
  /** 是否已从服务端加载 */
  loaded: boolean;
  setPreferences: (pref: UserPreference) => void;
  /** 获取单个偏好值（带默认值回退） */
  getPreference: <K extends keyof typeof DEFAULT_PREFERENCES>(key: K) => (typeof DEFAULT_PREFERENCES)[K];
  clear: () => void;
}

export const usePreferenceStore = create<PreferenceState>((set, get) => ({
  preferences: null,
  loaded: false,
  setPreferences: (pref) => set({ preferences: pref, loaded: true }),
  getPreference: (key) => {
    const pref = get().preferences;
    if (pref && pref[key] !== undefined && pref[key] !== null) {
      return pref[key] as (typeof DEFAULT_PREFERENCES)[typeof key];
    }
    return DEFAULT_PREFERENCES[key];
  },
  clear: () => set({ preferences: null, loaded: false }),
}));
