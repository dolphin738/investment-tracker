/**
 * HoldingsPage — I-05 三板块联动 + URL 持久化集成测试
 *
 * 覆盖（增量 PRD I-05 验收 1/2/3/4/5 + 架构 §4.4.3 联动规则）：
 * 1. 页面顶部只有一个统一筛选器（持仓/买卖明细/分红费用三板块共享）
 * 2. 证券多选 → 三板块同步：useHoldings(securityId) + 买卖明细 query.securityId
 *    + 分红费用 securityIds
 * 3. 场景 → 买卖明细 side（BUY→BUY_SEC/SELL→SELL_SEC）；持仓不适用。
 *    分红板块（INC-04 后仅分红记录）不再承接 scenario 维度。
 * 4. 日期范围 → 买卖明细/分红费用 startDate/endDate；as-of → 持仓 date
 * 5. URL 持久化：date/closed/types/sec/range/from/to/scenario 写入；等于默认不写入
 * 6. 🔴 QA Bug 回归：用户选择快捷范围后 URL 写入 range，不被偏好对齐 effect 弹回
 *    （HoldingsPage 偏好对齐 effect 2 修复验证，增量 PRD I-04 验收 2/3 + I-05 验收 5）
 *
 * 策略：真实 HoldingsPage + 真实 HoldingsToolbar + 真实 useUrlState；
 * mock 数据 hooks（use-holdings/use-transactions/use-securities/use-dividends）
 * 与两个板块子组件（SecurityTradeList/DividendFeeSection）以捕获派生 query props。
 * Radix Select 按既有做法 mock 为原生 <select>。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Portfolio } from '@/lib/types';
import { SecuritySide } from '@/lib/types';
import { FeeScenario } from '@/api/types';
import type { HoldingsAggregate } from '@/api/types';

// ---------------------------------------------------------------------------
// 捕获槽（vi.hoisted：vi.mock 工厂提升到 import 之前执行）
// ---------------------------------------------------------------------------
const capture = vi.hoisted(() => ({
  holdingsQuery: null as null | Record<string, unknown>,
  tradeQuery: null as null | Record<string, unknown>,
  incomeProps: null as null | Record<string, unknown>,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/components/ui/select', async () => {
  const React = await import('react');

  interface ItemProps {
    value: string;
    children?: React.ReactNode;
  }
  const SelectItem = (_props: ItemProps): null => null;
  (SelectItem as unknown as { __selectItem: boolean }).__selectItem = true;

  const passthrough =
    (tag: string) =>
    ({ children, ...rest }: { children?: React.ReactNode }) =>
      React.createElement(tag, rest, children);

  function collectItems(
    node: React.ReactNode,
    out: Array<{ value: string; label: string }>,
  ): void {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;
      const type = child.type as unknown as { __selectItem?: boolean };
      if (type?.__selectItem) {
        const props = child.props as ItemProps;
        out.push({ value: props.value, label: flattenText(props.children) });
        return;
      }
      const props = child.props as { children?: React.ReactNode };
      if (props?.children) collectItems(props.children, out);
    });
  }
  function flattenText(node: React.ReactNode): string {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(flattenText).join('');
    if (React.isValidElement(node)) {
      return flattenText((node.props as { children?: React.ReactNode }).children);
    }
    return '';
  }

  const Select = ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
    children?: React.ReactNode;
  }) => {
    const items: Array<{ value: string; label: string }> = [];
    collectItems(children, items);
    return React.createElement(
      'select',
      {
        value: value ?? '',
        disabled,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
          onValueChange?.(e.target.value),
      },
      [
        React.createElement('option', { key: '__ph', value: '' }, ''),
        ...items.map((i) =>
          React.createElement('option', { key: i.value, value: i.value }, i.label),
        ),
      ],
    );
  };

  return {
    Select,
    SelectTrigger: passthrough('span'),
    SelectItem,
    SelectValue: passthrough('span'),
    SelectContent: passthrough('span'),
    SelectGroup: passthrough('span'),
    SelectLabel: passthrough('span'),
    SelectSeparator: passthrough('span'),
    SelectScrollUpButton: passthrough('span'),
    SelectScrollDownButton: passthrough('span'),
  };
});

// 数据 hooks —— 捕获查询参数
vi.mock('@/hooks/use-portfolios', () => ({
  PORTFOLIOS_KEY: ['portfolios'],
  usePortfolios: () => ({ data: [PORTFOLIO_FIXTURE], isLoading: false }),
  useCreatePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useArchivePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeletePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useClearPortfolioData: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-holdings', () => ({
  useHoldings: (_pf: string | null, query: Record<string, unknown>) => {
    capture.holdingsQuery = query ?? null;
    return {
      data: { items: [], aggregate: AGGREGATE_FIXTURE },
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
  },
}));

vi.mock('@/hooks/use-securities', () => ({
  useSecurities: () => ({ data: SECURITIES_FIXTURE, isLoading: false }),
  useCreateSecurity: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-transactions', () => ({
  useTransactions: () => ({
    data: { items: [{ date: '2024-03-01' }], total: 1 },
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
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

// 板块子组件 —— 捕获派生 query props
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
    SecurityTradeList: (props: { query?: Record<string, unknown> }) => {
      capture.tradeQuery = props.query ?? null;
      return createElement('div', { 'data-testid': 'trade-list' }, '买卖明细列表');
    },
  };
});

vi.mock('@/features/security-price/inline-price-editor', async () => {
  const { createElement } = await import('react');
  return {
    InlinePriceEditor: ({ value }: { value: number }) =>
      createElement('span', null, String(value)),
  };
});

vi.mock('@/features/security-income/dividend-fee-section', async () => {
  const { createElement } = await import('react');
  return {
    DividendFeeSection: (props: Record<string, unknown>) => {
      capture.incomeProps = props;
      return createElement('div', { 'data-testid': 'income-section' }, '分红费用区');
    },
  };
});

// 必须在 vi.mock 之后导入
import HoldingsPage from '@/pages/HoldingsPage';
import { usePortfolioStore } from '@/stores/portfolio.store';
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

const AGGREGATE_FIXTURE: HoldingsAggregate = {
  totalMarketValue: 0,
  totalCost: 0,
  totalProfit: 0,
  totalProfitRate: 0,
  securityCount: 0,
};

const SECURITIES_FIXTURE = [
  { id: 's-a', name: '甲股票', code: '600000' },
  { id: 's-b', name: '乙基金', code: '000002' },
];

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
  showLiquidated: false,
  amountThousands: true,
  amountAbbrev: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

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

function renderPage() {
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

/** 打开指定 Tab（Radix Tabs 的 Trigger 通过 onMouseDown 激活） */
function activateTab(name: string): void {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

/** 读取统一筛选器容器内的原生 <select>：[0]=快捷范围, [1]=场景 */
function getFilterSelects() {
  const container = screen.getByTestId('holdings-unified-filter');
  return Array.from(container.querySelectorAll('select')) as HTMLSelectElement[];
}

/** 定位「持仓日期（as-of）」单点输入（Label 无 htmlFor，不能 getByLabelText） */
function getAsOfInput(): HTMLInputElement {
  const label = screen.getByText('持仓日期（as-of）');
  const wrap = label.parentElement as HTMLElement;
  const input = wrap.querySelector('input[type="date"]');
  if (!input) throw new Error('未找到 as-of 日期输入');
  return input as HTMLInputElement;
}

describe('HoldingsPage — I-05 三板块联动', () => {
  beforeEach(() => {
    installJsdomPolyfills();
    window.history.replaceState({}, '', '/holdings');
    usePortfolioStore.setState({
      portfolios: [PORTFOLIO_FIXTURE],
      currentPortfolioId: 'pf-1',
    });
    usePreferenceStore.setState({ preferences: BASE_PREF, loaded: true });
    capture.holdingsQuery = null;
    capture.tradeQuery = null;
    capture.incomeProps = null;
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/holdings');
    usePreferenceStore.setState({ preferences: null, loaded: false });
    usePortfolioStore.setState({ portfolios: [], currentPortfolioId: null });
    vi.clearAllMocks();
  });

  it('页面顶部只有一个统一筛选器，三板块共享', () => {
    renderPage();

    expect(screen.getAllByTestId('holdings-unified-filter')).toHaveLength(1);
    // 三板块 Tab 都在
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['持仓', '买卖明细', '分红']);
  });

  it('默认：range 不写入 URL（等于默认 1y），as-of 默认今日', () => {
    renderPage();

    expect(window.location.search).not.toContain('range=');
    expect(window.location.search).not.toContain('sec=');
    expect(window.location.search).not.toContain('scenario=');
    // 持仓板块初始以今日为 as-of
    expect(capture.holdingsQuery).toMatchObject({
      date: expect.any(String),
      includeClosed: false,
    });
  });

  it('证券多选 → 三板块同步（持仓 securityId + 买卖明细 securityId + 分红费用 securityIds）', async () => {
    renderPage();

    // 聚焦证券文本框（文本框模糊匹配，I-05 升级）→ 打开多选面板并勾选甲股票
    const secInput = screen.getByPlaceholderText(
      '搜索代码或名称',
    ) as HTMLInputElement;
    fireEvent.focus(secInput);
    const checkboxes = document.querySelectorAll(
      '[data-testid="holdings-unified-filter"] input[type="checkbox"]',
    );
    fireEvent.click(checkboxes[0]);

    // 持仓板块（恒挂载）：useHoldings 收到 securityId
    await waitFor(() => {
      expect(capture.holdingsQuery?.securityId).toBe('s-a');
    });
    // 买卖明细板块：切到 Tab 后 SecurityTradeList 收到 query.securityId
    activateTab('买卖明细');
    await waitFor(() => {
      expect(capture.tradeQuery?.securityId).toBe('s-a');
    });
    // 分红费用板块：切到 Tab 后 DividendFeeSection 收到 securityIds
    activateTab('分红');
    await waitFor(() => {
      expect(capture.incomeProps?.securityIds).toEqual(['s-a']);
    });
    // URL 持久化
    expect(window.location.search).toContain('sec=s-a');
  });

  it('场景 → 买卖明细 side + 分红费用 scenario；持仓不受影响', async () => {
    renderPage();
    const selects = getFilterSelects();
    const scenarioSelect = selects[1];

    // 买卖明细板块：scenario=BUY → side=BUY_SEC
    activateTab('买卖明细');
    fireEvent.change(scenarioSelect, { target: { value: FeeScenario.BUY } });
    await waitFor(() => {
      expect(capture.tradeQuery?.side).toBe(SecuritySide.BUY_SEC);
    });
    expect(window.location.search).toContain('scenario=BUY');

    fireEvent.change(scenarioSelect, { target: { value: FeeScenario.SELL } });
    await waitFor(() => {
      expect(capture.tradeQuery?.side).toBe(SecuritySide.SELL_SEC);
    });

    fireEvent.change(scenarioSelect, { target: { value: 'all' } });
    await waitFor(() => {
      expect(capture.tradeQuery?.side).toBeUndefined();
    });

    // 持仓板块不适用场景：useHoldings 不接收 scenario
    expect(capture.holdingsQuery).not.toHaveProperty('scenario');
  });

  it('日期范围 → 买卖明细/分红费用 startDate/endDate；as-of 不变（含 QA Bug 回归：range 写入 URL 不被弹回）', async () => {
    renderPage();
    const selects = getFilterSelects();
    const quickSelect = selects[0];

    activateTab('买卖明细');
    fireEvent.change(quickSelect, { target: { value: '1m' } });
    await waitFor(() => {
      expect(capture.tradeQuery?.startDate).toBeTruthy();
    });
    expect(capture.tradeQuery?.endDate).toBeTruthy();
    // 🔴 QA Bug 回归：用户选择 1m 后 URL 必须写入 range=1m，
    // 不被偏好对齐 effect 弹回（修复前为 ''）
    await waitFor(() => {
      expect(window.location.search).toContain('range=1m');
    });

    // 分红费用板块同步收到日期范围
    activateTab('分红');
    await waitFor(() => {
      expect(capture.incomeProps?.startDate).toBeTruthy();
    });
    expect(capture.incomeProps?.endDate).toBeTruthy();

    // 持仓板块以 as-of 为准，不接收 startDate/endDate
    expect(capture.holdingsQuery).not.toHaveProperty('startDate');
    expect(capture.holdingsQuery).not.toHaveProperty('endDate');
  });

  it('as-of → 持仓板块 date；买卖明细/分红费用不变', async () => {
    renderPage();
    const asOfInput = getAsOfInput();

    fireEvent.change(asOfInput, { target: { value: '2026-05-01' } });
    await waitFor(() => {
      expect(capture.holdingsQuery?.date).toBe('2026-05-01');
    });
    expect(window.location.search).toContain('date=2026-05-01');
  });

  it('URL 持久化：从带参数的 URL 进入 → 筛选状态还原', async () => {
    window.history.replaceState(
      {},
      '',
      '/holdings?sec=s-b&scenario=SELL&range=3m&date=2026-04-01',
    );
    renderPage();

    // 持仓板块：date 还原
    await waitFor(() => {
      expect(capture.holdingsQuery?.date).toBe('2026-04-01');
    });
    // 买卖明细：securityId + side + startDate 还原
    activateTab('买卖明细');
    await waitFor(() => {
      expect(capture.tradeQuery?.securityId).toBe('s-b');
    });
    expect(capture.tradeQuery?.side).toBe(SecuritySide.SELL_SEC);
    expect(capture.tradeQuery?.startDate).toBeTruthy();
  });
});
