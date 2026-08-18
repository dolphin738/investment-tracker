/**
 * modules/portfolio/__tests__/use-portfolios-invalidation.test.ts
 *
 * 平移自 React web/src/hooks/__tests__/use-portfolios-invalidation.test.tsx，
 * 钉死「组合变更后缓存失效」契约：
 *
 * 1. useCreatePortfolio / useUpdatePortfolio 成功 → 失效 列表 + 摘要（不含偏好）
 * 2. useArchivePortfolio / useDeletePortfolio 成功 → 失效 列表 + 摘要 + 偏好
 *    （后端会把默认组合置空，偏好查询必须一并失效，否则「默认组合」下拉悬空）
 * 3. 归档/删除的是当前选中组合 → 立即清空 portfolio store 当前选择；
 *    非当前组合 → 选择保持不变
 *
 * 该组合式在 web 中**已完整实现**（modules/portfolio/composables/use-portfolios.ts），
 * 本测试为功能缺口复核后的契约补强，与 React 测试逐条对齐。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import {
  PORTFOLIOS_KEY,
  useArchivePortfolio,
  useCreatePortfolio,
  useDeletePortfolio,
  useUpdatePortfolio,
} from '../composables/use-portfolios';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { PREFERENCE_KEY } from '@/modules/overview/composables/use-preferences';

// ---------------------------------------------------------------------------
// mock：组合 API + toast（隔离网络与 sonner 全局提示副作用）
// ---------------------------------------------------------------------------

const apiMocks = vi.hoisted(() => ({
  listPortfolios: vi.fn(),
  createPortfolio: vi.fn(),
  updatePortfolio: vi.fn(),
  archivePortfolio: vi.fn(),
  deletePortfolio: vi.fn(),
  clearPortfolioData: vi.fn(),
  setDefaultPortfolio: vi.fn(),
}));

vi.mock('@/api/portfolio.api', () => apiMocks);

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
);
vi.mock('@/composables/use-toast', () => ({ toast: toastMock }));

// ---------------------------------------------------------------------------
// 挂载脚手架：每次新建 QueryClient + Pinia，杜绝跨用例缓存/状态污染
// ---------------------------------------------------------------------------

let queryClient: QueryClient;
let wrapper: VueWrapper | null = null;

/** 摘要 query key（实现文件私有常量，此处按契约显式声明） */
const SUMMARY_KEY = ['portfolios', 'summary'] as const;

/**
 * 从 invalidateQueries 的 spy 调用中提取全部 queryKey。
 * 形参类型是 `InvalidateQueryFilters | (() => InvalidateQueryFilters)`，
 * 无参调用时为 undefined，需安全处理。
 */
function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls
    .map((c) => {
      const f = c[0];
      if (typeof f === 'function') return undefined;
      return (f as { queryKey?: unknown } | undefined)?.queryKey;
    })
    .filter((k): k is NonNullable<typeof k> => k !== undefined);
}

/** 组件式测试的 VM 访问器（与 use-range-preference-sync.test.ts 同款） */
function vmOf<H>(w: VueWrapper): H {
  return w.vm as unknown as H;
}

async function settle(): Promise<void> {
  await flushPromises();
  await flushPromises();
}

function freshQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** 归档 mutation 挂载 harness */
function mountArchiveHarness() {
  const Harness = defineComponent({
    setup() {
      const { mutate } = useArchivePortfolio();
      return { mutate };
    },
    template: '<div />',
  });
  queryClient = freshQueryClient();
  wrapper = mount(Harness, {
    attachTo: document.body,
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], createPinia()],
    },
  });
  return wrapper;
}

/** 删除 mutation 挂载 harness */
function mountDeleteHarness() {
  const Harness = defineComponent({
    setup() {
      const { mutate } = useDeletePortfolio();
      return { mutate };
    },
    template: '<div />',
  });
  queryClient = freshQueryClient();
  wrapper = mount(Harness, {
    attachTo: document.body,
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], createPinia()],
    },
  });
  return wrapper;
}

/** 创建 / 更新 mutation 挂载 harness */
function mountWriteHarness(kind: 'create' | 'update') {
  const Harness = defineComponent({
    setup() {
      const create = useCreatePortfolio();
      const update = useUpdatePortfolio();
      return { create, update };
    },
    template: '<div />',
  });
  queryClient = freshQueryClient();
  wrapper = mount(Harness, {
    attachTo: document.body,
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], createPinia()],
    },
  });
  return { vm: vmOf<{ create: { mutate: (p: unknown) => void }; update: { mutate: (p: unknown) => void } }>(wrapper!), kind };
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
  apiMocks.archivePortfolio.mockResolvedValue({ ok: true });
  apiMocks.deletePortfolio.mockResolvedValue({ ok: true });
  apiMocks.createPortfolio.mockResolvedValue({ id: 'p-new' });
  apiMocks.updatePortfolio.mockResolvedValue({ ok: true });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('useArchivePortfolio — 缓存失效契约', () => {
  it('归档成功 → 失效 列表 + 摘要 + 偏好 三组 key，并提示成功', async () => {
    mountArchiveHarness();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    vmOf<{ mutate: (p: { id: string; archived: boolean }) => void }>(wrapper!).mutate({
      id: 'p1',
      archived: true,
    });
    await settle();

    expect(apiMocks.archivePortfolio).toHaveBeenCalledWith('p1', true);
    const calls = invalidatedKeys(spy);
    expect(calls).toContainEqual(PORTFOLIOS_KEY);
    expect(calls).toContainEqual(SUMMARY_KEY);
    expect(calls).toContainEqual(PREFERENCE_KEY);
    expect(toastMock.success).toHaveBeenCalledWith('组合已归档');
  });

  it('取消归档成功 → 同样失效三组 key，提示「组合已取消归档」', async () => {
    mountArchiveHarness();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    vmOf<{ mutate: (p: { id: string; archived: boolean }) => void }>(wrapper!).mutate({
      id: 'p1',
      archived: false,
    });
    await settle();

    const calls = invalidatedKeys(spy);
    expect(calls).toContainEqual(PORTFOLIOS_KEY);
    expect(calls).toContainEqual(SUMMARY_KEY);
    expect(calls).toContainEqual(PREFERENCE_KEY);
    expect(toastMock.success).toHaveBeenCalledWith('组合已取消归档');
  });

  it('归档的是当前选中组合 → 立即清空 store 当前选择', async () => {
    mountArchiveHarness();
    const store = usePortfolioStore();
    store.setCurrentPortfolio('p1');

    vmOf<{ mutate: (p: { id: string; archived: boolean }) => void }>(wrapper!).mutate({
      id: 'p1',
      archived: true,
    });
    await settle();

    expect(store.currentPortfolioId).toBeNull();
  });

  it('归档非当前组合 → 当前选择保持不变', async () => {
    mountArchiveHarness();
    const store = usePortfolioStore();
    store.setCurrentPortfolio('p-current');

    vmOf<{ mutate: (p: { id: string; archived: boolean }) => void }>(wrapper!).mutate({
      id: 'p-other',
      archived: true,
    });
    await settle();

    expect(store.currentPortfolioId).toBe('p-current');
  });
});

describe('useDeletePortfolio — 缓存失效契约', () => {
  it('删除成功 → 失效 列表 + 摘要 + 偏好 三组 key，并提示成功', async () => {
    mountDeleteHarness();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    vmOf<{ mutate: (id: string) => void }>(wrapper!).mutate('p1');
    await settle();

    expect(apiMocks.deletePortfolio).toHaveBeenCalledWith('p1');
    const calls = invalidatedKeys(spy);
    expect(calls).toContainEqual(PORTFOLIOS_KEY);
    expect(calls).toContainEqual(SUMMARY_KEY);
    expect(calls).toContainEqual(PREFERENCE_KEY);
    expect(toastMock.success).toHaveBeenCalledWith('组合已删除');
  });

  it('删除的是当前选中组合 → 立即清空 store 当前选择', async () => {
    mountDeleteHarness();
    const store = usePortfolioStore();
    store.setCurrentPortfolio('p1');

    vmOf<{ mutate: (id: string) => void }>(wrapper!).mutate('p1');
    await settle();

    expect(store.currentPortfolioId).toBeNull();
  });

  it('删除非当前组合 → 当前选择保持不变', async () => {
    mountDeleteHarness();
    const store = usePortfolioStore();
    store.setCurrentPortfolio('p-current');

    vmOf<{ mutate: (id: string) => void }>(wrapper!).mutate('p-other');
    await settle();

    expect(store.currentPortfolioId).toBe('p-current');
  });
});

describe('useCreatePortfolio / useUpdatePortfolio — 写入失效契约', () => {
  it('创建成功 → 失效 列表 + 摘要（不含偏好）', async () => {
    const { vm } = mountWriteHarness('create');
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    vm.create.mutate({ name: '新组合' });
    await settle();

    const calls = invalidatedKeys(spy);
    expect(calls).toContainEqual(PORTFOLIOS_KEY);
    expect(calls).toContainEqual(SUMMARY_KEY);
    expect(calls).not.toContainEqual(PREFERENCE_KEY);
    expect(toastMock.success).toHaveBeenCalledWith('组合已创建');
  });

  it('更新成功 → 失效 列表 + 摘要（不含偏好）', async () => {
    const { vm } = mountWriteHarness('update');
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    vm.update.mutate({ id: 'p1', payload: { name: '改名' } });
    await settle();

    const calls = invalidatedKeys(spy);
    expect(calls).toContainEqual(PORTFOLIOS_KEY);
    expect(calls).toContainEqual(SUMMARY_KEY);
    expect(calls).not.toContainEqual(PREFERENCE_KEY);
    expect(toastMock.success).toHaveBeenCalledWith('组合已更新');
  });
});
