/**
 * api/interface-category.api.ts — 接口分类（后台管理）API
 *
 * 对应后端 modules/admin/router.py（前缀 /api/admin）：
 * - GET    /api/admin/interface-categories：列出全部分类（按 sort_order 升序）
 * - POST   /api/admin/interface-categories：新增分类
 * - PATCH  /api/admin/interface-categories/{id}：更新分类
 * - DELETE /api/admin/interface-categories/{id}：删除分类（不影响接口）
 *
 * 与 quote-provider.api.ts 保持一致的信封解包风格。
 */

import { http } from '@/lib/api-client';

/** 接口分类（后端 InterfaceCategoryOut 经信封解包后的结构） */
export interface InterfaceCategory {
  id: string;
  label: string;
  icon: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** 新增分类请求体 */
export interface InterfaceCategoryCreate {
  label: string;
  icon?: string | null;
  sort_order?: number;
}

/** 更新分类请求体（全字段可选） */
export interface InterfaceCategoryUpdate {
  label?: string;
  icon?: string | null;
  sort_order?: number;
}

/** 列出全部分类 */
export function listInterfaceCategories(): Promise<InterfaceCategory[]> {
  return http.get<InterfaceCategory[]>('/admin/interface-categories');
}

/** 新增分类 */
export function createInterfaceCategory(
  body: InterfaceCategoryCreate,
): Promise<InterfaceCategory> {
  return http.post<InterfaceCategory>('/admin/interface-categories', body);
}

/** 更新分类 */
export function updateInterfaceCategory(
  id: string,
  body: InterfaceCategoryUpdate,
): Promise<InterfaceCategory> {
  return http.patch<InterfaceCategory>(
    `/admin/interface-categories/${encodeURIComponent(id)}`,
    body,
  );
}

/** 删除分类 */
export function deleteInterfaceCategory(
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  return http.delete<{ id: string; deleted: boolean }>(
    `/admin/interface-categories/${encodeURIComponent(id)}`,
  );
}
