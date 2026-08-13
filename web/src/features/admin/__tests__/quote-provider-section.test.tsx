/**
 * features/admin/__tests__/quote-provider-section.test.tsx — 管理面「按分类汇总」dnd 调序验收
 *
 * 验收点（对应 ADR-002 优先级链 / T09）：
 * 1. computeReorderedIds 纯函数：正常移动 / 拖到原位 / id 不存在 三种情形正确；
 * 2. 总览渲染：已分类分组带拖拽手柄（aria-label=「拖拽排序 X」），未分类分组不带；
 * 3. 初始渲染不触发 reorderQuoteInterfaces（无拖拽则不写后端）；
 * 4. useReorderInterfaces（T08）真实 hook 调用 reorderQuoteInterfaces 并带入正确 body。
 *
 * Mock 策略：仅 mock 网络层（api + auth + category + provider），保留真实的
 * use-quote-interface（含 useReorderInterfaces）与组件渲染，保证 dnd 结构与调序链路真实。
 *
 * 隔离策略（关键）：vitest 以 pool:forks + singleFork:true 全量串行跑在「单一 fork」
 * 内，模块注册表跨文件共享。若其他测试文件先以「真实」方式加载了
 * @/api/quote-interface.api（如 admin 页面测试渲染管理面、传递式 import 了
 * use-quote-interface → 真实 api），本文件的 vi.mock 会被已缓存的真实模块「短路」，
 * 导致真实 hook 调用的是真实 reorderQuoteInterfaces、被 spy 的 mock 永远 0 调用。
 * 因此这里在 beforeEach 内 vi.resetModules() 主动清空共享注册表，并对被测模块做
 * 动态 import，确保本文件声明的 mock 一定优先生效（单一文件运行时本就如此，
 * 全量场景下借此消除跨文件污染）。
 *
 * ④ 调序链路的确定性写法：直接 renderHook 拿到真实 useReorderInterfaces，
 * 用 act + await mutateAsync 同步派发并等待 mutationFn 完成，再断言被 mock 的
 * reorderQuoteInterfaces 入参正确。这样不依赖 useEffect 异步派发与 waitFor 轮询，
 * 在 singleFork 全量重载下也不会因事件循环调度时延而偶发 0 调用。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactElement } from 'react';
import { useEffect } from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { QuoteInterface, ReorderQuoteInterfacesReq } from '@/api/quote-interface.api';

// dnd-kit 在 jsdom 下挂载可能引用 ResizeObserver，补一个 no-op 垫片
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

// 模块级开关：控制 useIsAdmin 的返回值
let adminFlag = true;

vi.mock('@/stores/auth.store', () => ({
  useIsAdmin: () => adminFlag,
  useAuthStore: () => ({
    user: { role: 'admin' },
    token: null,
    isAuthenticated: true,
    login: () => {},
    logout: () => {},
    setUser: () => {},
  }),
}));

vi.mock('@/hooks/use-interface-category', () => ({
  useInterfaceCategories: () => ({
    data: [{ id: 'c1', label: '行情分类', icon: null, sort_order: 0, created_at: '', updated_at: '' }],
  }),
}));

vi.mock('@/api/quote-provider.api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    listQuoteProviders: vi.fn().mockResolvedValue([
      { id: 'p1', name: '新浪', access_method: 'https', config: {}, enabled: true, description: null, created_at: '', updated_at: '' },
      { id: 'p2', name: '腾讯', access_method: 'https', config: {}, enabled: true, description: null, created_at: '', updated_at: '' },
    ]),
  };
});

vi.mock('@/api/quote-interface.api', async (importOriginal) => {
  const actual = await importOriginal();
    return {
      ...(actual as Record<string, unknown>),
      listAllInterfaces: vi.fn(),
      reorderQuoteInterfaces: vi.fn().mockResolvedValue({ ok: true }),
    };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// 被测模块与 mock 函数均经动态 import 取得，确保 vi.resetModules() 后重新求值、
// 本文件声明的 mock 一定优先生效（规避 singleFork 共享注册表跨文件污染）。
let QuoteProviderSection: ComponentType;
let computeReorderedIds: (ids: string[], activeId: string, overId: string) => string[];
let useReorderInterfaces: () => UseMutationResult<{ ok: boolean }, unknown, ReorderQuoteInterfacesReq>;
let listAllInterfaces: ReturnType<typeof vi.fn>;
let reorderQuoteInterfaces: ReturnType<typeof vi.fn>;

const SAMPLE_INTERFACES: QuoteInterface[] = [
  mkIface('i1', 'p1', 'c1', '接口A', 0),
  mkIface('i2', 'p1', 'c1', '接口B', 1),
  mkIface('i3', 'p2', 'c1', '接口C', 2),
  mkIface('i4', 'p2', null, '接口D', null),
];

function mkIface(
  id: string,
  provider_id: string,
  category_id: string | null,
  name: string,
  priority: number | null,
): QuoteInterface {
  return {
    id,
    provider_id,
    category_id,
    name,
    endpoint: `/${id}`,
    http_method: 'GET',
    params: null,
    enabled: true,
    description: null,
    direction: 'in',
    timeout: null,
    retry_count: null,
    rate_limit: null,
    purpose: 'QUOTE',
    asset_class: null,
    resp_code_field: 'code',
    resp_price_field: 'price',
    resp_name_field: null,
    resp_exchange_field: null,
    priority,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeWrapper(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/admin']}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  // 清空跨文件共享的模块注册表，避免被其它测试文件缓存的「真实」api 短路本文件 mock
  vi.resetModules();
  adminFlag = true;
  const sectionMod = await import('@/features/admin/quote-provider-section');
  QuoteProviderSection = sectionMod.QuoteProviderSection;
  computeReorderedIds = sectionMod.computeReorderedIds;
  const hookMod = await import('@/hooks/use-quote-interface');
  useReorderInterfaces = hookMod.useReorderInterfaces;
  const apiMod = await import('@/api/quote-interface.api');
  listAllInterfaces = apiMod.listAllInterfaces as ReturnType<typeof vi.fn>;
  reorderQuoteInterfaces = apiMod.reorderQuoteInterfaces as ReturnType<typeof vi.fn>;
  vi.mocked(listAllInterfaces).mockResolvedValue(SAMPLE_INTERFACES as never);
  vi.mocked(reorderQuoteInterfaces).mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('computeReorderedIds — 拖拽重排算法', () => {
  it('① 正常移动：把首项移到末尾', () => {
    expect(computeReorderedIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  });
  it('② 拖到原位：顺序不变', () => {
    expect(computeReorderedIds(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });
  it('③ id 不在列表中：原样返回', () => {
    expect(computeReorderedIds(['a', 'b', 'c'], 'x', 'a')).toEqual(['a', 'b', 'c']);
    expect(computeReorderedIds(['a', 'b', 'c'], 'a', 'x')).toEqual(['a', 'b', 'c']);
  });
  it('④ 上移：把末项移到首位', () => {
    expect(computeReorderedIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });
});

describe('QuoteProviderSection — 按分类汇总 dnd 调序 UI', () => {
  it('① 已分类分组渲染拖拽手柄，未分类分组不带手柄', async () => {
    render(makeWrapper(<QuoteProviderSection />));
    // 分类 c1 下三个接口均带拖拽手柄
    expect(await screen.findByLabelText('拖拽排序 接口A')).toBeTruthy();
    expect(screen.getByLabelText('拖拽排序 接口B')).toBeTruthy();
    expect(screen.getByLabelText('拖拽排序 接口C')).toBeTruthy();
    // 未分类（接口D）不带手柄
    expect(screen.queryByLabelText('拖拽排序 接口D')).toBeNull();
    // 接口名称均可见
    expect(screen.getByText('接口A')).toBeTruthy();
    expect(screen.getByText('接口D')).toBeTruthy();
    // 分类标签展示
    expect(screen.getByText('行情分类')).toBeTruthy();
  });

  it('② 初始渲染不触发 reorderQuoteInterfaces', async () => {
    render(makeWrapper(<QuoteProviderSection />));
    await screen.findByLabelText('拖拽排序 接口A');
    expect(vi.mocked(reorderQuoteInterfaces)).not.toHaveBeenCalled();
  });
});

describe('useReorderInterfaces — T08 调序 hook 链路', () => {
  it('① 调用 mutate 即触发 reorderQuoteInterfaces 且 body 正确', async () => {
    const { result } = renderHook(() => useReorderInterfaces(), {
      wrapper: ({ children }) => makeWrapper(children as ReactElement),
    });
    // 直接派发 mutation 并等待 mutationFn 完成（act + await 同步化异步链路，
    // 避免 useEffect/waitFor 在全量重载下的事件循环调度时序不确定）
    await act(async () => {
      await result.current.mutateAsync({
        category_id: 'c1',
        ordered_ids: ['i2', 'i1', 'i3'],
      });
    });
    expect(vi.mocked(reorderQuoteInterfaces)).toHaveBeenCalledWith({
      category_id: 'c1',
      ordered_ids: ['i2', 'i1', 'i3'],
    });
  });
});
