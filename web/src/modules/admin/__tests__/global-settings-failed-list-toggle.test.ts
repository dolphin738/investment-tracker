/**
 * QA 独立验证：全局设置「股息率 → 初始化」→「补齐历史分红」进度面板的
 * **失败证券清单展开入口**（由「独立按钮」改为「统计行『失败 N』数字本身」）。
 *
 * 背景（本文件存在的理由）：
 * 既有两个用例（global-settings-dividend-tab.test.ts / global-settings-page-qa.test.ts）
 * 都把 `useSeedProgress` mock 成 idle（`data: ref(null)`），进度面板根本不渲染，
 * 因此它们全绿**不能证明**本次交互改动正确。本文件把进度数据打到 `failed > 0`，
 * 直接挂载 GlobalSettingsDividendInitBlock.vue 断言真实 DOM 行为。
 *
 * 覆盖：
 * ① failed > 0：统计行数字即 button（含 aria-expanded / aria-controls / title / 三角标记）
 * ② 反向断言：旧入口文案「查看失败证券」不再存在于 DOM（防回归）
 * ③ 初始收起：aria-expanded=false 且清单容器不在 DOM
 * ④ 点击展开：aria-expanded=true、#seed-failed-securities 出现、代码·名称与截断说明渲染
 * ⑤ 再点收起：回到 aria-expanded=false、容器移除
 * ⑥ 反向断言：failed === 0 时无该 button，数字退化为不可点的 span
 * ⑦ 边界：running_elsewhere === true 且 failed > 0 时，触发器与清单容器均不渲染
 *    （网格与清单隐藏条件须一致，否则出现「展开着却无法收起」的孤儿面板）
 *
 * Mock 策略沿用仓库既有写法：composables 层整体 mock、vue-router mock 掉
 * （组件仅用 useRouter().push）、auth.store 的 useIsAdmin 恒 true。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import type { components } from '@/types/api';

type SeedProgressOut = components['schemas']['SeedProgressOut'];
type SeedFailedSecurityOut = components['schemas']['SeedFailedSecurityOut'];

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

const FAILED_SECURITIES: SeedFailedSecurityOut[] = [
  { master_id: 'm-1', code: '600519', name: '贵州茅台' },
  { master_id: 'm-2', code: '000001', name: '平安银行' },
  { master_id: 'm-3', code: '300750', name: '' },
];

/** 进度数据工厂：默认「已完成、无失败」，用例按需 override */
function makeProgress(overrides: Partial<SeedProgressOut> = {}): SeedProgressOut {
  return {
    state: 'done',
    running_elsewhere: false,
    total: 5923,
    processed: 5923,
    hits: 1200,
    failed: 0,
    covered: 4700,
    started_at: '2025-01-01T00:00:00Z',
    finished_at: null,
    error: null,
    message: '补齐完成',
    failed_securities: [],
    failed_truncated: false,
    ...overrides,
  };
}

/** 进度面板状态（模块级共享：mock 工厂读取、用例在 mount 前改写） */
const seedProgressState = vi.hoisted(() => ({
  data: null as SeedProgressOut | null,
  isError: false,
}));

const refetchSpy = vi.hoisted(() => vi.fn());
const pushSpy = vi.hoisted(() => vi.fn());

vi.mock('@/modules/dividend-yield/composables/use-dividend-yield', () => ({
  useRebuildDividendYield: () => ({ isPending: ref(false), isError: ref(false), mutate: vi.fn() }),
  useSeedInitialDividends: () => ({ isPending: ref(false), isError: ref(false), mutate: vi.fn() }),
  // 进度轮询：data 由 seedProgressState 提供（用例可打到 failed > 0 / running_elsewhere）
  useSeedProgress: () => ({
    data: ref(seedProgressState.data),
    isError: ref(seedProgressState.isError),
    refetch: refetchSpy,
  }),
  useCancelSeed: () => ({ isPending: ref(false), isError: ref(false), mutate: vi.fn() }),
}));

// 待人工划分入口依赖的概览查询（替身须覆盖完整对外面 isLoading/data/isError/refetch）
vi.mock('@/modules/dividend-yield/composables/use-pending-dividends', async () => {
  const { ref: vueRef } = await import('vue');
  return {
    usePendingDividendSummary: () => ({
      isLoading: vueRef(false),
      data: vueRef({ pending: 0 }),
      isError: vueRef(false),
      refetch: vi.fn(),
    }),
  };
});

vi.mock('@/stores/auth.store', () => ({ useIsAdmin: () => true }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushSpy }) }));

import GlobalSettingsDividendInitBlock from '../components/GlobalSettingsDividendInitBlock.vue';

// ---------------------------------------------------------------------------
// 挂载 / 定位辅助
// ---------------------------------------------------------------------------

const TOGGLE_SELECTOR = '[aria-controls="seed-failed-securities"]';
const PANEL_ID = '#seed-failed-securities';

async function mountBlock(): Promise<VueWrapper> {
  const w = mount(GlobalSettingsDividendInitBlock);
  await flushPromises();
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  seedProgressState.isError = false;
  seedProgressState.data = makeProgress({
    failed: 3,
    failed_securities: FAILED_SECURITIES,
    failed_truncated: true,
  });
});

describe('QA · 补齐历史分红进度面板「失败证券清单」展开入口', () => {
  it('① failed > 0：统计行里的数字本身是展开按钮（带无障碍语义，不是独立入口按钮）', async () => {
    const wrapper = await mountBlock();

    const toggle = wrapper.find(TOGGLE_SELECTOR);
    expect(toggle.exists()).toBe(true);
    expect(toggle.element.tagName).toBe('BUTTON');
    expect(toggle.attributes('type')).toBe('button');
    // 数字与三角都在按钮内
    expect(toggle.text()).toContain('3');
    expect(toggle.text()).toContain('▸');
    // 三角仅作状态指示 → 对读屏隐藏
    const caret = toggle.findAll('span').find((s) => s.text() === '▸');
    expect(caret).toBeTruthy();
    expect(caret!.attributes('aria-hidden')).toBe('true');
    expect(toggle.attributes('title')).toBe('点击展开失败证券清单');

    wrapper.unmount();
  });

  it('② 反向断言：旧入口文案「查看失败证券」已从 DOM 消失（防回归）', async () => {
    const wrapper = await mountBlock();

    expect(wrapper.html()).not.toContain('查看失败证券');
    expect(
      wrapper.findAll('button').some((b) => b.text().includes('查看失败证券')),
    ).toBe(false);

    wrapper.unmount();
  });

  it('③ 初始收起：aria-expanded=false 且清单容器不在 DOM', async () => {
    const wrapper = await mountBlock();

    expect(wrapper.find(TOGGLE_SELECTOR).attributes('aria-expanded')).toBe('false');
    expect(wrapper.find(PANEL_ID).exists()).toBe(false);

    wrapper.unmount();
  });

  it('④ 点击数字 → 展开：aria-expanded=true，清单容器出现且渲染代码 · 名称与截断说明', async () => {
    const wrapper = await mountBlock();

    await wrapper.find(TOGGLE_SELECTOR).trigger('click');
    await flushPromises();

    const toggle = wrapper.find(TOGGLE_SELECTOR);
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(toggle.attributes('title')).toBe('点击收起失败证券清单');
    expect(toggle.text()).toContain('▾');

    const panel = wrapper.find(PANEL_ID);
    expect(panel.exists()).toBe(true);
    // failed_truncated=true → 截断说明
    expect(panel.text()).toContain('仅显示前 3 只');
    expect(panel.text()).toContain('失败共 3 只');
    // 证券代码 · 名称（空名回退「（无名）」）
    const items = panel.findAll('li').map((li) => li.text());
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('600519');
    expect(items[0]).toContain('贵州茅台');
    expect(items[1]).toContain('000001');
    expect(items[2]).toContain('300750');
    expect(items[2]).toContain('（无名）');

    wrapper.unmount();
  });

  it('⑤ 再点一次 → 收起：aria-expanded 回到 false，清单容器移除', async () => {
    const wrapper = await mountBlock();

    await wrapper.find(TOGGLE_SELECTOR).trigger('click');
    await flushPromises();
    expect(wrapper.find(PANEL_ID).exists()).toBe(true);

    await wrapper.find(TOGGLE_SELECTOR).trigger('click');
    await flushPromises();
    expect(wrapper.find(TOGGLE_SELECTOR).attributes('aria-expanded')).toBe('false');
    expect(wrapper.find(PANEL_ID).exists()).toBe(false);

    wrapper.unmount();
  });

  it('⑥ 反向断言：failed === 0 时不存在该按钮，数字退化为不可点的 span', async () => {
    seedProgressState.data = makeProgress({ failed: 0, failed_securities: [] });
    const wrapper = await mountBlock();

    expect(wrapper.find(TOGGLE_SELECTOR).exists()).toBe(false);
    expect(wrapper.find(PANEL_ID).exists()).toBe(false);
    const zero = wrapper.findAll('span.text-destructive').filter((s) => s.text() === '0');
    expect(zero.length).toBeGreaterThan(0);
    // 退化形态必须是 span，不是 button
    expect(zero[0].element.tagName).toBe('SPAN');

    wrapper.unmount();
  });

  it('⑦ 边界：running_elsewhere=true 且 failed>0 时，触发器与清单容器均不渲染（无孤儿面板）', async () => {
    seedProgressState.data = makeProgress({
      state: 'running',
      running_elsewhere: true,
      failed: 3,
      failed_securities: FAILED_SECURITIES,
      failed_truncated: true,
    });
    const wrapper = await mountBlock();

    // 面板本体仍在（跨进程态有独立标题），但统计网格不渲染 → 触发器消失
    expect(wrapper.text()).toContain('补齐历史分红进行中（其它进程）');
    expect(wrapper.find(TOGGLE_SELECTOR).exists()).toBe(false);
    // 清单容器隐藏条件须与网格一致，否则展开后无法收起
    expect(wrapper.find(PANEL_ID).exists()).toBe(false);

    wrapper.unmount();
  });
});
