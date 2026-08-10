/**
 * features/security-trade/security-trade-list.tsx — filterState 短路（缺陷4 二次修复）
 *
 * 回归重点：持仓页类型筛选器命中为空时，列表必须显示空态，
 * **绝不能**因为「没传 securityId」而向后端发出无过滤查询、回显全量交易。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SecurityTradeResponse } from '@/api/types';
import { SecuritySide } from '@/lib/types';
import { SecurityTradeList } from '@/features/security-trade/security-trade-list';

const mocks = vi.hoisted(() => ({
  /** 记录每次 useSecurityTrades 收到的 portfolioId（null = 查询被禁用） */
  calls: [] as Array<string | null>,
  items: [] as SecurityTradeResponse[],
}));

vi.mock('@/hooks/use-security-trades', () => ({
  useSecurityTrades: (portfolioId: string | null) => {
    mocks.calls.push(portfolioId);
    // 模拟 react-query enabled:false 的返回：不 loading、无数据
    if (!portfolioId) {
      return { data: undefined, isLoading: false, isError: false };
    }
    return {
      data: { items: mocks.items, total: mocks.items.length, page: 1, pageSize: 20 },
      isLoading: false,
      isError: false,
    };
  },
  useDeleteSecurityTrade: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-securities', () => ({
  useSecurities: () => ({ data: [], isLoading: false }),
}));

function makeTrade(id: string): SecurityTradeResponse {
  return {
    id,
    portfolioId: 'pf-1',
    securityId: 's-1',
    date: '2025-08-15',
    side: SecuritySide.BUY_SEC,
    quantity: '100',
    costPrice: '10',
    feeTotal: '0',
    commission: '0',
    stampTax: '0',
    other: '0',
    note: null,
    createdAt: '2025-08-15T00:00:00.000Z',
    updatedAt: '2025-08-15T00:00:00.000Z',
  };
}

function renderList(props: Partial<React.ComponentProps<typeof SecurityTradeList>>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SecurityTradeList portfolioId="pf-1" {...props} />
    </QueryClientProvider>,
  );
}

describe('SecurityTradeList · filterState 短路', () => {
  beforeEach(() => {
    mocks.calls = [];
    mocks.items = [makeTrade('t-1'), makeTrade('t-2')];
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('默认 filterState=ready → 正常查询并渲染数据', () => {
    renderList({});
    expect(mocks.calls.every((id) => id === 'pf-1')).toBe(true);
    expect(screen.queryByText('暂无买卖流水')).toBeNull();
  });

  it('🔴 filterState=empty → 不发查询（portfolioId 传 null）且渲染空态', () => {
    renderList({
      filterState: 'empty',
      filteredEmptyText: '当前筛选条件下没有匹配的标的，暂无买卖流水',
    });
    expect(mocks.calls.every((id) => id === null)).toBe(true);
    expect(
      screen.getByText('当前筛选条件下没有匹配的标的，暂无买卖流水'),
    ).toBeTruthy();
  });

  it('filterState=empty 未给 filteredEmptyText 时回落 emptyText', () => {
    renderList({ filterState: 'empty' });
    expect(screen.getByText('暂无买卖流水')).toBeTruthy();
  });

  it('🔴 filterState=loading → 不发查询且渲染骨架（不闪全量数据）', () => {
    const { container } = renderList({ filterState: 'loading' });
    expect(mocks.calls.every((id) => id === null)).toBe(true);
    // 骨架占位存在，且没有任何表格行
    expect(container.querySelector('table')).toBeNull();
    expect(screen.queryByText('暂无买卖流水')).toBeNull();
  });
});
