/**
 * composables/use-securities.ts — 标的列表查询 composable（vue-query）
 *
 * 平移自 React 版 web/src/hooks/use-securities.ts 的列表查询部分。
 * 标的 CRUD / resolve mutation 归属标的管理批次迁移，本文件暂只承载
 * 页面共用的「标的字典」查询（select 解包为纯数组，调用方直接用 data）。
 */

import { computed } from 'vue';
import { toValue, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { listSecurities } from '@/api/security.api';
import type { PaginatedResponse, Security } from '@/api/types';

/**
 * 标的列表（后端返回分页结构，select 解包为纯数组，调用方直接用 data 即可）。
 *
 * @param portfolioId 组合 id（支持 ref；null 时不发起请求）
 */
export function useSecurities(portfolioId: Ref<string | null> | string | null) {
  return useQuery<PaginatedResponse<Security>, Error, Security[]>({
    queryKey: ['securities', 'list', portfolioId],
    queryFn: () => listSecurities(toValue(portfolioId)!),
    select: (res) => res?.items ?? [],
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 60 * 1000,
  });
}
