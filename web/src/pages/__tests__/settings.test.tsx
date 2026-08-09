/**
 * pages/settings.tsx — 设置页「无限更新循环」回归测试
 *
 * 背景（被修复的 Bug）：
 * 原代码 `const prefStore = usePreferenceStore();` 未传选择器，订阅了整个 store。
 * preference.store 的 setPreferences 内部 `set({ preferences, loaded: true })`
 * 每次都会产生**新的 state 对象**，于是 `prefStore` 引用恒变；
 * 而同步服务端偏好的 effect 依赖里带了 `prefStore` →
 * effect 反复触发 setPreferences → 反复产生新 state → 反复触发 effect，
 * 形成无限更新循环，React 抛 `Maximum update depth exceeded`，/settings 整页白屏。
 *
 * 修复：改为选择器订阅稳定的 action
 * `const setPreferences = usePreferenceStore((s) => s.setPreferences);`
 * 并把 effect 依赖改为 `[serverPrefs, setPreferences]`。
 *
 * 测试策略：
 * 1. 只 mock API 层 hooks（use-preferences / use-portfolios），**保留真实的
 *    preference.store**。这一点很关键：循环的根因来自 store 每次 set 都换
 *    state 引用，若把 store 也 mock 掉，这条回归就测了个寂寞。
 * 2. usePreferences 返回**引用稳定**的 serverPrefs（模块级常量），
 *    排除「数据引用每次变」这一干扰因素，让断言只针对 store 订阅方式。
 * 3. 三重断言，任一命中即说明循环复发：
 *    - render 不抛异常（循环时 React 会抛 Maximum update depth exceeded）
 *    - console.error 中未出现 Maximum update depth exceeded
 *    - 真实 store 的 setPreferences 只被调用 1 次（最锋利的判据）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Portfolio } from '@/lib/types';
import type { UserPreference } from '@/api/types';

// ---------------------------------------------------------------------------
// 测试夹具（vi.hoisted：vi.mock 工厂会被提升到 import 之前执行，
// 普通 const 在那时还处于 TDZ，必须用 hoisted 才能被工厂安全引用）
// ---------------------------------------------------------------------------
const fixtures = vi.hoisted(() => {
  const serverPrefs: UserPreference = {
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
  };

  const portfolios: Portfolio[] = [
    {
      id: 'pf-1',
      userId: 'user-1',
      name: '测试组合',
      description: '回归测试用组合',
      baseDate: '2024-01-01',
      currency: 'CNY',
      archivedAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ];

  return { serverPrefs, portfolios };
});

// sonner 的 toast 在 jsdom 下会尝试渲染，直接 mock 掉（与 api-client.test.ts 一致）
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// 偏好 API hooks：返回引用稳定的 serverPrefs
vi.mock('@/hooks/use-preferences', () => ({
  PREFERENCE_KEY: ['users', 'preferences'],
  usePreferences: () => ({ data: fixtures.serverPrefs, isLoading: false }),
  useUpdatePreferences: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
}));

// 组合 API hooks：PortfolioDialog（即使 open=false 组件函数体也会执行）
// 同样依赖本模块，故 create/update/delete/clearData 一并提供桩
vi.mock('@/hooks/use-portfolios', () => ({
  PORTFOLIOS_KEY: ['portfolios'],
  usePortfolios: () => ({ data: fixtures.portfolios, isLoading: false }),
  useCreatePortfolio: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdatePortfolio: () => ({ mutate: vi.fn(), isPending: false }),
  useDeletePortfolio: () => ({ mutate: vi.fn(), isPending: false }),
  useArchivePortfolio: () => ({ mutate: vi.fn(), isPending: false }),
  useClearPortfolioData: () => ({ mutate: vi.fn(), isPending: false }),
  // 项6：默认组合星标 toggle → PATCH /portfolios/:id/default
  useSetDefaultPortfolio: () => ({ mutate: vi.fn(), isPending: false }),
}));

// 必须在 vi.mock 之后再导入被测页面与真实 store
import SettingsPage from '@/pages/settings';
import { usePreferenceStore } from '@/stores/preference.store';

/** React 无限更新循环的特征错误信息 */
const MAX_DEPTH_MSG = 'Maximum update depth exceeded';

/** jsdom 缺失的浏览器 API 兜底（Radix Select / Dialog 需要） */
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

/** 用 MemoryRouter + QueryClientProvider 包裹渲染设置页 */
function renderSettingsPage() {
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

describe('SettingsPage — 无限更新循环回归', () => {
  let consoleErrorSpy: MockInstance<
    Parameters<typeof console.error>,
    ReturnType<typeof console.error>
  >;
  let setPreferencesSpy: Mock<[UserPreference], void>;

  beforeEach(() => {
    installJsdomPolyfills();

    // 记录 console.error，但保留原始行为之外的噪音过滤（不打印，避免污染输出）
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 包装真实 action：保留 store 真实行为（set 仍会产生新 state 引用，
    // 这样旧写法依旧会触发循环），同时统计调用次数
    const realSetPreferences = usePreferenceStore.getState().setPreferences;
    setPreferencesSpy = vi.fn((pref: UserPreference) => {
      realSetPreferences(pref);
    });
    usePreferenceStore.setState({ setPreferences: setPreferencesSpy });
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
    usePreferenceStore.setState({ preferences: null, loaded: false });
    vi.clearAllMocks();
  });

  it('渲染设置页不会触发 Maximum update depth exceeded', () => {
    expect(() => renderSettingsPage()).not.toThrow();

    const loggedErrors = consoleErrorSpy.mock.calls
      .map((args) => args.map((a) => String(a)).join(' '))
      .join('\n');
    expect(loggedErrors).not.toContain(MAX_DEPTH_MSG);
  });

  it('设置页正常渲染出「设置」标题与主要分区', () => {
    renderSettingsPage();

    // 一级标题（避免与「偏好设置」卡片标题混淆，用 heading role + 精确名匹配）
    expect(
      screen.getByRole('heading', { level: 1, name: '设置' }),
    ).toBeDefined();

    // 关键分区存在，说明整页不是白屏
    expect(screen.getByText('账户')).toBeDefined();
    expect(screen.getByText('组合管理')).toBeDefined();
    expect(screen.getByText('偏好设置')).toBeDefined();
  });

  it('服务端偏好只同步一次到本地 store（effect 不应反复触发）', () => {
    renderSettingsPage();

    // 核心判据：旧写法下这里会是几十上百次（直到 React 抛错）
    expect(setPreferencesSpy).toHaveBeenCalledTimes(1);
    expect(setPreferencesSpy).toHaveBeenCalledWith(fixtures.serverPrefs);

    // 同步结果正确写入了真实 store
    const state = usePreferenceStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.preferences).toEqual(fixtures.serverPrefs);
  });
});
