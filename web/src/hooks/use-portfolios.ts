/**
 * hooks/use-portfolios.ts — 组合 CRUD TanStack Query hooks
 *
 * - usePortfolios：列表 query
 * - useCreatePortfolio / useUpdatePortfolio / useArchivePortfolio / useDeletePortfolio：mutation
 * - 自动同步 portfolio store
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
// 归档 / 删除组合时后端会把偏好里的 defaultPortfolioId 置空，需要一并失效偏好查询。
// use-preferences 只依赖 preference.api / preference.store，不反向引用本模块，无循环依赖。
import { PREFERENCE_KEY } from '@/hooks/use-preferences';
import type {
  CreatePortfolioRequest,
  UpdatePortfolioRequest,
} from '@/api/types';

/** 组合列表 query key */
export const PORTFOLIOS_KEY = ['portfolios'] as const;

/**
 * 组合业绩摘要 query key（GET /portfolios/summary）
 *
 * 账户页「我的组合」统一表格的业绩列（最新总资产 / 净值 / 当年%）与概览页
 * 「组合表现对比」都读这个 key。它与 PORTFOLIOS_KEY 是**两个独立的 query**，
 * 组合被删除 / 归档后若不失效它，表格里会残留一行已不存在的组合。
 *
 * ⚠️ 这里是有意「显式点名」而非依赖前缀匹配：TanStack Query 默认按前缀匹配，
 * 失效 ['portfolios'] 目前确实会连带命中 ['portfolios','summary']，但那是一条
 * **隐式**依赖 —— 一旦有人把 PORTFOLIOS_KEY 改成 ['portfolios','list'] 之类，
 * 覆盖关系会静默断裂且不产生任何编译错误。显式声明把它固化成契约。
 * （重复失效不会产生重复网络请求：进行中的 refetch 会被去重复用。）
 */
const PORTFOLIOS_SUMMARY_KEY = ['portfolios', 'summary'] as const;

/** 组合列表 */
export function usePortfolios() {
  const setPortfolios = usePortfolioStore((s) => s.setPortfolios);
  const query = useQuery({
    queryKey: PORTFOLIOS_KEY,
    queryFn: async () => {
      const list = await listApi();
      setPortfolios(list);
      return list;
    },
    staleTime: 60 * 1000,
  });
  return query;
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
      if (archived && usePortfolioStore.getState().currentPortfolioId === id) {
        usePortfolioStore.getState().clearCurrent();
      }
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
      // 账户页「我的组合」的归档标记来自组合列表、业绩列来自 summary，两者都要刷新
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_SUMMARY_KEY });
      // 后端 archive() 会 clearDefaultPortfolioIfMatch 把默认组合置空；
      // 不失效偏好查询的话，设置页「默认组合」下拉仍指向已归档组合，
      // 而候选列表已把归档组合过滤掉 → 选中值悬空，必须刷新才恢复「不设置」。
      queryClient.invalidateQueries({ queryKey: PREFERENCE_KEY });
    },
  });
}

/** 删除组合（级联删除子数据） */
export function useDeletePortfolio() {
  const queryClient = useQueryClient();
  const clearCurrent = usePortfolioStore((s) => s.clearCurrent);
  return useMutation({
    mutationFn: (id: string) => deleteApi(id),
    onSuccess: (_data, deletedId) => {
      toast.success('组合已删除');
      const { currentPortfolioId } = usePortfolioStore.getState();
      if (currentPortfolioId === deletedId) {
        clearCurrent();
      }
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
      // 不失效 summary 的话，账户页「我的组合」表格里被删掉的那一行会继续挂着
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
 * 调用方：账户页「我的组合」操作列的星标按钮（组合管理平面收敛后的唯一入口）。
 * 调后端 PATCH /portfolios/:id/default：已是默认则取消（defaultPortfolioId 置 null），
 * 否则设为默认。成功后续：
 * - 失效偏好查询，让设置页偏好区「默认组合」下拉重新与后端对齐（两页读同一份偏好）；
 * - 若切换为新的默认组合，且不同于当前视图组合，则把当前视图切过去（与保存偏好口径一致）；
 * - 取消默认时不强制切走当前视图（保持用户当前所在组合）。
 */
export function useSetDefaultPortfolio() {
  const queryClient = useQueryClient();
  const setCurrentPortfolio = usePortfolioStore((s) => s.setCurrentPortfolio);
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  return useMutation({
    mutationFn: (id: string) => setDefaultApi(id),
    onSuccess: (pref, id) => {
      const nextDefault = pref.defaultPortfolioId;
      if (nextDefault && nextDefault !== currentPortfolioId) {
        setCurrentPortfolio(nextDefault);
      }
      queryClient.invalidateQueries({ queryKey: PREFERENCE_KEY });
      if (nextDefault) {
        toast.success('已设为默认组合');
      } else if (id === currentPortfolioId || currentPortfolioId === null) {
        toast.success('已取消默认组合');
      } else {
        toast.success('已取消默认组合');
      }
    },
    onError: () => {
      toast.error('默认组合切换失败，请重试');
    },
  });
}
