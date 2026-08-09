/**
 * stores/portfolio.store.ts — 当前选中组合状态（Zustand）
 *
 * 管理 currentPortfolioId + portfolios 列表缓存。
 * - currentPortfolioId：当前选中组合（持久化到 localStorage）
 * - portfolios：组合列表（由 usePortfolios hook 同步更新）
 * - setCurrentPortfolio：切换当前组合
 * - setPortfolios：批量设置列表
 */

import { create } from 'zustand';
import type { Portfolio } from '@/lib/types';
import { usePreferenceStore } from '@/stores/preference.store';

const PORTFOLIO_STORAGE_KEY = 'investment_tracker_current_portfolio';

interface PortfolioState {
  portfolios: Portfolio[];
  currentPortfolioId: string | null;
  currentPortfolio: () => Portfolio | null;
  setPortfolios: (portfolios: Portfolio[]) => void;
  setCurrentPortfolio: (id: string) => void;
  /** 当前组合失效（被删除时清空） */
  clearCurrent: () => void;
  /** 切换账号时整体重置（列表 + 当前选中），避免残留上个用户的组合 */
  reset: () => void;
}

function loadInitialPortfolioId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(PORTFOLIO_STORAGE_KEY);
}

export const usePortfolioStore = create<PortfolioState>((set, get) => ({
  portfolios: [],
  currentPortfolioId: loadInitialPortfolioId(),
  currentPortfolio: () => {
    const { portfolios, currentPortfolioId } = get();
    if (!currentPortfolioId) return null;
    return portfolios.find((p) => p.id === currentPortfolioId) ?? null;
  },
  setPortfolios: (portfolios) => {
    const { currentPortfolioId } = get();
    // 只从「未归档」组合里挑选，归档组合仅在设置页组合管理可见、不应被自动选中
    const selectable = portfolios.filter((p) => !p.archivedAt);

    // 当前组合仍可选 → 保留用户选择
    if (selectable.some((p) => p.id === currentPortfolioId)) {
      set({ portfolios });
      return;
    }

    // 当前组合失效（不存在 / 已归档 / 残留）→ 就地重选，别早退（修复 KI-1：去掉清空分支的早退，
    // 统一进入下方「默认 or 兜底」逻辑，使失效 ID 清空后能正确重选，不卡在空占位）
    const prefs = usePreferenceStore.getState().preferences;
    const defaultId = prefs?.defaultPortfolioId ?? null;
    const next =
      selectable.find((p) => p.id === defaultId) ??
      // 偏好未加载（undefined）时先不兜底选 selectable[0]，避免误选第一个覆盖真正的默认组合，
      // 保留 currentPortfolioId=null 等 PreferenceBootstrap 拿到偏好再决定
      (prefs ? selectable[0] : undefined);

    if (next) {
      localStorage.setItem(PORTFOLIO_STORAGE_KEY, next.id);
      set({ portfolios, currentPortfolioId: next.id });
      return;
    }

    // 无可选 / 偏好未加载：清掉失效 ID，交给 PreferenceBootstrap 兜底
    if (currentPortfolioId !== null) {
      localStorage.removeItem(PORTFOLIO_STORAGE_KEY);
    }
    set({ portfolios, currentPortfolioId: null });
  },
  setCurrentPortfolio: (id) => {
    localStorage.setItem(PORTFOLIO_STORAGE_KEY, id);
    set({ currentPortfolioId: id });
  },
  clearCurrent: () => {
    localStorage.removeItem(PORTFOLIO_STORAGE_KEY);
    set({ currentPortfolioId: null });
  },
  reset: () => {
    localStorage.removeItem(PORTFOLIO_STORAGE_KEY);
    set({ portfolios: [], currentPortfolioId: null });
  },
}));

/**
 * 当前组合的首个交易日（`Portfolio.baseDate`，问题②）。
 *
 * 为什么不用 `currentPortfolio()`：它是 store 里的普通方法，
 * `useStore((s) => s.currentPortfolio())` 每次渲染都会新建对象引用，
 * 触发无谓重渲染。这里直接选出**原始字符串**，引用天然稳定。
 *
 * @returns ISO 日期串（YYYY-MM-DD）；组合未选中或尚无首笔买入时为 `null`
 */
export function usePortfolioBaseDate(): string | null {
  return usePortfolioStore(
    (s) =>
      s.portfolios.find((p) => p.id === s.currentPortfolioId)?.baseDate ?? null,
  );
}
