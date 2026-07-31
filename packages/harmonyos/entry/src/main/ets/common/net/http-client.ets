/**
 * HTTP 请求封装 — 基于 @ohos.net.http
 *
 * 功能：
 * - 支持 GET / POST / PUT / PATCH / DELETE
 * - JWT 自动注入（从 AppStorage 读取 token）
 * - 响应信封解包（{ code, data, message } → 返回 data）
 * - 401 自动清除 token 并跳转登录页
 * - 统一错误处理
 */

import { http } from '@kit.NetworkKit';
import { router } from '@kit.ArkUI';
import { ApiConfig } from './api-config';
import type { ApiResponse } from './api-types';

export class HttpClient {
  /**
   * GET 请求
   * @param path 请求路径（含 query string）
   */
  static async get<T>(path: string): Promise<T> {
    return this.request<T>(http.RequestMethod.GET, path);
  }

  /**
   * POST 请求
   */
  static async post<T>(path: string, body?: object): Promise<T> {
    return this.request<T>(http.RequestMethod.POST, path, body);
  }

  /**
   * PUT 请求（用于快照 upsert）
   */
  static async put<T>(path: string, body?: object): Promise<T> {
    return this.request<T>(http.RequestMethod.PUT, path, body);
  }

  /**
   * PATCH 请求（用于部分更新）
   */
  static async patch<T>(path: string, body?: object): Promise<T> {
    return this.request<T>('PATCH' as http.RequestMethod, path, body);
  }

  /**
   * DELETE 请求
   */
  static async delete<T>(path: string): Promise<T> {
    return this.request<T>(http.RequestMethod.DELETE, path);
  }

  /**
   * 核心请求方法
   */
  private static async request<T>(
    method: http.RequestMethod,
    path: string,
    body?: object,
  ): Promise<T> {
    const url: string = ApiConfig.BASE_URL + path;

    // 从 AppStorage 读取 JWT Token
    const token: string = AppStorage.get<string>(ApiConfig.TOKEN_KEY) || '';

    // 构建请求头
    const header: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token && token.length > 0) {
      header['Authorization'] = `Bearer ${token}`;
    }

    // 构建请求体
    const extraData: string | undefined = body ? JSON.stringify(body) : undefined;

    const httpRequest = http.createHttp();

    try {
      const response = await httpRequest.request(url, {
        method: method,
        header: header,
        extraData: extraData,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: ApiConfig.TIMEOUT,
        readTimeout: ApiConfig.TIMEOUT,
      });

      // 处理 401 未授权
      if (response.responseCode === 401) {
        this.handleUnauthorized();
        throw new Error('登录已过期，请重新登录');
      }

      // 处理非 2xx 状态码
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error(`服务器错误 (${response.responseCode})`);
      }

      // 解析响应体
      const resultStr: string = typeof response.result === 'string' ? response.result : '';
      if (resultStr.length === 0) {
        throw new Error('服务器返回空响应');
      }

      const result: ApiResponse<T> = JSON.parse(resultStr) as ApiResponse<T>;

      // 检查 API 信封状态码
      if (result.code !== 0) {
        throw new Error(result.message || '请求失败');
      }

      if (result.data === null || result.data === undefined) {
        return null as T;
      }

      return result.data;
    } catch (error) {
      // 已经是业务错误的直接抛出
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`网络请求异常: ${JSON.stringify(error)}`);
    } finally {
      httpRequest.destroy();
    }
  }

  /**
   * 处理 401 未授权 — 清除 token 并跳转登录页
   */
  private static handleUnauthorized(): void {
    AppStorage.setOrCreate(ApiConfig.TOKEN_KEY, '');
    AppStorage.setOrCreate(ApiConfig.USER_KEY, null);
    // 避免在登录页时重复跳转
    const currentPath = router.getState()?.path || '';
    if (currentPath !== 'pages/Login' && currentPath !== 'pages/Register') {
      router.replaceUrl({ url: 'pages/Login' });
    }
  }
}
