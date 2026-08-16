/**
 * HoldingsToolbar — I-05 统一筛选器（纯受控组件）单元测试
 *
 * 覆盖（增量 PRD I-05 验收 1/3/4/6 + I-06 联动验收 8）：
 * 1. 统一筛选器容器渲染：标题「统一筛选器」+ 口径提示 + 全部维度控件齐备
 * 2. 快捷范围下拉（DateRangeQuickPicker）变更 → onChange({ range, from:'', to:'' })
 * 3. as-of 单点输入变更 → onChange({ date })（持仓日期能力保留：默认今日、min/max 校验）
 * 4. 证券多选切换 → onChange({ sec })（含已选计数徽标）
 * 5. 场景下拉 → onChange({ scenario })，且持仓板块不适用（控件仍在但语义置灰/隐藏由页面处理）
 * 6. 持仓专属折叠区：类型多选 + 显示已清仓开关
 *
 * 说明：Radix Select 在 jsdom 下无法展开，按既有做法 mock @/components/ui/select
 * 为原生 <select> 替身（同 dividend-fee-tax.test.tsx）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SecurityType } from '@/lib/types';
import { FeeScenario } from '@/api/types';
import { HoldingsToolbar } from '../holdings-toolbar';
import type { HoldingsFilterState } from '../holdings-query-params';
import type { Security } from '@/api/types';

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

const SECURITIES: Security[] = [
  { id: 's-a', name: '甲股票', code: '600000', type: SecurityType.STOCK },
  { id: 's-b', name: '乙基金', code: '000002', type: SecurityType.ON_EXCHANGE_FUND },
] as unknown as Security[];

const BASE_STATE: HoldingsFilterState = {
  date: '2026-06-15',
  closed: false,
  types: [],
  sec: [],
  scenario: 'all',
  range: '1y',
  from: '',
  to: '',
};

function renderToolbar(
  overrides: Partial<HoldingsFilterState> = {},
  onChange = vi.fn(),
) {
  return render(
    <HoldingsToolbar
      value={{ ...BASE_STATE, ...overrides }}
      onChange={onChange}
      minDate="2024-01-01"
      allRangeStart="2024-01-01"
      securities={SECURITIES}
    />,
  );
}

/**
 * 定位「持仓日期（as-of）」单点输入。
 * 注意：HoldingsToolbar 的 Label 未设 htmlFor、Input 未设 id，
 * 不能 getByLabelText；按「label 所在容器内唯一的 date input」定位。
 */
function getAsOfInput(): HTMLInputElement {
  const label = screen.getByText('持仓日期（as-of）');
  const wrap = label.parentElement as HTMLElement;
  const input = wrap.querySelector('input[type="date"]');
  if (!input) throw new Error('未找到 as-of 日期输入');
  return input as HTMLInputElement;
}

describe('HoldingsToolbar — I-05 统一筛选器', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('容器渲染：标题「统一筛选器」+ 口径提示 + 唯一 data-testid', () => {
    renderToolbar();

    expect(screen.getByText('统一筛选器')).toBeDefined();
    expect(
      screen.getByText('持仓板块以持仓日期为准，买卖明细 / 分红费用以日期范围为准'),
    ).toBeDefined();
    expect(screen.getAllByTestId('holdings-unified-filter')).toHaveLength(1);
  });

  it('快捷范围下拉存在（7 项由 DateRangeQuickPicker 提供，I-06 联动）且变更回调携带 range', () => {
    const onChange = vi.fn();
    renderToolbar({}, onChange);

    // 容器内第一个 <select> = DateRangeQuickPicker 的快捷范围
    const container = document.querySelector('[data-testid="holdings-unified-filter"]')!;
    const selects = container.querySelectorAll('select');
    expect(selects.length).toBeGreaterThanOrEqual(2);
    const quickSelect = selects[0];
    // 7 项快捷范围 + 1 占位 option
    expect(quickSelect.querySelectorAll('option').length).toBe(8);
    expect(screen.getByText('快捷范围')).toBeDefined();

    fireEvent.change(quickSelect, { target: { value: '1m' } });
    expect(onChange).toHaveBeenCalledWith({ range: '1m', from: '', to: '' });
  });

  it('as-of 单点输入：变更回调携带 date（持仓日期能力保留：min/max 已设）', () => {
    const onChange = vi.fn();
    renderToolbar({}, onChange);

    const asOfInput = getAsOfInput();
    expect(asOfInput.type).toBe('date');
    expect(asOfInput.value).toBe('2026-06-15');
    expect(asOfInput.min).toBe('2024-01-01');

    fireEvent.change(asOfInput, { target: { value: '2026-06-01' } });
    expect(onChange).toHaveBeenCalledWith({ date: '2026-06-01' });
  });

  it('证券多选：文本框模糊匹配 + 勾选回调携带 sec 数组', () => {
    // 选中态：placeholder 显示已选计数「已选 1 项」（I-05 升级：文本框替代原「全部证券」按钮）
    const onChangeA = vi.fn();
    renderToolbar({ sec: ['s-a'] }, onChangeA);
    expect(screen.getByPlaceholderText('已选 1 项')).toBeDefined();

    // 空态：placeholder 提示「搜索代码或名称」
    cleanup();
    const onChange = vi.fn();
    renderToolbar({}, onChange);
    const secInput = screen.getByPlaceholderText(
      '搜索代码或名称',
    ) as HTMLInputElement;
    expect(secInput).toBeDefined();

    // 文本框模糊匹配：输入「股」过滤出甲股票（code/name 覆盖全部标的类型）
    fireEvent.change(secInput, { target: { value: '股' } });
    fireEvent.focus(secInput);
    expect(screen.getByText('甲股票')).toBeDefined();
    expect(screen.queryByText('乙基金')).toBeNull();

    // 勾选面板第一项（甲股票）→ onChange({ sec: ['s-a'] })
    const checkboxes = document.querySelectorAll(
      '[data-testid="holdings-unified-filter"] input[type="checkbox"]',
    );
    fireEvent.click(checkboxes[0]);
    expect(onChange).toHaveBeenCalledWith({ sec: ['s-a'] });
  });

  it('场景下拉：全部/买入/卖出，变更回调携带 scenario', () => {
    const onChange = vi.fn();
    renderToolbar({}, onChange);

    const container = document.querySelector('[data-testid="holdings-unified-filter"]')!;
    const selects = container.querySelectorAll('select');
    const scenarioSelect = selects[1]; // [0]=快捷范围, [1]=场景
    expect(Array.from(scenarioSelect.querySelectorAll('option')).map((o) => o.value)).toEqual([
      '',
      'all',
      FeeScenario.BUY,
      FeeScenario.SELL,
    ]);

    fireEvent.change(scenarioSelect, { target: { value: FeeScenario.BUY } });
    expect(onChange).toHaveBeenCalledWith({ scenario: FeeScenario.BUY });
  });

  it('持仓专属折叠区：展开后类型多选 + 显示已清仓开关可操作', () => {
    const onChange = vi.fn();
    renderToolbar({}, onChange);

    // 折叠区默认收起
    expect(screen.queryByText('显示已清仓')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /展开持仓选项/ }));
    expect(screen.getByText('显示已清仓')).toBeDefined();

    // 类型多选：先展开「全部类型」面板，勾选第一项（股票）
    fireEvent.click(screen.getByRole('button', { name: /全部类型/ }));
    const typeCheckboxes = document.querySelectorAll(
      '[data-testid="holdings-unified-filter"] input[type="checkbox"]',
    );
    fireEvent.click(typeCheckboxes[0]);
    expect(onChange).toHaveBeenCalledWith({ types: [SecurityType.STOCK] });

    // 显示已清仓开关
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith({ closed: true });
  });

  it('回显：value.sec/scenario/date/closed 均正确反映到控件', () => {
    renderToolbar({
      date: '2026-05-01',
      sec: ['s-b'],
      scenario: FeeScenario.SELL,
      closed: true,
      types: [SecurityType.ON_EXCHANGE_FUND],
      range: '3m',
    });

    expect(getAsOfInput().value).toBe('2026-05-01');
    // 已选计数反映到文本框 placeholder（I-05 升级：文本框替代原徽标）
    expect(screen.getByPlaceholderText('已选 1 项')).toBeDefined();

    const container = document.querySelector('[data-testid="holdings-unified-filter"]')!;
    const selects = container.querySelectorAll('select');
    expect((selects[1] as HTMLSelectElement).value).toBe(FeeScenario.SELL);

    fireEvent.click(screen.getByRole('button', { name: /展开持仓选项/ }));
    expect(
      (screen.getByRole('switch') as HTMLButtonElement).getAttribute('data-state'),
    ).toBe('checked');
  });
});
