/**
 * 分红表单增量验收（R-2 / R-5 / K-1 / K-2）
 *
 * 覆盖：
 * 1. 表单含「分红额（税前）/ 所得税 / 净额（自动）」字段
 * 2. 净额实时 = 税前 − 税（整数分运算无浮点毛刺，DOM 文本断言）
 * 3. 税 > 税前 → 阻止提交（净额不能为负）
 * 4. 税为负 → 阻止提交
 * 5. 编辑态：record 预填 → 保存走 PATCH（payload 带 tax）
 *
 * ⚠️ Radix Select 在 jsdom 下无法展开，按既有做法把 @/components/ui/select
 *    mock 为原生 <select> 替身；被测表单 value/onValueChange 链路仍真实执行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DividendRecord } from '@/api/types';

// ---------------------------------------------------------------------------
// 可变夹具槽 + mock
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  createDividend: vi.fn(),
  updateDividend: vi.fn(),
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
  useCreateDividend: () => ({
    mutateAsync: state.createDividend,
    isPending: false,
  }),
  useUpdateDividend: () => ({
    mutateAsync: state.updateDividend,
    isPending: false,
  }),
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
  useCreateFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

  /** 深度遍历 children，收集所有 SelectItem 的 value 与文本 */
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

  /** 找到 SelectTrigger 上的 id，透传给原生 select（保持 label 关联） */
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

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const EDIT_RECORD: DividendRecord = {
  id: 'div-1',
  portfolioId: 'pf-1',
  securityId: 's-a',
  securityName: '贵州茅台',
  securityCode: '600519',
  date: '2025-07-15',
  type: 'CASH',
  amount: '1500.00',
  tax: '300.00',
  netAmount: '1200.00',
  note: '中期分红',
  createdAt: '2025-07-16T00:00:00.000Z',
} as DividendRecord;

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderForm(props: {
  kind?: 'dividend' | 'fee';
  record?: DividendRecord | null;
} = {}) {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter>
        <DividendFeeForm
          portfolioId="pf-1"
          kind={props.kind ?? 'dividend'}
          record={props.record}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 录入最小合法分红（选标的 + 金额），返回后由用例继续填税/提交 */
function fillDividendBasics(): void {
  const securitySelect = document.getElementById(
    'income-security',
  ) as HTMLSelectElement;
  fireEvent.change(securitySelect, { target: { value: 's-a' } });
  fireEvent.change(screen.getByLabelText('分红额（税前）*'), {
    target: { value: '1500' },
  });
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
describe('分红表单增量（所得税 + 净额 + 编辑态）', () => {
  beforeEach(() => {
    state.createDividend = vi.fn().mockResolvedValue({});
    state.updateDividend = vi.fn().mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // =========================================================================
  // 字段构成 + 净额实时展示
  // =========================================================================
  describe('字段与净额实时展示（R-2 / K-1）', () => {
    it('表单含「分红额（税前）*」「所得税 *」「净额（自动）」', () => {
      renderForm();

      expect(screen.getByLabelText('分红额（税前）*')).toBeDefined();
      expect(screen.getByLabelText('所得税（可选）')).toBeDefined();
      expect(screen.getByText('净额（自动）')).toBeDefined();
    });

    it('净额实时 = 税前 − 税（1500 − 300 → ¥1,200.00）', () => {
      renderForm();
      fillDividendBasics();

      fireEvent.change(screen.getByLabelText('所得税（可选）'), {
        target: { value: '300' },
      });

      const net = screen.getByTestId('dividend-net-amount');
      expect(net.textContent).toBe('¥1,200.00');
    });

    it('税未填时净额 = 税前（1500 → ¥1,500.00）', () => {
      renderForm();
      fillDividendBasics();

      const net = screen.getByTestId('dividend-net-amount');
      expect(net.textContent).toBe('¥1,500.00');
    });

    it('金额精度：0.10 + 0.20 类毛刺不出现（税 0.20、金额 0.30 → ¥0.10）', () => {
      renderForm();

      fireEvent.change(screen.getByLabelText('分红额（税前）*'), {
        target: { value: '0.30' },
      });
      fireEvent.change(screen.getByLabelText('所得税（可选）'), {
        target: { value: '0.20' },
      });

      const net = screen.getByTestId('dividend-net-amount');
      expect(net.textContent).toBe('¥0.10');
      expect(net.textContent).not.toContain('0000');
    });
  });

  // =========================================================================
  // 税 > 金额 / 税为负 → 阻止提交
  // =========================================================================
  describe('净额校验（K-1：税 > 税前 → 阻止）', () => {
    it('税 > 税前 → 显示「净额不能为负」且不发请求', async () => {
      renderForm();
      fillDividendBasics();

      fireEvent.change(screen.getByLabelText('所得税（可选）'), {
        target: { value: '1600' },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(screen.getByText('净额不能为负')).toBeTruthy();
      });
      expect(state.createDividend).not.toHaveBeenCalled();
    });

    it('税为负 → 显示「所得税不能为负」且不发请求', async () => {
      renderForm();
      fillDividendBasics();

      fireEvent.change(screen.getByLabelText('所得税（可选）'), {
        target: { value: '-1' },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(screen.getByText('所得税不能为负')).toBeTruthy();
      });
      expect(state.createDividend).not.toHaveBeenCalled();
    });

    it('税超过 2 位小数 → 显示「所得税最多 2 位小数」且不发请求', async () => {
      renderForm();
      fillDividendBasics();

      fireEvent.change(screen.getByLabelText('所得税（可选）'), {
        target: { value: '1.234' },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(screen.getByText('所得税最多 2 位小数')).toBeTruthy();
      });
      expect(state.createDividend).not.toHaveBeenCalled();
    });

    it('合法提交：payload 含 tax 字符串（1500 + 300）', async () => {
      renderForm();
      fillDividendBasics();

      fireEvent.change(screen.getByLabelText('所得税（可选）'), {
        target: { value: '300' },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(state.createDividend).toHaveBeenCalledTimes(1);
      });
      const payload = state.createDividend.mock.calls[0][0] as {
        securityId: string;
        amount: string;
        tax: string;
        type: string;
      };
      expect(payload.securityId).toBe('s-a');
      expect(payload.amount).toBe('1500');
      expect(payload.tax).toBe('300');
      expect(payload.type).toBe('CASH');
    });
  });

  // =========================================================================
  // 编辑态（R-5）：record 预填 → PATCH
  // =========================================================================
  describe('编辑态（record 预填 → PATCH）', () => {
    it('record 传入后字段预填（金额/税/日期/标的/备注）', () => {
      renderForm({ record: EDIT_RECORD });

      expect(
        (screen.getByLabelText('分红额（税前）*') as HTMLInputElement).value,
      ).toBe('1500.00');
      expect(
        (screen.getByLabelText('所得税（可选）') as HTMLInputElement).value,
      ).toBe('300.00');
      expect(
        (document.getElementById('income-security') as HTMLSelectElement).value,
      ).toBe('s-a');
      expect(
        (screen.getByLabelText('备注') as HTMLTextAreaElement).value,
      ).toBe('中期分红');
    });

    it('编辑提交走 updateDividend（id + payload 含 tax），不走 createDividend', async () => {
      renderForm({ record: EDIT_RECORD });

      fireEvent.change(screen.getByLabelText('分红额（税前）*'), {
        target: { value: '1800' },
      });
      fireEvent.change(screen.getByLabelText('所得税（可选）'), {
        target: { value: '360' },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(state.updateDividend).toHaveBeenCalledTimes(1);
      });
      expect(state.createDividend).not.toHaveBeenCalled();

      const args = state.updateDividend.mock.calls[0][0] as {
        id: string;
        payload: {
          securityId: string;
          amount: string;
          tax: string;
          type: string;
        };
      };
      expect(args.id).toBe('div-1');
      expect(args.payload.securityId).toBe('s-a');
      expect(args.payload.amount).toBe('1800');
      expect(args.payload.tax).toBe('360');
      // 🔴 I-02 P0 根因：编辑分红 payload 必须携带 type，
      // 否则后端 forbidNonWhitelisted 报「property type should not exist」400
      expect(args.payload.type).toBe('CASH');
    });

    it('编辑态净额同样实时重算（1800 − 360 → ¥1,440.00）', () => {
      renderForm({ record: EDIT_RECORD });

      fireEvent.change(screen.getByLabelText('分红额（税前）*'), {
        target: { value: '1800' },
      });
      fireEvent.change(screen.getByLabelText('所得税（可选）'), {
        target: { value: '360' },
      });

      const net = screen.getByTestId('dividend-net-amount');
      expect(net.textContent).toBe('¥1,440.00');
    });
  });
});
