/**
 * hooks/use-snapshots.ts — 快照 CRUD TanStack Query hooks
 *
 * - useSnapshots：列表 query（分页 + 日期范围）
 * - useUpsertSnapshot：mutation（upsert 语义，每日唯一）
 * - useUpdateSnapshot：mutation（更新手工记录，source=MANUAL）
 * - useResetSnapshot：mutation（重置指定日期为 DERIVED）
 * - useDeleteSnapshot：mutation
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  deleteSnapshot as deleteApi,
  listSnapshots as listApi,
  resetToDerived as resetApi,
  updateSnapshot as updateApi,
  upsertSnapshot as upsertApi,
} from '@/api/snapshot.api';
import type { SnapshotQuery, UpsertSnapshotRequest } from '@/api/types';

/** 快照列表 query key 工厂 */
export function snapshotsKey(portfolioId: string, query: SnapshotQuery) {
  return ['snapshots', portfolioId, query] as const;
}

/** 快照列表 */
export function useSnapshots(portfolioId: string | null, query: SnapshotQuery = {}) {
  return useQuery({
    queryKey: portfolioId ? snapshotsKey(portfolioId, query) : ['snapshots', 'disabled'],
    queryFn: () => listApi(portfolioId!, query),
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

/** 录入/覆盖快照（upsert 语义） */
export function useUpsertSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      payload,
    }: {
      portfolioId: string;
      payload: UpsertSnapshotRequest;
    }) => upsertApi(portfolioId, payload),
    onSuccess: () => {
      toast.success('快照已保存');
      queryClient.invalidateQueries({ queryKey: ['snapshots'] });
      queryClient.invalidateQueries({ queryKey: ['xirr'] });
      queryClient.invalidateQueries({ queryKey: ['nav'] });
    },
  });
}

/** 删除快照 */
export function useDeleteSnapshot() {
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
      toast.success('快照已删除');
      queryClient.invalidateQueries({ queryKey: ['snapshots'] });
      queryClient.invalidateQueries({ queryKey: ['xirr'] });
      queryClient.invalidateQueries({ queryKey: ['nav'] });
    },
  });
}

/** 更新手工快照记录（source=MANUAL，PATCH） */
export function useUpdateSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      id,
      payload,
    }: {
      portfolioId: string;
      id: string;
      payload: UpsertSnapshotRequest;
    }) => updateApi(portfolioId, id, payload),
    onSuccess: () => {
      toast.success('快照已更新');
      queryClient.invalidateQueries({ queryKey: ['snapshots'] });
      queryClient.invalidateQueries({ queryKey: ['xirr'] });
      queryClient.invalidateQueries({ queryKey: ['nav'] });
    },
  });
}

/** 重置指定日期快照为 DERIVED（仅手工记录） */
export function useResetSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      date,
    }: {
      portfolioId: string;
      date: string;
    }) => resetApi(portfolioId, date),
    onSuccess: () => {
      toast.success('已恢复系统自动计算值');
      queryClient.invalidateQueries({ queryKey: ['snapshots'] });
      queryClient.invalidateQueries({ queryKey: ['xirr'] });
      queryClient.invalidateQueries({ queryKey: ['nav'] });
    },
  });
}
