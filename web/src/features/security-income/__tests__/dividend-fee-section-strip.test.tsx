/**
 * features/security-income/dividend-fee-section.tsx — 费用剥离（INC-04）
 *
 * 验证点（对齐增量 PRD INC-04 验收）：
 * 1. 费用相关 UI（累计费用卡、按标的汇总累计费用列、费用记录 Tab）全部消失；
 *    分红能力回归无差异：标题「分红记录」、汇总卡「累计分红（净额）」、分红明细正常。
 * 2. 净额口径（K-2）：sumNetAmount = Σ(amount − tax)；aggregateBySecurity 按标的聚合净额。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DividendRecord } from '@/api/types';
import {
  aggregateBySecurity,
  sumNetAmount,
  DividendFeeSection,
} from '@/features/security-income/dividend-fee-section';

const mocks = vi.hoisted(() => ({
  dividends: [] as DividendRecord[],
  isLoading: false,
  isError: false,
  deleteDividend: vi.fn(),
}));

vi.mock('@/hooks/use-dividends', () => ({
  useDividends: () => ({
    data: mocks.dividends,
    isLoading: mocks.isLoading,
    isError: mocks.isError,
    refetch: vi.fn(),
  }),
  useDeleteDividend: () => ({
    mutateAsync: mocks.deleteDividend,
    isPending: false,
  }),
}));

const mockGetPreference = vi.fn();

vi.mock('@/stores/preference.store', () => ({
  usePreferenceStore: (selector: (s: { getPreference: typeof mockGetPreference }) => unknown) =>
    selector({ getPreference: mockGetPreference }),
}));

function makeDividend(overrides: Partial<DividendRecord> = {}): DividendRecord {
  return {
    id: 'd-1',
    portfolioId: 'pf-1',
    securityId: 's-1',
    securityName: '贵州茅台',
    securityCode: '600519',
    date: '2025-06-01',
    type: 'CASH' as DividendRecord['type'],
    amount: '100',
    tax: '10',
    netAmount: '90',
    note: null,
    createdAt: '2025-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('dividend-fee-section 纯函数（K-2 净额口径）', () => {
  it('sumNetAmount = Σ(amount − tax)', () => {
    expect(
      sumNetAmount([
        { amount: '100', tax: '10' },
        { amount: '50', tax: '0' },
      ]),
    ).toBe(140);
  });

  it('aggregateBySecurity 按标的聚合净额并降序排列', () => {
    const rows = aggregateBySecurity([
      makeDividend({ id: '1', securityId: 'a', securityName: 'A', securityCode: '600000', amount: '100', tax: '10', netAmount: '90' }),
      makeDividend({ id: '2', securityId: 'a', securityName: 'A', securityCode: '600000', amount: '50', tax: '0', netAmount: '50' }),
      makeDividend({ id: '3', securityId: 'b', securityName: 'B', securityCode: '000001', amount: '200', tax: '20', netAmount: '180' }),
    ]);
    expect(rows).toHaveLength(2);
    // 降序：b(180) 在前，a(140) 在后
    expect(rows[0].securityId).toBe('b');
    expect(rows[0].dividendTotal).toBe(180);
    expect(rows[1].securityId).toBe('a');
    expect(rows[1].dividendTotal).toBe(140);
  });
});

describe('dividend-fee-section 费用剥离（INC-04）', () => {
  beforeEach(() => {
    mocks.dividends = [];
    mocks.isLoading = false;
    mocks.isError = false;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function renderSection(): ReturnType<typeof render> {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DividendFeeSection portfolioId="pf-1" />
      </QueryClientProvider>,
    );
  }

  it('仅保留分红能力：标题/汇总卡存在；费用相关 Tab/卡/列已剥离', () => {
    mocks.dividends = [makeDividend()];
    renderSection();

    // 分红能力回归无差异
    expect(screen.getAllByText('分红记录').length).toBeGreaterThan(0);
    // 汇总卡标签 + 按标的汇总表头均含「累计分红（净额）」（INC-04 后仅保留分红）
    expect(screen.getAllByText('累计分红（净额）').length).toBeGreaterThan(0);

    // 费用相关 UI 已移除（硬验收）
    expect(screen.queryByText('累计费用')).toBeNull();
    expect(screen.queryByText('费用记录')).toBeNull();
    expect(screen.queryByText('费用合计')).toBeNull();
  });

  it('分红明细正常渲染（日期/标的/金额/所得税/净额）', () => {
    mocks.dividends = [makeDividend()];
    renderSection();

    // 展开明细前无法看到明细行；点击「分红记录」折叠头展开
    fireEventClickDividendToggle();
    // 代码/名称同时出现在「按标的汇总表」与「分红明细表」，故用 getAllByText
    expect(screen.getAllByText('600519').length).toBeGreaterThan(0); // 标的代码
    expect(screen.getAllByText('贵州茅台').length).toBeGreaterThan(0); // 标的名称
    // 金额按 formatCurrency 渲染为 ¥100.00（非裸 100）
    expect(screen.getByText(/100/)).toBeTruthy();
  });
});

/** 点击「分红记录」明细折叠头 */
function fireEventClickDividendToggle(): void {
  const toggle = screen.getByRole('button', { name: /分红记录/ });
  fireEvent.click(toggle);
}
