/**
 * features/transaction/transaction-list.tsx — 交易类型展示文案回归测试
 *
 * 背景（本次改动）：
 * 交易类型的**展示文案**由「买入/卖出」统一改为「存入/取出」。
 * 这是纯展示层替换：数据层枚举 TransactionType = BUY/SELL 与所有分支
 * 判断（`tx.type === TransactionType.BUY`）保持不变。
 *
 * 本测试锁定两件事（缺一不可）：
 * 1. 文案本身正确：渲染出「存入」「取出」，且旧文案「买入」「卖出」彻底消失。
 * 2. **枚举与文案的绑定关系正确**：BUY 行显示「存入」、SELL 行显示「取出」，
 *    而不是两者被写反。只断言「页面上有存入两个字」是测不出映射写反的，
 *    因此这里按行定位后再断言，这是本测试最锋利的判据。
 *
 * 测试策略：只 mock 数据层 hooks（use-transactions），保留真实组件渲染，
 * 与 settings.test.tsx 的做法保持一致。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TransactionResponse } from '@/api/types';

// ---------------------------------------------------------------------------
// 测试夹具（vi.hoisted：vi.mock 工厂被提升到 import 之前执行）
// 一条 BUY、一条 SELL，用日期作为行定位锚点（cashflow 不含标的/数量/单价/费用）
// ---------------------------------------------------------------------------
const fixtures = vi.hoisted(() => {
  const base = {
    portfolioId: 'pf-1',
    note: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const items = [
    {
      ...base,
      id: 'tx-buy',
      date: '2024-03-01',
      type: 'BUY' as const,
      amount: '1000.00',
    },
    {
      ...base,
      id: 'tx-sell',
      date: '2024-03-02',
      type: 'SELL' as const,
      amount: '500.00',
    },
  ];

  return { items };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-transactions', () => ({
  transactionsKey: () => ['transactions'],
  useTransactions: () => ({
    data: { items: fixtures.items, total: fixtures.items.length },
    isLoading: false,
    isError: false,
  }),
  useCreateTransaction: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateTransaction: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteTransaction: () => ({ mutate: vi.fn(), isPending: false }),
}));

// 必须在 vi.mock 之后导入被测组件
import { TransactionList } from '@/features/transaction/transaction-list';

/** jsdom 缺失的浏览器 API 兜底（Radix Dialog / Select 需要） */
function installJsdomPolyfills(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
      return false;
    };
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture =
      function releasePointerCapture(): void {};
  }
}

function renderList() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TransactionList portfolioId="pf-1" />
    </QueryClientProvider>,
  );
}

/** 按日期定位到所在的表格行 */
function rowOf(date: string): HTMLElement {
  const cell = screen.getByText(date);
  const row = cell.closest('tr');
  if (!row) throw new Error(`未找到 ${date} 所在的表格行`);
  return row as HTMLElement;
}

describe('TransactionList — 交易类型展示文案（存入/取出）', () => {
  beforeEach(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('渲染出新文案「存入」与「取出」', () => {
    renderList();

    expect(screen.getByText('存入')).toBeDefined();
    expect(screen.getByText('取出')).toBeDefined();
  });

  it('旧文案「买入」「卖出」不应再出现在任何位置', () => {
    const { container } = renderList();

    expect(container.textContent).not.toContain('买入');
    expect(container.textContent).not.toContain('卖出');
  });

  it('枚举与文案绑定正确：BUY 行显示「存入」，SELL 行显示「取出」（防映射写反）', () => {
    renderList();

    const buyRow = rowOf('2024-03-01');
    expect(within(buyRow).getByText('存入')).toBeDefined();
    expect(within(buyRow).queryByText('取出')).toBeNull();

    const sellRow = rowOf('2024-03-02');
    expect(within(sellRow).getByText('取出')).toBeDefined();
    expect(within(sellRow).queryByText('存入')).toBeNull();
  });

  it('类型标签数量与数据条数一致（每行恰好一个类型标签）', () => {
    renderList();

    const labels = [
      ...screen.queryAllByText('存入'),
      ...screen.queryAllByText('取出'),
    ];
    expect(labels).toHaveLength(fixtures.items.length);
  });
});

// 类型自检：夹具需满足 TransactionResponse 契约（type 仍是 'BUY' | 'SELL'）
const _typeCheck: TransactionResponse[] = fixtures.items;
void _typeCheck;
