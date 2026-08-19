/**
 * api/quote-sync.api.ts — 行情自动同步配置 API（账户页「行情自动同步」卡）
 *
 * 对应后端 /api/quote-sync（http 客户端已解包信封）：
 * - GET  /quote-sync           — 当前用户行情同步配置（任意登录用户可调用）
 * - PUT  /quote-sync           — 保存配置（body 同字段；校验失败 400，成功后后端重载调度）
 * - POST /quote-sync/trigger   — 手动立即同步当前用户全部组合一次
 */

import { http } from '@/lib/api-client';

/** 同步周期：每日 / 每周 / 每月 */
export type QuoteSyncFrequency = 'DAY' | 'WEEK' | 'MONTH';

/** 上次执行状态 */
export type QuoteSyncStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';

/** 行情同步配置（后端 QuoteSyncConfig 响应/请求同构） */
export interface UserQuoteSyncConfig {
  user_id: string;
  /** 同步周期 */
  frequency: QuoteSyncFrequency;
  /** 每日执行时刻 "HH:MM" */
  time: string;
  /** 是否启用 */
  enabled: boolean;
  /** 触发星期（1=周一 .. 7=周日，仅 WEEK 有效，其余为 null） */
  weekday: number | null;
  /** 触发日（1..31，仅 MONTH 有效，其余为 null） */
  day_of_month: number | null;
  /** 上次执行时间（ISO；尚无执行为 null） */
  last_run_at: string | null;
  /** 上次执行状态（RUNNING/SUCCESS/FAILED；尚未执行为 null） */
  last_status: QuoteSyncStatus | null;
  /** 上次执行消息（成功/失败说明） */
  last_message: string | null;
}

/**
 * 可写字段子集（PUT 提交用）：不含只读回显字段（user_id / last_*）。
 * 后端 PUT 为 upsert，未做全字段必要；该类型信号更收敛。
 */
export interface UserQuoteSyncConfigUpdate {
  /** 是否启用 */
  enabled: boolean;
  /** 同步周期 */
  frequency: QuoteSyncFrequency;
  /** 每日执行时刻 "HH:MM" */
  time: string;
  /** 触发星期（仅 WEEK 有效，其余置 null） */
  weekday: number | null;
  /** 触发日（仅 MONTH 有效，其余置 null） */
  day_of_month: number | null;
}

/** 手动触发立即同步的响应 */
export interface QuoteSyncTriggerResult {
  triggered: boolean;
}

/** 获取当前用户的行情同步配置 */
export function getQuoteSync(): Promise<UserQuoteSyncConfig> {
  return http.get<UserQuoteSyncConfig>('/quote-sync');
}

/** 保存行情同步配置（提交可写字段子集，成功后后端重载调度） */
export function setQuoteSync(
  body: UserQuoteSyncConfigUpdate,
): Promise<UserQuoteSyncConfig> {
  return http.put<UserQuoteSyncConfig>('/quote-sync', body);
}

/** 手动立即同步当前用户全部组合一次 */
export function triggerQuoteSync(): Promise<QuoteSyncTriggerResult> {
  return http.post<QuoteSyncTriggerResult>('/quote-sync/trigger');
}