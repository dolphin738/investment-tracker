/**
 * modules/dividend-yield/composables/use-pending-dividends.ts — 待人工划分分红 vue-query hooks
 *
 * 对应后端 /api/dividend-yield/pending-dividends/*（批次 C 七端点）：
 * - usePendingDividendsList(filters, enabled)：分页列表（固定排序 created_at DESC, id DESC，
 *   无 sort 参数；筛选 status/label/q）——读端点，admin/auditor 可见。
 * - usePendingDividendSummary(enabled)：各状态计数 + 标签候选集——读端点。
 * - useAssignPendingDividend()：单笔划分（写回主表 + 置 ASSIGNED；同格冲突返回 conflict=true）。
 * - useBatchAssignPendingDividends()：批量划分（部分失败返回 { succeeded, failed[] }）。
 * - useIgnorePendingDividend()：单笔忽略（PENDING → IGNORED；不写主表）。
 * - useBatchIgnorePendingDividends()：批量忽略（部分失败）。
 * - useReopenPendingDividend()：撤销指定（仅 ASSIGNED 可撤销；连带删除 assign 写入的主表行）。
 *
 * 约定（设计 §9.4）：
 * - queryKey：列表 ['dividend-yield','pending-list', ...filters]、概览 ['dividend-yield','pending-summary']。
 * - staleTime 30s；非授权（enabled=false）不发请求（由调用方按角色门控传入）。
 * - 五个写 mutation 的 onSuccess 均失效 pending-list 与 pending-summary（列表与按钮计数同步刷新）。
 * - toast 一律交由调用组件（按 conflict / 部分失败等情形区分文案），本 hook 不弹 toast。
 */

import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  assignPendingDividend,
  batchAssignPendingDividends,
  batchIgnorePendingDividends,
  getPendingDividendSummary,
  ignorePendingDividend,
  listPendingDividends,
  reopenPendingDividend,
  type PendingAssignItemPayload,
  type PendingAssignPayload,
  type PendingDividendFilters,
} from '@/api/dividend-yield.api';

/** 待划分列表 queryKey 前缀（与筛选维度拼装） */
export const PENDING_LIST_KEY = ['dividend-yield', 'pending-list'] as const;
/** 待划分概览 queryKey（唯一，无参数） */
export const PENDING_SUMMARY_KEY = ['dividend-yield', 'pending-summary'] as const;

/** 列表 staleTime（与概览一致，30s） */
const PENDING_STALE_MS = 30_000;

/** 待划分分页列表（筛选/翻页变化时重建 queryKey 触发重新请求） */
export function usePendingDividendsList(
  filters: MaybeRefOrGetter<PendingDividendFilters>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  const queryKey = computed(() => {
    const f = toValue(filters);
    return [
      ...PENDING_LIST_KEY,
      f.status ?? null,
      f.label ?? null,
      f.q ?? null,
      f.page ?? 1,
      f.pageSize ?? 20,
    ];
  });
  return useQuery({
    queryKey,
    queryFn: () => listPendingDividends(toValue(filters)),
    enabled: computed(() => Boolean(toValue(enabled))),
    // 翻页/筛选时保留上一页数据，避免闪烁（vue-query v5 placeholderData）
    placeholderData: (prev) => prev,
    staleTime: PENDING_STALE_MS,
    refetchOnWindowFocus: false,
  });
}

/** 待划分概览（按钮计数 + 标签候选集） */
export function usePendingDividendSummary(
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  return useQuery({
    queryKey: [...PENDING_SUMMARY_KEY],
    queryFn: () => getPendingDividendSummary(),
    enabled: computed(() => Boolean(toValue(enabled))),
    staleTime: PENDING_STALE_MS,
    refetchOnWindowFocus: false,
  });
}

/** 写操作成功后统一失效列表与概览（两者共同构成同一份「待划分」视图） */
function useInvalidatePending() {
  const queryClient = useQueryClient();
  return (): void => {
    queryClient.invalidateQueries({ queryKey: [...PENDING_LIST_KEY] });
    queryClient.invalidateQueries({ queryKey: [...PENDING_SUMMARY_KEY] });
  };
}

/** 划分单笔。入参 { id, payload }（id 与表单值分离，便于逐行调用） */
export function useAssignPendingDividend() {
  const invalidate = useInvalidatePending();
  return useMutation({
    mutationFn: (input: { id: string; payload: PendingAssignPayload }) =>
      assignPendingDividend(input.id, input.payload),
    onSuccess: invalidate,
  });
}

/** 批量划分（逐项独立提交；部分失败由响应 { succeeded, failed[] } 表达） */
export function useBatchAssignPendingDividends() {
  const invalidate = useInvalidatePending();
  return useMutation({
    mutationFn: (items: PendingAssignItemPayload[]) =>
      batchAssignPendingDividends(items),
    onSuccess: invalidate,
  });
}

/** 忽略单笔（不可撤销：派息永久丢弃、不写主表） */
export function useIgnorePendingDividend() {
  const invalidate = useInvalidatePending();
  return useMutation({
    mutationFn: (id: string) => ignorePendingDividend(id),
    onSuccess: invalidate,
  });
}

/** 批量忽略（逐项独立提交；部分失败由响应表达） */
export function useBatchIgnorePendingDividends() {
  const invalidate = useInvalidatePending();
  return useMutation({
    mutationFn: (ids: string[]) => batchIgnorePendingDividends(ids),
    onSuccess: invalidate,
  });
}

/** 撤销指定（仅 ASSIGNED 可撤销；连带删除 assign 写入的主表同键行） */
export function useReopenPendingDividend() {
  const invalidate = useInvalidatePending();
  return useMutation({
    mutationFn: (id: string) => reopenPendingDividend(id),
    onSuccess: invalidate,
  });
}
