/**
 * api/security-master.api.ts — 系统级证券主数据 API
 *
 * 对应后端 modules/admin/router.py（前缀 /api/admin）：
 * - GET  /api/admin/securities/masters：分页浏览主数据行（portfolio_id IS NULL），
 *   q 匹配 code / name / 拼音首字母（后端 ILIKE）
 * - POST /api/admin/securities/sync：手动触发全量同步（遍历 MASTER_LIST 接口）
 *
 * http 客户端已自动解包信封 data；路径不含 /api 前缀（由 client 统一拼接）。
 */

import { http } from '@/lib/api-client';
import type { PaginatedResponse } from './types';

/** 系统级证券主数据行（后端 serialize_security_master 的 camelCase 形状） */
export interface SecurityMaster {
  id: string;
  code: string;
  name: string;
  /** 交易所/市场（SH/SZ/BJ/HK…）；主数据同步填充，可空 */
  exchange: string | null;
  /**
   * 资产类别（SecurityType：STOCK/HK_STOCK/ETF/INDEX…）。
   * 仅用于唯一约束 + 接口配置路由，不参与组合维度类型推导
   * （组合行 type 由代码前缀推断 / 手动 override，见 ADR-003）。
   */
  assetClass: string | null;
  /** 最近同步时间（TimestampMixin updated_at，ISO 8601） */
  updatedAt: string;
}

/** 主数据列表查询参数（§4.2：page/pageSize 分页 + q 关键字搜索） */
export interface SecurityMasterQuery {
  page?: number;
  pageSize?: number;
  /** 关键字：匹配 code / name / 拼音首字母（后端 ILIKE，大小写不敏感） */
  q?: string;
}

/** 单次同步实际命中的接口与提供方（用于前端展示「本次同步来源」） */
export interface UsedInterfaceInfo {
  providerId: string;
  providerName: string;
  interfaceId: string;
  interfaceName: string;
}

/** 主数据同步结果（POST /securities/sync） */
export interface SecurityMasterSyncResult {
  synced: number;
  failed: number;
  errors: string[];
  /** 本次同步实际使用的接口（按资产类别可能命中多个，已去重） */
  used?: UsedInterfaceInfo[];
}

/** 分页浏览系统级证券主数据 */
export function listSecurityMasters(
  params: SecurityMasterQuery = {},
): Promise<PaginatedResponse<SecurityMaster>> {
  const query: Record<string, unknown> = {};
  if (params.page != null) query.page = params.page;
  if (params.pageSize != null) query.pageSize = params.pageSize;
  if (params.q) query.q = params.q;
  return http.get<PaginatedResponse<SecurityMaster>>(
    '/admin/securities/masters',
    { params: query },
  );
}

/** 手动触发主数据全量同步 */
export function syncSecurityMasters(): Promise<SecurityMasterSyncResult> {
  return http.post<SecurityMasterSyncResult>('/admin/securities/sync');
}
