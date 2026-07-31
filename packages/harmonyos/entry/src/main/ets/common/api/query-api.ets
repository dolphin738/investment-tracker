/**
 * 查询 API — XIRR / 净值 四维度查询
 *
 * 对应后端端点：
 * - GET /api/portfolios/:portfolioId/xirr          查询 XIRR 时间序列
 * - GET /api/portfolios/:portfolioId/xirr/latest   获取最新 XIRR
 * - GET /api/portfolios/:portfolioId/nav           查询净值时间序列
 * - GET /api/portfolios/:portfolioId/nav/latest    获取最新净值
 *
 * 四维度查询参数：
 * - granularity: day / week / month / year
 * - startDate: YYYY-MM-DD（可选）
 * - endDate: YYYY-MM-DD（可选）
 * - aggregation: last（期末值，默认）/ avg（均值）
 */

import { HttpClient } from '../net/http-client';
import { ApiConfig } from '../net/api-config';
import type {
  LatestNav,
  LatestXirr,
  NavSeriesPoint,
  XirrSeriesPoint,
} from '../net/api-types';

export class QueryApi {
  /**
   * 查询 XIRR 时间序列
   * @param portfolioId 组合 ID
   * @param granularity 粒度：day / week / month / year
   * @param startDate 起始日期（可选）
   * @param endDate 结束日期（可选）
   * @param aggregation 聚合方式：last / avg（默认 last）
   */
  static async getXirrSeries(
    portfolioId: string,
    granularity: string,
    startDate?: string,
    endDate?: string,
    aggregation: string = 'last',
  ): Promise<XirrSeriesPoint[]> {
    let path: string = `${ApiConfig.xirrSeries(portfolioId)}?granularity=${granularity}&aggregation=${aggregation}`;
    if (startDate) {
      path += `&startDate=${startDate}`;
    }
    if (endDate) {
      path += `&endDate=${endDate}`;
    }
    return HttpClient.get<XirrSeriesPoint[]>(path);
  }

  /**
   * 获取最新 XIRR
   */
  static async getLatestXirr(portfolioId: string): Promise<LatestXirr> {
    return HttpClient.get<LatestXirr>(ApiConfig.xirrLatest(portfolioId));
  }

  /**
   * 查询净值时间序列
   * @param portfolioId 组合 ID
   * @param granularity 粒度：day / week / month / year
   * @param startDate 起始日期（可选）
   * @param endDate 结束日期（可选）
   * @param aggregation 聚合方式：last / avg（默认 last）
   */
  static async getNavSeries(
    portfolioId: string,
    granularity: string,
    startDate?: string,
    endDate?: string,
    aggregation: string = 'last',
  ): Promise<NavSeriesPoint[]> {
    let path: string = `${ApiConfig.navSeries(portfolioId)}?granularity=${granularity}&aggregation=${aggregation}`;
    if (startDate) {
      path += `&startDate=${startDate}`;
    }
    if (endDate) {
      path += `&endDate=${endDate}`;
    }
    return HttpClient.get<NavSeriesPoint[]>(path);
  }

  /**
   * 获取最新净值
   */
  static async getLatestNav(portfolioId: string): Promise<LatestNav> {
    return HttpClient.get<LatestNav>(ApiConfig.navLatest(portfolioId));
  }
}
