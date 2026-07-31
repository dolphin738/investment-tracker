/**
 * 组合状态管理 — currentPortfolioId / portfolios 列表
 *
 * 使用 AppStorage 共享当前选中的组合 ID（跨页面同步）。
 * 组合列表由各页面按需从 API 获取，不在此缓存。
 */

import { ApiConfig } from '../net/api-config';
import { PortfolioApi } from '../api/portfolio-api';
import type { Portfolio } from '../net/api-types';

export class PortfolioStore {
  /**
   * 获取当前选中的组合 ID
   */
  static getCurrentPortfolioId(): string {
    return AppStorage.get<string>(ApiConfig.PORTFOLIO_KEY) || '';
  }

  /**
   * 设置当前选中的组合 ID
   */
  static setCurrentPortfolioId(id: string): void {
    AppStorage.setOrCreate(ApiConfig.PORTFOLIO_KEY, id);
  }

  /**
   * 获取当前用户的组合列表
   */
  static async listPortfolios(): Promise<Portfolio[]> {
    return PortfolioApi.list();
  }

  /**
   * 创建新组合
   */
  static async createPortfolio(name: string, description?: string): Promise<Portfolio> {
    const portfolio = await PortfolioApi.create(name, description);
    // 如果之前没有选中组合，自动选中新创建的
    if (!PortfolioStore.getCurrentPortfolioId()) {
      PortfolioStore.setCurrentPortfolioId(portfolio.id);
    }
    return portfolio;
  }

  /**
   * 删除组合
   */
  static async deletePortfolio(id: string): Promise<void> {
    await PortfolioApi.delete(id);
    // 如果删除的是当前选中的组合，清除选中状态
    if (PortfolioStore.getCurrentPortfolioId() === id) {
      PortfolioStore.setCurrentPortfolioId('');
    }
  }

  /**
   * 确保有选中的组合 — 如果没有则自动选中第一个
   * @returns 当前选中的组合 ID，如果没有组合则返回空字符串
   */
  static async ensureSelected(): Promise<string> {
    let currentId = PortfolioStore.getCurrentPortfolioId();
    if (currentId && currentId.length > 0) {
      return currentId;
    }
    const portfolios = await PortfolioStore.listPortfolios();
    if (portfolios.length > 0) {
      currentId = portfolios[0].id;
      PortfolioStore.setCurrentPortfolioId(currentId);
      return currentId;
    }
    return '';
  }
}