/**
 * hooks/use-portfolios.ts — 删除 / 归档后的缓存失效契约（账户页表格刷新一致性）
 *
 * 【为什么单独建这个文件】
 * 组合管理平面收敛到账户页「我的组合」后，该表格的业绩列读的是
 * `['portfolios','summary']`（AccountPage.tsx:194），而组合元信息读的是
 * `['portfolios']` —— **两个独立 query**。删除 / 归档组合若只失效前者不失效后者
 * （或反之），表格里会残留一行已经不存在的组合，这是本次重构最核心的回归点。
 *
 * 但既有测试全部把 `@/hooks/use-portfolios` 整个 vi.mock 掉（account-portfolio-table
 * / settings / app-layout 等都是如此），mutation 的 onSuccess **从未真正执行过**。
 * 也就是说：把 use-portfolios.ts 里的 `invalidateQueries(PORTFOLIOS_SUMMARY_KEY)`
 * 整行删掉，全量用例依旧全绿 —— 关键回归点其实处于**零覆盖**状态。
 *
 * 本文件用「捕获真实 onSuccess → 直接调用 → 断言 invalidateQueries」的确定性写法，
 * 把这条契约钉死：一旦有人删掉某个 invalidateQueries 或改动 query key 命名，这里立刻红。
 * （不触发真实网络：archiveApi/deleteApi 的 Promise 解析在单 fork 整包并发下偶发不稳，
 *   所以这里只验证 hook 内部对「成功」的定义 —— 即 onSuccess 里失效了哪些 key。）
 *
 * 覆盖：
 * 1. 删除组合 → 失效 ['portfolios','summary']（否则账户页残留已删行）
 * 2. 归档组合 → 失效 ['portfolios','summary']（否则归档标记不刷新）
 * 3. 两者都同时失效 ['portfolios'] 与偏好 key（默认组合被后端置空后需对齐）
 * 4. 归档当前选中组合时清空当前选择（避免选择器指向不可见的归档组合）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// 仅 mock 到 react-query 的 useMutation 层：捕获 hook 传给 useMutation 的
// 真实 onSuccess（里面就是我们要验证的 invalidateQueries 契约），其余走真实实现。
// 这样既不发真实网络请求，又 100% 验证源码里 onSuccess 的失效逻辑。
// ---------------------------------------------------------------------------
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const capturedArchive = { options: null as Record<string, unknown> | null };
const capturedDelete = { options: null as Record<string, unknown> | null };

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useMutation: (options: Record<string, unknown>) => {
      // 按 mutationFn 的引用区分是 archive 还是 delete（源码里两者函数体不同）
      const fn = options.mutationFn as ((...a: unknown[]) => unknown) | undefined;
      // 简单区分：archive 的 mutationFn 签名是 ({id,archived})，delete 是 (id)
      // 这里统一捕获，供用例里按被调用的 hook 取用。
      capturedArchive.options = options;
      capturedDelete.options = options;
      return actual.useMutation(options);
    },
  };
});

import { useArchivePortfolio, useDeletePortfolio, PORTFOLIOS_KEY } from '@/hooks/use-portfolios';
import { PREFERENCE_KEY } from '@/hooks/use-preferences';
import { usePortfolioStore } from '@/stores/portfolio.store';

/**
 * 账户页「我的组合」表格业绩列所用的 query key。
 * 🔴 必须与 AccountPage.tsx 里 `useQuery({ queryKey: ['portfolios','summary'] })`
 *    逐字一致 —— 这里刻意写死字面量，任何一侧漂移都会被这组用例抓到。
 */
const ACCOUNT_TABLE_SUMMARY_KEY = ['portfolios', 'summary'];

let queryClient: QueryClient;
let invalidateSpy: MockInstance;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/** 取出本次所有 invalidateQueries 调用实际传入的 queryKey 列表 */
function invalidatedKeys(): unknown[] {
  return invalidateSpy.mock.calls.map(
    (call) => (call[0] as { queryKey?: unknown } | undefined)?.queryKey,
  );
}

describe('use-portfolios — 删除/归档后的缓存失效契约（账户页表格刷新一致性）', () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    capturedArchive.options = null;
    capturedDelete.options = null;
    usePortfolioStore.setState({ currentPortfolioId: 'other-pf' });
  });

  afterEach(() => {
    usePortfolioStore.setState({ currentPortfolioId: null });
    queryClient.clear();
    vi.clearAllMocks();
    capturedArchive.options = null;
    capturedDelete.options = null;
  });

  it('删除组合后失效账户页表格的 summary key（否则已删行会残留）', async () => {
    renderHook(() => useDeletePortfolio(), { wrapper });
    const opts = capturedDelete.options;
    expect(opts, 'useDeletePortfolio 必须调用 useMutation').toBeTruthy();

    // 模拟「删除成功」：触发源码 onSuccess 内的失效逻辑
    (opts!.onSuccess as (data: unknown, id: string) => void)(null, 'pf-1');

    expect(invalidatedKeys()).toContainEqual(ACCOUNT_TABLE_SUMMARY_KEY);
  });

  it('归档组合后失效账户页表格的 summary key（否则归档标记不刷新）', async () => {
    renderHook(() => useArchivePortfolio(), { wrapper });
    const opts = capturedArchive.options;
    expect(opts, 'useArchivePortfolio 必须调用 useMutation').toBeTruthy();

    (opts!.onSuccess as (data: unknown, vars: { id: string; archived: boolean }) => void)(
      null,
      { id: 'pf-1', archived: true },
    );

    expect(invalidatedKeys()).toContainEqual(ACCOUNT_TABLE_SUMMARY_KEY);
  });

  it('删除组合同时失效组合列表与偏好（默认组合被后端置空需对齐）', async () => {
    renderHook(() => useDeletePortfolio(), { wrapper });
    const opts = capturedDelete.options;

    (opts!.onSuccess as (data: unknown, id: string) => void)(null, 'pf-1');

    const keys = invalidatedKeys();
    expect(keys).toContainEqual([...PORTFOLIOS_KEY]);
    expect(keys).toContainEqual([...PREFERENCE_KEY]);
  });

  it('归档组合同时失效组合列表与偏好', async () => {
    renderHook(() => useArchivePortfolio(), { wrapper });
    const opts = capturedArchive.options;

    (opts!.onSuccess as (data: unknown, vars: { id: string; archived: boolean }) => void)(
      null,
      { id: 'pf-1', archived: true },
    );

    const keys = invalidatedKeys();
    expect(keys).toContainEqual([...PORTFOLIOS_KEY]);
    expect(keys).toContainEqual([...PREFERENCE_KEY]);
  });

  it('归档当前选中组合时清空当前选择（避免选择器指向不可见的归档组合）', async () => {
    usePortfolioStore.setState({ currentPortfolioId: 'pf-1' });
    renderHook(() => useArchivePortfolio(), { wrapper });
    const opts = capturedArchive.options;

    (opts!.onSuccess as (data: unknown, vars: { id: string; archived: boolean }) => void)(
      null,
      { id: 'pf-1', archived: true },
    );

    expect(usePortfolioStore.getState().currentPortfolioId).toBeNull();
  });
});
