/**
 * features/query/dimension-switcher.tsx — 维度切换 + 内嵌统一日期范围控件（INC-01 决策 G）
 *
 * 验证点：
 * 1. `toDimensionQueryParams` 必须剥离仅用于 UI 回显的 `quick` 字段 —— 否则后端
 *    ValidationPipe(forbidNonWhitelisted) 会因多出 `quick` 键返回 400。
 * 2. 内嵌全站唯一控件 `DateRangeQuickPicker`：渲染「快捷范围 / 开始日期 / 结束日期」
 *    且受控 quick 回显（value.quick 透传）。
 * 3. 不再自绘第二套范围 UI（无独立 quickRange state / 无第二处 Select+Input 范围组合）。
 * 4. Tabs（维度）与 Select（聚合方式）正常 onChange。
 *
 * ⚠️ Radix Select / Tabs 均 mock 为原生替身（同其他组件测试）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GRANULARITY_OPTIONS, AGGREGATION_OPTIONS } from '@/lib/constants';
import {
  DimensionSwitcher,
  toDimensionQueryParams,
  type DimensionSwitcherValue,
} from '@/features/query/dimension-switcher';

// ---------------------------------------------------------------------------
// Radix Select 替身（原生 <select>）
// ---------------------------------------------------------------------------
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
  }) => {
    const items: Array<{ value: string; label: string }> = [];
    collectItems(children, items);
    return React.createElement(
      'select',
      {
        value: value ?? '',
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

// ---------------------------------------------------------------------------
// Radix Tabs 替身（TabsTrigger → <button role=tab>，点击调用 onValueChange）
// ---------------------------------------------------------------------------
vi.mock('@/components/ui/tabs', async () => {
  const React = await import('react');
  const Ctx = React.createContext<{
    value?: string;
    onValueChange?: (v: string) => void;
  } | null>(null);

  const Tabs = ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children?: React.ReactNode;
  }) =>
    React.createElement(Ctx.Provider, { value: { value, onValueChange } }, children);

  const TabsList = ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', { role: 'tablist' }, children);

  const TabsTrigger = ({
    value,
    children,
  }: {
    value: string;
    children?: React.ReactNode;
  }) => {
    const ctx = React.useContext(Ctx);
    return React.createElement(
      'button',
      {
        role: 'tab',
        type: 'button',
        onClick: () => ctx?.onValueChange?.(value),
      },
      children,
    );
  };

  return { Tabs, TabsList, TabsTrigger };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const BASE_VALUE: DimensionSwitcherValue = {
  granularity: 'month',
  startDate: '',
  endDate: '',
  aggregation: 'last',
  quick: '',
};

// ───────────────────────────────────────────────────────────────────────────
// 1) toDimensionQueryParams 剥离 quick（防后端 400）
// ───────────────────────────────────────────────────────────────────────────
describe('toDimensionQueryParams — 剥离 quick 防后端 400', () => {
  it('返回结果不含 quick 字段', () => {
    const value: DimensionSwitcherValue = { ...BASE_VALUE, quick: '1y' };
    const params = toDimensionQueryParams(value);
    expect('quick' in params).toBe(false);
  });

  it('granularity/startDate/endDate/aggregation 原样保留', () => {
    const value: DimensionSwitcherValue = {
      granularity: 'week',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      aggregation: 'avg',
      quick: '3m',
    };
    expect(toDimensionQueryParams(value)).toEqual({
      granularity: 'week',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      aggregation: 'avg',
    });
  });

  it('quick 为 undefined 也不出现在结果中', () => {
    const params = toDimensionQueryParams({ ...BASE_VALUE });
    expect(Object.keys(params).sort()).toEqual([
      'aggregation',
      'endDate',
      'granularity',
      'startDate',
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2) 内嵌 DateRangeQuickPicker + 受控 quick 回显
// ───────────────────────────────────────────────────────────────────────────
describe('DimensionSwitcher — 内嵌统一日期范围控件', () => {
  it('渲染内嵌的「快捷范围 / 开始日期 / 结束日期」与维度/聚合', () => {
    render(<DimensionSwitcher value={BASE_VALUE} onChange={() => {}} />);
    expect(screen.getByText('快捷范围')).toBeDefined();
    expect(screen.getByText('开始日期')).toBeDefined();
    expect(screen.getByText('结束日期')).toBeDefined();
    expect(screen.getByText('维度')).toBeDefined();
  });

  it('受控 quick 透传到内嵌控件：value.quick="1m" → 快捷下拉选中「近1月」', () => {
    render(
      <DimensionSwitcher value={{ ...BASE_VALUE, quick: '1m' }} onChange={() => {}} />,
    );
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const quickSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === '1m'),
    );
    expect(quickSelect).toBeDefined();
    expect(quickSelect!.value).toBe('1m');
  });

  it('空 quick 不选中任何预设（下拉落到占位）', () => {
    render(<DimensionSwitcher value={BASE_VALUE} onChange={() => {}} />);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const quickSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === '1m'),
    );
    expect(quickSelect!.value).toBe('');
  });

  it('选中快捷项 → onChange 携带 quick（其余字段保留）', () => {
    const onChange = vi.fn();
    render(<DimensionSwitcher value={BASE_VALUE} onChange={onChange} />);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const quickSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === '3m'),
    )!;
    fireEvent.change(quickSelect, { target: { value: '3m' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ quick: '3m', granularity: 'month', aggregation: 'last' }),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3) 不再自绘第二套范围 UI
// ───────────────────────────────────────────────────────────────────────────
describe('DimensionSwitcher — 不再自绘范围 UI（INC-01 决策 G）', () => {
  it('源码不含独立的 quickRange 本地状态（已删除私有 Select+Input 范围组合）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.resolve(__dirname, '../dimension-switcher.tsx');
    const src = fs.readFileSync(file, 'utf-8');
    expect(src).not.toMatch(/const\s+quickRange\s*=/);
    // 内嵌 DateRangeQuickPicker（唯一控件）
    expect(src).toMatch(/<DateRangeQuickPicker/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4) Tabs / Select 正常 onChange
// ───────────────────────────────────────────────────────────────────────────
describe('DimensionSwitcher — Tabs / Select 正常交互', () => {
  it('切换维度 Tabs → onChange 携带新 granularity', () => {
    const onChange = vi.fn();
    render(<DimensionSwitcher value={BASE_VALUE} onChange={onChange} />);
    const target = GRANULARITY_OPTIONS.find((o) => o.value !== 'month')!;
    fireEvent.click(screen.getByRole('tab', { name: target.label }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: target.value }),
    );
  });

  it('切换聚合方式 Select → onChange 携带新 aggregation', () => {
    const onChange = vi.fn();
    render(<DimensionSwitcher value={BASE_VALUE} onChange={onChange} />);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const aggSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value !== 'last'),
    )!;
    const target = AGGREGATION_OPTIONS.find((o) => o.value !== 'last')!;
    fireEvent.change(aggSelect, { target: { value: target.value } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ aggregation: target.value }),
    );
  });
});
