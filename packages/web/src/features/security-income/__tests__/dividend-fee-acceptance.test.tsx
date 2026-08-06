/**
 * 【E】分红 / 费用区 — 阶段 C 验收补充测试（QA 严过关）
 *
 * 工程师自带的 `holdings-dividend-fee.test.tsx` 已覆盖 E1-E7 主干，
 * 本文件补齐三处主理人点名、但现有用例未真正把住的验收缺口：
 *
 * 1. **金额精度（验收 4）**：现有用例用 `toBeCloseTo(0.3, 10)` 断言聚合结果，
 *    这会**掩盖** 0.1+0.2=0.30000000000000004 的浮点毛刺。此处改为断言
 *    **真实 DOM 文本**必须是「¥0.30」，把毛刺是否被格式化层吃掉验到实处。
 * 2. **Tab 三向互斥（验收 3）**：现有用例只验了【E】↔【C】买卖明细，
 *    此处补【E】↔【B】持仓表，确保三个 Tab 两两互斥。
 * 3. **表单金额双闸的前端一侧（验收 4）**：≤ 0 与 > 2 位小数必须被
 *    zod 挡在提交之前，不得发出请求。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Portfolio } from '@investment-tracker/shared';
import type {
  DividendRecord,
  FeeRecord,
  HoldingsAggregate,
  UserPreference,
} from '@/api/types';

// ---------------------------------------------------------------------------
// 可变夹具槽 + mock
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  dividends: {
    data: [] as unknown[],
    isLoading: false,
    isError: false,
    refetch: () => {},
  },
  fees: {
    data: [] as unknown[],
    isLoading: false,
    isError: false,
    refetch: () => {},
  },
  createDividend: vi.fn(),
  createFee: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-portfolios', () => ({
  PORTFOLIOS_KEY: ['portfolios'],
  usePortfolios: () => ({ data: [PORTFOLIO_FIXTURE], isLoading: false }),
}));

vi.mock('@/hooks/use-holdings', () => ({
  useHoldings: () => ({
    data: { items: [], aggregate: AGGREGATE_FIXTURE },
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
}));

vi.mock('@/hooks/use-securities', () => ({
  useSecurities: () => ({
    data: [{ id: 's-a', name: '甲股票', code: '600000' }],
    isLoading: false,
  }),
  useCreateSecurity: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-dividends', () => ({
  DIVIDENDS_KEY: ['dividends'],
  useDividends: () => state.dividends,
  useCreateDividend: () => ({
    mutateAsync: state.createDividend,
    isPending: false,
  }),
  useUpdateDividend: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteDividend: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-fees', () => ({
  FEES_KEY: ['fees'],
  useFees: () => state.fees,
  useCreateFee: () => ({ mutateAsync: state.createFee, isPending: false }),
  useUpdateFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/features/security-trade/security-trade-form', async () => {
  const { createElement } = await import('react');
  return {
    SecurityTradeForm: () =>
      createElement('div', { 'data-testid': 'trade-form' }, '买卖表单'),
  };
});

vi.mock('@/features/security-trade/security-trade-list', async () => {
  const { createElement } = await import('react');
  return {
    SecurityTradeList: () =>
      createElement('div', { 'data-testid': 'trade-list' }, '买卖明细列表'),
  };
});

vi.mock('@/features/security-price/inline-price-editor', async () => {
  const { createElement } = await import('react');
  return {
    InlinePriceEditor: ({ value }: { value: number }) =>
      createElement('span', null, String(value)),
  };
});

// 必须在 vi.mock 之后导入
import HoldingsPage from '@/pages/HoldingsPage';
import { DividendFeeForm } from '@/features/security-income/dividend-fee-form';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
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

const AGGREGATE_FIXTURE: HoldingsAggregate = {
  totalMarketValue: 0,
  totalCost: 0,
  totalProfit: 0,
  totalProfitRate: 0,
  securityCount: 0,
};

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

/** 制造浮点毛刺的经典组合：0.10 + 0.20（JS 下 = 0.30000000000000004） */
const GLITCH_DIVIDENDS = [
  {
    id: 'd1',
    portfolioId: 'pf-1',
    securityId: 's-a',
    securityName: '甲股票',
    securityCode: '600000',
    date: '2025-07-15',
    type: 'CASH',
    amount: '0.10',
    note: null,
    createdAt: '2025-07-16T00:00:00.000Z',
  },
  {
    id: 'd2',
    portfolioId: 'pf-1',
    securityId: 's-a',
    securityName: '甲股票',
    securityCode: '600000',
    date: '2025-07-16',
    type: 'CASH',
    amount: '0.20',
    note: null,
    createdAt: '2025-07-17T00:00:00.000Z',
  },
] as unknown as DividendRecord[];

/** 费用侧同样造毛刺：0.10 + 0.20 */
const GLITCH_FEES = [
  {
    id: 'f1',
    portfolioId: 'pf-1',
    securityId: 's-a',
    securityName: '甲股票',
    securityCode: '600000',
    date: '2025-08-01',
    type: 'COMMISSION',
    amount: '0.10',
    transactionId: null,
    note: null,
    createdAt: '2025-08-01T00:00:00.000Z',
  },
  {
    id: 'f2',
    portfolioId: 'pf-1',
    securityId: 's-a',
    securityName: '甲股票',
    securityCode: '600000',
    date: '2025-08-02',
    type: 'COMMISSION',
    amount: '0.20',
    transactionId: null,
    note: null,
    createdAt: '2025-08-02T00:00:00.000Z',
  },
] as unknown as FeeRecord[];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function installJsdomPolyfills(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = (): boolean => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = (): void => {};
  }
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderHoldingsPage() {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter initialEntries={['/holdings']}>
        <HoldingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderForm(kind: 'dividend' | 'fee') {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter>
        <DividendFeeForm portfolioId="pf-1" kind={kind} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Radix Tabs 的 Trigger 通过 onMouseDown 激活 */
function activateTab(name: string): void {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

function openIncomeTab(): void {
  renderHoldingsPage();
  activateTab('分红/费用');
}

function getSummaryRows(): HTMLTableRowElement[] {
  const tbody = screen
    .getByTestId('income-summary-table')
    .querySelector('tbody');
  if (!tbody) throw new Error('未找到汇总表 tbody');
  return Array.from(tbody.querySelectorAll('tr'));
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
describe('【E】阶段 C 验收补充', () => {
  beforeEach(() => {
    installJsdomPolyfills();
    state.createDividend = vi.fn().mockResolvedValue({});
    state.createFee = vi.fn().mockResolvedValue({});
    usePortfolioStore.setState({
      portfolios: [PORTFOLIO_FIXTURE],
      currentPortfolioId: 'pf-1',
    });
    usePreferenceStore.setState({ preferences: BASE_PREF, loaded: true });
  });

  afterEach(() => {
    cleanup();
    usePreferenceStore.setState({ preferences: null, loaded: false });
    usePortfolioStore.setState({ portfolios: [], currentPortfolioId: null });
    vi.clearAllMocks();
  });

  // =========================================================================
  // 验收 4：金额精度（DOM 实测，不用 toBeCloseTo 兜底）
  // =========================================================================
  describe('[验收4] 0.10 + 0.20 无浮点毛刺', () => {
    beforeEach(() => {
      state.dividends = {
        data: GLITCH_DIVIDENDS,
        isLoading: false,
        isError: false,
        refetch: () => {},
      };
      state.fees = {
        data: GLITCH_FEES,
        isLoading: false,
        isError: false,
        refetch: () => {},
      };
    });

    it('前置确认：JS 原生相加确实有毛刺（证明本用例不是空跑）', () => {
      expect(0.1 + 0.2).not.toBe(0.3);
      expect(String(0.1 + 0.2)).toBe('0.30000000000000004');
    });

    it('累计分红汇总卡显示 ¥0.30（不是 ¥0.30000000000000004）', () => {
      openIncomeTab();

      const total = screen.getByTestId('dividend-total');
      expect(total.textContent).toBe('¥0.30');
      expect(total.textContent).not.toContain('0000');
    });

    it('累计费用汇总卡显示 ¥0.30', () => {
      openIncomeTab();

      const total = screen.getByTestId('fee-total');
      expect(total.textContent).toBe('¥0.30');
      expect(total.textContent).not.toContain('0000');
    });

    it('按标的汇总行的分红 / 费用列均显示 ¥0.30', () => {
      openIncomeTab();

      const cells = getSummaryRows()[0].querySelectorAll('td');
      expect(cells[2].textContent).toBe('¥0.30');
      expect(cells[3].textContent).toBe('¥0.30');
    });

    it('明细行金额按原值渲染两位小数（¥0.10 / ¥0.20）', () => {
      openIncomeTab();

      fireEvent.click(screen.getByText('分红记录'));
      const rows = Array.from(
        screen
          .getByTestId('dividend-detail-table')
          .querySelectorAll('tbody tr'),
      );
      const amounts = rows.map(
        (r) => r.querySelectorAll('td')[3].textContent,
      );
      expect(amounts).toEqual(['¥0.10', '¥0.20']);
    });
  });

  // =========================================================================
  // 验收 3：Tab 三向互斥（补【E】↔【B】）
  // =========================================================================
  describe('[验收3] 三个 Tab 两两互斥', () => {
    beforeEach(() => {
      state.dividends = {
        data: GLITCH_DIVIDENDS,
        isLoading: false,
        isError: false,
        refetch: () => {},
      };
      state.fees = {
        data: GLITCH_FEES,
        isLoading: false,
        isError: false,
        refetch: () => {},
      };
    });

    it('切到【E】后【B】持仓区块卸载', () => {
      renderHoldingsPage();
      // 默认在持仓 Tab：持仓区块存在、【E】不存在
      const holdingsPanel = document.querySelector(
        '[role="tabpanel"][data-state="active"]',
      );
      expect(holdingsPanel).not.toBeNull();
      expect(screen.queryByTestId('dividend-fee-section')).toBeNull();

      activateTab('分红/费用');

      // 【E】挂载，且持仓专属列头（成本价/浮动盈亏）已从 DOM 移除
      expect(screen.getByTestId('dividend-fee-section')).toBeDefined();
      expect(screen.queryByText('成本价')).toBeNull();
      expect(screen.queryByText('浮动盈亏')).toBeNull();
    });

    it('从【E】切回【B】后【E】卸载（双向互斥）', () => {
      renderHoldingsPage();
      activateTab('分红/费用');
      expect(screen.getByTestId('dividend-fee-section')).toBeDefined();

      activateTab('持仓');
      expect(screen.queryByTestId('dividend-fee-section')).toBeNull();
    });

    it('任意时刻只有一个 tabpanel 处于 active', () => {
      renderHoldingsPage();
      for (const tab of ['持仓', '买卖明细', '分红/费用']) {
        activateTab(tab);
        const active = document.querySelectorAll(
          '[role="tabpanel"][data-state="active"]',
        );
        expect(active.length).toBe(1);
      }
    });
  });

  // =========================================================================
  // 验收 4：前端表单金额闸（≤ 0 / > 2 位小数）
  // =========================================================================
  describe('[验收4] 表单金额校验（前端闸）', () => {
    beforeEach(() => {
      state.dividends = {
        data: [],
        isLoading: false,
        isError: false,
        refetch: () => {},
      };
      state.fees = {
        data: [],
        isLoading: false,
        isError: false,
        refetch: () => {},
      };
    });

    it.each(['0', '0.00', '-1', '-0.01'])(
      '分红金额 ≤ 0 被拒且不发请求：%s',
      async (amount) => {
        renderForm('dividend');

        fireEvent.change(screen.getByLabelText('分红额（税前）*'), {
          target: { value: amount },
        });
        fireEvent.click(screen.getByRole('button', { name: '保存' }));

        await waitFor(() => {
          expect(screen.getByText(/金额必须大于 0|金额最多 2 位小数/)).toBeTruthy();
        });
        expect(state.createDividend).not.toHaveBeenCalled();
      },
    );

    it.each(['1.234', '0.001', '10.555'])(
      '分红金额超过 2 位小数被拒且不发请求：%s',
      async (amount) => {
        renderForm('dividend');

        fireEvent.change(screen.getByLabelText('分红额（税前）*'), {
          target: { value: amount },
        });
        fireEvent.click(screen.getByRole('button', { name: '保存' }));

        await waitFor(() => {
          expect(screen.getByText('金额最多 2 位小数')).toBeTruthy();
        });
        expect(state.createDividend).not.toHaveBeenCalled();
      },
    );

    it('费用金额 > 2 位小数同样被拒', async () => {
      renderForm('fee');

      fireEvent.change(screen.getByLabelText('费用金额 *'), {
        target: { value: '5.005' },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(screen.getByText('金额最多 2 位小数')).toBeTruthy();
      });
      expect(state.createFee).not.toHaveBeenCalled();
    });

    it('金额为空时提示「请输入金额」', async () => {
      renderForm('dividend');

      fireEvent.click(screen.getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(screen.getByText('请输入金额')).toBeTruthy();
      });
      expect(state.createDividend).not.toHaveBeenCalled();
    });

    it('合法两位小数金额不产生金额报错（0.30）', async () => {
      renderForm('dividend');

      fireEvent.change(screen.getByLabelText('分红额（税前）*'), {
        target: { value: '0.30' },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));

      // 金额闸放行（此时仅剩「请选择标的」这类其它字段错误）
      await waitFor(() => {
        expect(screen.getByText('请选择标的')).toBeTruthy();
      });
      expect(screen.queryByText('金额最多 2 位小数')).toBeNull();
      expect(screen.queryByText('金额必须大于 0')).toBeNull();
    });
  });
});
