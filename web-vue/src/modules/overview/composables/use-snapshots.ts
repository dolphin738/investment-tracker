/**
 * modules/overview/composables/use-snapshots.ts — 快照列表查询（概览页用）
 *
 * 平移自 React 版 web/src/hooks/use-snapshots.ts 的列表 query 部分。
 * 快照 upsert / update / reset / delete 等 mutation 属资产记录批次，
 * 待该批次在对应模块补齐（保持与 React 版同名 hook 对齐）。
 */

import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { listSnapshots as listApi } from '@/api/snapshot.api';
import type { SnapshotQuery } from '@/api/types';

/** 快照列表 query key 工厂 */
export function snapshotsKey(portfolioId: string, query: SnapshotQuery) {
  return ['snapshots', portfolioId, query] as const;
}

/**
 * 快照列表（透传 source/日期筛选：source 走服务端筛选，
 * 概览页「总资产走势」用它取 source=MANUAL 的手工记录标记）。
 */
export function useSnapshots(
  portfolioId: MaybeRefOrGetter<string | null>,
  query: MaybeRefOrGetter<SnapshotQuery> = {},
) {
  return useQuery({
    queryKey: computed(() => {
      const id = toValue(portfolioId);
      return id ? snapshotsKey(id, toValue(query)) : ['snapshots', 'disabled'];
    }),
    queryFn: () => listApi(toValue(portfolioId)!, toValue(query)),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 30 * 1000,
  });
}
