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
import { listSecurities, SECURITY_LIST_PAGE_SIZE } from '@/api/security.api';
import type { PaginatedResponse, Security } from '@/api/types';

/**
 * 标的列表（后端返回分页结构，select 解包为纯数组，调用方直接用 data 即可）。
 *
 * 翻页拉全：后端单页上限 200（data/router.py `le=200`），本 hook 按 200/页顺序翻页，
 * 直到最后一页不足一页为止，拼接为完整字典——既避免单次请求 >200 触发 422，
 * 也保证组合标的数超过单页上限时字典不被截断（类型筛选 / 标的名回显 / 证券多选依赖完整字典）。
 *
 * @param portfolioId 组合 id（支持 ref；null 时不发起请求）
 */
export function useSecurities(portfolioId: Ref<string | null> | string | null) {
  return useQuery<PaginatedResponse<Security>, Error, Security[]>({
    queryKey: ['securities', 'list', portfolioId],
    queryFn: async () => {
      const pid = toValue(portfolioId)!;
      const all: Security[] = [];
      let page = 1;
      let lastLen = 0;
      // 当返回页恰好装满（== 单页上限）时，后端仍可能有下一页，继续翻；
      // 末页不足一页（lastLen < 单页上限）即停止。不依赖 total，避免 total 缺失时死循环。
      do {
        const res = await listSecurities(pid, SECURITY_LIST_PAGE_SIZE, page);
        all.push(...(res?.items ?? []));
        lastLen = res?.items?.length ?? 0;
        page += 1;
      } while (lastLen === SECURITY_LIST_PAGE_SIZE);
      return {
        items: all,
        total: all.length,
        page: 1,
        pageSize: all.length,
      } as PaginatedResponse<Security>;
    },
    select: (res) => res?.items ?? [],
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 60 * 1000,
  });
}
