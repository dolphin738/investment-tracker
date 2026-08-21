/**
 * lib/log-reporter.ts — 前端客户端错误上报（方案 §4.2 / §7.2-2 / §7.3-2）
 *
 * 把浏览器侧错误（Vue 运行异常、未捕获 Promise、window error、API 失败）上报到
 * 后端 ``POST /api/client-logs``，最终写入 ``app_logs``。
 *
 * 设计约束：
 * - 仅已登录时上报（localStorage 有 token），未登录/登录失效不打请求，避免上报接口
 *   自身 401 循环（§7.2-2）。
 * - 同源去重 + 节流：相同 ``level|module|message`` 5 分钟内只报一次（§7.3-2），否则
 *   高频错误瞬间灌爆 ``app_logs``。
 * - 走裸 axios（不带项目拦截器），上报失败/401 时不会弹 toast 制造噪音；失败静默。
 * - 上报是 best-effort，绝不影响主流程。
 */

import axios from 'axios';
import { API_BASE_URL, AUTH_TOKEN_KEY } from '@/lib/constants';

/** 同源去重 + 节流窗口（ms）：5 分钟 */
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/** 已上报 (level|module|message) → 上次上报时间戳，用于节流 */
const lastSentAt = new Map<string, number>();

export type ClientLogLevel = 'error' | 'warning' | 'info';

export interface ClientLogPayload {
  level?: ClientLogLevel;
  /** 来源模块标识，如 'vue' / 'unhandledrejection' / 'api' / 'window.error' */
  module: string;
  message: string;
  trace?: string | null;
  detail?: unknown;
}

/**
 * 把客户端错误上报到后端 ``app_logs``（scope='client'）。
 *
 * 未登录直接本地打印并跳过；命中节流窗口则跳过；其余情况 fire-and-forget，
 * 失败静默（日志采集绝不能影响主流程）。
 */
export function reportClientError(payload: ClientLogPayload): void {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) {
    // 未登录不打上报请求（避免 401 循环），仅本地留痕便于开发排查
    // eslint-disable-next-line no-console
    console.error('[client-error]', payload.module, payload.message, payload.trace);
    return;
  }

  const level = payload.level ?? 'error';
  const dedupeKey = `${level}|${payload.module}|${payload.message}`;
  const now = Date.now();
  const prev = lastSentAt.get(dedupeKey);
  if (prev !== undefined && now - prev < DEDUPE_WINDOW_MS) {
    return; // 同源去重 + 节流
  }
  lastSentAt.set(dedupeKey, now);

  const body = {
    level,
    module: payload.module,
    message: payload.message,
    trace: payload.trace ?? null,
    detail: payload.detail ?? null,
  };

  // 裸 axios：绕过 api-client 拦截器（避免上报失败/401 弹 toast 噪音）
  axios
    .post(`${API_BASE_URL}/client-logs`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    })
    .catch(() => {
      /* 上报失败静默：日志采集绝不能影响主流程 */
    });
}
