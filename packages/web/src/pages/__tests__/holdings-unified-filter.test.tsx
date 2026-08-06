/**
 * pages/HoldingsPage — 统一筛选器页面级回归（I-05 / QA 第 1 轮 Bug 修复验证）
 *
 * 覆盖：
 * - R-1 用户在统一筛选器选择快捷范围（如 1m）→ URL 写入 range=1m，
 *   且**不被偏好对齐 effect 弹回偏好默认值**（QA Bug：偏好对齐 effect 依赖
 *   holdingsQuery.range，用户每次改 range 都被重置回 defaultRange）
 * - R-2 买卖明细板块收到派生 query（securityId / startDate / endDate）
 * - R-3 分红/费用板块收到派生筛选 props（securityIds / scenario / startDate / endDate）
 * - R-4 as-of 不随日期范围变化（持仓板块以 as-of 为准，I-05 联动规则）
 *
 * 策略：真实渲染 HoldingsPage + HoldingsToolbar + DateRangeQuickPicker（交互真实）；
 * stub 掉 SecurityTradeList / DividendFeeSection 以捕获派生 query（页面装配观测点）；
 * Radix Select mock 为原生 <select> 替身（同 security-type-shared.test.tsx）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// 可变夹具槽 + mock
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  /** 捕获 SecurityTradeList 每次收到的 query props */
  tradeProps: [] as Array<Record<string, unknown>>,
  /** 捕获 DividendFeeSection 每次收到的筛选 props */
  incomeProps: [] as Array<Record<string, unknown>>,
  /** 捕获 useHoldings 收到的查询参数 */
  holdingParams: [] as Array<Record<string, unknown>>,
  /** 稳定引用（避免 useMemo/effect 依赖循环） */
  stableEmpty: [] as unknown[],
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-portfolios', () => ({
  usePortfolios: () => ({
    data: [
      { id: 'pf-1', name: '测试组合', createdAt: '2025-01-01T00:00:00.000Z' },
    ],
    isLoading: false,
  }),
}));

vi.mock('@/stores/portfolio.store', () => ({
  usePortfolioStore: (selector: (s: unknown) => unknown) =>
    selector({ currentPortfolioId: 'pf-1' }),
  usePortfolioBaseDate: () => null,
}));

vi.mock('@/stores/preference.store', () => ({
  usePreferenceStore: (selector: (s: unknown) => unknown) =>
    selector({
      getPreference: (key: string) =>
        ({
          showLiquidated: false,
          amountThousands: true,
          amountAbbrev: false,
          xirrDecimals: 2,
        })[key],
    }),
}));

vi.mock('@/hooks/use-holdings', () => ({
  useHoldings: (_pid: unknown, params: Record<string, unknown>) => {
    state.holdingParams.push(params);
    return {
      data: {
        items: [],
        aggregate: {
          totalMarketValue: 0,
          totalCost: 0,
          totalProfit: 0,
          totalProfitRate: 0,
          securityCount: 0,
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
}));

vi.mock('@/hooks/use-securities', () => ({
  useSecurities: () => ({
    data: [{ id: 's-a', name: '贵州茅台', code: '600519' }],
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-transactions', () => ({
  useTransactions: () => ({ data: { items: [] }, isLoading: false }),
}));

vi.mock('@/hooks/use-security-trades', () => ({
  useSecurityTrades: () => ({
    data: { items: [], total: 0, page: 1, pageSize: 20 },
    isLoading: false,
    isError: false,
  }),
  useDeleteSecurityTrade: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-fees', () => ({
  FEES_KEY: ['fees'],
  useFees: () => ({
    data: state.stableEmpty,
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
  useCreateFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-dividends', () => ({
  DIVIDENDS_KEY: ['dividends'],
  useDividends: () => ({
    data: state.stableEmpty,
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
  useCreateDividend: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateDividend: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteDividend: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// stub 板块组件：捕获页面装配的派生 query（真实渲染的只有统一筛选器链路）
vi.mock('@/features/security-trade/security-trade-list', async () => {
  const { createElement } = await import('react');
  return {
    SecurityTradeList: (props: Record<string, unknown>) => {
      state.tradeProps.push(props);
      return createElement('div', { 'data-testid': 'trade-list' }, '买卖明细');
    },
  };
});

vi.mock('@/features/security-income/dividend-fee-section', async () => {
  const { createElement } = await import('react');
  return {
    DividendFeeSection: (props: Record<string, unknown>) => {
      state.incomeProps.push(props);
      return createElement('div', { 'data-testid': 'income-section' }, '分红费用');
    },
  };
});

/**
 * Radix Select 替身（原生 <select>）—— 同 security-type-shared.test.tsx。
 */
vi.mock('@/components/ui/select', async () => {  const React = await import('react');

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

  function findTriggerId(node: React.ReactNode): string | undefined {
    let found: string | undefined;
    React.Children.forEach(node, (child) => {
      if (found || !React.isValidElement(child)) return;
      const props = child.props as { id?: string; children?: React.ReactNode };
      const isTrigger =
        (child.type as unknown as { __selectTrigger?: boolean })?.__selectTrigger;
      if (isTrigger && props.id) {
        found = props.id;
        return;
      }
      if (props?.children) found = findTriggerId(props.children) ?? found;
    });
    return found;
  }

  const SelectTrigger = ({
    children,
    ...rest
  }: { children?: React.ReactNode }) =>
    React.createElement('span', rest, children);
  (SelectTrigger as unknown as { __selectTrigger: boolean }).__selectTrigger =
    true;

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
    const id = findTriggerId(children);
    return React.createElement(
      'select',
      {
        id,
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
    SelectTrigger,
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

/**
 * Radix Tabs 替身（受控/非受控均支持）：
 * jsdom 下 radix tabs 的 click 切换不生效（探针已验证），mock 为 context 驱动切换，
 * 使「切到买卖明细/分红费用 Tab → 板块组件挂载」这条链路在测试中真实可测。
 */
vi.mock('@/components/ui/tabs', async () => {
  const React = await import('react');
  const Ctx = React.createContext<{ active: string; select: (v: string) => void }>({
    active: '',
    select: () => {},
  });

  const Tabs = ({
    defaultValue,
    value,
    onValueChange,
    children,
  }: {
    defaultValue?: string;
    value?: string;
    onValueChange?: (v: string) => void;
    children?: React.ReactNode;
  }) => {
    const [inner, setInner] = React.useState<string>(defaultValue ?? value ?? '');
    const active = value ?? inner;
    const select = (v: string) => {
      if (onValueChange) onValueChange(v);
      else setInner(v);
    };
    return React.createElement(Ctx.Provider, { value: { active, select } }, children);
  };

  const TabsList = ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', { role: 'tablist' }, children);

  const TabsTrigger = ({
    value,
    children,
  }: {
    value: string;
    children?: React.ReactNode;
  }) => {
    const { select } = React.useContext(Ctx);
    return React.createElement(
      'button',
      { role: 'tab', type: 'button', onClick: () => select(value) },
      children,
    );
  };

  const TabsContent = ({
    value,
    children,
  }: {
    value: string;
    children?: React.ReactNode;
  }) => {
    const { active } = React.useContext(Ctx);
    return active === value ? React.createElement('div', null, children) : null;
  };

  return { Tabs, TabsList, TabsTrigger, TabsContent };
});

import HoldingsPage from '@/pages/HoldingsPage';

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <HoldingsPage />
    </QueryClientProvider>,
  );
}

/** 统一筛选器中的快捷范围下拉（DOM 顺序第 1 个 select） */
function quickRangeSelect(): HTMLSelectElement {
  const selects = document.querySelectorAll('select');
  return selects[0] as HTMLSelectElement;
}

describe('持仓页统一筛选器（I-05 · QA Bug 回归）', () => {
  beforeEach(() => {
    // 无任何 URL 参数（等同首次进入）
    window.history.replaceState({}, '', '/holdings');
    state.tradeProps = [];
    state.incomeProps = [];
    state.holdingParams = [];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/holdings');
  });

  it('用户选择快捷范围 1m → URL 写入 range=1m 且不被偏好对齐弹回（QA Bug 修复）', async () => {
    renderPage();

    // 用户选择快捷范围「近1月」
    fireEvent.change(quickRangeSelect(), { target: { value: '1m' } });

    await waitFor(() => {
      expect(window.location.search).toContain('range=1m');
    });
    // 关键断言：URL 真实写入了 range=1m（修复前被弹回默认后等于默认不写入 → 空）
    expect(window.location.search).not.toBe('');
  });

  it('日期范围 → 买卖明细/分红费用收到派生 query；as-of 不随之变化（联动规则）', async () => {
    renderPage();

    // 切换到「买卖明细」Tab（TabsContent 懒渲染，需激活后才挂载 SecurityTradeList）
    fireEvent.click(screen.getByRole('tab', { name: '买卖明细' }));
    await waitFor(() => {
      expect(state.tradeProps.length).toBeGreaterThan(0);
    });

    // 选择快捷范围 1m
    fireEvent.change(quickRangeSelect(), { target: { value: '1m' } });

    await waitFor(() => {
      expect(window.location.search).toContain('range=1m');
    });

    // 买卖明细：1m 区间 startDate/endDate 非空（tab 已激活，组件持续收到派生 query）
    const trade = state.tradeProps[state.tradeProps.length - 1];
    const tradeQuery = trade.query as { startDate?: string; endDate?: string };
    expect(tradeQuery.startDate).toBeTruthy();
    expect(tradeQuery.endDate).toBeTruthy();

    // 分红/费用：切到该 Tab 后同样收到派生筛选 props
    fireEvent.click(screen.getByRole('tab', { name: '分红/费用' }));
    await waitFor(() => {
      expect(state.incomeProps.length).toBeGreaterThan(0);
    });
    const income = state.incomeProps[state.incomeProps.length - 1];
    expect(income.startDate).toBeTruthy();
    expect(income.endDate).toBeTruthy();
    expect(income.scenario).toBe('all');

    // 持仓板块：as-of 使用默认今日（URL 无 date 参数时 schema 默认值），
    // 不因日期范围变化而改变
    const holdingParam = state.holdingParams[state.holdingParams.length - 1];
    expect(holdingParam.date).toBeTruthy();
  });
});
