/**
 * modules/security-income/composables/use-dividends.ts — 分红记录 vue-query hooks
 *
 * 平移自 React 版 hooks/use-dividends.ts，行为契约一致：
 * - useDividends：列表 query（标的多值 / 日期范围过滤，I-05）
 * - useCreateDividend / useUpdateDividend / useDeleteDividend：mutation
 *
 * 与 use-security-trades 的关键差异：
 * 分红**不参与 XIRR / 净值 / 持仓推导**（D-02 / C-08），因此写入后
 * **只失效 ['dividends'] 自身缓存**，绝不连带失效 holdings / nav / xirr /
 * snapshots / overview —— 连带失效会造成「分红污染收益计算」的错觉。
 *
 * 参数支持 ref / computed 传入（组合切换、筛选变化时 queryKey 自动跟随）。
 */

import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import {
  createDividend as createApi,
  deleteDividend as deleteApi,
  listDividends as listApi,
  updateDividend as updateApi,
} from '@/api/dividend.api';
import type { DividendQuery } from '@/api/dividend.api';
import type {
  CreateDividendRecordDto,
  DividendRecord,
  DividendType,
  PaginatedResponse,
  UpdateDividendRecordDto,
} from '@/api/types';

/** 分红类型中文映射（表单与列表共用；编辑态下拉遍历） */
export const DIVIDEND_TYPE_LABEL: Record<DividendType, string> = {
  CASH: '现金分红',
  STOCK_DIVIDEND: '红利再投',
};

/**
 * 分红记录列表（I-05：支持 securityId 多值 / 日期范围过滤）。
 *
 * 后端返回分页结构 {items,total,page,pageSize}，select 解包为纯数组，
 * 调用方直接用 `data` 即可（如 DividendList 的 `dividends.data`）。
 */
export function useDividends(
  portfolioId: MaybeRefOrGetter<string | null>,
  query: MaybeRefOrGetter<DividendQuery> = {},
) {
  return useQuery<PaginatedResponse<DividendRecord>, Error, DividendRecord[]>({
    queryKey: computed(() => {
      const id = toValue(portfolioId);
      return id
        ? ['dividends', 'list', id, toValue(query)]
        : ['dividends', 'disabled'];
    }),
    queryFn: () => listApi(toValue(portfolioId)!, toValue(query)),
    select: (res) => res?.items ?? [],
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 30 * 1000,
  });
}

/** 失效分红自身缓存（写入成功后仅此，绝不连带收益相关缓存） */
function invalidateDividends(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: ['dividends'] });
}

/** 新增分红记录 */
export function useCreateDividend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      payload,
    }: {
      portfolioId: string;
      payload: CreateDividendRecordDto;
    }) => createApi(portfolioId, payload),
    onSuccess: () => {
      toast.success('分红记录已保存');
      invalidateDividends(queryClient);
    },
  });
}

/**
 * 编辑分红记录（增量设计 R-5 / K-6）
 *
 * 只失效 ['dividends'] 自身缓存，绝不连带失效 holdings / nav / xirr /
 * snapshots / overview —— 分红编辑不参与收益计算，连带失效会造成
 * 「改了分红 → 收益变了」的错觉。
 */
export function useUpdateDividend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      id,
      payload,
    }: {
      portfolioId: string;
      id: string;
      payload: UpdateDividendRecordDto;
    }) => updateApi(portfolioId, id, payload),
    onSuccess: () => {
      toast.success('分红记录已更新');
      invalidateDividends(queryClient);
    },
  });
}

/** 删除分红记录 */
export function useDeleteDividend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      id,
    }: {
      portfolioId: string;
      id: string;
    }) => deleteApi(portfolioId, id),
    onSuccess: () => {
      toast.success('分红记录已删除');
      invalidateDividends(queryClient);
    },
  });
}