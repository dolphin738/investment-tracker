/**
 * stores/portfolio.store.ts — 当前选中组合状态（Pinia）
 *
 * 管理 currentPortfolioId + portfolios 列表缓存。
 * - currentPortfolioId：当前选中组合（持久化到 localStorage）
 * - portfolios：组合列表（由组合查询 hook 同步更新）
 * - setCurrentPortfolio：切换当前组合
 * - setPortfolios：批量设置列表
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Portfolio } from '@/lib/types';
import { usePreferenceStore } from '@/stores/preference.store';

const PORTFOLIO_STORAGE_KEY = 'investment_tracker_current_portfolio';

function loadInitialPortfolioId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(PORTFOLIO_STORAGE_KEY);
}

export const usePortfolioStore = defineStore('portfolio', () => {
  const portfolios = ref<Portfolio[]>([]);
  const currentPortfolioId = ref<string | null>(loadInitialPortfolioId());

  /** 当前选中的组合对象（未选中或列表中不存在时为 null） */
  const currentPortfolio = computed<Portfolio | null>(() => {
    if (!currentPortfolioId.value) return null;
    return portfolios.value.find((p) => p.id === currentPortfolioId.value) ?? null;
  });

  /**
   * 当前组合的首个交易日（Portfolio.baseDate）。
   *
   * 直接选出原始字符串，引用天然稳定；组合未选中或尚无首笔买入时为 null。
   */
  const currentPortfolioBaseDate = computed<string | null>(
    () =>
      portfolios.value.find((p) => p.id === currentPortfolioId.value)?.baseDate
      ?? null,
  );

  function setPortfolios(next: Portfolio[]): void {
    // 只从「未归档」组合里挑选，归档组合仅在账户页「我的组合」可见、不应被自动选中
    const selectable = next.filter((p) => !p.archivedAt);

    // 当前组合仍可选 → 保留用户选择
    if (selectable.some((p) => p.id === currentPortfolioId.value)) {
      portfolios.value = next;
      return;
    }

    // 当前组合失效（不存在 / 已归档 / 残留）→ 就地重选，别早退（修复 KI-1：去掉清空分支的早退，
    // 统一进入下方「默认 or 兜底」逻辑，使失效 ID 清空后能正确重选，不卡在空占位）
    const prefs = usePreferenceStore().preferences;
    const defaultId = prefs?.defaultPortfolioId ?? null;
    const nextSelected =
      selectable.find((p) => p.id === defaultId) ??
      // 偏好未加载（undefined）时先不兜底选 selectable[0]，避免误选第一个覆盖真正的默认组合，
      // 保留 currentPortfolioId=null 等偏好引导组件拿到偏好再决定
      (prefs ? selectable[0] : undefined);

    if (nextSelected) {
      localStorage.setItem(PORTFOLIO_STORAGE_KEY, nextSelected.id);
      portfolios.value = next;
      currentPortfolioId.value = nextSelected.id;
      return;
    }

    // 无可选 / 偏好未加载：清掉失效 ID，交给偏好引导兜底
    if (currentPortfolioId.value !== null) {
      localStorage.removeItem(PORTFOLIO_STORAGE_KEY);
    }
    portfolios.value = next;
    currentPortfolioId.value = null;
  }

  function setCurrentPortfolio(id: string): void {
    localStorage.setItem(PORTFOLIO_STORAGE_KEY, id);
    currentPortfolioId.value = id;
  }

  /** 当前组合失效（被删除时清空） */
  function clearCurrent(): void {
    localStorage.removeItem(PORTFOLIO_STORAGE_KEY);
    currentPortfolioId.value = null;
  }

  /** 切换账号时整体重置（列表 + 当前选中），避免残留上个用户的组合 */
  function reset(): void {
    localStorage.removeItem(PORTFOLIO_STORAGE_KEY);
    portfolios.value = [];
    currentPortfolioId.value = null;
  }

  return {
    portfolios,
    currentPortfolioId,
    currentPortfolio,
    currentPortfolioBaseDate,
    setPortfolios,
    setCurrentPortfolio,
    clearCurrent,
    reset,
  };
});
