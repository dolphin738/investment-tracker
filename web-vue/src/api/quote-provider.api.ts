/**
 * api/quote-provider.api.ts — 证券行情数据提供方（多提供方管理）API
 *
 * 对应后端 modules/admin/router.py（前缀 /api/admin）：
 * - GET    /api/admin/quote-providers：列出全部提供方
 * - POST   /api/admin/quote-providers：新增提供方
 * - GET    /api/admin/quote-providers/{id}：读取单个
 * - PATCH  /api/admin/quote-providers/{id}：局部更新
 * - DELETE /api/admin/quote-providers/{id}：删除
 *
 * 取代旧的单 URL 系统配置（system-config）端点。
 * 提供方仅保留 enabled 启停开关（全局单一活跃源 is_default/is_active 已移除，见 ADR-002）。
 */

import { http } from '@/lib/api-client';

/** 接入方式：HTTPS（API 地址）或 SDK（如 akshare） */
export type QuoteProviderAccessMethod = 'https' | 'sdk';

/** 提供方（后端 QuoteProviderOut 经信封解包后的结构） */
export interface QuoteProvider {
  id: string;
  name: string;
  access_method: QuoteProviderAccessMethod;
  config: Record<string, unknown>;
  enabled: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
}

/** 新增提供方请求体 */
export interface QuoteProviderCreate {
  name: string;
  access_method: QuoteProviderAccessMethod;
  config: Record<string, unknown>;
  enabled?: boolean;
  description?: string | null;
}

/** 更新提供方请求体（全字段可选） */
export interface QuoteProviderUpdate {
  name?: string;
  access_method?: QuoteProviderAccessMethod;
  config?: Record<string, unknown>;
  enabled?: boolean;
  description?: string | null;
}

/** 列出全部提供方 */
export function listQuoteProviders(): Promise<QuoteProvider[]> {
  return http.get<QuoteProvider[]>('/admin/quote-providers');
}

/** 读取单个提供方 */
export function getQuoteProvider(id: string): Promise<QuoteProvider> {
  return http.get<QuoteProvider>(`/admin/quote-providers/${encodeURIComponent(id)}`);
}

/** 新增提供方 */
export function createQuoteProvider(
  body: QuoteProviderCreate,
): Promise<QuoteProvider> {
  return http.post<QuoteProvider>('/admin/quote-providers', body);
}

/** 局部更新提供方 */
export function updateQuoteProvider(
  id: string,
  body: QuoteProviderUpdate,
): Promise<QuoteProvider> {
  return http.patch<QuoteProvider>(
    `/admin/quote-providers/${encodeURIComponent(id)}`,
    body,
  );
}

/** 删除提供方 */
export function deleteQuoteProvider(
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  return http.delete<{ id: string; deleted: boolean }>(
    `/admin/quote-providers/${encodeURIComponent(id)}`,
  );
}
