/**
 * 分红 / 费用 hooks — 不污染收益计算的前端一侧（D-02 / D-03，验收 2）
 *
 * 后端已实锤「不写 cash_flows / daily_nav / daily_xirr」，但前端仍有一条
 * **隐性污染路径**：写入后若顺手 invalidate 了 holdings / nav / xirr /
 * overview 等查询，界面上概览页数值会跟着刷新一次，用户会误以为
 * 「录了分红 → 收益变了」。本文件把这条路径钉死：
 *
 * - 新增 / 删除分红 → 只失效 ['dividends']
 * - 新增 / 删除费用 → 只失效 ['fees']
 * - 两者都**不得**触碰 holdings / nav / xirr / overview / snapshots / cashflows
 *
 * 策略：mock api 层，用真实 hooks + 真实 QueryClient，侦听 invalidateQueries。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/dividend.api', () => ({
  listDividends: vi.fn().mockResolvedValue([]),
  createDividend: vi.fn().mockResolvedValue({ id: 'd1' }),
  updateDividend: vi.fn().mockResolvedValue({ id: 'd1' }),
  deleteDividend: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/api/fee.api', () => ({
  listFees: vi.fn().mockResolvedValue([]),
  createFee: vi.fn().mockResolvedValue({ id: 'f1' }),
  deleteFee: vi.fn().mockResolvedValue(null),
}));

import {
  useCreateDividend,
  useUpdateDividend,
  useDeleteDividend,
} from '@/hooks/use-dividends';
import { useCreateFee, useDeleteFee } from '@/hooks/use-fees';
import { DividendType, FeeType } from '@/api/types';

/** 收益计算相关的 query key 前缀 —— 一个都不许被失效 */
const FORBIDDEN_KEYS = [
  'holdings',
  'nav',
  'daily-nav',
  'xirr',
  'daily-xirr',
  'overview',
  'dashboard',
  'snapshots',
  'cashflows',
  'cash-flows',
  'transactions',
];

let queryClient: QueryClient;
/** invalidateQueries 的侦听器（显式标注参数/返回类型，避免落到 unknown[] 上） */
let invalidateSpy: MockInstance<
  Parameters<QueryClient['invalidateQueries']>,
  ReturnType<QueryClient['invalidateQueries']>
>;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/** 取出所有被失效的 queryKey 首段 */
function invalidatedPrefixes(): string[] {
  return invalidateSpy.mock.calls.map((call) => {
    const arg = call[0] as { queryKey?: unknown[] } | undefined;
    return String(arg?.queryKey?.[0] ?? '');
  });
}

describe('[验收2] 分红/费用写入不失效任何收益类缓存（D-02 / D-03）', () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  });

  afterEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
  });

  it('新增分红：只失效 ["dividends"]', async () => {
    const { result } = renderHook(() => useCreateDividend('pf-1'), { wrapper });

    await result.current.mutateAsync({
      securityId: 's-a',
      date: '2025-07-15',
      amount: '320.00',
      type: DividendType.CASH,
    });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    expect(invalidatedPrefixes()).toEqual(['dividends']);
  });

  it('删除分红：只失效 ["dividends"]', async () => {
    const { result } = renderHook(() => useDeleteDividend('pf-1'), { wrapper });

    await result.current.mutateAsync('d1');

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    expect(invalidatedPrefixes()).toEqual(['dividends']);
  });

  it('编辑分红（增量 R-5/K-6）：只失效 ["dividends"]，不触碰收益类缓存', async () => {
    const { result } = renderHook(() => useUpdateDividend('pf-1'), { wrapper });

    await result.current.mutateAsync({
      id: 'd1',
      payload: { amount: '500.00', tax: '100.00' },
    });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    expect(invalidatedPrefixes()).toEqual(['dividends']);
  });

  it('新增费用：只失效 ["fees"]', async () => {
    const { result } = renderHook(() => useCreateFee('pf-1'), { wrapper });

    await result.current.mutateAsync({
      securityId: 's-a',
      date: '2025-08-01',
      amount: '5.00',
      type: FeeType.COMMISSION,
    });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    expect(invalidatedPrefixes()).toEqual(['fees']);
  });

  it('删除费用：只失效 ["fees"]', async () => {
    const { result } = renderHook(() => useDeleteFee('pf-1'), { wrapper });

    await result.current.mutateAsync('f1');

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    expect(invalidatedPrefixes()).toEqual(['fees']);
  });

  it('四种写操作累计后，禁用清单中的 key 一个都没被失效', async () => {
    const dividendCreate = renderHook(() => useCreateDividend('pf-1'), {
      wrapper,
    });
    await dividendCreate.result.current.mutateAsync({
      securityId: 's-a',
      date: '2025-07-15',
      amount: '1.00',
    });

    const dividendDelete = renderHook(() => useDeleteDividend('pf-1'), {
      wrapper,
    });
    await dividendDelete.result.current.mutateAsync('d1');

    const feeCreate = renderHook(() => useCreateFee('pf-1'), { wrapper });
    await feeCreate.result.current.mutateAsync({
      securityId: 's-a',
      date: '2025-08-01',
      amount: '1.00',
    });

    const feeDelete = renderHook(() => useDeleteFee('pf-1'), { wrapper });
    await feeDelete.result.current.mutateAsync('f1');

    await waitFor(() => expect(invalidateSpy.mock.calls.length).toBe(4));

    const touched = invalidatedPrefixes();
    // 只应出现 dividends / fees
    expect([...new Set(touched)].sort()).toEqual(['dividends', 'fees']);
    // 且禁用清单零命中
    expect(touched.filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
  });

  it('概览页缓存数据在分红写入前后保持同一引用（未被刷新）', async () => {
    // 预置一份「概览页」缓存
    const overviewData = { xirr: 0.1234, nav: 1.5678 };
    queryClient.setQueryData(['overview', 'pf-1'], overviewData);

    const { result } = renderHook(() => useCreateDividend('pf-1'), { wrapper });
    await result.current.mutateAsync({
      securityId: 's-a',
      date: '2025-07-15',
      amount: '320.00',
    });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());

    const after = queryClient.getQueryData(['overview', 'pf-1']);
    // 同一对象引用 + 数值不变 → 概览页 XIRR / 净值确实没被动过
    expect(after).toBe(overviewData);
    expect(after).toEqual({ xirr: 0.1234, nav: 1.5678 });
    expect(
      queryClient.getQueryState(['overview', 'pf-1'])?.isInvalidated,
    ).toBeFalsy();
  });
});
