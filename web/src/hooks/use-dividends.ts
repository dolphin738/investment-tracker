/**
 * hooks/use-dividends.ts — 分红记录 TanStack Query hooks（HOLD-B-P0-10 / 阶段 C）
 *
 * ⚠️ 与 use-security-trades 的关键差异：
 * 分红**不参与 XIRR / 净值 / 持仓推导**（D-02 / C-08），因此写入后
 * **只失效 ['dividends'] 自身缓存**，绝不连带失效 holdings / nav / xirr /
 * snapshots / overview —— 连带失效会造成「分红污染收益计算」的错觉。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
  PaginatedResponse,
  UpdateDividendRecordDto,
} from '@/api/types';

/** 分红列表 query key 前缀 */
export const DIVIDENDS_KEY = ['dividends'] as const;

/**
 * 分红记录列表（I-05：支持 securityId 多值 / 日期范围过滤）
 *
 * 后端返回分页结构 {items,total,page,pageSize}，select 解包为纯数组，
 * 调用方直接用 `data` 即可（如 dividend-fee-section 的 `dividends.data`）。
 */
export function useDividends(
  portfolioId: string | null,
  query: DividendQuery = {},
) {
  return useQuery<PaginatedResponse<DividendRecord>, Error, DividendRecord[]>({
    queryKey: portfolioId
      ? ['dividends', 'list', portfolioId, query]
      : ['dividends', 'disabled'],
    queryFn: () => listApi(portfolioId!, query),
    select: (res) => res?.items ?? [],
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

/** 新增分红记录 */
export function useCreateDividend(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateDividendRecordDto) =>
      createApi(portfolioId!, payload),
    onSuccess: () => {
      toast.success('分红记录已保存');
      queryClient.invalidateQueries({ queryKey: ['dividends'] });
    },
  });
}

/**
 * 编辑分红记录（增量设计 R-5 / K-6）
 *
 * ⚠️ 只失效 ['dividends'] 自身缓存，绝不连带失效 holdings / nav / xirr /
 * snapshots / overview —— 分红编辑不参与收益计算，连带失效会造成
 * 「改了分红 → 收益变了」的错觉。
 */
export function useUpdateDividend(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: UpdateDividendRecordDto;
    }) => updateApi(portfolioId!, id, payload),
    onSuccess: () => {
      toast.success('分红记录已更新');
      queryClient.invalidateQueries({ queryKey: ['dividends'] });
    },
  });
}

/** 删除分红记录 */
export function useDeleteDividend(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApi(portfolioId!, id),
    onSuccess: () => {
      toast.success('分红记录已删除');
      queryClient.invalidateQueries({ queryKey: ['dividends'] });
    },
  });
}
