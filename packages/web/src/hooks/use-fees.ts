/**
 * hooks/use-fees.ts — 费用记录 TanStack Query hooks（HOLD-B-P0-10 / 阶段 C + 增量 I-03）
 *
 * ⚠️ 与 use-security-trades 的关键差异：
 * 此处的费用记录**不参与 XIRR / 净值 / 持仓推导**（D-03 / C-09），因此写入后
 * **只失效 ['fees'] 自身缓存**，绝不连带失效 holdings / nav / xirr /
 * snapshots / overview。
 *
 * 注意与 `SecurityTrade.fee` 区分：后者计入持仓成本、写入会触发重算；
 * 本模块的 FeeRecord 仅作信息记录。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  createFee as createApi,
  deleteFee as deleteApi,
  listFees as listApi,
  updateFee as updateApi,
} from '@/api/fee.api';
import type {
  CreateFeeRecordDto,
  FeeGroupedRow,
  FeeQuery,
  FeeRecord,
  UpdateFeeRecordDto,
} from '@/api/types';

/** 费用列表 query key 前缀 */
export const FEES_KEY = ['fees'] as const;

/**
 * 费用记录列表（I-03/I-05：支持 securityId 多值 / scenario / 日期范围 / grouped 聚合）
 *
 * grouped=true 时返回聚合行 FeeGroupedRow[]；否则返回明细行 FeeRecord[]。
 */
export function useFees(
  portfolioId: string | null,
  query: FeeQuery = {},
) {
  return useQuery<FeeRecord[] | FeeGroupedRow[]>({
    queryKey: portfolioId
      ? ['fees', 'list', portfolioId, query]
      : ['fees', 'disabled'],
    queryFn: () => listApi(portfolioId!, query),
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

/** 新增费用记录 */
export function useCreateFee(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateFeeRecordDto) => createApi(portfolioId!, payload),
    onSuccess: () => {
      toast.success('费用记录已保存');
      queryClient.invalidateQueries({ queryKey: ['fees'] });
    },
  });
}

/** 编辑费用记录（I-03 · PATCH /fees/:id；只失效 ['fees'] 自身缓存） */
export function useUpdateFee(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: UpdateFeeRecordDto;
    }) => updateApi(portfolioId!, id, payload),
    onSuccess: () => {
      toast.success('费用记录已更新');
      queryClient.invalidateQueries({ queryKey: ['fees'] });
    },
  });
}

/** 删除费用记录 */
export function useDeleteFee(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApi(portfolioId!, id),
    onSuccess: () => {
      toast.success('费用记录已删除');
      queryClient.invalidateQueries({ queryKey: ['fees'] });
    },
  });
}
