/**
 * api/admin.api.ts — 管理员配置 API
 *
 * 对应后端 modules/admin/router.py（前缀 /api/admin）：
 * - GET    /api/admin/system-config/{key} — 读取单项系统配置（需管理员）
 * - PATCH  /api/admin/system-config/{key} — 更新单项系统配置（需管理员，body 即 value dict）
 */

import { http } from '@/lib/api-client';

/** 系统配置项（后端 SystemConfig 经信封解包后的结构） */
export interface SystemConfig {
  key: string;
  value: Record<string, unknown>;
  description: string | null;
  updatedAt: string | null;
}

/** 读取单项系统配置（key 为白名单内的配置键，如 securities_quote_api_base_url） */
export function getSystemConfig(key: string): Promise<SystemConfig> {
  return http.get<SystemConfig>(`/admin/system-config/${encodeURIComponent(key)}`);
}

/** 更新单项系统配置；请求体直接是配置 value（如 { url: "..." }） */
export function updateSystemConfig(
  key: string,
  value: Record<string, unknown>,
): Promise<SystemConfig> {
  return http.patch<SystemConfig>(
    `/admin/system-config/${encodeURIComponent(key)}`,
    value,
  );
}
