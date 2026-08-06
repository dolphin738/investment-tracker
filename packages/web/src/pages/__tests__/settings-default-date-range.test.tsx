/**
 * settings.tsx — I-04 默认日期范围下拉与 QUICK_RANGE_OPTIONS 单一真相源比对
 *
 * 覆盖（增量 PRD I-04 验收 1/5/7）：
 * 1. 设置页「默认日期范围」下拉恰为 7 项，value/label 与 QUICK_RANGE_OPTIONS 逐项一致
 * 2. 修改下拉 → 调用偏好更新 mutation（payload.defaultDateRange = 新值）
 * 3. 设置页不存在第二份范围选项数组（DATE_RANGE_OPTIONS 已删除，代码评审佐证）
 *
 * 说明：Radix Select mock 为原生 <select> 替身（同 dividend-fee-tax.test.tsx），
 * 便于逐项读取 option 的 value/text。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Portfolio } from '@investment-tracker/shared';
import type { UserPreference } from '@/api/types';
import { QUICK_RANGE_OPTIONS } from '@/features/query/dimension-switcher';

const state = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-portfolios', () => ({
  PORTFOLIOS_KEY: ['portfolios'],
  usePortfolios: () => ({ data: [PORTFOLIO_FIXTURE], isLoading: false }),
  useCreatePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useArchivePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeletePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useClearPortfolioData: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-preferences', () => ({
  PREFERENCE_KEY: ['users', 'preferences'],
  usePreferences: () => ({ data: SERVER_PREFS, isLoading: false }),
  useUpdatePreferences: () => ({
    mutate: state.updatePreferences,
    mutateAsync: state.updatePreferences,
    isPending: false,
  }),
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

// 必须在 vi.mock 之后导入
import SettingsPage from '@/pages/settings';
import { usePreferenceStore } from '@/stores/preference.store';

const PORTFOLIO_FIXTURE = {
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

const SERVER_PREFS: UserPreference = {
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
  showLiquidated: false,
  cashHintOnCashflow: true,
  cashHintOnTrade: true,
  amountThousands: true,
  amountAbbrev: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
} as unknown as UserPreference;

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('settings.tsx — I-04 默认日期范围下拉（QUICK_RANGE_OPTIONS 单一真相源）', () => {
  beforeEach(() => {
    state.updatePreferences = vi.fn();
    usePreferenceStore.setState({
      preferences: SERVER_PREFS,
      loaded: true,
    });
  });

  afterEach(() => {
    cleanup();
    usePreferenceStore.setState({ preferences: null, loaded: false });
    vi.clearAllMocks();
  });

  it('「默认日期范围」下拉恰为 7 项，value/label 与 QUICK_RANGE_OPTIONS 逐项一致', () => {
    renderPage();

    const select = screen.getByLabelText('默认日期范围') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option')).filter(
      (o) => o.value !== '',
    );

    expect(options).toHaveLength(QUICK_RANGE_OPTIONS.length);
    expect(options.map((o) => o.value)).toEqual(
      QUICK_RANGE_OPTIONS.map((o) => o.value),
    );
    expect(options.map((o) => o.textContent?.trim())).toEqual(
      QUICK_RANGE_OPTIONS.map((o) => o.label),
    );
  });

  it('修改下拉为「近一周」→ 点「保存偏好」调用偏好更新 mutation（payload.defaultDateRange = 1w）', async () => {
    renderPage();

    const select = screen.getByLabelText('默认日期范围') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1w' } });

    // 保存偏好按钮（依赖 hasPrefChanges 解锁）
    fireEvent.click(screen.getByRole('button', { name: /保存偏好/ }));

    await waitFor(() => {
      expect(state.updatePreferences).toHaveBeenCalled();
    });
    const payload = state.updatePreferences.mock.calls[0][0] as {
      defaultDateRange: string;
    };
    expect(payload.defaultDateRange).toBe('1w');
  });

  it('「近6月」同样可选（后端白名单扩展 1w/6m 的前端载体）', () => {
    renderPage();

    const select = screen.getByLabelText('默认日期范围') as HTMLSelectElement;
    const values = Array.from(select.querySelectorAll('option')).map(
      (o) => o.value,
    );
    expect(values).toContain('6m');
    expect(values).toContain('1w');
  });
});
