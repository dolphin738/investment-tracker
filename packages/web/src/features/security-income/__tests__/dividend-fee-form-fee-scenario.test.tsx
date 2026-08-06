/**
 * DividendFeeForm（费用模式）— I-03 场景选择器 + 费用编辑
 *
 * 覆盖（增量 PRD I-03 验收 5/6 + 架构 §4.2.3）：
 * 1. 费用模式渲染「场景 *」必填选择器（买入时 / 卖出时，缺省 BUY）
 * 2. 提交 payload 携带 scenario（BUY/SELL）
 * 3. 费用编辑（record 为 FeeRecord）→ 场景回填 + 走 updateFee（PATCH /fees/:id）
 *
 * 说明：Radix Select mock 为原生 <select> 替身（同 dividend-fee-tax.test.tsx）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FeeRecord } from '@/api/types';
import { FeeScenario, FeeType } from '@/api/types';

const state = vi.hoisted(() => ({
  createFee: vi.fn(),
  updateFee: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-securities', () => ({
  useSecurities: () => ({
    data: [
      { id: 's-a', name: '贵州茅台', code: '600519' },
      { id: 's-b', name: '乙基金', code: '000002' },
    ],
    isLoading: false,
  }),
  useCreateSecurity: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
  useFees: () => ({
    data: [],
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
  useCreateFee: () => ({ mutateAsync: state.createFee, isPending: false }),
  useUpdateFee: () => ({ mutateAsync: state.updateFee, isPending: false }),
  useDeleteFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

import { DividendFeeForm } from '@/features/security-income/dividend-fee-form';

const EDIT_FEE: FeeRecord = {
  id: 'fee-1',
  portfolioId: 'pf-1',
  securityId: 's-a',
  securityName: '贵州茅台',
  securityCode: '600519',
  date: '2025-08-01',
  type: 'COMMISSION',
  scenario: FeeScenario.SELL,
  amount: '5.00',
  transactionId: null,
  note: '卖出佣金',
  createdAt: '2025-08-01T00:00:00.000Z',
} as FeeRecord;

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderFeeForm(record?: FeeRecord | null) {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter>
        <DividendFeeForm portfolioId="pf-1" kind="fee" record={record} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillFeeBasics(): void {
  const securitySelect = document.getElementById(
    'income-security',
  ) as HTMLSelectElement;
  fireEvent.change(securitySelect, { target: { value: 's-a' } });
  fireEvent.change(screen.getByLabelText('费用金额 *'), {
    target: { value: '5.00' },
  });
}

describe('DividendFeeForm（费用模式）— I-03 场景选择器', () => {
  beforeEach(() => {
    state.createFee = vi.fn().mockResolvedValue({});
    state.updateFee = vi.fn().mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('费用模式渲染「场景 *」选择器（买入时 / 卖出时），缺省 BUY', () => {
    renderFeeForm();

    const select = screen.getByLabelText('场景 *') as HTMLSelectElement;
    expect(select).toBeDefined();
    const options = Array.from(select.querySelectorAll('option')).filter(
      (o) => o.value !== '',
    );
    expect(options.map((o) => o.value)).toEqual([FeeScenario.BUY, FeeScenario.SELL]);
    expect(options.map((o) => o.textContent?.trim())).toEqual(['买入时', '卖出时']);
    expect(select.value).toBe(FeeScenario.BUY);
  });

  it('提交 payload 携带 scenario（显式选 SELL）', async () => {
    renderFeeForm();
    fillFeeBasics();

    fireEvent.change(screen.getByLabelText('场景 *'), {
      target: { value: FeeScenario.SELL },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(state.createFee).toHaveBeenCalledTimes(1);
    });
    const payload = state.createFee.mock.calls[0][0] as {
      securityId: string;
      amount: string;
      type: string;
      scenario: string;
    };
    expect(payload.securityId).toBe('s-a');
    expect(payload.amount).toBe('5.00');
    expect(payload.type).toBe(FeeType.OTHER);
    expect(payload.scenario).toBe(FeeScenario.SELL);
  });

  it('费用编辑态：场景回填 SELL，保存走 updateFee（PATCH /fees/:id）且 payload 含 scenario', async () => {
    renderFeeForm(EDIT_FEE);

    const scenarioSelect = screen.getByLabelText('场景 *') as HTMLSelectElement;
    expect(scenarioSelect.value).toBe(FeeScenario.SELL);
    expect(
      (screen.getByLabelText('费用金额 *') as HTMLInputElement).value,
    ).toBe('5.00');

    fireEvent.change(screen.getByLabelText('费用金额 *'), {
      target: { value: '8.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(state.updateFee).toHaveBeenCalledTimes(1);
    });
    expect(state.createFee).not.toHaveBeenCalled();
    const args = state.updateFee.mock.calls[0][0] as {
      id: string;
      payload: { amount: string; scenario: string };
    };
    expect(args.id).toBe('fee-1');
    expect(args.payload.amount).toBe('8.00');
    expect(args.payload.scenario).toBe(FeeScenario.SELL);
  });
});
