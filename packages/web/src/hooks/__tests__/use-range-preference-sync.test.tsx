/**
 * hooks/use-range-preference-sync.ts — 偏好对齐守卫（INC-01 · 决策 E）
 *
 * 验证点（对齐增量 PRD 验收）：
 * 1. 偏好异步对齐：currentQuick='' 且偏好 defaultDateRange='1y' 时，挂载后
 *    onAlign 被调用一次，写入 { quick:'1y', startDate, endDate }。
 * 2. markInteracted 守卫：用户一旦 markInteracted()，即便偏好/依赖项变化，
 *    对齐 effect 永不再回写（避免把用户选择弹回）。
 * 3. URL 参数守卫：挂载瞬间 URL 已带 range/from/to → 全程不对齐。
 * 4. enabled=false：未启用时不对齐（依赖数据未就绪可延后）。
 * 5. 'all' 二次对齐：baseDate 异步到达后，若当前 startDate 仍是兜底值，再对齐一次。
 * 6. 三种状态载体一致（决策 E 核心）：useState / useUrlState / useSearchParams
 *    下，对齐效果与守卫行为完全一致（hook 不持有状态，只通过 onAlign 交回页面）。
 *
 * 时间控制：renderHook 核心用例用 fake timers 钉死系统时间，便于断言精确起止日。
 * 载体用例用真实时间，期望通过 resolveQuickRange() 实时计算，避免随运行日期漂移。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';
import { useUrlState, type UrlStateSchema } from '@/lib/url-query';
import {
  useRangePreferenceSync,
  type RangePreferenceAlignment,
} from '@/hooks/use-range-preference-sync';
import { resolveQuickRange } from '@/features/query/quick-range';

// ---------------------------------------------------------------------------
// 偏好 store mock —— 让 useDefaultDateRange() 返回可控值
// ---------------------------------------------------------------------------
const mockGetPreference = vi.fn();

vi.mock('@/stores/preference.store', () => ({
  usePreferenceStore: (selector: (s: { getPreference: typeof mockGetPreference }) => unknown) =>
    selector({ getPreference: mockGetPreference }),
}));

/** 基准「今天」：2026-06-15（与 quick-range.test.ts 对齐） */
const BASE_NOW = new Date(2026, 5, 15, 12, 0, 0);

function setPref(range: string): void {
  mockGetPreference.mockImplementation((key: string) =>
    key === 'defaultDateRange' ? range : undefined,
  );
}

beforeEach(() => {
  setPref('1y');
  vi.useFakeTimers();
  vi.setSystemTime(BASE_NOW);
  // 干净的 URL 起点（useUrlState / useSearchParams 用例会各自覆盖）
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
// 1) 偏好异步对齐：挂载即对齐一次
// ───────────────────────────────────────────────────────────────────────────
describe('useRangePreferenceSync — 偏好异步对齐', () => {
  it('currentQuick 为空 + 偏好 1y → 挂载后 onAlign 调用一次，写入 1y 的起止日', () => {
    setPref('1y');
    const onAlign = vi.fn();
    const { result } = renderHook(() =>
      useRangePreferenceSync({ currentQuick: '', onAlign }),
    );

    expect(result.current.defaultRange).toBe('1y');
    expect(onAlign).toHaveBeenCalledTimes(1);
    expect(onAlign).toHaveBeenCalledWith({
      quick: '1y',
      startDate: '2025-06-15',
      endDate: '2026-06-15',
    } satisfies RangePreferenceAlignment);
  });

  it('对齐产物与 resolveQuickRange 口径一致（不依赖测试内硬编码）', () => {
    setPref('3m');
    const onAlign = vi.fn();
    renderHook(() => useRangePreferenceSync({ currentQuick: '', onAlign }));

    const expected = resolveQuickRange('3m');
    expect(onAlign).toHaveBeenCalledTimes(1);
    expect(onAlign.mock.calls[0][0]).toMatchObject({
      quick: '3m',
      startDate: expected.startDate,
      endDate: expected.endDate,
    });
  });

  it('currentQuick 已等于偏好值 → 不再回写（已对齐）', () => {
    setPref('1y');
    const onAlign = vi.fn();
    renderHook(() => useRangePreferenceSync({ currentQuick: '1y', onAlign }));
    expect(onAlign).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2) markInteracted 守卫
// ───────────────────────────────────────────────────────────────────────────
describe('useRangePreferenceSync — markInteracted 守卫', () => {
  it('用户交互后，即便偏好/依赖项变化也不再对齐', () => {
    setPref('1y');
    const onAlign = vi.fn();
    const { result, rerender } = renderHook(
      ({ pref }: { pref: string }) => {
        setPref(pref);
        return useRangePreferenceSync({ currentQuick: '', onAlign });
      },
      { initialProps: { pref: '1y' } },
    );

    expect(onAlign).toHaveBeenCalledTimes(1);

    // 用户先手动交互（markInteracted 仅置 ref，不触发重渲染）
    act(() => result.current.markInteracted());

    // 偏好变化触发 effect 再次评估；交互守卫应阻止对齐
    rerender({ pref: 'all' });
    // 重渲染后读取 ref 快照（hasInteracted 由 interactedRef 在渲染期回显）
    expect(result.current.hasInteracted).toBe(true);
    expect(onAlign).toHaveBeenCalledTimes(1); // 次数不变
  });

  it('未交互时，依赖项（allRangeStart）变化会重新对齐（幂等：仍为同一偏好值）', () => {
    setPref('1y');
    const onAlign = vi.fn();
    const { rerender } = renderHook(
      ({ allStart }: { allStart?: string | null }) =>
        useRangePreferenceSync({ currentQuick: '', onAlign, allRangeStart: allStart }),
      { initialProps: { allStart: null as string | null } },
    );

    // 挂载对齐一次
    expect(onAlign).toHaveBeenCalledTimes(1);

    // 未交互，allRangeStart 变化触发 effect 重新评估：对 1y 无影响，幂等再写一次
    rerender({ allStart: '2024-01-01' });
    expect(onAlign).toHaveBeenCalledTimes(2);
    expect(onAlign.mock.calls[1][0].quick).toBe('1y');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3) URL 参数守卫
// ───────────────────────────────────────────────────────────────────────────
describe('useRangePreferenceSync — URL 参数守卫', () => {
  it('挂载时 URL 含 range → 不对齐（hasUrlRangeParam=true）', () => {
    window.history.replaceState(null, '', '/?range=1y');
    const onAlign = vi.fn();
    const { result } = renderHook(() =>
      useRangePreferenceSync({ currentQuick: '', onAlign }),
    );
    expect(result.current.hasUrlRangeParam).toBe(true);
    expect(onAlign).not.toHaveBeenCalled();
  });

  it('挂载时 URL 含 from/to → 不对齐', () => {
    window.history.replaceState(null, '', '/?from=2024-01-01&to=2024-12-31');
    const onAlign = vi.fn();
    renderHook(() => useRangePreferenceSync({ currentQuick: '', onAlign }));
    expect(onAlign).not.toHaveBeenCalled();
  });

  it('urlParamKeys=[] → 不做 URL 判定（本地状态载体，应正常对齐）', () => {
    window.history.replaceState(null, '', '/?range=1y'); // 即便带 range
    const onAlign = vi.fn();
    renderHook(() =>
      useRangePreferenceSync({ currentQuick: '', onAlign, urlParamKeys: [] }),
    );
    // urlParamKeys=[] 跳过 URL 守卫 → 对齐仍发生（如 snapshot-list 本地状态）
    expect(onAlign).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4) enabled 开关
// ───────────────────────────────────────────────────────────────────────────
describe('useRangePreferenceSync — enabled 开关', () => {
  it('enabled=false → 不对齐', () => {
    const onAlign = vi.fn();
    renderHook(() =>
      useRangePreferenceSync({ currentQuick: '', onAlign, enabled: false }),
    );
    expect(onAlign).not.toHaveBeenCalled();
  });

  it('enabled 由 false→true → 启用后对对齐（依赖数据就绪）', () => {
    const onAlign = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useRangePreferenceSync({ currentQuick: '', onAlign, enabled }),
      { initialProps: { enabled: false } },
    );
    expect(onAlign).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(onAlign).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5) 'all' 二次对齐（baseDate 异步到达）
// ───────────────────────────────────────────────────────────────────────────
describe('useRangePreferenceSync — 「全部」二次对齐', () => {
  it('首次用兜底起点对齐，baseDate 到达后若 startDate 仍是兜底值则再对齐一次', () => {
    setPref('all');
    const onAlign = vi.fn();

    // 首次挂载：allRangeStart=null → 兜底 2000-01-01
    const { rerender } = renderHook(
      ({ allStart }: { allStart?: string | null }) =>
        useRangePreferenceSync({ currentQuick: '', onAlign, allRangeStart: allStart }),
      { initialProps: { allStart: null as string | null } },
    );

    expect(onAlign).toHaveBeenCalledTimes(1);
    expect(onAlign.mock.calls[0][0].startDate).toBe('2000-01-01');

    // baseDate 到达（2024-01-01）：当前 startDate 仍是兜底值 → 应再对齐
    rerender({ allStart: '2024-01-01' });
    expect(onAlign).toHaveBeenCalledTimes(2);
    expect(onAlign.mock.calls[1][0].startDate).toBe('2024-01-01');
    expect(onAlign.mock.calls[1][0].quick).toBe('all');
  });

  it('baseDate 到达后 startDate 已为真实起点 → 不再重复对齐', () => {
    setPref('all');
    const onAlign = vi.fn();
    const { rerender } = renderHook(
      ({ start, allStart }: { start: string; allStart: string }) =>
        useRangePreferenceSync({
          currentQuick: 'all',
          currentStartDate: start,
          onAlign,
          allRangeStart: allStart,
        }),
      { initialProps: { start: '2000-01-01', allStart: '2024-01-01' } },
    );

    // 首次：startDate 仍是兜底值 → 对齐到真实起点
    expect(onAlign).toHaveBeenCalledTimes(1);
    expect(onAlign.mock.calls[0][0].startDate).toBe('2024-01-01');

    // 页面已把修复后的 start 回写，baseDate 不变 → 不重复对齐
    rerender({ start: '2024-01-01', allStart: '2024-01-01' });
    expect(onAlign).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6) 三种状态载体一致（决策 E 核心）
// ───────────────────────────────────────────────────────────────────────────
// 统一断言：无 URL 参数、currentQuick='' 时，挂载后对齐一次到偏好默认值。
function expectAlignsOnceToDefault(
  onAlign: ReturnType<typeof vi.fn>,
  pref: string,
): void {
  expect(onAlign).toHaveBeenCalledTimes(1);
  const call = onAlign.mock.calls[0][0] as RangePreferenceAlignment;
  expect(call.quick).toBe(pref);
  expect(call.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(call.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
}

// 载体 A：本地 useState
function UsableCarrier({
  onAlign,
  interactRef,
  initialQuick = '',
}: {
  onAlign: ReturnType<typeof vi.fn>;
  interactRef: { current: (() => void) | null };
  initialQuick?: string;
}): JSX.Element {
  const [quick, setQuick] = useState<string>(initialQuick);
  const api = useRangePreferenceSync({
    currentQuick: quick,
    onAlign: (a) => {
      setQuick(a.quick);
      onAlign(a);
    },
  });
  interactRef.current = api.markInteracted;
  return <span data-testid="quick">{quick}</span>;
}

// 载体 B：useUrlState（@/lib/url-query）
const stringSchema = {
  range: {
    parse: (v: string | null) => (v ?? ''),
    serialize: (v: string) => (v ? v : null),
  },
} as unknown as UrlStateSchema<{ range: string }>;

function UrlStateCarrier({
  onAlign,
  interactRef,
}: {
  onAlign: ReturnType<typeof vi.fn>;
  interactRef: { current: (() => void) | null };
}): JSX.Element {
  const [state, setState] = useUrlState<{ range: string }>(stringSchema);
  const api = useRangePreferenceSync({
    currentQuick: state.range ?? '',
    onAlign: (a) => {
      setState({ range: a.quick });
      onAlign(a);
    },
  });
  interactRef.current = api.markInteracted;
  return <span data-testid="quick">{state.range}</span>;
}

// 载体 C：useSearchParams（react-router-dom）
function SearchParamsCarrier({
  onAlign,
  interactRef,
}: {
  onAlign: ReturnType<typeof vi.fn>;
  interactRef: { current: (() => void) | null };
}): JSX.Element {
  const [sp, setSp] = useSearchParams();
  const quick = sp.get('range') ?? '';
  const api = useRangePreferenceSync({
    currentQuick: quick,
    onAlign: (a) => {
      setSp({ range: a.quick });
      onAlign(a);
    },
  });
  interactRef.current = api.markInteracted;
  return <span data-testid="quick">{quick}</span>;
}

describe('useRangePreferenceSync — 三种状态载体行为一致', () => {
  it('useState 载体：对齐一次到偏好默认值', () => {
    setPref('1y');
    const onAlign = vi.fn();
    const interactRef = { current: null as (() => void) | null };
    render(<UsableCarrier onAlign={onAlign} interactRef={interactRef} />);
    expectAlignsOnceToDefault(onAlign, '1y');
  });

  it('useUrlState 载体：对齐一次到偏好默认值', () => {
    setPref('1y');
    const onAlign = vi.fn();
    const interactRef = { current: null as (() => void) | null };
    render(<UrlStateCarrier onAlign={onAlign} interactRef={interactRef} />);
    expectAlignsOnceToDefault(onAlign, '1y');
  });

  it('useSearchParams 载体：对齐一次到偏好默认值', () => {
    setPref('1y');
    const onAlign = vi.fn();
    const interactRef = { current: null as (() => void) | null };
    render(
      <MemoryRouter initialEntries={['/']}>
        <SearchParamsCarrier onAlign={onAlign} interactRef={interactRef} />
      </MemoryRouter>,
    );
    expectAlignsOnceToDefault(onAlign, '1y');
  });

  it('三载体 markInteracted 守卫一致：交互后偏好变化不覆盖', () => {
    const carriers: Array<{
      name: string;
      node: JSX.Element;
    }> = [
      { name: 'useState', node: <UsableCarrier onAlign={vi.fn()} interactRef={{ current: null }} /> },
      { name: 'useUrlState', node: <UrlStateCarrier onAlign={vi.fn()} interactRef={{ current: null }} /> },
      {
        name: 'useSearchParams',
        node: (
          <MemoryRouter initialEntries={['/']}>
            <SearchParamsCarrier onAlign={vi.fn()} interactRef={{ current: null }} />
          </MemoryRouter>
        ),
      },
    ];

    for (const c of carriers) {
      setPref('1y');
      const onAlign = vi.fn();
      const interactRef = { current: null as (() => void) | null };
      // 用同一节点工厂重新构造以拿到 interactRef
      const node =
        c.name === 'useState' ? (
          <UsableCarrier onAlign={onAlign} interactRef={interactRef} />
        ) : c.name === 'useUrlState' ? (
          <UrlStateCarrier onAlign={onAlign} interactRef={interactRef} />
        ) : (
          <MemoryRouter initialEntries={['/']}>
            <SearchParamsCarrier onAlign={onAlign} interactRef={interactRef} />
          </MemoryRouter>
        );
      const { rerender } = render(node);
      expect(onAlign).toHaveBeenCalledTimes(1);

      act(() => interactRef.current?.());
      setPref('all');
      rerender(node);
      expect(onAlign).toHaveBeenCalledTimes(1); // 守卫生效，不覆盖
    }
  });
});
