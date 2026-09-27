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

// 翻页护栏：单页 200 × 50 页 = 10000 条。正常组合的标的字典远达不到；
// 若后端分页实现异常（如忽略 page 参数恒返满页），无上限翻页会变成死循环。
// 超限**抛错**而非静默截断——截断字典会静默重现「类型筛选漏标的 / 标的名回显 '-'」原缺陷。
const MAX_SECURITY_PAGES = 50;

/**
 * 标的列表（后端返回分页结构，select 解包为纯数组，调用方直接用 data 即可）。
 *
 * 翻页拉全：后端单页上限 200（data/router.py `le=200`），本 hook 按 200/页顺序翻页，
 * 直到最后一页不足一页为止，拼接为完整字典——既避免单次请求 >200 触发 422，
 * 也保证组合标的数超过单页上限时字典不被截断（类型筛选 / 标的名回显 / 证券多选依赖完整字典）。
 * 页数超过 MAX_SECURITY_PAGES 视为后端分页异常，抛错可见（vue-query error 态）。
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
      // 页数护栏在循环体开头判定：前 50 页全满、仍要请求第 51 页时才抛错，
      // 「第 50 页恰为末页」的正常收尾不受影响。
      do {
        if (page > MAX_SECURITY_PAGES) {
          throw new Error(
            `标的字典翻页超过上限（${MAX_SECURITY_PAGES} 页 × ${SECURITY_LIST_PAGE_SIZE} 条），` +
              '疑似后端分页异常，已中止拉取',
          );
        }
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
