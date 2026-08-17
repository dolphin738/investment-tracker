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
   * 资产类别（SecurityType：STOCK/HK_STOCK/ON_EXCHANGE_FUND/OFF_EXCHANGE_FUND/INDEX…）。
   * 仅用于唯一约束 + 接口配置路由，不参与组合维度类型推导
   * （组合行 type 由代码前缀推断 / 手动 override，见 ADR-003）。
   */
  assetClass: string | null;
  /** 最近同步时间（TimestampMixin updated_at，ISO 8601） */
  updatedAt: string;
}

/** 主数据列表查询参数（§4.2：page/pageSize 分页 + q 关键字搜索 + assetClass 类别筛选） */
export interface SecurityMasterQuery {
  page?: number;
  pageSize?: number;
  /** 关键字：匹配 code / name / 拼音首字母（后端 ILIKE，大小写不敏感） */
  q?: string;
  /** 按资产类别过滤（SecurityType 值；UNCATEGORIZED=未分类）；不传=全部 */
  assetClass?: string;
  /** 按交易所过滤（SH/SZ/BJ/HK）；不传=全部 */
  exchange?: string;
}

/** 主数据按资产类别统计（GET /securities/masters/stats）：{ 资产类别: 条数 } */
export interface SecurityMasterStats {
  counts: Record<string, number>;
}

/** 单次同步实际命中的接口与提供方（用于前端展示「本次同步来源」+ 各接口获取条数） */
export interface UsedInterfaceInfo {
  providerId: string;
  providerName: string;
  interfaceId: string;
  interfaceName: string;
  /** 该接口本次返回的原始行数（0 表示未命中/无响应） */
  fetched?: number;
  /** 命中状态：ok=成功获取并写入；空/失败不计 */
  status?: string;
}

/** 主数据同步结果（POST /securities/sync） */
export interface SecurityMasterSyncResult {
  synced: number;
  failed: number;
  errors: string[];
  /** 本次同步实际使用的接口（按资产类别可能命中多个，已去重） */
  used?: UsedInterfaceInfo[];
}

/** 批量/单行删除主数据结果（DELETE /securities/masters） */
export interface SecurityMasterDeleteResult {
  /** 实际删除的孤儿主数据条数 */
  deleted: number;
  /** 被跳过的 id 及原因（不存在 / 被组合持仓引用） */
  skipped: { id: string; reason: string }[];
}

/** 批量/单行删除主数据请求参数：
 *  - ids：指定 id 删除（与 all 互斥；all=true 时忽略）；
 *  - all=true：删除「当前筛选条件下全部孤儿主数据」（跨所有页），并传回列表同款筛选条件。 */
export interface SecurityMasterDeleteParams {
  ids?: string[];
  all?: boolean;
  q?: string;
  assetClass?: string;
  exchange?: string;
}

/** 分页浏览系统级证券主数据 */
export function listSecurityMasters(
  params: SecurityMasterQuery = {},
): Promise<PaginatedResponse<SecurityMaster>> {
  const query: Record<string, unknown> = {};
  if (params.page != null) query.page = params.page;
  if (params.pageSize != null) query.pageSize = params.pageSize;
  if (params.q) query.q = params.q;
  if (params.assetClass) query.asset_class = params.assetClass;
  if (params.exchange) query.exchange = params.exchange;
  return http.get<PaginatedResponse<SecurityMaster>>(
    '/admin/securities/masters',
    { params: query },
  );
}

/** 主数据按资产类别统计条数 */
export function getSecurityMasterStats(): Promise<SecurityMasterStats> {
  return http.get<SecurityMasterStats>('/admin/securities/masters/stats');
}

/** 主数据同步调用的客户端超时（覆盖 axios 实例默认的 30s）。
 *
 * 实测 dev 库同步耗时 62s（3 个 MASTER_LIST 接口 + 12k 行 upsert + 自愈去重）。
 * 30s 超时会让 axios 提前 abort，但后端进程仍在跑且最终会 commit，
 * 前端却因「网络异常 + 同步失败」两条 toast 误判为失败——属于 30s < 实际耗时。
 * 180s 给 12k~30k 行留足余量；该同步是手动触发、有明确预期，不是高频热路径。
 */
const SYNC_MASTER_TIMEOUT_MS = 180_000;

/** 手动触发主数据全量同步 */
export function syncSecurityMasters(): Promise<SecurityMasterSyncResult> {
  return http.post<SecurityMasterSyncResult>('/admin/securities/sync', undefined, {
    timeout: SYNC_MASTER_TIMEOUT_MS,
  });
}

/** 批量/单行删除系统级证券主数据（仅管理员；被组合持仓引用的主数据会被跳过） */
export function deleteSecurityMasters(
  params: SecurityMasterDeleteParams,
): Promise<SecurityMasterDeleteResult> {
  // 与 listSecurityMasters 保持一致：后端 body 字段为 snake_case，
  // 须把 camelCase 的 assetClass 转为 asset_class，否则类别筛选会失效
  // （all=true 时退化为删除全部孤儿主数据）。
  const body: Record<string, unknown> = {};
  if (params.ids != null) body.ids = params.ids;
  if (params.all != null) body.all = params.all;
  if (params.q) body.q = params.q;
  if (params.assetClass) body.asset_class = params.assetClass;
  if (params.exchange) body.exchange = params.exchange;
  return http.delete<SecurityMasterDeleteResult>('/admin/securities/masters', {
    data: body,
  });
}
