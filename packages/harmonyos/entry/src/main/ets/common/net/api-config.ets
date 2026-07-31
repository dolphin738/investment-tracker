/**
 * API 配置 — 基础 URL、超时时间、端点路径常量
 *
 * HarmonyOS APP 调用同一套后端 API（与 Web 端共用）。
 * 模拟器访问本机后端使用 10.0.2.2，真机调试时需替换为实际 IP。
 */

export class ApiConfig {
  /** 后端基础 URL（模拟器访问宿主机） */
  static readonly BASE_URL: string = 'http://10.0.2.2:3000';

  /** 请求超时时间（毫秒） */
  static readonly TIMEOUT: number = 15000;

  /** AppStorage 中存储 JWT Token 的 key */
  static readonly TOKEN_KEY: string = 'authToken';

  /** AppStorage 中存储用户信息的 key */
  static readonly USER_KEY: string = 'authUser';

  /** AppStorage 中存储当前组合 ID 的 key */
  static readonly PORTFOLIO_KEY: string = 'currentPortfolioId';

  // ==================== 认证端点 ====================
  static readonly AUTH_REGISTER: string = '/api/auth/register';
  static readonly AUTH_LOGIN: string = '/api/auth/login';
  static readonly AUTH_PROFILE: string = '/api/auth/profile';

  // ==================== 组合端点 ====================
  static readonly PORTFOLIOS: string = '/api/portfolios';

  /** 获取单个组合详情/更新/删除路径 */
  static portfolioDetail(id: string): string {
    return `/api/portfolios/${id}`;
  }

  // ==================== 交易端点 ====================

  /** 获取交易列表/创建交易路径 */
  static transactions(portfolioId: string): string {
    return `/api/portfolios/${portfolioId}/transactions`;
  }

  /** 编辑/删除单个交易路径 */
  static transactionDetail(portfolioId: string, txId: string): string {
    return `/api/portfolios/${portfolioId}/transactions/${txId}`;
  }

  // ==================== 快照端点 ====================

  /** 获取快照列表/录入(upsert)快照路径 */
  static snapshots(portfolioId: string): string {
    return `/api/portfolios/${portfolioId}/snapshots`;
  }

  /** 删除单个快照路径 */
  static snapshotDetail(portfolioId: string, snapshotId: string): string {
    return `/api/portfolios/${portfolioId}/snapshots/${snapshotId}`;
  }

  // ==================== XIRR 查询端点 ====================

  /** 查询 XIRR 时间序列路径 */
  static xirrSeries(portfolioId: string): string {
    return `/api/portfolios/${portfolioId}/xirr`;
  }

  /** 获取最新 XIRR 路径 */
  static xirrLatest(portfolioId: string): string {
    return `/api/portfolios/${portfolioId}/xirr/latest`;
  }

  // ==================== 净值查询端点 ====================

  /** 查询净值时间序列路径 */
  static navSeries(portfolioId: string): string {
    return `/api/portfolios/${portfolioId}/nav`;
  }

  /** 获取最新净值路径 */
  static navLatest(portfolioId: string): string {
    return `/api/portfolios/${portfolioId}/nav/latest`;
  }
}
