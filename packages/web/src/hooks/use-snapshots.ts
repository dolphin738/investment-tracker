/**
 * hooks/use-snapshots.ts — 快照 CRUD TanStack Query hooks
 *
 * - useSnapshots：列表 query（分页 + 日期范围）
 * - useUpsertSnapshot：mutation（upsert 语义，每日唯一）
 * - useDeleteSnapshot：mutation
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  deleteSnapshot as deleteApi,
  listSnapshots as listApi,
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
