/**
 * 【E】分红 / 费用记录区 — 阶段 C 对齐验收（HOLD-B-P0-10 / Q-1 A）
 *
 * 覆盖验证项：
 * - E1 Tab 接入：持仓页出现第三个 Tab「分红/费用」，且与【B】【C】互斥
 * - E2 汇总卡：累计分红 / 累计费用金额正确，§9.5 分红红（text-up）费用绿（text-down）
 * - E3 按标的汇总（验收 2 核心）：只在一侧出现的标的也成行、金额累加正确、排序稳定
 * - E4 明细折叠：[分红记录 ▾] / [费用记录 ▾] 展开后渲染明细行与类型中文标签
 * - E5 口径提示：区块声明「不参与 XIRR 与净值计算」（D-02 / D-03）
 * - E6 加载 / 错误 / 空态
 * - E7 aggregateBySecurity 纯函数聚合口径（含小数累加与缺失侧）
 *
 * 测试策略：mock 数据层 hooks，保留真实 Tabs / Table / 格式化函数与 preference store。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
// 可变夹具槽
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
  useSecurities: () => ({ data: [], isLoading: false }),
  useCreateSecurity: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-dividends', () => ({
  DIVIDENDS_KEY: ['dividends'],
  useDividends: () => state.dividends,
  useCreateDividend: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateDividend: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteDividend: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-fees', () => ({
  FEES_KEY: ['fees'],
  useFees: () => state.fees,
  useCreateFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
  // I-03：费用编辑走 PATCH /fees/:id（DividendFeeForm 依赖 useUpdateFee）
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
import { aggregateBySecurity } from '@/features/security-income/dividend-fee-section';
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

/**
 * 分红夹具：甲股票两笔（320 + 80 = 400），乙基金一笔（150）
 * 丙债券**只有费用没有分红**，用于验证缺失侧仍成行
 */
const DIVIDENDS: DividendRecord[] = [
  {
    id: 'div-1',
    portfolioId: 'pf-1',
    securityId: 's-a',
    securityName: '甲股票',
    securityCode: '600000',
    date: '2025-07-15',
    type: 'CASH',
    amount: '320.00',
    tax: '0.00',
    netAmount: '320.00',
    note: '中期分红',
    createdAt: '2025-07-16T00:00:00.000Z',
  },
  {
    id: 'div-2',
    portfolioId: 'pf-1',
    securityId: 's-a',
    securityName: '甲股票',
    securityCode: '600000',
    date: '2025-01-10',
    type: 'CASH',
    amount: '80.00',
    tax: '0.00',
    netAmount: '80.00',
    note: null,
    createdAt: '2025-01-11T00:00:00.000Z',
  },
  {
    id: 'div-3',
    portfolioId: 'pf-1',
    securityId: 's-b',
    securityName: '乙基金',
    securityCode: '000002',
    date: '2025-06-01',
    type: 'STOCK_DIVIDEND',
    amount: '150.00',
    tax: '0.00',
    netAmount: '150.00',
    note: null,
    createdAt: '2025-06-02T00:00:00.000Z',
  },
] as DividendRecord[];

/** 费用夹具：甲股票 5.00 + 丙债券 2.50 = 7.50 */
const FEES: FeeRecord[] = [
  {
    id: 'fee-1',
    portfolioId: 'pf-1',
    securityId: 's-a',
    securityName: '甲股票',
    securityCode: '600000',
    date: '2025-08-01',
    type: 'COMMISSION',
    amount: '5.00',
    transactionId: null,
    note: '买入佣金',
    createdAt: '2025-08-01T00:00:00.000Z',
  },
  {
    id: 'fee-2',
    portfolioId: 'pf-1',
    securityId: 's-c',
    securityName: '丙债券',
    securityCode: '019547',
    date: '2025-05-20',
    type: 'STAMP_TAX',
    amount: '2.50',
    transactionId: null,
    note: null,
    createdAt: '2025-05-21T00:00:00.000Z',
  },
] as FeeRecord[];

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

function renderHoldingsPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/holdings']}>
        <HoldingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Radix Tabs 的 Trigger 通过 onMouseDown 激活 */
function activateTab(name: string): void {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

/** 打开【E】Tab */
function openIncomeTab(): void {
  renderHoldingsPage();
  activateTab('分红/费用');
}

/** 取按标的汇总表的数据行 */
function getSummaryRows(): HTMLTableRowElement[] {
  const table = screen.getByTestId('income-summary-table');
  const tbody = table.querySelector('tbody');
  if (!tbody) throw new Error('未找到汇总表 tbody');
  return Array.from(tbody.querySelectorAll('tr'));
}

function cellAt(row: HTMLTableRowElement, index: number): HTMLTableCellElement {
  const cell = row.querySelectorAll('td')[index];
  if (!cell) throw new Error(`第 ${index} 列不存在`);
  return cell as HTMLTableCellElement;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
describe('HoldingsPage 阶段 C —【E】分红 / 费用区', () => {
  beforeEach(() => {
    installJsdomPolyfills();
    state.dividends = {
      data: DIVIDENDS,
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    state.fees = {
      data: FEES,
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
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

  // ===== E1 Tab 接入 =====
  describe('E1 Tab 接入与互斥', () => {
    it('持仓页存在第三个 Tab「分红/费用」', () => {
      renderHoldingsPage();

      const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
      expect(tabs).toEqual(['持仓', '买卖明细', '分红/费用']);
    });

    it('默认不渲染【E】区，切到该 Tab 后才挂载', () => {
      renderHoldingsPage();
      expect(screen.queryByTestId('dividend-fee-section')).toBeNull();

      activateTab('分红/费用');
      expect(screen.getByTestId('dividend-fee-section')).toBeDefined();
    });

    it('切到【E】后买卖明细区卸载（Tab 互斥）', () => {
      renderHoldingsPage();

      activateTab('买卖明细');
      expect(screen.getByTestId('trade-list')).toBeDefined();

      activateTab('分红/费用');
      expect(screen.queryByTestId('trade-list')).toBeNull();
      expect(screen.getByTestId('dividend-fee-section')).toBeDefined();
    });
  });

  // ===== E2 汇总卡 =====
  describe('E2 汇总卡金额与红涨绿跌（§9.5）', () => {
    it('累计分红 = 320+80+150 = 550，用 text-up（红）', () => {
      openIncomeTab();

      const total = screen.getByTestId('dividend-total');
      expect(total.textContent).toBe('¥550.00');
      expect(total.className).toContain('text-up');
      expect(total.className).not.toContain('text-down');
    });

    it('累计费用 = 5+2.5 = 7.50，用 text-down（绿）', () => {
      openIncomeTab();

      const total = screen.getByTestId('fee-total');
      expect(total.textContent).toBe('¥7.50');
      expect(total.className).toContain('text-down');
      expect(total.className).not.toContain('text-up');
    });
  });

  // ===== E3 按标的汇总（验收 2） =====
  describe('E3 按标的累计分红 / 累计费用（HOLD-B-P0-10 验收 2）', () => {
    it('汇总表 4 列：标的 / 代码 / 累计分红（净额） / 累计费用', () => {
      openIncomeTab();

      const headers = Array.from(
        screen
          .getByTestId('income-summary-table')
          .querySelectorAll('thead th'),
      ).map((th) => th.textContent?.trim());

      expect(headers).toEqual(['标的', '代码', '累计分红（净额）', '累计费用']);
    });

    it('同标的多笔分红累加（甲股票 320+80=400），并按分红降序排列', () => {
      openIncomeTab();

      const rows = getSummaryRows();
      expect(rows).toHaveLength(3);

      // 甲 400 > 乙 150 > 丙 0
      expect(cellAt(rows[0], 0).textContent).toBe('甲股票');
      expect(cellAt(rows[0], 2).textContent).toBe('¥400.00');
      expect(cellAt(rows[0], 3).textContent).toBe('¥5.00');

      expect(cellAt(rows[1], 0).textContent).toBe('乙基金');
      expect(cellAt(rows[1], 2).textContent).toBe('¥150.00');
    });

    it('只有费用、没有分红的标的仍必须成行（丙债券）', () => {
      openIncomeTab();

      const rows = getSummaryRows();
      const last = rows[rows.length - 1];
      expect(cellAt(last, 0).textContent).toBe('丙债券');
      expect(cellAt(last, 2).textContent).toBe('¥0.00');
      expect(cellAt(last, 3).textContent).toBe('¥2.50');
    });

    it('金额为 0 时不着色，> 0 时分红红、费用绿', () => {
      openIncomeTab();

      const rows = getSummaryRows();
      // 丙债券：分红 0 不着色，费用 2.5 绿
      const last = rows[rows.length - 1];
      expect(cellAt(last, 2).className).not.toContain('text-up');
      expect(cellAt(last, 3).className).toContain('text-down');

      // 甲股票：两侧都 > 0
      expect(cellAt(rows[0], 2).className).toContain('text-up');
      expect(cellAt(rows[0], 3).className).toContain('text-down');
    });
  });

  // ===== E4 明细折叠 =====
  describe('E4 明细折叠区', () => {
    it('分红明细默认折叠，展开后渲染 3 行并显示类型中文', () => {
      openIncomeTab();
      expect(screen.queryByTestId('dividend-detail-table')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /分红记录/ }));

      const table = screen.getByTestId('dividend-detail-table');
      expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
      expect(screen.getAllByText('现金分红').length).toBe(2);
      expect(screen.getByText('红利再投')).toBeDefined();
    });

    it('费用明细展开后渲染 2 行，费用类型显示中文', () => {
      openIncomeTab();

      fireEvent.click(screen.getByRole('button', { name: /费用记录/ }));

      const table = screen.getByTestId('fee-detail-table');
      expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
      expect(screen.getByText('佣金')).toBeDefined();
      expect(screen.getByText('印花税')).toBeDefined();
    });

    it('明细金额沿用红涨绿跌：分红红、费用绿', () => {
      openIncomeTab();

      fireEvent.click(screen.getByRole('button', { name: /分红记录/ }));
      const divRow = screen
        .getByTestId('dividend-detail-table')
        .querySelectorAll('tbody tr')[0];
      expect(divRow.querySelectorAll('td')[3].className).toContain('text-up');

      fireEvent.click(screen.getByRole('button', { name: /费用记录/ }));
      const feeRow = screen
        .getByTestId('fee-detail-table')
        .querySelectorAll('tbody tr')[0];
      // I-03：费用明细列序 = 日期/标的/场景/费用类型/金额（合计）/笔数/操作 → 金额为 td[4]
      expect(feeRow.querySelectorAll('td')[4].className).toContain('text-down');
    });

    it('折叠标题带记录条数徽标，并可再次点击收起', () => {
      openIncomeTab();

      const trigger = screen.getByRole('button', { name: /分红记录/ });
      expect(trigger.textContent).toContain('3');

      fireEvent.click(trigger);
      expect(screen.getByTestId('dividend-detail-table')).toBeDefined();

      fireEvent.click(trigger);
      expect(screen.queryByTestId('dividend-detail-table')).toBeNull();
    });
  });

  // ===== E5 口径提示 =====
  describe('E5 不参与收益计算口径提示（D-02 / D-03）', () => {
    it('区块头部声明不参与 XIRR 与净值计算', () => {
      openIncomeTab();

      expect(
        screen.getByText('独立记录，不参与 XIRR 与净值计算'),
      ).toBeDefined();
    });
  });

  // ===== E6 加载 / 错误 / 空态 =====
  describe('E6 加载 / 错误 / 空态', () => {
    it('任一请求加载中 → 展示骨架，不渲染汇总表', () => {
      state.dividends = {
        data: [],
        isLoading: true,
        isError: false,
        refetch: () => {},
      };

      openIncomeTab();

      expect(screen.queryByTestId('income-summary-table')).toBeNull();
      expect(screen.queryByTestId('dividend-total')).toBeNull();
    });

    it('任一请求失败 → 错误卡 + 重新加载按钮，不渲染汇总表', () => {
      state.fees = {
        data: [],
        isLoading: false,
        isError: true,
        refetch: () => {},
      };

      openIncomeTab();

      expect(screen.getByText('分红 / 费用数据加载失败')).toBeDefined();
      expect(screen.getByRole('button', { name: '重新加载' })).toBeDefined();
      expect(screen.queryByTestId('income-summary-table')).toBeNull();
    });

    it('两侧皆空 → 空态引导，汇总卡仍显示 ¥0.00', () => {
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

      openIncomeTab();

      expect(screen.getByText('暂无分红 / 费用记录')).toBeDefined();
      expect(screen.queryByTestId('income-summary-table')).toBeNull();
      expect(screen.getByTestId('dividend-total').textContent).toBe('¥0.00');
      expect(screen.getByTestId('fee-total').textContent).toBe('¥0.00');
    });
  });
});

// ===========================================================================
// E7 纯函数聚合口径
// ===========================================================================
describe('aggregateBySecurity 聚合口径', () => {
  it('空输入返回空数组', () => {
    expect(aggregateBySecurity([], [])).toEqual([]);
  });

  it('字符串金额按数值累加，保留两位小数精度', () => {
    const rows = aggregateBySecurity(
      [
        { securityId: 's', securityName: 'X', securityCode: 'C', amount: '0.10' },
        { securityId: 's', securityName: 'X', securityCode: 'C', amount: '0.20' },
      ] as DividendRecord[],
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].dividendTotal).toBeCloseTo(0.3, 10);
    expect(rows[0].feeTotal).toBe(0);
  });

  it('仅有费用的标的也返回一行，dividendTotal 为 0', () => {
    const rows = aggregateBySecurity(
      [],
      [
        { securityId: 's', securityName: 'X', securityCode: 'C', amount: '9.99' },
      ] as FeeRecord[],
    );

    expect(rows[0]).toMatchObject({
      securityId: 's',
      dividendTotal: 0,
      feeTotal: 9.99,
    });
  });

  it('分红相同时按费用降序，费用也相同时按代码升序（排序稳定）', () => {
    const rows = aggregateBySecurity(
      [
        { securityId: 's1', securityName: 'A', securityCode: '002', amount: '10' },
        { securityId: 's2', securityName: 'B', securityCode: '001', amount: '10' },
        { securityId: 's3', securityName: 'C', securityCode: '003', amount: '10' },
      ] as DividendRecord[],
      [
        { securityId: 's3', securityName: 'C', securityCode: '003', amount: '5' },
      ] as FeeRecord[],
    );

    // s3 费用最高排首位；s1/s2 费用同为 0 → 代码升序 001 → 002
    expect(rows.map((r) => r.securityCode)).toEqual(['003', '001', '002']);
  });

  it('非法金额按 0 处理，不产生 NaN', () => {
    const rows = aggregateBySecurity(
      [
        {
          securityId: 's',
          securityName: 'X',
          securityCode: 'C',
          amount: 'not-a-number',
        },
      ] as DividendRecord[],
      [],
    );

    expect(rows[0].dividendTotal).toBe(0);
    expect(Number.isNaN(rows[0].dividendTotal)).toBe(false);
  });
});

// ===========================================================================
// 增量回归（R-3 / R-4 / R-5 / R-6）：净额口径 / 三列明细 / 编辑入口 / 费用入口移除
// ===========================================================================
describe('增量：分红净额口径 / 三列 / 编辑入口 / 费用入口移除', () => {
  /** 带所得税的分红夹具（按 date desc 与后端一致）：甲 1500−300=1200、甲 1000−200=800 → 汇总 2000（非 2500） */
  const TAXED_DIVIDENDS = [
    {
      id: 't2',
      portfolioId: 'pf-1',
      securityId: 's-a',
      securityName: '甲股票',
      securityCode: '600000',
      date: '2026-08-05',
      type: 'CASH',
      amount: '1500.00',
      tax: '300.00',
      netAmount: '1200.00',
      note: '中期',
      createdAt: '2026-08-06T00:00:00.000Z',
    },
    {
      id: 't1',
      portfolioId: 'pf-1',
      securityId: 's-a',
      securityName: '甲股票',
      securityCode: '600000',
      date: '2026-05-01',
      type: 'CASH',
      amount: '1000.00',
      tax: '200.00',
      netAmount: '800.00',
      note: 'Q1',
      createdAt: '2026-05-02T00:00:00.000Z',
    },
  ] as DividendRecord[];

  beforeEach(() => {
    installJsdomPolyfills();
    state.dividends = {
      data: TAXED_DIVIDENDS,
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

  it('汇总卡「累计分红（净额）」= Σ(amount−tax) = 2000（非税前 2500）', () => {
    openIncomeTab();

    const total = screen.getByTestId('dividend-total');
    expect(total.textContent).toBe('¥2,000.00');
    expect(total.textContent).not.toBe('¥2,500.00');
  });

  it('按标的汇总列同样按净额（甲股票 800+1200=2000）', () => {
    openIncomeTab();

    const rows = getSummaryRows();
    expect(rows).toHaveLength(1);
    expect(cellAt(rows[0], 0).textContent).toBe('甲股票');
    expect(cellAt(rows[0], 2).textContent).toBe('¥2,000.00');
  });

  it('分红明细三列：金额 / 所得税 / 净额（逐行 1000/200/800、1500/300/1200）', () => {
    openIncomeTab();
    fireEvent.click(screen.getByRole('button', { name: /分红记录/ }));

    const headers = Array.from(
      screen
        .getByTestId('dividend-detail-table')
        .querySelectorAll('thead th'),
    ).map((th) => th.textContent?.trim());
    expect(headers).toContain('金额');
    expect(headers).toContain('所得税');
    expect(headers).toContain('净额');

    const rows = Array.from(
      screen
        .getByTestId('dividend-detail-table')
        .querySelectorAll('tbody tr'),
    );
    // 日期倒序：1500 行在前
    const first = rows[0].querySelectorAll('td');
    expect(first[3].textContent).toBe('¥1,500.00'); // 金额
    expect(first[4].textContent).toBe('¥300.00'); // 所得税
    expect(first[5].textContent).toBe('¥1,200.00'); // 净额

    const second = rows[1].querySelectorAll('td');
    expect(second[3].textContent).toBe('¥1,000.00');
    expect(second[4].textContent).toBe('¥200.00');
    expect(second[5].textContent).toBe('¥800.00');
  });

  it('行内「编辑」入口存在，点击弹出预填表单（编辑分红）', () => {
    openIncomeTab();
    fireEvent.click(screen.getByRole('button', { name: /分红记录/ }));

    const editButtons = screen.getAllByRole('button', { name: '编辑分红记录' });
    expect(editButtons).toHaveLength(2);

    fireEvent.click(editButtons[0]);

    // 弹窗标题 + 预填金额/税（record 传入）
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('编辑分红');
    const amountInput = dialog.querySelector('#income-amount') as HTMLInputElement;
    expect(amountInput.value).toBe('1500.00');
    const taxInput = dialog.querySelector('#income-tax') as HTMLInputElement;
    expect(taxInput.value).toBe('300.00');
  });

  it('【E】区块无「录入费用」按钮（R-6）；费用明细展示保留', () => {
    openIncomeTab();

    expect(screen.queryByRole('button', { name: /录入费用/ })).toBeNull();
    expect(screen.getByRole('button', { name: /录入分红/ })).toBeDefined();
    // 费用明细折叠标题保留
    expect(screen.getByRole('button', { name: /费用记录/ })).toBeDefined();
  });

  it('无分红时汇总卡显示 ¥0.00（净额口径空集边界）', () => {
    state.dividends = {
      data: [],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    openIncomeTab();

    expect(screen.getByTestId('dividend-total').textContent).toBe('¥0.00');
  });
});
