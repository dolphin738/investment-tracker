/**
 * hooks/use-transactions.ts — 交易 CRUD TanStack Query hooks
 *
 * - useTransactions：列表 query（分页 + 日期范围）
 * - useCreateTransaction / useUpdateTransaction / useDeleteTransaction：mutation
 * - mutation 成功后失效列表 + 相关净值/XIRR 查询缓存
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  createTransaction as createApi,
  deleteTransaction as deleteApi,
  listTransactions as listApi,
  updateTransaction as updateApi,
} from '@/api/transaction.api';
import type {
  CreateTransactionRequest,
  TransactionQuery,
  UpdateTransactionRequest,
} from '@/api/types';

/** 交易列表 query key 工厂 */
export function transactionsKey(
  portfolioId: string,
  query: TransactionQuery,
) {
  return ['transactions', portfolioId, query] as const;
}

/** 交易列表 */
export function useTransactions(portfolioId: string | null, query: TransactionQuery = {}) {
  return useQuery({
    queryKey: portfolioId ? transactionsKey(portfolioId, query) : ['transactions', 'disabled'],
    queryFn: () => listApi(portfolioId!, query),
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

/** 创建交易 */
export function useCreateTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      payload,
    }: {
      portfolioId: string;
      payload: CreateTransactionRequest;
    }) => createApi(portfolioId, payload),
    onSuccess: () => {
      toast.success('交易已录入');
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['xirr'] });
      queryClient.invalidateQueries({ queryKey: ['nav'] });
    },
  });
}

/** 更新交易 */
export function useUpdateTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      id,
      payload,
    }: {
      portfolioId: string;
      id: string;
      payload: UpdateTransactionRequest;
    }) => updateApi(portfolioId, id, payload),
    onSuccess: () => {
      toast.success('交易已更新');
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['xirr'] });
      queryClient.invalidateQueries({ queryKey: ['nav'] });
    },
  });
}

/** 删除交易 */
export function useDeleteTransaction() {
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
      toast.success('交易已删除');
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['xirr'] });
      queryClient.invalidateQueries({ queryKey: ['nav'] });
    },
  });
}
