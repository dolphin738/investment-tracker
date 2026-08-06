/**
 * 买卖表单增量验收（R-6 / R-7 / R-8 / C-4 / C-5 / C-6 / C-7 / K-3 / K-4）
 *
 * 覆盖：
 * 1. 费用三框并列 + 费用合计自动求和
 * 2. 买入含费单价 = (成交额+费用合计)/数量 → 写入 trade.price，trade.fee=0
 * 3. 卖出含费单价 = (成交额−费用合计)/数量
 * 4. 卖出费用合计 > 成交额 → 阻止提交（前端闸）
 * 5. 提交序列：先 POST trade 拿 id → 仅 amount>0 的类型 POST fee（transactionId 关联）
 * 6. 值为 0 不落 FeeRecord（C-6）
 * 7. 编辑态：无费用三框；存量 fee≠0 显示口径提示
 *
 * ⚠️ Radix Select mock 为原生 <select>（同 security-type-shared.test.tsx）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SecurityTradeResponse } from '@/api/types';

// ---------------------------------------------------------------------------
// 可变夹具槽 + mock
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  createTrade: vi.fn(),
  updateTrade: vi.fn(),
  createFee: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-securities', () => ({
  useSecurities: () => ({
    data: [{ id: 's-a', name: '贵州茅台', code: '600519' }],
    isLoading: false,
  }),
  useCreateSecurity: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock('@/hooks/use-security-trades', () => ({
  useSecurityTrades: () => ({
    data: { items: [], total: 0, page: 1, pageSize: 20 },
    isLoading: false,
    isError: false,
  }),
  useCreateSecurityTrade: () => ({
    mutateAsync: mocks.createTrade,
    isPending: false,
  }),
  useUpdateSecurityTrade: () => ({
    mutateAsync: mocks.updateTrade,
    isPending: false,
  }),
  useDeleteSecurityTrade: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/api/fee.api', () => ({
  listFees: vi.fn().mockResolvedValue([]),
  createFee: mocks.createFee,
  deleteFee: vi.fn().mockResolvedValue(null),
}));

/**
 * Radix Select 替身（原生 <select>）—— 同 security-type-shared.test.tsx。
 */
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

  const SelectTrigger = ({ children, ...rest }: { children?: React.ReactNode }) =>
    React.createElement('span', rest, children);
  (SelectTrigger as unknown as { __selectTrigger: boolean }).__selectTrigger = true;

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

import { SecurityTradeForm } from '@/features/security-trade/security-trade-form';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const TRADE_RESPONSE: SecurityTradeResponse = {
  id: 'trade-1',
  portfolioId: 'pf-1',
  securityId: 's-a',
  date: '2025-07-15',
  side: 'BUY_SEC',
  quantity: '100',
  price: '1500.45',
  fee: '0',
  note: '建仓',
  createdAt: '2025-07-15T00:00:00.000Z',
  updatedAt: '2025-07-15T00:00:00.000Z',
};

/** 旧口径记录（fee≠0） */
const LEGACY_TRADE: SecurityTradeResponse = {
  ...TRADE_RESPONSE,
  fee: '45.00',
};

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderForm(props: { trade?: SecurityTradeResponse | null } = {}) {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter>
        <SecurityTradeForm portfolioId="pf-1" trade={props.trade} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 录入态最小合法字段（默认买入、贵州茅台、数量 100、成交额 150000） */
function fillCreateBasics(): void {
  const securitySelect = document.getElementById('st-security') as HTMLSelectElement;
  fireEvent.change(securitySelect, { target: { value: 's-a' } });
  fireEvent.change(screen.getByLabelText('数量 *'), {
    target: { value: '100' },
  });
  fireEvent.change(screen.getByLabelText('成交额（元）*'), {
    target: { value: '150000' },
  });
}

/** 选方向 */
function selectSide(side: 'BUY_SEC' | 'SELL_SEC'): void {
  const sideSelect = document.getElementById('st-side') as HTMLSelectElement;
  fireEvent.change(sideSelect, { target: { value: side } });
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
describe('买卖表单增量（成交额 + 三费用 → 含费单价 + 先 trade 后 fee）', () => {
  beforeEach(() => {
    mocks.createTrade.mockReset();
    mocks.updateTrade.mockReset();
    mocks.createFee.mockReset();
    mocks.createTrade.mockResolvedValue(TRADE_RESPONSE);
    mocks.createFee.mockResolvedValue({ id: 'fee-1' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // =========================================================================
  // 费用三框 + 费用合计（R-6）
  // =========================================================================
  describe('费用三框并列 + 费用合计自动求和（R-6）', () => {
    it('录入态渲染 佣金/印花税/其他 三输入框 + 费用合计', () => {
      renderForm();

      expect(screen.getByLabelText('佣金')).toBeDefined();
      expect(screen.getByLabelText('印花税')).toBeDefined();
      expect(screen.getByLabelText('其他')).toBeDefined();
      expect(screen.getByTestId('fee-total')).toBeDefined();
    });

    it('费用合计自动求和（45 + 5 + 2 = 52 → ¥52.00）', () => {
      renderForm();
      fillCreateBasics();

      fireEvent.change(screen.getByLabelText('佣金'), {
        target: { value: '45' },
      });
      fireEvent.change(screen.getByLabelText('印花税'), {
        target: { value: '5' },
      });
      fireEvent.change(screen.getByLabelText('其他'), {
        target: { value: '2' },
      });

      expect(screen.getByTestId('fee-total').textContent).toContain('¥52.00');
    });

    it('费用留空按 0 计（合计 ¥0.00）', () => {
      renderForm();
      fillCreateBasics();

      expect(screen.getByTestId('fee-total').textContent).toContain('¥0.00');
    });
  });

  // =========================================================================
  // 含费单价公式（R-8 / K-3）
  // =========================================================================
  describe('含费单价公式', () => {
    it('买入：price = (成交额+费用合计)/数量 → (150000+45)/100 = 1500.45', async () => {
      renderForm();
      fillCreateBasics();
      fireEvent.change(screen.getByLabelText('佣金'), {
        target: { value: '45' },
      });

      // 实时展示含费单价（6 位小数显示）
      expect(screen.getByText(/成本价（自动，含费）/)).toBeDefined();
      expect(screen.getByText(/1,500\.45/)).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: '录入' }));

      await waitFor(() => {
        expect(mocks.createTrade).toHaveBeenCalledTimes(1);
      });
      const arg = mocks.createTrade.mock.calls[0][0] as {
        portfolioId: string;
        payload: { price: number; fee: number; quantity: number; side: string };
      };
      expect(arg.payload.side).toBe('BUY_SEC');
      expect(arg.payload.quantity).toBe(100);
      expect(arg.payload.price).toBe(1500.45);
      expect(arg.payload.fee).toBe(0);
    });

    it('卖出：price = (成交额−费用合计)/数量 → (150000−45)/100 = 1499.55', async () => {
      renderForm();
      fillCreateBasics();
      selectSide('SELL_SEC');
      fireEvent.change(screen.getByLabelText('佣金'), {
        target: { value: '45' },
      });

      fireEvent.click(screen.getByRole('button', { name: '录入' }));

      await waitFor(() => {
        expect(mocks.createTrade).toHaveBeenCalledTimes(1);
      });
      const arg = mocks.createTrade.mock.calls[0][0] as {
        payload: { price: number; side: string };
      };
      expect(arg.payload.side).toBe('SELL_SEC');
      expect(arg.payload.price).toBe(1499.55);
    });
  });

  // =========================================================================
  // 卖出费用 > 成交额 → 阻止（C-7）
  // =========================================================================
  describe('卖出费用合计 > 成交额 → 阻止提交（C-7）', () => {
    it('费用合计 1600 > 成交额 1500 → 提示「费用合计不能超过成交额」且不发请求', async () => {
      renderForm();
      fillCreateBasics();
      selectSide('SELL_SEC');
      fireEvent.change(screen.getByLabelText('成交额（元）*'), {
        target: { value: '1500' },
      });
      fireEvent.change(screen.getByLabelText('佣金'), {
        target: { value: '1600' },
      });

      fireEvent.click(screen.getByRole('button', { name: '录入' }));

      await waitFor(() => {
        expect(screen.getByText('费用合计不能超过成交额')).toBeTruthy();
      });
      expect(mocks.createTrade).not.toHaveBeenCalled();
      expect(mocks.createFee).not.toHaveBeenCalled();
    });

    it('买入不受费用>成交额限制（费用并入成本价）', async () => {
      renderForm();
      fillCreateBasics();
      fireEvent.change(screen.getByLabelText('成交额（元）*'), {
        target: { value: '1500' },
      });
      fireEvent.change(screen.getByLabelText('佣金'), {
        target: { value: '1600' },
      });

      fireEvent.click(screen.getByRole('button', { name: '录入' }));

      await waitFor(() => {
        expect(mocks.createTrade).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByText('费用合计不能超过成交额')).toBeNull();
    });
  });

  // =========================================================================
  // 提交序列：先 trade 后 fee（C-4 / K-4 / C-6）
  // =========================================================================
  describe('提交序列：先 POST trade 拿 id → 仅 amount>0 的类型 POST fee', () => {
    it('佣金 45 / 印花税 0 / 其他 0 → 只落 1 条 FeeRecord（COMMISSION）且带 transactionId', async () => {
      renderForm();
      fillCreateBasics();
      fireEvent.change(screen.getByLabelText('佣金'), {
        target: { value: '45' },
      });

      fireEvent.click(screen.getByRole('button', { name: '录入' }));

      await waitFor(() => {
        expect(mocks.createTrade).toHaveBeenCalledTimes(1);
      });
      // 等 fee POST 完成
      await waitFor(() => {
        expect(mocks.createFee).toHaveBeenCalledTimes(1);
      });

      // createFee(portfolioId, payload) —— payload 是第二个入参
      const feeArg = mocks.createFee.mock.calls[0][1] as {
        securityId: string;
        date: string;
        amount: string;
        type: string;
        transactionId: string;
      };
      expect(feeArg.securityId).toBe('s-a');
      expect(feeArg.amount).toBe('45');
      expect(feeArg.type).toBe('COMMISSION');
      // date 与交易一致（YYYY-MM-DD）
      expect(feeArg.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // transactionId = 新建 trade.id（C-4）
      expect(feeArg.transactionId).toBe('trade-1');
    });

    it('三费用都有值 → 落 3 条 FeeRecord（COMMISSION/STAMP_TAX/OTHER）', async () => {
      renderForm();
      fillCreateBasics();
      fireEvent.change(screen.getByLabelText('佣金'), {
        target: { value: '45' },
      });
      fireEvent.change(screen.getByLabelText('印花税'), {
        target: { value: '5' },
      });
      fireEvent.change(screen.getByLabelText('其他'), {
        target: { value: '2' },
      });

      fireEvent.click(screen.getByRole('button', { name: '录入' }));

      await waitFor(() => {
        expect(mocks.createFee).toHaveBeenCalledTimes(3);
      });

      const types = mocks.createFee.mock.calls.map(
        (c) => (c[1] as { type: string }).type,
      );
      expect(types).toEqual(['COMMISSION', 'STAMP_TAX', 'OTHER']);
      // 每条都带同一个 trade.id
      for (const call of mocks.createFee.mock.calls) {
        expect((call[1] as { transactionId: string }).transactionId).toBe(
          'trade-1',
        );
      }
    });

    it('全部费用为 0 → 不落任何 FeeRecord（C-6）', async () => {
      renderForm();
      fillCreateBasics();

      fireEvent.click(screen.getByRole('button', { name: '录入' }));

      await waitFor(() => {
        expect(mocks.createTrade).toHaveBeenCalledTimes(1);
      });
      // 给 fee POST 一点时间窗口
      await new Promise((r) => setTimeout(r, 30));
      expect(mocks.createFee).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 编辑态（U-4 / C-10）
  // =========================================================================
  describe('编辑态：无费用三框 + 存量口径提示', () => {
    it('编辑态不渲染费用三框与成交额输入，改为 含费单价 直编 + 只读成交额', () => {
      renderForm({ trade: TRADE_RESPONSE });

      expect(screen.queryByLabelText('佣金')).toBeNull();
      expect(screen.queryByLabelText('印花税')).toBeNull();
      expect(screen.queryByLabelText('其他')).toBeNull();
      expect(screen.queryByLabelText('成交额（元）*')).toBeNull();
      expect(screen.getByLabelText('含费单价（元）*')).toBeDefined();
      expect(screen.getByText(/成交额（只读换算/)).toBeDefined();
    });

    it('存量 fee≠0 显示口径提示（U-1/C-10）', () => {
      renderForm({ trade: LEGACY_TRADE });

      expect(
        screen.getByText(/旧口径记录/),
      ).toBeDefined();
      expect(screen.getByText(/编辑不改成本口径/)).toBeDefined();
    });

    it('新口径（fee=0）不显示口径提示', () => {
      renderForm({ trade: TRADE_RESPONSE });

      expect(screen.queryByText(/旧口径记录/)).toBeNull();
    });

    it('编辑保存走 updateTrade（payload 无 fee 字段）', async () => {
      mocks.updateTrade.mockResolvedValue(TRADE_RESPONSE);
      renderForm({ trade: TRADE_RESPONSE });

      fireEvent.change(screen.getByLabelText('含费单价（元）*'), {
        target: { value: '1600' },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(mocks.updateTrade).toHaveBeenCalledTimes(1);
      });
      const arg = mocks.updateTrade.mock.calls[0][0] as {
        id: string;
        payload: { price: number; fee?: number };
      };
      expect(arg.id).toBe('trade-1');
      expect(arg.payload.price).toBe(1600);
      expect(arg.payload).not.toHaveProperty('fee');
      // 编辑不触发 FeeRecord 写入（U-4）
      expect(mocks.createFee).not.toHaveBeenCalled();
    });
  });
});
