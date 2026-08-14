/**
 * features/security-trade/security-trade-form.tsx — 三项费用物理并表（INC-04）
 *
 * 验证点（对齐增量 PRD INC-03/INC-04 验收）：
 * 1. 提交时 feeTotal = commission + stampTax + other（前端公式提交），
 *    costPrice 按含费单价公式推导（买入=(成交额+费用合计)/数量），
 *    费用三项直接写 security_trades 一行（不再有「删旧 FeeRecord 插新 FeeRecord」逻辑）。
 * 2. 编辑态三项费用正确回填（trade.commission/stampTax/other）。
 *
 * §10 改造后标的通过「搜索 → 选中主数据 → resolve 懒实例化」选择：
 * 测试 mock 掉证券主数据搜索与 resolve 端点，验证选中回填 securityId 后提交链路不变。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SecurityTradeResponse } from '@/api/types';

const mocks = vi.hoisted(() => ({
  createTrade: vi.fn(),
  updateTrade: vi.fn(),
  securities: [] as Array<{ id: string; name: string; code: string }>,
  secLoading: false,
  // 证券主数据搜索（SecuritySearchCombobox 数据源）
  searchMasters: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-securities', () => ({
  useSecurities: () => ({
    data: mocks.securities,
    isLoading: mocks.secLoading,
  }),
  useResolveSecurity: () => ({
    mutate: (_payload: unknown, opts?: { onSuccess?: (r: unknown) => void }) => {
      // 模拟 resolve 端点：选中主数据 → 实例化/命中组合行，回填 id='s-1'
      opts?.onSuccess?.({
        id: 's-1',
        code: '600000',
        name: '测试标的',
        type: 'STOCK',
        exchange: 'SH',
        isNew: true,
      });
    },
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useUpdateSecurity: () => ({
    mutate: vi.fn(),
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

// 证券主数据搜索：返回一条候选（名称/代码/交易所/类型）
vi.mock('@/api/security-master.api', () => ({
  listSecurityMasters: mocks.searchMasters,
  syncSecurityMasters: vi.fn(),
}));

// 方向字段仍用 Radix Select；测试不与其交互，保留原生替身 mock 规避 jsdom 渲染差异
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

const TRADE: SecurityTradeResponse = {
  id: 'trade-1',
  portfolioId: 'pf-1',
  securityId: 's-a',
  date: '2025-07-15',
  side: 'BUY_SEC',
  quantity: '100',
  costPrice: '1500.45',
  commission: '3',
  stampTax: '1.5',
  other: '0.5',
  feeTotal: '5',
  note: '建仓',
  createdAt: '2025-07-15T00:00:00.000Z',
  updatedAt: '2025-07-15T00:00:00.000Z',
};

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderForm(props: { trade?: SecurityTradeResponse | null } = {}): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter>
        <SecurityTradeForm portfolioId="pf-1" trade={props.trade} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function securityInput(): HTMLInputElement {
  return document.getElementById('st-security') as HTMLInputElement;
}

/** 通过搜索框选择标的：键入 code → 等待候选 → 点击（触发 resolve 回填 securityId） */
async function pickSecurityBySearch(code: string): Promise<void> {
  fireEvent.change(securityInput(), { target: { value: code } });
  const candidate = await screen.findByRole('button', { name: /测试标的/ });
  fireEvent.click(candidate);
}

describe('证券买卖录入 · 三项费用物理并表（INC-03/INC-04）', () => {
  beforeEach(() => {
    mocks.createTrade.mockReset();
    mocks.updateTrade.mockReset();
    mocks.searchMasters.mockReset();
    mocks.createTrade.mockResolvedValue({ id: 'new-id' });
    mocks.securities = [{ id: 's-1', name: '测试标的', code: '600000' }];
    mocks.secLoading = false;
    mocks.searchMasters.mockResolvedValue({
      items: [
        {
          id: 'm-1',
          code: '600000',
          name: '测试标的',
          exchange: 'SH',
          type: 'STOCK',
          updatedAt: '2026-08-13T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('提交时 feeTotal = 三项之和，costPrice 由含费单价公式推导，直接写 security_trades（无 FeeRecord 痕迹）', async () => {
    renderForm();

    // 标的：搜索 → 选中主数据 → resolve 回填 securityId='s-1'
    await pickSecurityBySearch('600000');
    expect(securityInput().value).toBe('测试标的（600000）');

    // 数量 / 成交额 / 三项费用
    fireEvent.change(document.getElementById('st-quantity') as HTMLInputElement, {
      target: { value: '100' },
    });
    fireEvent.change(document.getElementById('st-trade-amount') as HTMLInputElement, {
      target: { value: '100000' },
    });
    fireEvent.change(document.getElementById('st-commission') as HTMLInputElement, {
      target: { value: '3' },
    });
    fireEvent.change(document.getElementById('st-stamp-tax') as HTMLInputElement, {
      target: { value: '1.5' },
    });
    fireEvent.change(document.getElementById('st-other') as HTMLInputElement, {
      target: { value: '0.5' },
    });

    fireEvent.click(screen.getByRole('button', { name: '录入' }));

    await waitFor(() => expect(mocks.createTrade).toHaveBeenCalledTimes(1));
    const payload = (mocks.createTrade.mock.calls[0][0] as { payload: Record<string, unknown> })
      .payload;

    // resolve 回填的 securityId 被正确提交
    expect(payload.securityId).toBe('s-1');
    // feeTotal = 3 + 1.5 + 0.5 = 5
    expect(payload.commission).toBe(3);
    expect(payload.stampTax).toBe(1.5);
    expect(payload.other).toBe(0.5);
    expect(payload.feeTotal).toBe(5);
    // 买入含费单价 = (成交额 100000 + 费用合计 5) / 数量 100 = 1000.05
    expect(payload.costPrice).toBe(1000.05);
    // 物理并表：直接写 security_trades 行，无 fee/price 旧字段
    expect(payload).not.toHaveProperty('fee');
    expect(payload).not.toHaveProperty('price');
  });

  it('编辑态三项费用正确回填（trade.commission/stampTax/other）', () => {
    renderForm({ trade: TRADE });

    expect((document.getElementById('st-commission') as HTMLInputElement).value).toBe('3');
    expect((document.getElementById('st-stamp-tax') as HTMLInputElement).value).toBe('1.5');
    expect((document.getElementById('st-other') as HTMLInputElement).value).toBe('0.5');
    // 费用合计预览 = 5
    expect(screen.getByTestId('fee-total').textContent).toContain('5');
  });
});
