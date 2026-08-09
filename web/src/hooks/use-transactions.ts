/**
 * hooks/use-transactions.ts — 交易 CRUD TanStack Query hooks
 *
 * - useTransactions：列表 query（分页 + 日期范围 + 类型多选 + 排序 + 标的）
 * - useCreateTransaction / useUpdateTransaction / useDeleteTransaction：mutation
 * - mutation 成功后失效列表 + 相关净值/XIRR 查询缓存
 *
 * FLOW-P0-04（重算反馈 toast）：create/update/delete 成功后读取服务端
 * `response.recalculation`（F3/F4，Part E-6），字段缺失时前端兜底降级。
 * FLOW-P0-06（软提示）：create/update 保存成功后按偏好 `cashHintOnCashflow`
 * 决定是否弹「是否同步调整现金余额？[去更新]」；「去更新」只负责聚焦【B】金额
 * 输入框（派发 CustomEvent，由出入金页监听），**绝不自动修改 CashBalance**。
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
  RecalculationInfo,
  TransactionQuery,
  TransactionResponse,
  UpdateTransactionRequest,
} from '@/api/types';
import { usePreferenceStore } from '@/stores/preference.store';
import { PORTFOLIOS_KEY } from '@/hooks/use-portfolios';;

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
    queryFn: () => listApi(portfolioId!, query) as Promise<{
      items: TransactionResponse[];
      total: number;
      page: number;
      pageSize: number;
    }>,
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

// ---------------------------------------------------------------------------
// FLOW-P0-06 软提示「去更新」聚焦事件
// ---------------------------------------------------------------------------

/** 【B】现金余额输入框聚焦事件名（出入金页监听后聚焦金额输入框） */
export const CASH_BALANCE_FOCUS_EVENT = 'app:focus-cash-balance-input';

/** 派发聚焦【B】现金余额输入框事件（软提示「去更新」点击时调用；绝不自动改 CashBalance） */
export function requestCashBalanceInputFocus(): void {
  window.dispatchEvent(new CustomEvent(CASH_BALANCE_FOCUS_EVENT));
}

// ---------------------------------------------------------------------------
// toast 文案构造
// ---------------------------------------------------------------------------

/**
 * 拼接重算反馈文案（FLOW-P0-04 / Part E-3）：
 * - recalc 存在：主文案「已重算 {fromDate} 起 {N} 天的净值与 XIRR」
 * - affectedDays 缺失（后端 F3 未落盘）：降级「已重算（自 {fromDate} 起）」
 * - F4 字段存在时追加「已更新 M 条自动总资产记录」「其中 K 天为手工记录，已跳过、未被覆盖」；
 *   缺失时省略（兜底，不阻塞）
 * - fallbackDate：mutation 入参的 payload.date（create/update 一定存在）
 */
function buildRecalcSuffix(
  recalc: RecalculationInfo | undefined,
  fallbackDate?: string,
): string {
  const fromDate = recalc?.fromDate ?? fallbackDate;
  const parts: string[] = [];
  if (fromDate) {
    parts.push(
      recalc?.affectedDays !== undefined
        ? `已重算 ${fromDate} 起 ${recalc.affectedDays} 天的净值与 XIRR`
        : `已重算（自 ${fromDate} 起）`,
    );
  } else {
    parts.push('已触发净值与 XIRR 重算');
  }
  if (recalc?.updatedAutoDays !== undefined) {
    parts.push(`已更新 ${recalc.updatedAutoDays} 条自动总资产记录`);
  }
  if (recalc?.skippedManualDays !== undefined) {
    parts.push(`其中 ${recalc.skippedManualDays} 天为手工记录，已跳过、未被覆盖`);
  }
  return parts.join('；');
}

/**
 * FLOW-P0-06 软提示：读偏好 `cashHintOnCashflow`（SET-P0-07，默认 true），
 * 为 true 时 toast「是否同步调整现金余额？」+ action「去更新」（聚焦【B】输入框）；
 * 为 false 时不弹，重算 toast 不受影响（由调用方先展示）。
 */
function maybeShowCashHint(): void {
  const hintOn = usePreferenceStore.getState().getPreference('cashHintOnCashflow');
  if (!hintOn) return;
  toast.info('是否同步调整现金余额？', {
    action: {
      label: '去更新',
      onClick: () => requestCashBalanceInputFocus(),
    },
  });
}

/** 创建/更新/删除共用的缓存失效集合（出入金参与净值/XIRR 推导） */
function invalidateCashflowRelated(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: ['transactions'] });
  queryClient.invalidateQueries({ queryKey: ['xirr'] });
  queryClient.invalidateQueries({ queryKey: ['nav'] });
  queryClient.invalidateQueries({ queryKey: ['overview'] });
  // 缺陷2：出入金增删改会改变组合成立日（base_date），失效组合列表以实时刷新成立日
  queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
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
    onSuccess: (data, variables) => {
      toast.success(
        `交易已录入；${buildRecalcSuffix(data?.recalculation, variables.payload.date)}`,
      );
      // FLOW-P0-06：保存出入金后按偏好开关弹软提示（仅在 create/update，delete 无意义）
      maybeShowCashHint();
      invalidateCashflowRelated(queryClient);
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
    onSuccess: (data, variables) => {
      toast.success(
        `交易已更新；${buildRecalcSuffix(data?.recalculation, variables.payload.date)}`,
      );
      maybeShowCashHint();
      invalidateCashflowRelated(queryClient);
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
    onSuccess: (data) => {
      // F3：delete 返回 { recalculation }；缺失时仅提示已删除（无 payload.date 可兜底）
      toast.success(
        data?.recalculation
          ? `交易已删除；${buildRecalcSuffix(data.recalculation)}`
          : '交易已删除',
      );
      invalidateCashflowRelated(queryClient);
    },
  });
}
