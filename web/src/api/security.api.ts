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

/** 获取标的列表（后端返回分页结构 {items,total,page,pageSize}，hook 层已 select 解包为数组） */
export function listSecurities(
  portfolioId: string,
): Promise<PaginatedResponse<Security>> {
  return http.get<PaginatedResponse<Security>>(`/portfolios/${portfolioId}/securities`);
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
