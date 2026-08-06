/**
 * DividendFeeSection — I-03 费用按合并键聚合展示
 *
 * 覆盖（增量 PRD I-03 验收 1/4/6）：
 * 1. 同合并键多笔 → grouped=1 后端返回一行，列表展示「金额（合计）」+「笔数」
 * 2. 场景徽标「买入时 / 卖出时」正确呈现
 * 3. 修改组成笔后聚合重算（编辑/删除作用于代表明细，合并结果自动重算）——
 *    通过捕获 useUpdateFee / useDeleteFee 入口存在性验证
 *
 * 策略：渲染真实 DividendFeeSection，mock use-fees 按 grouped 参数分流
 * （useFees 被调用两次：明细 + grouped=1 聚合），其余 hooks 一并 mock。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Portfolio } from '@investment-tracker/shared';
import type { FeeGroupedRow, FeeRecord, UserPreference } from '@/api/types';
import { FeeScenario, FeeType } from '@/api/types';

const state = vi.hoisted(() => ({
  fees: [] as unknown[],
  groupedFees: [] as unknown[],
  updateFee: vi.fn(),
  deleteFee: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-portfolios', () => ({
  PORTFOLIOS_KEY: ['portfolios'],
  usePortfolios: () => ({ data: [PORTFOLIO_FIXTURE], isLoading: false }),
}));

vi.mock('@/hooks/use-dividends', () => ({
  DIVIDENDS_KEY: ['dividends'],
  useDividends: () => ({
    data: [],
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
  useCreateDividend: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateDividend: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteDividend: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-fees', () => ({
  FEES_KEY: ['fees'],
  // 组件内 useFees 被调用两次：明细（无 grouped）与聚合（grouped=true）——
  // 按 query.grouped 分流返回 react-query 形态结果
  useFees: (_pf: string | null, query: { grouped?: boolean }) => {
    const data = query?.grouped ? state.groupedFees : state.fees;
    return { data, isLoading: false, isError: false, refetch: () => {} };
  },
  useCreateFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateFee: () => ({ mutateAsync: state.updateFee, isPending: false }),
  useDeleteFee: () => ({ mutateAsync: state.deleteFee, isPending: false }),
}));

// 必须在 vi.mock 之后导入
import { DividendFeeSection } from '@/features/security-income/dividend-fee-section';
import { usePreferenceStore } from '@/stores/preference.store';

const PORTFOLIO_FIXTURE = {
  id: 'pf-1',
  userId: 'user-1',
  name: '测试组合',
  description: null,
  baseDate: '2024-01-01',
  currency: 'CNY',
  archivedAt: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
} as unknown as Portfolio;

const BASE_PREF = {
  id: 'pref-1',
  userId: 'user-1',
  defaultPortfolioId: 'pf-1',
  defaultGranularity: 'month',
  defaultDateRange: '1y',
  aggregation: 'last',
  weekStartsOn: 1,
  navDecimals: 4,
  xirrDecimals: 2,
  theme: 'system',
  staleDays: 3,
  cashHintOnCashflow: true,
  cashHintOnTrade: true,
  amountThousands: true,
  amountAbbrev: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
} as unknown as UserPreference;

/** 明细：同合并键两笔（同 security/date/scenario/type，金额 5.00 + 3.50） */
const FEE_DETAILS: FeeRecord[] = [
  {
    id: 'fee-1',
    portfolioId: 'pf-1',
    securityId: 's-a',
    securityName: '甲股票',
    securityCode: '600000',
    date: '2025-08-01',
    type: FeeType.COMMISSION,
    scenario: FeeScenario.BUY,
    amount: '5.00',
    transactionId: null,
    note: '买入佣金',
    createdAt: '2025-08-01T00:00:00.000Z',
  },
  {
    id: 'fee-2',
    portfolioId: 'pf-1',
    securityId: 's-a',
    securityName: '甲股票',
    securityCode: '600000',
    date: '2025-08-01',
    type: FeeType.COMMISSION,
    scenario: FeeScenario.BUY,
    amount: '3.50',
    transactionId: null,
    note: null,
    createdAt: '2025-08-02T00:00:00.000Z',
  },
] as FeeRecord[];

/** 聚合（模拟后端 grouped=1 返回）：同一合并键合计 8.50，count 2 */
const FEE_GROUPED: FeeGroupedRow[] = [
  {
    mergeKey: 's-a|2025-08-01|BUY|COMMISSION',
    securityId: 's-a',
    securityName: '甲股票',
    securityCode: '600000',
    date: '2025-08-01',
    scenario: FeeScenario.BUY,
    type: FeeType.COMMISSION,
    amount: '8.50',
    count: 2,
    transactionIds: [],
  },
] as FeeGroupedRow[];

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DividendFeeSection portfolioId="pf-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DividendFeeSection — I-03 费用合并展示', () => {
  beforeEach(() => {
    state.fees = FEE_DETAILS;
    state.groupedFees = FEE_GROUPED;
    usePreferenceStore.setState({ preferences: BASE_PREF, loaded: true });
  });

  afterEach(() => {
    cleanup();
    usePreferenceStore.setState({ preferences: null, loaded: false });
    vi.clearAllMocks();
  });

  it('同合并键多笔 → 明细列表只显示一行（金额=合计 8.50、笔数=2 笔）', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /费用记录/ }));

    const table = screen.getByTestId('fee-detail-table');
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);

    const cells = rows[0].querySelectorAll('td');
    // 列序：日期/标的/场景/费用类型/金额（合计）/笔数/操作
    expect(cells[4].textContent).toBe('¥8.50');
    expect(cells[5].textContent).toContain('2 笔');
  });

  it('场景徽标：买入时（BUY）呈现，费用类型中文呈现', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /费用记录/ }));

    const table = screen.getByTestId('fee-detail-table');
    const cells = table.querySelectorAll('tbody tr')[0].querySelectorAll('td');
    expect(cells[2].textContent).toContain('买入时');
    expect(cells[3].textContent).toContain('佣金');
  });

  it('不同场景不合并：BUY + SELL 同类型 → 两行', () => {
    state.groupedFees = [
      FEE_GROUPED[0],
      {
        ...FEE_GROUPED[0],
        mergeKey: 's-a|2025-08-01|SELL|COMMISSION',
        scenario: FeeScenario.SELL,
        amount: '2.00',
        count: 1,
      },
    ] as FeeGroupedRow[];

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /费用记录/ }));

    const table = screen.getByTestId('fee-detail-table');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('编辑入口存在（作用于代表明细，修改后聚合自动重算）', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /费用记录/ }));

    const table = screen.getByTestId('fee-detail-table');
    const editBtn = within(table).getByRole('button', { name: '编辑费用记录' });
    expect(editBtn).toBeDefined();
    // 合并记录（count>1）时删除按钮禁用，避免误删组成笔
    const delBtn = within(table).getByRole('button', { name: '删除费用记录' });
    expect((delBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('汇总卡/按标的汇总使用聚合行金额（费用 8.50，绿）', () => {
    renderSection();

    expect(screen.getByTestId('fee-total').textContent).toBe('¥8.50');
    const summaryRows = screen
      .getByTestId('income-summary-table')
      .querySelectorAll('tbody tr');
    expect(summaryRows).toHaveLength(1);
    const cells = summaryRows[0].querySelectorAll('td');
    expect(cells[3].textContent).toBe('¥8.50');
    expect(cells[3].className).toContain('text-down');
  });
});
