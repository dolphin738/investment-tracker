/**
 * hooks/use-holdings.ts — 持仓查询 TanStack Query hooks（方案B · 只读）
 *
 * 持仓由后端按 SecurityTrade 流水实时推导，前端只保留 listHoldings 只读查询。
 * 方案A 的 upsert/delete/dates/sync-snapshot mutation 已删除。
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { listHoldings, type HoldingQueryParams } from '@/api/holding.api';

/** 持仓列表（含汇总） */
export function useHoldings(
  portfolioId: string | null,
  params: HoldingQueryParams = {},
) {
  return useQuery({
    queryKey: ['holdings', 'list', portfolioId, params],
    queryFn: () => listHoldings(portfolioId!, params),
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
    // 组合切换 / 日期 / 已清仓 / 类型变化时保留上一份数据，
    // 避免 loading 闪烁与「旧响应覆盖新响应」的请求竞态（T02 验收 7）
    placeholderData: keepPreviousData,
  });
}
