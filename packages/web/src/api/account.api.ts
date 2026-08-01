/**
 * api/account.api.ts — 账户统计 API
 *
 * 对应后端：
 * - GET /api/account/stats — 账户统计
 */

import { http } from '@/lib/api-client';
import type { AccountStats } from './types';

/** 获取账户统计数据 */
export function getAccountStats(): Promise<AccountStats> {
  return http.get<AccountStats>('/account/stats');
}
