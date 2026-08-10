/**
 * api/security.api.ts — 标的管理 API
 *
 * 对应后端 /api/portfolios/:portfolioId/securities：
 * - GET    /securities              — 标的列表
 * - POST   /securities              — 新增标的
 * - PATCH  /securities/:securityId  — 编辑标的
 * - DELETE /securities/:securityId  — 删除标的
 */

import { http } from '@/lib/api-client';
import type {
  Security,
  CreateSecurityDto,
  UpdateSecurityDto,
  PaginatedResponse,
} from './types';

/**
 * 标的列表默认拉取条数上限。
 *
 * 后端 `GET /securities` 默认 `pageSize=20`；而前端把标的列表当作「全量字典」用
 * （类型筛选 type→securityId 映射、明细表标的名回显、筛选器证券多选）。
 * 不显式传 pageSize 时，标的超过 20 个的组合会拿到被截断的字典，
 * 导致类型筛选漏掉标的、明细表标的列显示 '-'。
 */
const SECURITY_LIST_PAGE_SIZE = 500;

/** 获取标的列表（后端返回分页结构 {items,total,page,pageSize}，hook 层已 select 解包为数组） */
export function listSecurities(
  portfolioId: string,
  pageSize: number = SECURITY_LIST_PAGE_SIZE,
): Promise<PaginatedResponse<Security>> {
  return http.get<PaginatedResponse<Security>>(
    `/portfolios/${portfolioId}/securities`,
    { params: { page: 1, pageSize } },
  );
}

/** 新增标的 */
export function createSecurity(
  portfolioId: string,
  payload: CreateSecurityDto,
): Promise<Security> {
  return http.post<Security>(
    `/portfolios/${portfolioId}/securities`,
    payload,
  );
}

/** 编辑标的 */
export function updateSecurity(
  portfolioId: string,
  securityId: string,
  payload: UpdateSecurityDto,
): Promise<Security> {
  return http.patch<Security>(
    `/portfolios/${portfolioId}/securities/${securityId}`,
    payload,
  );
}

/** 删除标的（级联删除持仓记录） */
export function deleteSecurity(
  portfolioId: string,
  securityId: string,
): Promise<null> {
  return http.delete<null>(
    `/portfolios/${portfolioId}/securities/${securityId}`,
  );
}
