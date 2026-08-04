/**
 * lib/api-client.ts — Axios 实例 + JWT 拦截器 + 响应信封解包
 *
 * - 请求拦截器：自动注入 Authorization: Bearer <token>
 * - 响应拦截器：
 *   - code === 0 → 返回 data 字段
 *   - code === 1001/1002（未认证/Token 过期） → 清除 token，跳转 /login
 *   - code ∈ SILENT_CODES → 不弹 toast，交由调用方 UI 自行渲染
 *   - code !== 0 → Toast 提示 message，抛出错误
 * - 抛出的 ApiError 会携带后端信封里的 data（如 1007 的 { remainingDays }）
 * - 调用方使用 apiClient.request/get/post/... 即可直接拿到 data，无需手动解包
 */

import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { toast } from 'sonner';
import { API_BASE_URL, AUTH_TOKEN_KEY, ROUTE_PATH } from './constants';
import { BUSINESS_ERROR_CODE, type ApiResponse } from '@investment-tracker/shared';

/** 业务错误（响应信封 code !== 0） */
export class ApiError extends Error {
  code: number;
  /**
   * 后端信封里附带的结构化数据，绝大多数错误为 null / undefined。
   *
   * 典型用途：业务码 1007（注销冷静期）携带 { remainingDays }，
   * 登录页据此渲染恢复引导卡片（SYS-P1-02）。
   */
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.data = data;
  }
}

/** 未认证错误码（401 / Token 过期） */
const UNAUTH_CODES = [1001, 1002];

/**
 * 静默业务码：不弹全局 toast，由调用方 UI 自行呈现。
 *
 * 1007（注销冷静期）是登录页的「可自助恢复」信号而非错误，
 * 弹红色 toast 会与恢复引导卡片并存，体验矛盾（PRD §7.10「不显示错误提示」）。
 * 1008 / 1009 刻意**不入**静默名单：它们是真正的失败，照常 toast。
 */
const SILENT_CODES: number[] = [BUSINESS_ERROR_CODE.PENDING_DELETION];

/** 创建 Axios 实例 */
const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * 移除请求头上的 Content-Type。
 *
 * axios v1 的 config.headers 是 AxiosHeaders 实例（有大小写不敏感的 delete 方法），
 * 但在部分场景下也可能是普通对象，这里两种都兼容。
 */
function stripContentType(headers: InternalAxiosRequestConfig['headers']): void {
  if (!headers) {
    return;
  }
  const bag = headers as unknown as {
    delete?: (name: string) => boolean;
    [key: string]: unknown;
  };
  if (typeof bag.delete === 'function') {
    bag.delete('Content-Type');
    return;
  }
  delete bag['Content-Type'];
}

/** 请求拦截器：注入 JWT + FormData 放行 multipart */
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    // 实例级写死了 'Content-Type': 'application/json'，
    // 而 axios 的 transformRequest 一旦看到 JSON 类型头，会把 FormData 序列化成 JSON
    // （formDataToJSON），导致后端 multer 收不到任何文件。
    // 请求拦截器早于 transformRequest 执行，此处删掉该头，
    // 浏览器才会自动补上 multipart/form-data; boundary=...
    if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
      stripContentType(config.headers);
    }

    return config;
  },
  (error) => Promise.reject(error),
);

/** 响应拦截器：解包信封 + 错误处理 */
apiClient.interceptors.response.use(
  (response: AxiosResponse<ApiResponse>) => {
    const body = response.data;
    // 兼容 Blob 等非信封响应（如未来文件下载）
    if (!body || typeof body !== 'object' || !('code' in body)) {
      return response;
    }
    if (body.code === 0) {
      // 把 data 放回 response.data，方便调用方直接拿
      // body.data 类型为 unknown，此处断言为解包后的信封（调用方经 http.get<T> 二次定型）
      response.data = body.data as ApiResponse;
      return response;
    }
    // 业务错误
    if (UNAUTH_CODES.includes(body.code)) {
      // Token 失效，清理并跳转登录
      localStorage.removeItem(AUTH_TOKEN_KEY);
      toast.error('登录已失效，请重新登录');
      if (window.location.pathname !== ROUTE_PATH.LOGIN) {
        window.location.href = ROUTE_PATH.LOGIN;
      }
      return Promise.reject(new ApiError(body.code, body.message, body.data));
    }
    // 其他业务错误：Toast 提示（静默码除外）
    if (!SILENT_CODES.includes(body.code)) {
      toast.error(body.message || '请求失败');
    }
    return Promise.reject(new ApiError(body.code, body.message, body.data));
  },
  (error) => {
    // HTTP 层错误（非 2xx）
    if (error.response) {
      const status = error.response.status;
      const body = error.response.data as ApiResponse | undefined;
      if (status === 401 || (body && UNAUTH_CODES.includes(body.code))) {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        toast.error('登录已失效，请重新登录');
        if (window.location.pathname !== ROUTE_PATH.LOGIN) {
          window.location.href = ROUTE_PATH.LOGIN;
        }
        return Promise.reject(
          new ApiError(body?.code ?? 1001, body?.message ?? '未认证', body?.data),
        );
      }
      const message = body?.message || `请求失败 (${status})`;
      // 冷静期信号（1007）走 HTTP 409 落到这里：不 toast，只把 data 交给调用方
      if (!(body && SILENT_CODES.includes(body.code))) {
        toast.error(message);
      }
      return Promise.reject(new ApiError(body?.code ?? status, message, body?.data));
    }
    if (error.request) {
      toast.error('网络异常，请检查网络连接');
    } else {
      toast.error(error.message || '请求失败');
    }
    return Promise.reject(error);
  },
);

/**
 * 封装快捷方法：直接返回 data 字段（T 类型）。
 *
 * 拦截器已把信封解包到 response.data，这里再取出 response.data 返回，
 * 这样调用方拿到的就是纯数据 T，而非整个 AxiosResponse。
 */
export const http = {
  get: <T>(url: string, config?: AxiosRequestConfig) =>
    apiClient.get<unknown, AxiosResponse<T>>(url, config).then((r) => r.data),
  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    apiClient.post<unknown, AxiosResponse<T>>(url, data, config).then((r) => r.data),
  put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    apiClient.put<unknown, AxiosResponse<T>>(url, data, config).then((r) => r.data),
  patch: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    apiClient.patch<unknown, AxiosResponse<T>>(url, data, config).then((r) => r.data),
  delete: <T>(url: string, config?: AxiosRequestConfig) =>
    apiClient.delete<unknown, AxiosResponse<T>>(url, config).then((r) => r.data),
};

export default apiClient;
