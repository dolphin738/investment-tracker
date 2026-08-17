/**
 * modules/holdings/composables/use-holdings.ts — 持仓查询 vue-query composable（方案B · 只读）
 *
 * 平移自 React 版 web/src/hooks/use-holdings.ts。
 * 持仓由后端按 SecurityTrade 流水实时推导，前端只保留 listHoldings 只读查询。
 * 方案A 的 upsert/delete/dates/sync-snapshot mutation 已删除。
 */

import { computed, toValue, type Ref } from 'vue';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { listHoldings, type HoldingQueryParams } from '@/api/holding.api';

/**
 * 持仓列表（含汇总）。
 *
 * @param portfolioId 组合 id（支持 ref/computed；null 时不发起请求）
 * @param params 查询参数（支持 ref/computed，date/includeClosed/types/securityId
 *               变化即触发新查询，queryKey 随响应式值自动解包）
 */
export function useHoldings(
  portfolioId: Ref<string | null> | string | null,
  params: Ref<HoldingQueryParams | undefined> | HoldingQueryParams = {},
) {
  return useQuery({
    queryKey: ['holdings', 'list', portfolioId, params],
    queryFn: () =>
      listHoldings(
        toValue(portfolioId)!,
        toValue(params) ?? {},
      ),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 30 * 1000,
    // 组合切换 / 日期 / 已清仓 / 类型变化时保留上一份数据，
    // 避免 loading 闪烁与「旧响应覆盖新响应」的请求竞态（T02 验收 7）
    placeholderData: keepPreviousData,
  });
}
