/**
 * 组合管理 API — CRUD portfolios
 *
 * 对应后端端点：
 * - GET    /api/portfolios          获取组合列表
 * - POST   /api/portfolios          创建组合
 * - GET    /api/portfolios/:id      获取组合详情
 * - PATCH  /api/portfolios/:id      更新组合
 * - DELETE /api/portfolios/:id      删除组合（级联删除子数据）
 */

import { HttpClient } from '../net/http-client';
import { ApiConfig } from '../net/api-config';
import type {
  CreatePortfolioRequest,
  Portfolio,
  UpdatePortfolioRequest,
} from '../net/api-types';

export class PortfolioApi {
  /**
   * 获取当前用户的所有组合列表
   */
  static async list(): Promise<Portfolio[]> {
    return HttpClient.get<Portfolio[]>(ApiConfig.PORTFOLIOS);
  }

  /**
   * 创建新组合
   * @param name 组合名称
   * @param description 描述（可选）
   * @param currency 币种（默认 CNY）
   */
  static async create(name: string, description?: string, currency?: string): Promise<Portfolio> {
    const body: CreatePortfolioRequest = {
      name: name,
    };
    if (description && description.length > 0) {
      body.description = description;
    }
    if (currency && currency.length > 0) {
      body.currency = currency;
    }
    return HttpClient.post<Portfolio>(ApiConfig.PORTFOLIOS, body);
  }

  /**
   * 获取组合详情
   */
  static async getById(id: string): Promise<Portfolio> {
    return HttpClient.get<Portfolio>(ApiConfig.portfolioDetail(id));
  }

  /**
   * 更新组合
   */
  static async update(id: string, data: UpdatePortfolioRequest): Promise<Portfolio> {
    return HttpClient.patch<Portfolio>(ApiConfig.portfolioDetail(id), data);
  }

  /**
   * 删除组合（级联删除所有子数据）
   */
  static async delete(id: string): Promise<void> {
    await HttpClient.delete<void>(ApiConfig.portfolioDetail(id));
  }
}
