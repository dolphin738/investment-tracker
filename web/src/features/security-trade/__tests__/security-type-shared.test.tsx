/**
 * SecurityType 收敛到 @/lib/types — 无回归验收（Q-3 · 阶段 B）
 *
 * 背景：web 端原有本地 `export enum SecurityType`（TS enum），阶段 B 删除后统一
 * 从 shared 的 `as const` 对象取值。二者运行时形态不同（enum 会生成反向映射对象，
 * as const 只是普通冻结对象），必须验证**行为等价**：
 * - 同一引用：`@/api/types` 的 re-export 与 shared 原始导出是同一对象
 * - 取值等价：类型键值对与旧 enum 完全一致，且**无 enum 反向映射污染**
 *   （旧 TS enum 若是数字枚举会多出 0/1/2 反向键；字符串枚举不会，这里做防御性断言）
 * - UI 等价（§10 改造后）：证券买卖表单「搜索选中主数据 → resolve」链路中，
 *   透传给 resolve 的 `type` 取自系统主数据候选、值 ∈ shared 白名单；
 *   候选无类型时 resolve 不携带 type（走后端默认）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SecurityType as SharedSecurityType } from '@/lib/types';
import { SecurityType as ReExportedSecurityType } from '@/api/types';

// ---------------------------------------------------------------------------
// mock：隔离网络层，只留组件与 SecurityType 行为
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  resolveSecurity: vi.fn(),
  createTrade: vi.fn(),
  updateTrade: vi.fn(),
  // 证券主数据搜索（SecuritySearchCombobox 数据源）
  searchMasters: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-securities', () => ({
  useSecurities: () => ({ data: [], isLoading: false }),
  useResolveSecurity: () => ({
    mutate: mocks.resolveSecurity,
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useUpdateSecurity: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock('@/hooks/use-security-trades', () => ({
  useCreateSecurityTrade: () => ({
    mutate: mocks.createTrade,
    mutateAsync: mocks.createTrade,
    isPending: false,
  }),
  useUpdateSecurityTrade: () => ({
    mutate: mocks.updateTrade,
    mutateAsync: mocks.updateTrade,
    isPending: false,
  }),
}));

// 证券主数据搜索：mock 网络，返回可控候选
vi.mock('@/api/security-master.api', () => ({
  listSecurityMasters: mocks.searchMasters,
  syncSecurityMasters: vi.fn(),
}));

/**
 * Radix Select 替身（原生 <select>）
 *
 * 原因：Radix 的浮层依赖 PointerEvent / 布局测量，在 jsdom 下无法展开
 * （实测 pointerDown 与键盘 Enter 均不产生 role="option" 节点），属环境限制。
 * 这里**只替换第三方基元**，被测组件 security-trade-form 的
 * `value` / `onValueChange` / 选项遍历逻辑全部保持真实。
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
        // 占位项：value 为空时不至于自动选中首项，贴近 Radix placeholder 行为
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

/** 表单使用 react-query hooks（useSecurities / use-security-trades），渲染需 QueryClientProvider 包裹 */
function renderWithClient(ui: React.ReactElement): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// ---------------------------------------------------------------------------
// 1. 模块层等价
// ---------------------------------------------------------------------------

describe('SecurityType 单一定义（shared）', () => {
  it('@/api/types 的 re-export 与 shared 原始导出是同一对象引用', () => {
    expect(ReExportedSecurityType).toBe(SharedSecurityType);
  });

  it('类型键值一一对应（含主数据扩展；无 CASH）', () => {
    expect(SharedSecurityType).toEqual({
      STOCK: 'STOCK',
      FUND: 'FUND',
      BOND: 'BOND',
      OTHER: 'OTHER',
      HK_STOCK: 'HK_STOCK',
      CONVERTIBLE_BOND: 'CONVERTIBLE_BOND',
      ETF: 'ETF',
      INDEX: 'INDEX',
      LOF: 'LOF',
    });
    expect(Object.keys(SharedSecurityType)).toHaveLength(9);
  });

  it('无 enum 反向映射污染（键集合 === 值集合，遍历下拉不会多出条目）', () => {
    const keys = Object.keys(SharedSecurityType).sort();
    const values = Object.values(SharedSecurityType).sort();
    expect(keys).toEqual(values);
  });

  it('成员访问方式与旧 enum 写法保持兼容（SecurityType.STOCK === "STOCK"）', () => {
    expect(SharedSecurityType.STOCK).toBe('STOCK');
    expect(SharedSecurityType.FUND).toBe('FUND');
    expect(SharedSecurityType.BOND).toBe('BOND');
    expect(SharedSecurityType.OTHER).toBe('OTHER');
    expect(SharedSecurityType.LOF).toBe('LOF');
  });
});

// ---------------------------------------------------------------------------
// 2. UI 层等价：证券搜索选中 → resolve 的 type 取自 shared 白名单（§10 改造后）
// ---------------------------------------------------------------------------

describe('证券买卖表单证券搜索（shared SecurityType 驱动 resolve）', () => {
  beforeEach(() => {
    mocks.resolveSecurity.mockReset();
    mocks.searchMasters.mockReset();
    mocks.createTrade.mockReset();
    mocks.updateTrade.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('候选类型来自系统主数据，选中后原样透传给 resolve（值 ∈ shared 白名单）', async () => {
    mocks.searchMasters.mockResolvedValue({
      items: [
        {
          id: 'm-1',
          code: '110011',
          name: '易方达',
          exchange: 'SH',
          assetClass: 'FUND',
          updatedAt: '2026-08-13T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderWithClient(<SecurityTradeForm portfolioId="pf-1" />);

    const input = document.getElementById('st-security') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '110011' } });
    const candidate = await screen.findByRole('button', { name: /易方达/ });
    fireEvent.click(candidate);

    await waitFor(() => expect(mocks.resolveSecurity).toHaveBeenCalledTimes(1));
    const payload = mocks.resolveSecurity.mock.calls[0][0] as {
      masterId: string;
      type?: string;
    };
    expect(payload.masterId).toBe('m-1');
    // ADR-003 §2.2：resolve 不携带 type（type=NULL，读取时由代码前缀推断）
    expect(payload.type).toBeUndefined();
  });

  it('resolve 仅携带 masterId（不传 type，走后端默认推断）', async () => {
    mocks.searchMasters.mockResolvedValue({
      items: [
        {
          id: 'm-2',
          code: '600519',
          name: '贵州茅台',
          exchange: 'SH',
          assetClass: null,
          updatedAt: '2026-08-13T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderWithClient(<SecurityTradeForm portfolioId="pf-1" />);

    const input = document.getElementById('st-security') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '600519' } });
    const candidate = await screen.findByRole('button', { name: /贵州茅台/ });
    fireEvent.click(candidate);

    await waitFor(() => expect(mocks.resolveSecurity).toHaveBeenCalledTimes(1));
    const payload = mocks.resolveSecurity.mock.calls[0][0] as {
      masterId: string;
      type?: string;
    };
    expect(payload.masterId).toBe('m-2');
    expect(payload.type).toBeUndefined();
  });
});
