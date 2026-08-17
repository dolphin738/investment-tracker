/**
 * modules/portfolio/composables/use-portfolios.ts — 组合 CRUD vue-query hooks
 *
 * 平移自 React 版 web/src/hooks/use-portfolios.ts，行为契约一致：
 * - usePortfolios：列表 query（成功后同步 portfolio store）
 * - useCreatePortfolio / useUpdatePortfolio：mutation（成功后失效列表与摘要）
 * - useArchivePortfolio / useDeletePortfolio：归档 / 删除（当前选中被移除时清空选择）
 * - useClearPortfolioData / useSetDefaultPortfolio：清空数据 / 切换默认组合
 *
 * 归档 / 删除组合时后端会把偏好里的 defaultPortfolioId 置空，需要一并失效偏好查询。
 * use-preferences 只依赖 preference.api / preference.store，不反向引用本模块，无循环依赖。
 */

import { computed } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import {
  archivePortfolio as archiveApi,
  clearPortfolioData as clearDataApi,
  createPortfolio as createApi,
  deletePortfolio as deleteApi,
  listPortfolios as listApi,
  setDefaultPortfolio as setDefaultApi,
  updatePortfolio as updateApi,
} from '@/api/portfolio.api';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { PREFERENCE_KEY } from '@/modules/overview/composables/use-preferences';
import type {
  CreatePortfolioRequest,
  UpdatePortfolioRequest,
} from '@/api/types';

/** 组合列表 query key */
export const PORTFOLIOS_KEY = ['portfolios'] as const;

/**
 * 组合业绩摘要 query key（GET /portfolios/summary）
 *
 * 概览页「组合表现对比」读这个 key。它与 PORTFOLIOS_KEY 是**两个独立的 query**，
 * 组合被删除 / 归档后若不失效它，界面上会残留一行已不存在的组合。
 *
 * 这里是有意「显式点名」而非依赖前缀匹配：显式声明把覆盖关系固化成契约，
 * 避免 PORTFOLIOS_KEY 未来改名时静默断裂。（重复失效不会产生重复网络请求。）
 */
const PORTFOLIOS_SUMMARY_KEY = ['portfolios', 'summary'] as const;

/** 组合列表（成功后同步 portfolio store，供组合切换器 / baseDate 读取） */
export function usePortfolios() {
  const portfolioStore = usePortfolioStore();
  return useQuery({
    queryKey: PORTFOLIOS_KEY,
    queryFn: async () => {
      const list = await listApi();
      portfolioStore.setPortfolios(list);
      return list;
    },
    staleTime: 60 * 1000,
  });
}

/** 创建组合 */
export function useCreatePortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePortfolioRequest) => createApi(payload),
    onSuccess: () => {
      toast.success('组合已创建');
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_SUMMARY_KEY });
    },
  });
}

/** 更新组合 */
export function useUpdatePortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: UpdatePortfolioRequest;
    }) => updateApi(id, payload),
    onSuccess: () => {
      toast.success('组合已更新');
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_SUMMARY_KEY });
    },
  });
}

/** 归档/取消归档组合 */
export function useArchivePortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      archiveApi(id, archived),
    onSuccess: (_data, { id, archived }) => {
      toast.success(archived ? '组合已归档' : '组合已取消归档');
      // 归档的若是当前选中组合，立即清空选择，避免选择器指向一个在列表里看不见的归档组合（D2）
      const portfolioStore = usePortfolioStore();
      if (archived && portfolioStore.currentPortfolioId === id) {
        portfolioStore.clearCurrent();
      }
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_SUMMARY_KEY });
      // 后端 archive() 会把默认组合置空；不失效偏好查询的话，
      // 「默认组合」下拉的候选列表已过滤归档组合而选中值仍指向它，必须刷新才恢复。
      queryClient.invalidateQueries({ queryKey: PREFERENCE_KEY });
    },
  });
}

/** 删除组合（级联删除子数据） */
export function useDeletePortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApi(id),
    onSuccess: (_data, deletedId) => {
      toast.success('组合已删除');
      const portfolioStore = usePortfolioStore();
      if (portfolioStore.currentPortfolioId === deletedId) {
        portfolioStore.clearCurrent();
      }
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_SUMMARY_KEY });
      // 删除的若是默认组合，服务端同样会置空 defaultPortfolioId，存在同款「悬空」问题
      queryClient.invalidateQueries({ queryKey: PREFERENCE_KEY });
    },
  });
}

/** 清空组合全部数据（保留组合本身，SET-P0-05 危险操作区） */
export function useClearPortfolioData() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => clearDataApi(id),
    onSuccess: () => {
      toast.success('组合数据已清空');
      // 清空后概览/分析/持仓等数据全部失效，统一失效重取
      queryClient.invalidateQueries();
    },
  });
}

/**
 * 切换默认组合（toggle，项6 · SET-P0-06）
 *
 * 调后端 PATCH /portfolios/:id/default：已是默认则取消（defaultPortfolioId 置 null），
 * 否则设为默认。成功后续：
 * - 失效偏好查询，让「默认组合」下拉重新与后端对齐；
 * - 若切换为新的默认组合，且不同于当前视图组合，则把当前视图切过去（与保存偏好口径一致）；
 * - 取消默认时不强制切走当前视图（保持用户当前所在组合）。
 */
export function useSetDefaultPortfolio() {
  const queryClient = useQueryClient();
  const portfolioStore = usePortfolioStore();
  const currentPortfolioId = computed(() => portfolioStore.currentPortfolioId);
  return useMutation({
    mutationFn: (id: string) => setDefaultApi(id),
    onSuccess: (pref, id) => {
      const nextDefault = pref.defaultPortfolioId;
      if (nextDefault && nextDefault !== currentPortfolioId.value) {
        portfolioStore.setCurrentPortfolio(nextDefault);
      }
      queryClient.invalidateQueries({ queryKey: PREFERENCE_KEY });
      toast.success(nextDefault ? '已设为默认组合' : '已取消默认组合');
    },
    onError: () => {
      toast.error('默认组合切换失败，请重试');
    },
  });
}
