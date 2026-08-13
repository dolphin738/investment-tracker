/**
 * features/security-trade/security-trade-form.tsx — INC-02 标的回填竞态（编辑态）
 *
 * 背景：编辑态首帧 `useSecurities` 往往还没返回，表单的 `securityId` 虽已由回填
 * effect 写入，但证券搜索框（SecuritySearchCombobox）无键入时展示 `value` 文本。
 * INC-02 修复（§10 改造后保留语义）：受控展示值恒由 `selectedSecurityLabel` 推导——
 * 列表未到 → 「当前标的（加载中…）」；列表已到且含当前标的 → 「名称（代码）」；
 * 已不在列表 → 「当前标的（已不在可选列表）」——保证任意时刻正确回显。
 *
 * 验证点：
 * 1. securities 未加载完（isLoading=true, data=[]）即打开编辑 → 输入框回显保底文案，
 *    且控件不被禁用。
 * 2. securities 已加载且含当前标的 → 输入框回显「名称（代码）」。
 * 3. 无串号：当前标的已不在可选列表时 → 回显「当前标的（已不在可选列表）」，绝不串到其它标的。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SecurityTradeResponse } from '@/api/types';

const mocks = vi.hoisted(() => ({
  createTrade: vi.fn(),
  updateTrade: vi.fn(),
  // 可控标的夹具（组合维度，供 selectedSecurityLabel 回显推导）
  securities: [] as Array<{ id: string; name: string; code: string }>,
  secLoading: false,
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
  commission: '0',
  stampTax: '0',
  other: '0',
  feeTotal: '0',
  note: '建仓',
  createdAt: '2025-07-15T00:00:00.000Z',
  updatedAt: '2025-07-15T00:00:00.000Z',
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

/** 证券搜索框（无键入时回显选中标的文本） */
function securityInput(): HTMLInputElement {
  return document.getElementById('st-security') as HTMLInputElement;
}

describe('INC-02 标的回填竞态（编辑态）', () => {
  beforeEach(() => {
    mocks.createTrade.mockReset();
    mocks.updateTrade.mockReset();
    mocks.createTrade.mockResolvedValue(TRADE);
    mocks.securities = [];
    mocks.secLoading = false;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('securities 未加载完即打开编辑 → 输入框回显「当前标的（加载中…）」，不被禁用', () => {
    mocks.securities = [];
    mocks.secLoading = true;

    renderForm({ trade: TRADE });

    const input = securityInput();
    // 受控展示值恒含 trade.securityId 的推导文案，而非空占位
    expect(input.value).toBe('当前标的（加载中…）');
    // 编辑态即便列表在加载也不禁用（回显不受影响）
    expect(input.disabled).toBe(false);
  });

  it('securities 已加载且含当前标的 → 回显「名称（代码）」', () => {
    mocks.securities = [{ id: 's-a', name: '贵州茅台', code: '600519' }];
    mocks.secLoading = false;

    renderForm({ trade: TRADE });

    expect(securityInput().value).toBe('贵州茅台（600519）');
  });

  it('无串号：当前标的已不在可选列表 → 回显「当前标的（已不在可选列表）」，不串到其它标的', () => {
    mocks.securities = [{ id: 's-b', name: '其它股票', code: '000001' }];
    mocks.secLoading = false;

    renderForm({ trade: TRADE });

    const input = securityInput();
    // 仍回显 trade 自己的标的（s-a），而非列表中的 s-b
    expect(input.value).toBe('当前标的（已不在可选列表）');
    expect(input.value).not.toBe('其它股票（000001）');
  });

  it('加载完成后回填项被真实标的覆盖（不再显示「加载中」）', () => {
    // 先以加载态渲染
    mocks.securities = [];
    mocks.secLoading = true;
    const { rerender } = renderForm({ trade: TRADE });
    expect(securityInput().value).toBe('当前标的（加载中…）');

    // 列表到达
    mocks.securities = [{ id: 's-a', name: '贵州茅台', code: '600519' }];
    mocks.secLoading = false;
    rerender(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter>
          <SecurityTradeForm portfolioId="pf-1" trade={TRADE} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(securityInput().value).toBe('贵州茅台（600519）');
  });
});
