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
  category_id: string | null;
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
  /** 分类级优先级（ADR-002 优先级链）：数字越小越优先；跨分类独立计数，null = 未纳入优先级链 */
  priority: number | null;
  created_at: string;
  updated_at: string;
}

/** 新增接口请求体（provider_id 取自路径） */
export interface QuoteInterfaceCreate {
  category_id: string;
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
  category_id?: string;
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

/**
 * 同分类内拖拽调序请求体（前端 dnd 产生的完整有序 id 列表）。
 * 对应后端 PATCH /admin/quote-interfaces/reorder。
 */
export interface ReorderQuoteInterfacesReq {
  category_id: string;
  ordered_ids: string[];
}

/**
 * 同分类内拖拽调序：PATCH /admin/quote-interfaces/reorder
 *
 * 前端 dnd 产生的完整有序 id 列表 → 后端把 priority 设为 index。
 * 返回 `{ ok: true }`。
 */
export function reorderQuoteInterfaces(
  body: ReorderQuoteInterfacesReq,
): Promise<{ ok: boolean }> {
  return http.patch<{ ok: boolean }>('/admin/quote-interfaces/reorder', body);
}

/**
 * 单接口测试请求体（§5.2）：params 为经前端编辑后的完整有效参数，覆盖 itf.params；
 * codes 可选，对应 MarketDataSyncService 的 codes 入参。
 */
export interface InterfaceTestRequest {
  params: Record<string, unknown>;
  codes?: string[];
}

/** 单接口测试响应（后端 test_single_interface 原样回传） */
export interface InterfaceTestResponse {
  ok: boolean;
  status: 'success' | 'error';
  /** HTTPS 接口的上游状态码；SDK 接口为 null */
  httpStatus?: number;
  /** 调用耗时（毫秒） */
  elapsedMs: number;
  /** 原始响应（HTTPS: resp.json()；SDK: list[dict]） */
  raw: unknown;
  /** 按 resp_code_field / resp_price_field 解析出的 {code → price} */
  parsed: Record<string, string> | null;
  /** 异常信息 */
  error?: string;
  interfaceId: string;
}

/**
 * 单接口测试：POST /api/admin/quote-interfaces/{id}/test
 *
 * 用调用方传入的 params 调用接口，原样回传 raw + parsed（不计入 consecutive_failures）。
 * 对应后端 modules/admin/router.py 的 test_quote_interface。
 */
export function testInterface(
  id: string,
  body: InterfaceTestRequest,
): Promise<InterfaceTestResponse> {
  return http.post<InterfaceTestResponse>(
    `/admin/quote-interfaces/${encodeURIComponent(id)}/test`,
    body,
  );
}
