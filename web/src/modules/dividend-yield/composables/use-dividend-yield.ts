/**
 * modules/dividend-yield/composables/use-dividend-yield.ts — 股息率排名 vue-query hooks
 *
 * 阶段5 股息率排名的数据层，供榜单页 / 设置页「股息率」TAB 复用：
 * - useTop20(): Top20 看板（后端封顶 + 剔除 suspicious）
 * - useRank(page,pageSize,sort,enabled): 榜单分页（按股息率 / 连续分红年数排序）
 * - useImpliedPrice(masterId,targetRatio,enabled): 目标收益率反推隐含价格
 * - useDividendYieldSettings(enabled): 全局配置读取（端点要求 admin|auditor；其它角色传
 *   enabled=false，免发必然 403 的请求）
 * - useUpdateDividendYieldSettings(): 更新设置（admin-only）
 * - useSeedInitialDividends(): 触发历史分红补齐 / 播种（admin-only，fire-and-forget）
 * - useDividendYieldInterfaces(enabled): 设置页双源下拉候选接口（复用 listAllInterfaces）
 *
 * 参考 use-preferences.ts / use-query-data.ts 的 queryKey + enabled 语义约定。
 */

import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import {
  getSecurityDividends,
  getDividendYieldImpliedPrice,
  getDividendYieldRank,
  getDividendYieldSecurities,
  getDividendYieldSettings,
  getDividendYieldTop20,
  getSeedProgress,
  rebuildDividendYield,
  seedInitialDividends,
  cancelSeedInitialDividends,
  updateDividendYieldSettings,
  type DividendYieldRankFilters,
  // 设置请求体契约（单一真相源 = OpenAPI 生成物，见 api 模块注释）
  type SettingsUpdateBody,
} from '@/api/dividend-yield.api';
import { listAllInterfaces } from '@/api/quote-interface.api';
import type { DividendYieldSort } from '@/api/types';

/** 股息率领域 queryKey 前缀 */
export const DIVIDEND_YIELD_KEY = ['dividend-yield'] as const;

/**
 * 进度轮询宽限期（ms）：点击「补齐历史分红」后，后端后台任务要先 `await self._seed_rows()`
 * 取种子集（dividend_seed.py:114），才在第 131 行置 `state='running'`。首轮轮询（触发成功后的
 * invalidate 引发）常落在该启动窗口内、命中 `idle`，若 `refetchInterval` 仅看 running 会立刻
 * 停轮询、进度面板永不出现（须重进页面触发新轮询才显示）。故触发后置一个宽限期，期间强制轮询，
 * 覆盖启动延迟；宽限内任一 tick 捕获 running/done/error 即转入正常轮询/停止。
 */
export const SEED_PROGRESS_GRACE_MS = 20_000;

/** 宽限期截止时间戳（模块级：跨 useSeedProgress 实例共享，触发 mutation 与轮询 query 通信） */
let seedProgressGraceUntil = 0;

/** Top20 股息率看板（§8.3 双榜：top + consecutive，后端封顶 20、剔除 suspicious/僵尸行） */
export function useTop20() {
  return useQuery({
    queryKey: [...DIVIDEND_YIELD_KEY, 'top20'],
    queryFn: () => getDividendYieldTop20(),
    staleTime: 60 * 1000,
  });
}

/** 所有有分红的证券（股息价格推算选择框候选，无分页上限，§10.2） */
export function useDividendYieldSecurities() {
  return useQuery({
    queryKey: [...DIVIDEND_YIELD_KEY, 'securities'],
    queryFn: () => getDividendYieldSecurities(),
    staleTime: 5 * 60 * 1000,
  });
}

/** 股息率榜单分页（按 sort 排序 + §8.1 过滤参数） */
export function useRank(
  page: MaybeRefOrGetter<number>,
  pageSize: MaybeRefOrGetter<number>,
  sort: MaybeRefOrGetter<DividendYieldSort>,
  enabled: MaybeRefOrGetter<boolean> = true,
  filters: MaybeRefOrGetter<DividendYieldRankFilters> = {},
) {
  return useQuery({
    queryKey: computed(() => {
      const f = toValue(filters);
      return [
        ...DIVIDEND_YIELD_KEY,
        'rank',
        toValue(page),
        toValue(pageSize),
        toValue(sort),
        f.exchange ?? null,
        f.mode ?? null,
        f.min_consecutive ?? null,
        f.include_proposed ?? true,
        f.include_no_dividend ?? false,
        f.q ?? null,
      ];
    }),
    queryFn: () =>
      getDividendYieldRank(toValue(page), toValue(pageSize), toValue(sort), toValue(filters)),
    enabled: computed(() => Boolean(toValue(enabled))),
    staleTime: 60 * 1000,
  });
}

/** 单证券分红明细（按报告期；后端已过滤掉无分红的期次） */
export function useSecurityDividends(
  masterId: MaybeRefOrGetter<string | null>,
) {
  return useQuery({
    queryKey: computed(() => {
      const id = toValue(masterId);
      return [
        ...DIVIDEND_YIELD_KEY,
        'dividends',
        id ?? 'disabled',
      ];
    }),
    queryFn: () => getSecurityDividends(toValue(masterId)!),
    enabled: computed(() => Boolean(toValue(masterId))),
    staleTime: 5 * 60 * 1000,
  });
}

/** 按目标收益率反推隐含价格（targetRatio 为小数比率，null 时不发起） */
export function useImpliedPrice(
  masterId: MaybeRefOrGetter<string | null>,
  targetRatio: MaybeRefOrGetter<number | null>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  return useQuery({
    queryKey: computed(() => {
      const id = toValue(masterId);
      const ratio = toValue(targetRatio);
      return id !== null && ratio !== null
        ? [...DIVIDEND_YIELD_KEY, 'implied-price', id, ratio]
        : [...DIVIDEND_YIELD_KEY, 'implied-price', 'disabled'];
    }),
    queryFn: () =>
      getDividendYieldImpliedPrice(toValue(masterId)!, toValue(targetRatio)!),
    enabled: computed(
      () =>
        Boolean(toValue(masterId)) &&
        toValue(targetRatio) !== null &&
        Boolean(toValue(enabled)),
    ),
    staleTime: 60 * 1000,
  });
}

/** 股息率全局配置读取（要求 admin|auditor；其它角色传 enabled=false 免发 403） */
export function useDividendYieldSettings(
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  return useQuery({
    queryKey: [...DIVIDEND_YIELD_KEY, 'settings'],
    queryFn: () => getDividendYieldSettings(),
    enabled: computed(() => Boolean(toValue(enabled))),
    staleTime: 5 * 60 * 1000,
  });
}

/** 更新股息率设置（admin-only）；成功后失效设置与榜单查询 */
export function useUpdateDividendYieldSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: SettingsUpdateBody) =>
      updateDividendYieldSettings(payload),
    onSuccess: () => {
      toast.success('股息率设置已保存');
      queryClient.invalidateQueries({ queryKey: [DIVIDEND_YIELD_KEY[0], 'settings'] });
      queryClient.invalidateQueries({ queryKey: [DIVIDEND_YIELD_KEY[0], 'top20'] });
      queryClient.invalidateQueries({ queryKey: [DIVIDEND_YIELD_KEY[0], 'rank'] });
    },
  });
}

/**
 * 设置页数据源下拉候选接口（admin-only）。
 *
 * 复用已有 listAllInterfaces()（GET /admin/quote-providers/interfaces），
 * 前端按 category_id 过滤后再分别供给：
 * - 股息明细源接口候选 = category_id === '3' && enabled
 * - 行情源候选     = category_id === '2' && enabled
 */
export function useDividendYieldInterfaces(
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  return useQuery({
    queryKey: ['admin', 'quote-providers', 'interfaces'],
    queryFn: () => listAllInterfaces(),
    enabled: computed(() => Boolean(toValue(enabled))),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * 手动全量重建股息率派生快照（admin-only；替代原系统定时任务 DIVIDEND_YIELD_REBUILD）。
 * 成功后失效榜单与 Top20 查询，使排名页立即反映重建结果。
 */
export function useRebuildDividendYield() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => rebuildDividendYield(),
    onSuccess: (data) => {
      toast.success(data.summary || '股息率全量重建已完成');
      queryClient.invalidateQueries({ queryKey: [DIVIDEND_YIELD_KEY[0], 'rank'] });
      queryClient.invalidateQueries({ queryKey: [DIVIDEND_YIELD_KEY[0], 'top20'] });
    },
    onError: () => toast.error('全量重建失败，请稍后重试'),
  });
}

/**
 * 手动触发历史分红补齐 / 播种（admin-only；取代原「特别分红回补」入口）。
 *
 * 后端为 fire-and-forget：端点立即返回、播种（serviceable STOCK 约 5923 只 × ≈6s）在后台
 * 跑约 10 小时，进度经本页进度面板（``useSeedProgress``）轮询，故此处**不失效**榜单查询——
 * 此刻 invalidate 只会刷出旧数据（任务尚未完成、前端无从感知），
 * 用户可在跑完后手动刷新。该取舍与原回补 composable 保持一致。
 */
export function useSeedInitialDividends() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => seedInitialDividends(),
    onSuccess: (data) => {
      toast.success(data.message || '已触发历史分红补齐，后台执行中');
      // 触发成功后立即拉一次进度，并置轮询宽限期（覆盖后端 _seed_rows 启动延迟，
      // 避免首轮轮询命中 idle 后停轮询、进度面板不显示，须重进页面才出现）
      seedProgressGraceUntil = Date.now() + SEED_PROGRESS_GRACE_MS;
      queryClient.invalidateQueries({
        queryKey: [...DIVIDEND_YIELD_KEY, 'seed-progress'],
      });
    },
    onError: () => toast.error('历史分红补齐触发失败，请稍后重试'),
  });
}

/**
 * 查询历史分红补齐 / 播种的实时进度（admin-only）。
 *
 * 仅在 running 态以 3s 间隔轮询；done/error/idle 不轮询（避免空转）。
 * 仅 admin 启用（GET 端点本身也 require_admin，非 admin 调用会 403）。
 */
export function useSeedProgress(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: [...DIVIDEND_YIELD_KEY, 'seed-progress'],
    queryFn: () => getSeedProgress(),
    enabled: toValue(enabled),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.state === 'running' || Date.now() < seedProgressGraceUntil
        ? 3000
        : false,
  });
}

/**
 * 取消正在运行的历史分红补齐 / 播种（admin-only）。
 *
 * 后端经 ``task.cancel()`` 在下一个中断点停止，已完成部分保留、可再次触发续跑
 * （断点续跑语义）。无运行任务时后端返回 409，此处统一提示失败。
 */
export function useCancelSeed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => cancelSeedInitialDividends(),
    onSuccess: (data) => {
      toast.success(data.message || '已发送取消信号，任务将在下一个中断点停止');
      queryClient.invalidateQueries({ queryKey: [...DIVIDEND_YIELD_KEY, 'seed-progress'] });
    },
    onError: () => toast.error('取消失败：当前可能无运行中的补齐任务'),
  });
}