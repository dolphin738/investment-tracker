/**
 * components/date/date-range-quick-picker.tsx — INC-01 受控行为与统一文案（T-7 补充）
 *
 * 验证点（对齐 INC-01 验收）：
 * 1. 起止标签统一为「开始日期 / 结束日期」（全站唯一口径）。
 * 2. 受控 quick：传快捷值 → 下拉回显该项；传 '' 或未知值 → 落占位（= 不限）。
 * 3. 空值 '' = 不限：起止日期输入框为空串。
 * 4. 手动改日期（受控模式）→ onChange 的 quick 为 undefined（回显回落占位）。
 *
 * 时间控制：resolveQuickRange 读 `new Date()`，用 fake timers 钉死系统时间。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { DateRangeQuickPicker } from '@/components/date/date-range-quick-picker';

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
  const SelectTrigger = ({ children, ...rest }: { children?: React.ReactNode }) =>
    React.createElement('span', rest, children);

  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children?: React.ReactNode;
  }) =>
    React.createElement(
      'select',
      {
        value: value ?? '',
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
          onValueChange?.(e.target.value),
      },
      [
        React.createElement('option', { key: '__ph', value: '' }, ''),
        ...(() => {
          const items: Array<{ value: string; label: string }> = [];
          collectItems(children, items);
          return items.map((i) =>
            React.createElement('option', { key: i.value, value: i.value }, i.label),
          );
        })(),
      ],
    );

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

const BASE_NOW = new Date(2026, 5, 15, 12, 0, 0);
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(BASE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('DateRangeQuickPicker — INC-01 统一起止标签', () => {
  it('默认标签为「开始日期 / 结束日期」', () => {
    render(<DateRangeQuickPicker startDate="" endDate="" onChange={() => {}} />);
    expect(screen.getByText('开始日期')).toBeDefined();
    expect(screen.getByText('结束日期')).toBeDefined();
  });
});

describe('DateRangeQuickPicker — 受控 quick 回显', () => {
  it('受控 quick="1m" → 快捷下拉选中「近1月」', () => {
    render(
      <DateRangeQuickPicker startDate="" endDate="" quick="1m" onChange={() => {}} />,
    );
    const sel = screen.getByRole('combobox') as HTMLSelectElement;
    expect(sel.value).toBe('1m');
  });

  it('受控 quick="" → 下拉落占位（value 空 = 不限）', () => {
    render(
      <DateRangeQuickPicker startDate="" endDate="" quick="" onChange={() => {}} />,
    );
    const sel = screen.getByRole('combobox') as HTMLSelectElement;
    expect(sel.value).toBe('');
  });

  it('受控 quick="custom"（未知值）→ 下拉落占位', () => {
    render(
      <DateRangeQuickPicker
        startDate=""
        endDate=""
        quick="custom"
        onChange={() => {}}
      />,
    );
    const sel = screen.getByRole('combobox') as HTMLSelectElement;
    expect(sel.value).toBe('');
  });
});

describe('DateRangeQuickPicker — 空值 = 不限', () => {
  it('起止日期为空串 → 输入框值为空', () => {
    const { container } = render(
      <DateRangeQuickPicker startDate="" endDate="" onChange={() => {}} />,
    );
    const inputs = container.querySelectorAll('input[type="date"]');
    expect((inputs[0] as HTMLInputElement).value).toBe('');
    expect((inputs[1] as HTMLInputElement).value).toBe('');
  });
});

describe('DateRangeQuickPicker — 受控模式手动改日期', () => {
  it('改起始日 → onChange 携带 quick=undefined（回显回落占位）', () => {
    const onChange = vi.fn();
    const { container } = render(
      <DateRangeQuickPicker
        startDate=""
        endDate="2026-06-15"
        quick="1m"
        onChange={onChange}
      />,
    );
    const startInput = container.querySelectorAll('input[type="date"]')[0];
    fireEvent.change(startInput, { target: { value: '2026-03-01' } });
    expect(onChange).toHaveBeenCalledWith({
      startDate: '2026-03-01',
      endDate: '2026-06-15',
      quick: undefined,
    });
  });

  it('选中快捷项 → onChange 携带 quick（即便之前手动改过）', () => {
    const onChange = vi.fn();
    render(
      <DateRangeQuickPicker
        startDate=""
        endDate=""
        quick=""
        onChange={onChange}
      />,
    );
    const sel = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'all' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ quick: 'all' }),
    );
  });
});
