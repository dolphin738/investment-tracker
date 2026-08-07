/**
 * features/security-trade/security-trade-list.tsx — 三统计块 + 列改名（INC-03）
 *
 * 验证点（对齐增量 PRD INC-03 验收）：
 * 1. 列头改名：单价→「成本价」、费用→「费用合计」，并新增「佣金/印花税/其他」三列；
 *    旧列名「单价」「费用」零残留。
 * 2. 三统计块口径（用户原话逐字对齐）：
 *    - 买入金额 = 当前表内买入方向(side=BUY_SEC)成交额合计（qty × costPrice）
 *    - 卖出金额 = 当前表内卖出方向(side=SELL_SEC)成交额合计
 *    - 累计费用 = 当前表内「费用合计」列(feeTotal)之和
 * 3. 三统计块随筛选集合动态变化（统一筛选器作用后的可见结果集）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SecurityTradeResponse } from '@/api/types';
import { formatCurrency } from '@/lib/utils';
import { SecuritySide } from '@investment-tracker/shared';
import { SecurityTradeList } from '@/features/security-trade/security-trade-list';

const mocks = vi.hoisted(() => ({
  items: [] as SecurityTradeResponse[],
  total: 0,
}));

vi.mock('@/hooks/use-security-trades', () => ({
  useSecurityTrades: () => ({
    data: { items: mocks.items, total: mocks.total, page: 1, pageSize: 20 },
    isLoading: false,
    isError: false,
  }),
  useDeleteSecurityTrade: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-securities', () => ({
  useSecurities: () => ({ data: [], isLoading: false }),
}));

type TradeSeed = Partial<SecurityTradeResponse> &
  Pick<SecurityTradeResponse, 'id' | 'side' | 'quantity' | 'costPrice' | 'feeTotal'>;

function makeTrade(seed: TradeSeed): SecurityTradeResponse {
  return {
    portfolioId: 'pf-1',
    securityId: 's-1',
    date: '2025-07-15',
    commission: '0',
    stampTax: '0',
    other: '0',
    note: null,
    createdAt: '2025-07-15T00:00:00.000Z',
    updatedAt: '2025-07-15T00:00:00.000Z',
    ...seed,
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderList(query?: Record<string, unknown>): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={makeClient()}>
      <SecurityTradeList
        portfolioId="pf-1"
        query={query as Record<string, string> | undefined}
      />
    </QueryClientProvider>,
  );
}

/** 取统计卡（label 的直接父 div） */
function statCard(label: string): HTMLElement {
  const labelEl = screen.getByText(label);
  const card = labelEl.closest('div');
  if (!card) throw new Error(`统计卡未找到: ${label}`);
  return card;
}

describe('证券买卖明细表 · 三统计块 + 列改名（INC-03）', () => {
  beforeEach(() => {
    mocks.items = [];
    mocks.total = 0;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('列头含改名后字段「成本价/费用合计/佣金/印花税/其他」，旧列名「单价/费用」零残留', () => {
    mocks.items = [
      makeTrade({
        id: 't1',
        side: SecuritySide.BUY_SEC,
        quantity: '100',
        costPrice: '1500.45',
        feeTotal: '5',
      }),
    ];
    mocks.total = 1;
    renderList();

    expect(screen.getByText('成本价')).toBeTruthy();
    expect(screen.getByText('费用合计')).toBeTruthy();
    expect(screen.getByText('佣金')).toBeTruthy();
    expect(screen.getByText('印花税')).toBeTruthy();
    expect(screen.getByText('其他')).toBeTruthy();
    // 旧列名不应出现
    expect(screen.queryByText('单价')).toBeNull();
    expect(screen.queryByText('费用')).toBeNull();
  });

  it('三统计块口径正确：买入金额=ΣBUY qty×costPrice；卖出金额=ΣSELL；累计费用=ΣfeeTotal', () => {
    mocks.items = [
      makeTrade({
        id: 'b1',
        side: SecuritySide.BUY_SEC,
        quantity: '100',
        costPrice: '1500.45',
        feeTotal: '5',
      }),
      makeTrade({
        id: 'b2',
        side: SecuritySide.BUY_SEC,
        quantity: '50',
        costPrice: '100',
        feeTotal: '2',
      }),
      makeTrade({
        id: 's1',
        side: SecuritySide.SELL_SEC,
        quantity: '30',
        costPrice: '200',
        feeTotal: '1',
      }),
    ];
    mocks.total = 3;
    renderList();

    // 买入 = 100*1500.45 + 50*100 = 150045 + 5000 = 155045
    expect(
      within(statCard('买入金额（含费）')).getByText(formatCurrency(155045)),
    ).toBeTruthy();
    // 卖出 = 30*200 = 6000
    expect(
      within(statCard('卖出金额（含费）')).getByText(formatCurrency(6000)),
    ).toBeTruthy();
    // 累计费用 = 5 + 2 + 1 = 8
    expect(
      within(statCard('累计费用合计')).getByText(formatCurrency(8)),
    ).toBeTruthy();
  });

  it('筛选区间变化 → 三统计块同步变化（动态口径，统一筛选器作用后的可见结果集）', () => {
    // 全集（模拟全年范围）
    mocks.items = [
      makeTrade({
        id: 'b1',
        side: SecuritySide.BUY_SEC,
        quantity: '100',
        costPrice: '1500.45',
        feeTotal: '5',
      }),
      makeTrade({
        id: 'b2',
        side: SecuritySide.BUY_SEC,
        quantity: '50',
        costPrice: '100',
        feeTotal: '2',
      }),
    ];
    mocks.total = 2;
    const { rerender } = renderList({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
    expect(
      within(statCard('买入金额（含费）')).getByText(formatCurrency(155045)),
    ).toBeTruthy();

    // 切到仅 7 月子集（模拟日期筛选收紧）
    mocks.items = [
      makeTrade({
        id: 'b1',
        side: SecuritySide.BUY_SEC,
        quantity: '100',
        costPrice: '1500.45',
        feeTotal: '5',
      }),
    ];
    mocks.total = 1;
    rerender(
      <QueryClientProvider client={makeClient()}>
        <SecurityTradeList
          portfolioId="pf-1"
          query={{ startDate: '2025-07-01', endDate: '2025-07-31' }}
        />
      </QueryClientProvider>,
    );
    expect(
      within(statCard('买入金额（含费）')).getByText(formatCurrency(150045)),
    ).toBeTruthy();
  });
});
