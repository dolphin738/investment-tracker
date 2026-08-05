/**
 * SecurityType 收敛到 @investment-tracker/shared — 无回归验收（Q-3 · 阶段 B）
 *
 * 背景：web 端原有本地 `export enum SecurityType`（TS enum），阶段 B 删除后统一
 * 从 shared 的 `as const` 对象取值。二者运行时形态不同（enum 会生成反向映射对象，
 * as const 只是普通冻结对象），必须验证**行为等价**：
 * - 同一引用：`@/api/types` 的 re-export 与 shared 原始导出是同一对象
 * - 取值等价：5 个类型键值对与旧 enum 完全一致，且**无 enum 反向映射污染**
 *   （旧 TS enum 若是数字枚举会多出 0/1/2 反向键；字符串枚举不会，这里做防御性断言）
 * - UI 等价：证券买卖表单「新建标的」类型下拉可渲染并切换全部 5 个类型，
 *   选中值随之提交给 createSecurity
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SecurityType as SharedSecurityType } from '@investment-tracker/shared';
import { SecurityType as ReExportedSecurityType } from '@/api/types';

// ---------------------------------------------------------------------------
// mock：隔离网络层，只留组件与 SecurityType 行为
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  createSecurity: vi.fn(),
  createTrade: vi.fn(),
  updateTrade: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-securities', () => ({
  useSecurities: () => ({ data: [], isLoading: false }),
  useCreateSecurity: () => ({
    mutate: mocks.createSecurity,
    isPending: false,
  }),
}));

vi.mock('@/hooks/use-security-trades', () => ({
  useCreateSecurityTrade: () => ({ mutate: mocks.createTrade, isPending: false }),
  useUpdateSecurityTrade: () => ({ mutate: mocks.updateTrade, isPending: false }),
}));

/**
 * Radix Select 替身（原生 <select>）
 *
 * 原因：Radix 的浮层依赖 PointerEvent / 布局测量，在 jsdom 下无法展开
 * （实测 pointerDown 与键盘 Enter 均不产生 role="option" 节点），属环境限制。
 * 这里**只替换第三方基元**，被测组件 security-trade-form 的
 * `value` / `onValueChange` / 选项遍历逻辑全部保持真实，
 * 因此「切换类型 → 状态更新 → 提交载荷」这条链路仍是真在测。
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

function installPolyfills(): void {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function (): void {};
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
}

/** 展开「新建标的」折叠区：标的下拉选 __new__ */
async function openNewSecurityPanel(): Promise<void> {
  const securitySelect = document.getElementById('st-security') as HTMLSelectElement;
  fireEvent.change(securitySelect, { target: { value: '__new__' } });
  await screen.findByText('代码 *');
}

/** 取「类型」下拉（页面最后一个 combobox：方向、标的、类型） */
function getTypeSelect(): HTMLSelectElement {
  const combos = screen.getAllByRole('combobox') as HTMLSelectElement[];
  return combos[combos.length - 1];
}

// ---------------------------------------------------------------------------
// 1. 模块层等价
// ---------------------------------------------------------------------------

describe('SecurityType 单一定义（shared）', () => {
  it('@/api/types 的 re-export 与 shared 原始导出是同一对象引用', () => {
    expect(ReExportedSecurityType).toBe(SharedSecurityType);
  });

  it('恰好 5 个类型，键值一一对应（与被删除的本地 enum 完全一致）', () => {
    expect(SharedSecurityType).toEqual({
      STOCK: 'STOCK',
      FUND: 'FUND',
      BOND: 'BOND',
      CASH: 'CASH',
      OTHER: 'OTHER',
    });
    expect(Object.keys(SharedSecurityType)).toHaveLength(5);
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
    expect(SharedSecurityType.CASH).toBe('CASH');
    expect(SharedSecurityType.OTHER).toBe('OTHER');
  });
});

// ---------------------------------------------------------------------------
// 2. UI 层等价：新建标的类型下拉
// ---------------------------------------------------------------------------

describe('证券买卖表单「新建标的」类型下拉（shared SecurityType 驱动）', () => {
  beforeEach(() => {
    installPolyfills();
    mocks.createSecurity.mockReset();
    mocks.createTrade.mockReset();
    mocks.updateTrade.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('折叠区默认类型为「股票」（SecurityType.STOCK）', async () => {
    render(<SecurityTradeForm portfolioId="pf-1" />);
    await openNewSecurityPanel();

    expect(getTypeSelect().value).toBe('STOCK');
  });

  it('类型下拉 5 个选项齐全（股票/基金/债券/现金/其他），且值取自 shared', async () => {
    render(<SecurityTradeForm portfolioId="pf-1" />);
    await openNewSecurityPanel();

    const options = Array.from(getTypeSelect().querySelectorAll('option')).filter(
      (o) => o.value !== '',
    );
    expect(options).toHaveLength(5);
    expect(options.map((o) => o.value).sort()).toEqual(
      Object.values(SharedSecurityType).slice().sort(),
    );
    expect(options.map((o) => o.textContent)).toEqual([
      '股票',
      '基金',
      '债券',
      '现金',
      '其他',
    ]);
  });

  it.each([
    ['基金', 'FUND'],
    ['债券', 'BOND'],
    ['现金', 'CASH'],
    ['其他', 'OTHER'],
    ['股票', 'STOCK'],
  ])(
    '可切换到「%s」并以 %s 提交（as const 赋值不被字面量类型卡住）',
    async (_label, expectedValue) => {
      render(<SecurityTradeForm portfolioId="pf-1" />);
      await openNewSecurityPanel();

      fireEvent.change(screen.getByPlaceholderText('如 600519'), {
        target: { value: '600519' },
      });
      fireEvent.change(screen.getByPlaceholderText('如 贵州茅台'), {
        target: { value: '测试标的' },
      });

      // 切类型（受控组件：值必须真正回写到 state，否则下面断言会拿到 STOCK）
      fireEvent.change(getTypeSelect(), { target: { value: expectedValue } });
      await waitFor(() => {
        expect(getTypeSelect().value).toBe(expectedValue);
      });

      fireEvent.click(screen.getByRole('button', { name: '创建并选中' }));

      await waitFor(() => {
        expect(mocks.createSecurity).toHaveBeenCalledTimes(1);
      });
      const payload = mocks.createSecurity.mock.calls[0][0] as {
        code: string;
        name: string;
        type: string;
      };
      expect(payload.type).toBe(expectedValue);
      expect(payload.code).toBe('600519');
      expect(payload.name).toBe('测试标的');
    },
  );

  it('提交载荷的 type 取值必定落在 shared 白名单内（后端 400 防线的前置保证）', async () => {
    render(<SecurityTradeForm portfolioId="pf-1" />);
    await openNewSecurityPanel();

    fireEvent.change(screen.getByPlaceholderText('如 600519'), {
      target: { value: '110011' },
    });
    fireEvent.change(screen.getByPlaceholderText('如 贵州茅台'), {
      target: { value: '易方达' },
    });
    fireEvent.change(getTypeSelect(), { target: { value: 'FUND' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并选中' }));

    await waitFor(() => expect(mocks.createSecurity).toHaveBeenCalled());
    const payload = mocks.createSecurity.mock.calls[0][0] as { type: string };
    expect(Object.values(SharedSecurityType)).toContain(payload.type);
  });

  it('连续切换两次类型，最终以最后一次为准（状态不被首个字面量锁死）', async () => {
    render(<SecurityTradeForm portfolioId="pf-1" />);
    await openNewSecurityPanel();

    fireEvent.change(screen.getByPlaceholderText('如 600519'), {
      target: { value: '019547' },
    });
    fireEvent.change(screen.getByPlaceholderText('如 贵州茅台'), {
      target: { value: '国债' },
    });

    fireEvent.change(getTypeSelect(), { target: { value: 'FUND' } });
    await waitFor(() => expect(getTypeSelect().value).toBe('FUND'));
    fireEvent.change(getTypeSelect(), { target: { value: 'BOND' } });
    await waitFor(() => expect(getTypeSelect().value).toBe('BOND'));

    fireEvent.click(screen.getByRole('button', { name: '创建并选中' }));

    await waitFor(() => expect(mocks.createSecurity).toHaveBeenCalled());
    expect(
      (mocks.createSecurity.mock.calls[0][0] as { type: string }).type,
    ).toBe('BOND');
  });
});
