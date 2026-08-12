/**
 * api/quote-interface.api.ts — 提供方接口（接口 CRUD）API
 *
 * 对应后端 modules/admin/router.py（前缀 /api/admin）：
 * - GET    /api/admin/quote-providers/{providerId}/interfaces：列出某提供方全部接口
 * - POST   /api/admin/quote-providers/{providerId}/interfaces：新增接口
 * - GET    /api/admin/quote-providers/interfaces：扁平返回全部接口（顶层按分类汇总总览）
 * - GET    /api/admin/quote-providers/interfaces/{interfaceId}：读取单个
 * - PATCH  /api/admin/quote-providers/interfaces/{interfaceId}：局部更新
 * - DELETE /api/admin/quote-providers/interfaces/{interfaceId}：删除
 *
 * 与 quote-provider.api.ts 保持一致的信封解包风格（http 已解包 data）。
 */

import { http } from '@/lib/api-client';

/** HTTP 方法（大写），可空（SDK 接口可留空） */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** 接口方向（后端落库，UI 暂不暴露） */
export type InterfaceDirection = 'in' | 'out';

/** 接口（后端 QuoteInterfaceOut 经信封解包后的结构） */
export interface QuoteInterface {
  id: string;
  provider_id: string;
  interface_type: string;
  name: string;
  endpoint: string | null;
  http_method: HttpMethod | null;
  params: Record<string, unknown> | null;
  enabled: boolean;
  description: string | null;
  direction: InterfaceDirection;
  timeout: number | null;
  retry_count: number | null;
  rate_limit: string | null;
  created_at: string;
  updated_at: string;
}

/** 新增接口请求体（provider_id 取自路径） */
export interface QuoteInterfaceCreate {
  interface_type: string;
  name: string;
  endpoint?: string | null;
  http_method?: HttpMethod | null;
  params?: Record<string, unknown> | null;
  enabled?: boolean;
  description?: string | null;
  direction?: InterfaceDirection;
  timeout?: number | null;
  retry_count?: number | null;
  rate_limit?: string | null;
}

/** 更新接口请求体（全字段可选；provider_id 不可改） */
export interface QuoteInterfaceUpdate {
  interface_type?: string;
  name?: string;
  endpoint?: string | null;
  http_method?: HttpMethod | null;
  params?: Record<string, unknown> | null;
  enabled?: boolean;
  description?: string | null;
  direction?: InterfaceDirection;
  timeout?: number | null;
  retry_count?: number | null;
  rate_limit?: string | null;
}

/** 列出某提供方全部接口 */
export function listProviderInterfaces(providerId: string): Promise<QuoteInterface[]> {
  return http.get<QuoteInterface[]>(
    `/admin/quote-providers/${encodeURIComponent(providerId)}/interfaces`,
  );
}

/** 读取单个接口 */
export function getInterface(id: string): Promise<QuoteInterface> {
  return http.get<QuoteInterface>(
    `/admin/quote-providers/interfaces/${encodeURIComponent(id)}`,
  );
}

/** 新增接口 */
export function createInterface(
  providerId: string,
  body: QuoteInterfaceCreate,
): Promise<QuoteInterface> {
  return http.post<QuoteInterface>(
    `/admin/quote-providers/${encodeURIComponent(providerId)}/interfaces`,
    body,
  );
}

/** 局部更新接口 */
export function updateInterface(
  id: string,
  body: QuoteInterfaceUpdate,
): Promise<QuoteInterface> {
  return http.patch<QuoteInterface>(
    `/admin/quote-providers/interfaces/${encodeURIComponent(id)}`,
    body,
  );
}

/** 删除接口 */
export function deleteInterface(
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  return http.delete<{ id: string; deleted: boolean }>(
    `/admin/quote-providers/interfaces/${encodeURIComponent(id)}`,
  );
}

/** 扁平返回全部接口（顶层按分类汇总所有提供方接口总览） */
export function listAllInterfaces(): Promise<QuoteInterface[]> {
  return http.get<QuoteInterface[]>('/admin/quote-providers/interfaces');
}
