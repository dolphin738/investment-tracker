/**
 * modules/dividend-yield/__tests__/use-seed-progress.test.ts — 进度轮询策略（S16 护栏）
 *
 * 守护「点击补齐历史分红后，进度面板必须能出现」这条最绕的时序：
 * 后端是 fire-and-forget，且要先 `await self._seed_rows()` 取种子集才置 `state='running'`
 * （约数秒），首轮轮询常落在该启动窗口内、命中 `idle`；若只看 state 就停轮询，面板永不出现，
 * 用户会以为「点了没反应」并再点一次（撞 409）。故触发成功后置 20s 宽限期，期间强制轮询。
 *
 * 手法与 use-schedule-poll.test.ts 一致：直接取 vue-query query 的 `refetchInterval` 回调求值
 * （不依赖真实定时器/真实轮询），用假时钟推进 Date.now 来跨过宽限期边界。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

const api = vi.hoisted(() => ({
  getSeedProgress: vi.fn(async () => ({
    state: 'idle' as string,
    processed: 0,
    total: 0,
    hits: 0,
    failed: 0,
    covered: 0,
    failedSecurities: [] as string[],
    failedTruncated: false,
    startedAt: null as string | null,
    finishedAt: null as string | null,
    error: null as string | null,
    message: null as string | null,
  })),
  seedInitialDividends: vi.fn(async () => ({ triggered: true, message: 'ok' })),
  cancelSeedInitialDividends: vi.fn(async () => ({ message: 'cancelled' })),
}));

vi.mock('@/api/dividend-yield.api', async () => {
  const actual = await vi.importActual<typeof import('@/api/dividend-yield.api')>(
    '@/api/dividend-yield.api',
  );
  return {
    ...actual,
    getSeedProgress: api.getSeedProgress,
    seedInitialDividends: api.seedInitialDividends,
    cancelSeedInitialDividends: api.cancelSeedInitialDividends,
  };
});
vi.mock('@/composables/use-toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import {
  DIVIDEND_YIELD_KEY,
  useSeedInitialDividends,
  useSeedProgress,
} from '@/modules/dividend-yield/composables/use-dividend-yield';

const PROGRESS_KEY = [...DIVIDEND_YIELD_KEY, 'seed-progress'];

function setupHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const Comp = defineComponent({
    setup() {
      useSeedProgress(true);
      const seed = useSeedInitialDividends();
      return { seed };
    },
    template: '<div />',
  });
  const wrapper = mount(Comp, {
    global: { plugins: [[VueQueryPlugin, { queryClient }]] },
  });
  return { queryClient, wrapper };
}

/** 取 seed-progress query 的 refetchInterval 回调（vue-query 类型未暴露，按运行时结构取） */
function intervalFn(queryClient: QueryClient) {
  const q = queryClient.getQueryCache().find({ queryKey: PROGRESS_KEY });
  expect(q).toBeTruthy();
  const opts = q!.options as unknown as {
    refetchInterval?: (query: unknown) => number | false | undefined;
  };
  return opts.refetchInterval!;
}

function withState(queryClient: QueryClient, state: string) {
  const q = queryClient.getQueryCache().find({ queryKey: PROGRESS_KEY })!;
  q.state.data = { state, failedSecurities: [] } as never;
  return q;
}

describe('useSeedProgress 轮询策略（S16）', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('running 态按 3s 轮询；idle 且不在宽限期内 → 停止轮询', async () => {
    const { queryClient } = setupHarness();
    await flushPromises();

    const q = withState(queryClient, 'running');
    expect(intervalFn(queryClient)(q)).toBe(3000);

    // 推到远超宽限期之后（首次触发前的基准时刻 + 1 分钟）
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const idle = withState(queryClient, 'idle');
    expect(intervalFn(queryClient)(idle)).toBe(false);
    vi.useRealTimers();
  });

  it('触发播种后的宽限期内：即便仍是 idle 也继续 3s 轮询（面板不消失）', async () => {
    const { queryClient, wrapper } = setupHarness();
    await flushPromises();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T01:00:00Z')); // 固定「现在」，避免真实时钟漂移

    const seed = (wrapper.vm as unknown as { seed: ReturnType<typeof useSeedInitialDividends> })
      .seed;
    seed.mutate();
    await flushPromises();

    // 触发 → 立即拉一次进度 + 置 20s 宽限期
    expect(api.getSeedProgress).toHaveBeenCalled();

    // 宽限期内命中 idle（后端尚在 _seed_rows 启动窗口）→ 仍须轮询
    const idle = withState(queryClient, 'idle');
    expect(intervalFn(queryClient)(idle)).toBe(3000);

    // 宽限期已过（+21s）→ 停止（避免空转）
    vi.setSystemTime(new Date(Date.now() + 21_000));
    expect(intervalFn(queryClient)(idle)).toBe(false);

    vi.useRealTimers();
    wrapper.unmount();
  });
});
