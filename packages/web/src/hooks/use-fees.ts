/**
 * hooks/use-fees.ts — 费用记录 TanStack Query hooks（HOLD-B-P0-10 / 阶段 C）
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
} from '@/api/fee.api';
import type { CreateFeeRecordDto, FeeRecord } from '@/api/types';

/** 费用列表 query key 前缀 */
export const FEES_KEY = ['fees'] as const;

/** 费用记录列表 */
export function useFees(portfolioId: string | null) {
  return useQuery<FeeRecord[]>({
    queryKey: portfolioId ? ['fees', 'list', portfolioId] : ['fees', 'disabled'],
    queryFn: () => listApi(portfolioId!),
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
