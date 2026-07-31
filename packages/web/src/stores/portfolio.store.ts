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
import type { Portfolio } from '@investment-tracker/shared';

const PORTFOLIO_STORAGE_KEY = 'investment_tracker_current_portfolio';

interface PortfolioState {
  portfolios: Portfolio[];
  currentPortfolioId: string | null;
  currentPortfolio: () => Portfolio | null;
  setPortfolios: (portfolios: Portfolio[]) => void;
  setCurrentPortfolio: (id: string) => void;
  /** 当前组合失效（被删除时清空） */
  clearCurrent: () => void;
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
    // 如果当前组合不在列表中（或尚未选中），自动选第一个
    const exists = portfolios.some((p) => p.id === currentPortfolioId);
    if (!exists && portfolios.length > 0) {
      const first = portfolios[0];
      localStorage.setItem(PORTFOLIO_STORAGE_KEY, first.id);
      set({ portfolios, currentPortfolioId: first.id });
      return;
    }
    if (!exists && portfolios.length === 0) {
      localStorage.removeItem(PORTFOLIO_STORAGE_KEY);
      set({ portfolios, currentPortfolioId: null });
      return;
    }
    set({ portfolios });
  },
  setCurrentPortfolio: (id) => {
    localStorage.setItem(PORTFOLIO_STORAGE_KEY, id);
    set({ currentPortfolioId: id });
  },
  clearCurrent: () => {
    localStorage.removeItem(PORTFOLIO_STORAGE_KEY);
    set({ currentPortfolioId: null });
  },
}));
