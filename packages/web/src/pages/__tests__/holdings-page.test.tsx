/**
 * pages/HoldingsPage.tsx — 阶段 A 对齐验收（A1~A5）
 *
 * 覆盖验证项：
 * - A1 Tabs 修复：TabsContent 互斥，切到「买卖明细」后持仓区必须卸载
 * - A2 11 列顺序 + 红涨绿跌 + 正负号 + xirrDecimals 小数位
 * - A3 汇总第 5 卡「总盈亏率」（lg:grid-cols-5）
 * - A4 默认按市值降序，且不污染 react-query 缓存数组
 * - A5 占比进度条宽度与百分比一致（含 weight=0 / aggregate 缺失边界）
 * - 骨架屏列数 11
 *
 * 测试策略：只 mock 数据层 hooks 与重型子组件（买卖表单/列表、现价内联编辑），
 * 保留真实 Tabs / Table / Progress / 格式化函数与真实 preference store，
 * 这样「小数位联动」「排序」「着色」等断言才有意义。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Portfolio } from '@investment-tracker/shared';
import type {
  HoldingResponse,
  HoldingsAggregate,
  UserPreference,
} from '@/api/types';

// ---------------------------------------------------------------------------
// 可变夹具槽（vi.hoisted：vi.mock 工厂提升到 import 之前执行）
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  portfolios: [] as unknown[],
  portfoliosLoading: false,
  holdings: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    refetch: () => {},
  },
  securities: { data: [] as unknown[] },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-portfolios', () => ({
  PORTFOLIOS_KEY: ['portfolios'],
  usePortfolios: () => ({
    data: state.portfolios,
    isLoading: state.portfoliosLoading,
  }),
}));

vi.mock('@/hooks/use-holdings', () => ({
  useHoldings: () => state.holdings,
}));

vi.mock('@/hooks/use-securities', () => ({
  useSecurities: () => state.securities,
}));

// 重型子组件替身：只保留可定位的标记，避免拉起表单/请求
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
      createElement('span', { 'data-testid': 'price-editor' }, String(value)),
  };
});

// 必须在 vi.mock 之后导入被测页面与真实 store
import HoldingsPage from '@/pages/HoldingsPage';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const PORTFOLIO: Portfolio = {
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

/**
 * 三条持仓，**故意不按市值降序**（乙 3w → 甲 5w → 丙 2w），
 * 用于验证 A4 前端排序确实生效而不是碰巧顺序正确。
 * 市值 50000 / 30000 / 20000，总市值 100000 → 占比 50% / 30% / 20%，四舍五入后恰好 100%。
 */
const ITEMS: HoldingResponse[] = [
  {
    securityId: 's-b',
    securityCode: '000002',
    securityName: '乙基金',
    securityType: 'FUND',
    quantity: 200,
    avgCost: 100,
    costTotal: 20000,
    marketPrice: 150,
    priceAsOf: '2026-06-15',
    marketValue: 30000,
    pnl: 10000,
    pnlRate: 0.5,
    flag: 'EXACT',
  },
  {
    securityId: 's-a',
    securityCode: '600000',
    securityName: '甲股票',
    securityType: 'STOCK',
    quantity: 1000,
    avgCost: 51.5,
    costTotal: 51500,
    marketPrice: 50,
    priceAsOf: '2026-06-15',
    marketValue: 50000,
    pnl: -1500,
    pnlRate: -0.029126,
    flag: 'EXACT',
  },
  {
    securityId: 's-c',
    securityCode: '019547',
    securityName: '丙债券',
    securityType: 'BOND',
    quantity: 200,
    avgCost: 100,
    costTotal: 20000,
    marketPrice: 100,
    priceAsOf: null,
    marketValue: 20000,
    pnl: 0,
    pnlRate: 0,
    flag: 'COST_BASED',
  },
];

const AGGREGATE: HoldingsAggregate = {
  totalMarketValue: 100000,
  totalCost: 91500,
  totalProfit: 8500,
  totalProfitRate: 0.0929,
  securityCount: 3,
};

const BASE_PREF: UserPreference = {
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

/** PRD §5.2.3 锁定的 11 列表头顺序 */
const EXPECTED_HEADERS = [
  '标的',
  '代码',
  '类型',
  '数量',
  '成本价',
  '现价',
  '成本额',
  '市值',
  '浮动盈亏',
  '盈亏率',
  '占比',
];

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

/** Radix Tabs 的 Trigger 通过 onMouseDown 激活（非 click） */
function activateTab(name: string): void {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

/** 取持仓表 tbody 的数据行 */
function getBodyRows(): HTMLTableRowElement[] {
  const tbody = document.querySelector('tbody');
  if (!tbody) throw new Error('未找到持仓表 tbody');
  return Array.from(tbody.querySelectorAll('tr'));
}

/** 取某行第 n 列（0-based）单元格 */
function cellAt(row: HTMLTableRowElement, index: number): HTMLTableCellElement {
  const cells = row.querySelectorAll('td');
  const cell = cells[index];
  if (!cell) throw new Error(`第 ${index} 列不存在（共 ${cells.length} 列）`);
  return cell as HTMLTableCellElement;
}

/** 列索引常量（与 EXPECTED_HEADERS 对齐） */
const COL = {
  NAME: 0,
  CODE: 1,
  TYPE: 2,
  QTY: 3,
  AVG_COST: 4,
  PRICE: 5,
  COST_TOTAL: 6,
  MARKET_VALUE: 7,
  PNL: 8,
  PNL_RATE: 9,
  WEIGHT: 10,
} as const;

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
describe('HoldingsPage 阶段 A', () => {
  beforeEach(() => {
    installJsdomPolyfills();
    state.portfolios = [PORTFOLIO];
    state.portfoliosLoading = false;
    state.securities = { data: [] };
    state.holdings = {
      data: { items: ITEMS, aggregate: AGGREGATE },
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    usePortfolioStore.setState({
      portfolios: [PORTFOLIO],
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

  // ===== A1：Tabs 互斥切换 =====
  describe('A1 Tabs 修复（TabsContent 互斥）', () => {
    it('默认展示持仓 Tab：持仓表可见，买卖明细列表不在 DOM', () => {
      renderHoldingsPage();

      expect(screen.getByRole('table')).toBeDefined();
      expect(screen.getByText('甲股票')).toBeDefined();
      expect(screen.queryByTestId('trade-list')).toBeNull();
    });

    it('点「买卖明细」后：买卖列表出现，持仓表与汇总卡同时卸载（互斥）', () => {
      renderHoldingsPage();

      activateTab('买卖明细');

      // 买卖区已挂载
      expect(screen.getByTestId('trade-list')).toBeDefined();
      // 持仓区必须消失——这正是原 Bug（两个裸 div 恒同时渲染）的判据
      expect(screen.queryByText('甲股票')).toBeNull();
      expect(screen.queryByText('总盈亏率')).toBeNull();
      expect(document.querySelector('tbody')).toBeNull();
    });

    it('切回「持仓」后持仓区恢复、买卖区卸载', () => {
      renderHoldingsPage();

      activateTab('买卖明细');
      expect(screen.getByTestId('trade-list')).toBeDefined();

      activateTab('持仓');
      expect(screen.getByText('甲股票')).toBeDefined();
      expect(screen.queryByTestId('trade-list')).toBeNull();
    });
  });

  // ===== A2：11 列 + 着色 =====
  describe('A2 持仓列表 11 列与红涨绿跌', () => {
    it('表头恰为 11 列且顺序与 PRD §5.2.3 一致', () => {
      renderHoldingsPage();

      const headers = screen
        .getAllByRole('columnheader')
        .map((th) => th.textContent?.trim() ?? '');

      expect(headers).toHaveLength(11);
      expect(headers).toEqual(EXPECTED_HEADERS);
    });

    it('每个数据行同样是 11 个单元格', () => {
      renderHoldingsPage();

      for (const row of getBodyRows()) {
        expect(row.querySelectorAll('td')).toHaveLength(11);
      }
    });

    it('新增三列取值正确：成本额 / 市值 / 浮动盈亏', () => {
      renderHoldingsPage();

      const rows = getBodyRows();
      // 排序后首行为甲股票（市值 50000）
      expect(cellAt(rows[0], COL.NAME).textContent).toContain('甲股票');
      expect(cellAt(rows[0], COL.COST_TOTAL).textContent).toBe('¥51,500.00');
      expect(cellAt(rows[0], COL.MARKET_VALUE).textContent).toBe('¥50,000.00');
      expect(cellAt(rows[0], COL.PNL).textContent).toBe('¥-1,500.00');
    });

    it('盈利行：浮动盈亏与盈亏率用 text-up，且金额带 + 号', () => {
      renderHoldingsPage();

      // 乙基金（pnl=+10000, pnlRate=0.5）排第 2
      const row = getBodyRows()[1];
      expect(cellAt(row, COL.NAME).textContent).toContain('乙基金');

      const pnl = cellAt(row, COL.PNL);
      expect(pnl.className).toContain('text-up');
      expect(pnl.className).not.toContain('text-down');
      expect(pnl.textContent).toBe('+¥10,000.00');

      const rate = cellAt(row, COL.PNL_RATE);
      expect(rate.className).toContain('text-up');
      expect(rate.textContent).toBe('50.00%');
    });

    it('亏损行：浮动盈亏与盈亏率用 text-down，且带负号、无 + 号', () => {
      renderHoldingsPage();

      const row = getBodyRows()[0]; // 甲股票 pnl=-1500
      const pnl = cellAt(row, COL.PNL);
      expect(pnl.className).toContain('text-down');
      expect(pnl.className).not.toContain('text-up');
      expect(pnl.textContent).toContain('-');
      expect(pnl.textContent).not.toContain('+');

      const rate = cellAt(row, COL.PNL_RATE);
      expect(rate.className).toContain('text-down');
      expect(rate.textContent).toBe('-2.91%');
    });

    it('持平行（pnl=0）按涨色处理（>=0 → text-up），符合 §9.5 口径', () => {
      renderHoldingsPage();

      const row = getBodyRows()[2]; // 丙债券 pnl=0
      expect(cellAt(row, COL.PNL).className).toContain('text-up');
      expect(cellAt(row, COL.PNL).textContent).toBe('+¥0.00');
      expect(cellAt(row, COL.PNL_RATE).className).toContain('text-up');
    });
  });

  // ===== A3：汇总第 5 卡 =====
  describe('A3 汇总区总盈亏率', () => {
    it('5 项汇总齐备且总盈亏率数值正确', () => {
      renderHoldingsPage();

      for (const label of ['总市值', '总成本', '浮盈', '总盈亏率', '标的数']) {
        expect(screen.getByText(label)).toBeDefined();
      }
      expect(screen.getByText('9.29%')).toBeDefined();
    });

    it('栅格由 4 列改为 lg:grid-cols-5', () => {
      renderHoldingsPage();

      const grid = screen
        .getByText('总市值')
        .closest('div.grid') as HTMLElement | null;
      expect(grid).not.toBeNull();
      expect(grid?.className).toContain('lg:grid-cols-5');
      expect(grid?.className).not.toContain('lg:grid-cols-4');
    });

    it('总盈亏率为负时用 text-down', () => {
      state.holdings = {
        ...state.holdings,
        data: {
          items: ITEMS,
          aggregate: { ...AGGREGATE, totalProfitRate: -0.1234 },
        },
      };
      renderHoldingsPage();

      const el = screen.getByText('-12.34%');
      expect(el.className).toContain('text-down');
    });
  });

  // ===== A4：排序 =====
  describe('A4 默认按市值降序', () => {
    it('渲染顺序为 甲(5w) → 乙(3w) → 丙(2w)，而非接口返回顺序', () => {
      renderHoldingsPage();

      const names = getBodyRows().map((r) =>
        cellAt(r, COL.NAME).textContent?.trim(),
      );
      expect(names[0]).toContain('甲股票');
      expect(names[1]).toContain('乙基金');
      expect(names[2]).toContain('丙债券');
    });

    it('市值列单调不增', () => {
      renderHoldingsPage();

      const values = getBodyRows().map((r) =>
        Number(
          (cellAt(r, COL.MARKET_VALUE).textContent ?? '').replace(/[¥,]/g, ''),
        ),
      );
      for (let i = 1; i < values.length; i += 1) {
        expect(values[i - 1]).toBeGreaterThanOrEqual(values[i]);
      }
    });

    it('不污染 react-query 缓存：源 items 数组顺序保持不变', () => {
      const source = [...ITEMS];
      state.holdings = {
        ...state.holdings,
        data: { items: source, aggregate: AGGREGATE },
      };

      renderHoldingsPage();

      // 页面已按市值降序渲染，但源数组必须仍是原始顺序（乙/甲/丙）
      expect(source.map((i) => i.securityId)).toEqual(['s-b', 's-a', 's-c']);
    });
  });

  // ===== A5：占比进度条 =====
  describe('A5 占比进度条', () => {
    it('每行一个 progressbar，aria-valuenow 与百分比文本一致', () => {
      renderHoldingsPage();

      const rows = getBodyRows();
      expect(rows).toHaveLength(3);

      const expected = [50, 30, 20]; // 甲/乙/丙
      rows.forEach((row, idx) => {
        const weightCell = cellAt(row, COL.WEIGHT);
        const bar = weightCell.querySelector('[role="progressbar"]');
        expect(bar).not.toBeNull();

        // 文本百分比
        expect(weightCell.textContent).toContain(
          `${expected[idx].toFixed(2)}%`,
        );
        // aria 数值
        expect(Number(bar?.getAttribute('aria-valuenow'))).toBeCloseTo(
          expected[idx],
          6,
        );
        // 进度条宽度（translateX(-(100-percent)%)）
        const indicator = bar?.firstElementChild as HTMLElement;
        expect(indicator.style.transform).toBe(
          `translateX(-${100 - expected[idx]}%)`,
        );
      });
    });

    it('占比之和为 100%（四舍五入后含最后一行）', () => {
      renderHoldingsPage();

      const sum = getBodyRows().reduce((acc, row) => {
        const text = cellAt(row, COL.WEIGHT).textContent ?? '';
        const match = text.match(/(-?\d+\.\d+)%/);
        return acc + Number(match?.[1] ?? 0);
      }, 0);

      expect(sum).toBeCloseTo(100, 2);
    });

    it('等分三份时显示层四舍五入合计允许 ±0.01×N 误差（不强制归一化最后一行）', () => {
      const thirds: HoldingResponse[] = ITEMS.map((it, i) => ({
        ...it,
        securityId: `s-${i}`,
        marketValue: 10000,
      }));
      state.holdings = {
        ...state.holdings,
        data: {
          items: thirds,
          aggregate: { ...AGGREGATE, totalMarketValue: 30000 },
        },
      };

      renderHoldingsPage();

      const percents = getBodyRows().map((row) => {
        const match = (cellAt(row, COL.WEIGHT).textContent ?? '').match(
          /(-?\d+\.\d+)%/,
        );
        return Number(match?.[1] ?? 0);
      });

      expect(percents).toEqual([33.33, 33.33, 33.33]);
      const sum = percents.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.03);
      // 原始权重之和必须精确为 1（进度条 aria 值层面不丢精度）
      const ariaSum = getBodyRows().reduce((acc, row) => {
        const bar = cellAt(row, COL.WEIGHT).querySelector(
          '[role="progressbar"]',
        );
        return acc + Number(bar?.getAttribute('aria-valuenow'));
      }, 0);
      expect(ariaSum).toBeCloseTo(100, 6);
    });

    it('边界：totalMarketValue=0 时 weight 归 0，不产生 NaN', () => {
      state.holdings = {
        ...state.holdings,
        data: {
          items: [{ ...ITEMS[0], marketValue: 0 }],
          aggregate: { ...AGGREGATE, totalMarketValue: 0 },
        },
      };

      renderHoldingsPage();

      const cell = cellAt(getBodyRows()[0], COL.WEIGHT);
      expect(cell.textContent).toContain('0.00%');
      expect(cell.textContent).not.toContain('NaN');

      const bar = cell.querySelector('[role="progressbar"]');
      expect(bar?.getAttribute('aria-valuenow')).toBe('0');
      expect(
        (bar?.firstElementChild as HTMLElement).style.transform,
      ).toBe('translateX(-100%)');
    });

    it('边界：aggregate 缺失时列表仍渲染，占比归 0 且汇总卡不渲染', () => {
      state.holdings = {
        ...state.holdings,
        data: { items: ITEMS, aggregate: undefined },
      };

      renderHoldingsPage();

      expect(screen.queryByText('总盈亏率')).toBeNull();
      expect(getBodyRows()).toHaveLength(3);
      for (const row of getBodyRows()) {
        const cell = cellAt(row, COL.WEIGHT);
        expect(cell.textContent).toContain('0.00%');
        expect(cell.textContent).not.toContain('NaN');
      }
    });
  });

  // ===== xirrDecimals 联动 =====
  describe('偏好 xirrDecimals 联动（盈亏率 / 总盈亏率）', () => {
    it('xirrDecimals=4 时盈亏率与总盈亏率同步变为 4 位小数', () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, xirrDecimals: 4 },
        loaded: true,
      });

      renderHoldingsPage();

      // 总盈亏率
      expect(screen.getByText('9.2900%')).toBeDefined();
      // 行内盈亏率（甲 -2.9126% / 乙 50.0000%）
      const rows = getBodyRows();
      expect(cellAt(rows[0], COL.PNL_RATE).textContent).toBe('-2.9126%');
      expect(cellAt(rows[1], COL.PNL_RATE).textContent).toBe('50.0000%');
    });

    it('xirrDecimals=0 时两者同步取整', () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, xirrDecimals: 0 },
        loaded: true,
      });

      renderHoldingsPage();

      expect(screen.getByText('9%')).toBeDefined();
      expect(cellAt(getBodyRows()[1], COL.PNL_RATE).textContent).toBe('50%');
    });

    it('占比列固定 2 位小数，不随 xirrDecimals 变化（占比非收益率）', () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, xirrDecimals: 4 },
        loaded: true,
      });

      renderHoldingsPage();

      expect(cellAt(getBodyRows()[0], COL.WEIGHT).textContent).toContain(
        '50.00%',
      );
    });
  });

  // ===== 骨架屏 =====
  describe('加载态骨架屏', () => {
    it('持仓加载中时骨架屏为 11 列（与新表头一致，原为 8）', () => {
      state.holdings = {
        data: undefined,
        isLoading: true,
        isError: false,
        refetch: () => {},
      };

      const { container } = renderHoldingsPage();

      // TableSkeleton 表头行：div.flex.gap-4.border-b.pb-2，子节点数 = cols
      const skeletonHeader = container.querySelector('.border-b.pb-2');
      expect(skeletonHeader).not.toBeNull();
      expect(skeletonHeader?.children.length).toBe(11);

      // 骨架屏出现时不应同时渲染真实表格
      expect(document.querySelector('tbody')).toBeNull();
    });

    it('加载失败时展示错误卡与重新加载按钮，不渲染表格', () => {
      state.holdings = {
        data: undefined,
        isLoading: false,
        isError: true,
        refetch: () => {},
      };

      renderHoldingsPage();

      expect(screen.getByText('数据加载失败')).toBeDefined();
      expect(screen.getByRole('button', { name: '重新加载' })).toBeDefined();
      expect(document.querySelector('tbody')).toBeNull();
      // 关键：错误态不得退化成「暂无持仓数据」空态
      expect(screen.queryByText('暂无持仓数据')).toBeNull();
    });
  });
});
