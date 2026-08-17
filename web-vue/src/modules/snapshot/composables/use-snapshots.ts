/**
 * modules/snapshot/composables/use-snapshots.ts — 快照 CRUD vue-query hooks
 *
 * 平移自 React 版 web/src/hooks/use-snapshots.ts，行为契约一致：
 * - useSnapshots：列表 query（分页 + 日期范围 + 来源筛选）
 * - useUpsertSnapshot：mutation（upsert 语义，每日唯一）
 * - useUpdateSnapshot：mutation（更新手工记录，source=MANUAL）
 * - useResetSnapshot：mutation（重置指定日期为 DERIVED）
 * - useDeleteSnapshot：mutation
 * - useNavTotalAssetMap：指定日期系统自动计算值（表单覆盖提示用，平移自
 *   React 版 hooks/use-query-data.ts；依赖 listSnapshots，归属快照域）
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
  deleteSnapshot as deleteApi,
  listSnapshots as listApi,
  resetToDerived as resetApi,
  updateSnapshot as updateApi,
  upsertSnapshot as upsertApi,
} from '@/api/snapshot.api';
import type {
  PaginatedResponse,
  SnapshotQuery,
  SnapshotResponse,
  UpsertSnapshotRequest,
} from '@/api/types';
import { toNumberOrNull } from '@/lib/types';
import { formatCurrency } from '@/lib/utils';

/** 快照列表 query key 工厂 */
export function snapshotsKey(portfolioId: string, query: SnapshotQuery) {
  return ['snapshots', portfolioId, query] as const;
}

/**
 * 保存成功 toast（PRD SNAP-P0-06 验收 3）：
 * 「已记录 {date} 总资产 ¥{x}（手工，已取代自动值）」
 * PRD 后半句「＋ 已重算自该日起 N 天的净值与 XIRR」中的 N 依赖后端 recalc 返回，
 * 后端暂不返回（Part E-8），缺失时仅展示前半句；后端补齐 recalcDays 后在此拼接。
 */
function buildSavedToast(date: string, totalAsset: string): string {
  return `已记录 ${date} 总资产 ${formatCurrency(totalAsset)}（手工，已取代自动值）`;
}

/** 保存/删除/重置共用的缓存失效集合（快照参与净值/XIRR 推导） */
function invalidateSnapshotRelated(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  queryClient.invalidateQueries({ queryKey: ['snapshots'] });
  queryClient.invalidateQueries({ queryKey: ['xirr'] });
  queryClient.invalidateQueries({ queryKey: ['nav'] });
}

/** 快照列表（透传 source/日期筛选：F2 已获批，source 走服务端筛选） */
export function useSnapshots(
  portfolioId: MaybeRefOrGetter<string | null>,
  query: MaybeRefOrGetter<SnapshotQuery> = {},
) {
  return useQuery({
    queryKey: computed(() => {
      const id = toValue(portfolioId);
      return id
        ? snapshotsKey(id, toValue(query))
        : ['snapshots', 'disabled'];
    }),
    queryFn: () =>
      listApi(toValue(portfolioId)!, toValue(query)) as Promise<
        PaginatedResponse<SnapshotResponse>
      >,
    enabled: computed(() => Boolean(toValue(portfolioId))),
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
    onSuccess: (_data, variables) => {
      toast.success(buildSavedToast(variables.payload.date, variables.payload.totalAsset));
      invalidateSnapshotRelated(queryClient);
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
      invalidateSnapshotRelated(queryClient);
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
    onSuccess: (_data, variables) => {
      // SNAP-P0-06(4)：修改后触发 [date, today] 重算并 toast 反馈，文案同新建保存
      toast.success(buildSavedToast(variables.payload.date, variables.payload.totalAsset));
      invalidateSnapshotRelated(queryClient);
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
      invalidateSnapshotRelated(queryClient);
    },
  });
}

/**
 * 指定日期的系统自动计算总资产（AL-054 / 决策 Q-1 甲）
 *
 * 供资产记录录入表单的「覆盖提示」使用：按 date 精确查单条快照
 * （`startDate=endDate=date, pageSize=1` —— 合法且 ≤ 后端 `@Max(200)`），
 * 取该行 `derivedTotalAsset`（后端实时回填：DERIVED 行 == totalAsset；
 * MANUAL 行为 computeDerived 结果；计算失败 → null）。
 *
 * 不再拉全量：旧实现 `pageSize:1000` 触发后端 400（SnapshotQueryDto
 * `@Max(200)` + 全局 ValidationPipe），且只取第 1 页会丢老数据（BUG-1/2）。
 * 快照列表页自身的派生值直接读列表行内 `derivedTotalAsset`，不经过本 hook。
 *
 * 金额为 string 透传（非计算），符合「Decimal 以 string 传输」铁律；
 * 仅在边界转为 number 供展示格式化。
 */
export function useNavTotalAssetMap(
  portfolioId: MaybeRefOrGetter<string | null>,
  date: MaybeRefOrGetter<string | null>,
) {
  return useQuery({
    queryKey: computed(() => {
      const id = toValue(portfolioId);
      const d = toValue(date);
      return id && d
        ? ['nav', 'total-asset-map', id, d]
        : ['nav', 'total-asset-map', 'disabled'];
    }),
    queryFn: async () => {
      const res = await listApi(toValue(portfolioId)!, {
        startDate: toValue(date)!,
        endDate: toValue(date)!,
        pageSize: 1,
      });
      const row = res.items[0];
      if (!row || row.derivedTotalAsset == null) return null;
      return toNumberOrNull(row.derivedTotalAsset);
    },
    enabled: computed(() =>
      Boolean(toValue(portfolioId) && toValue(date)),
    ),
    staleTime: 60 * 1000,
  });
}
