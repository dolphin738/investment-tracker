/**
 * modules/security-trade/__tests__/security-trade-form-inc02.test.ts — INC-02 标的回填竞态（编辑态）
 *
 * 对齐 React 版 security-trade-form-inc02.test.tsx 的验收点：
 * 受控展示值恒由 selectedSecurityLabel 推导（列表未到/已到/已不在列表三态）。
 * 1. securities 未加载完即打开编辑 → 输入框回显保底文案「当前标的（加载中…）」，控件不被禁用。
 * 2. securities 已加载且含当前标的 → 回显「名称（代码）」。
 * 3. 无串号：当前标的已不在可选列表时 → 回显「当前标的（已不在可选列表）」，绝不串到其它标的。
 * 4. 加载完成后回填项被真实标的覆盖（不再显示「加载中」）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SecurityTradeForm from '../components/SecurityTradeForm.vue';
import type { SecurityTradeResponse } from '@/api/types';

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const apiMocks = vi.hoisted(() => ({
  listSecurityTrades: vi.fn(),
  createSecurityTrade: vi.fn(),
  updateSecurityTrade: vi.fn(),
  deleteSecurityTrade: vi.fn(),
  listSecurities: vi.fn(),
  resolveSecurity: vi.fn(),
  updateSecurity: vi.fn(),
  listSecurityMasters: vi.fn(),
}));

vi.mock('@/api/security-trade.api', () => ({
  listSecurityTrades: apiMocks.listSecurityTrades,
  createSecurityTrade: apiMocks.createSecurityTrade,
  updateSecurityTrade: apiMocks.updateSecurityTrade,
  deleteSecurityTrade: apiMocks.deleteSecurityTrade,
}));

vi.mock('@/api/security.api', () => ({
  listSecurities: apiMocks.listSecurities,
  resolveSecurity: apiMocks.resolveSecurity,
  updateSecurity: apiMocks.updateSecurity,
}));

vi.mock('@/api/security-master.api', () => ({
  listSecurityMasters: apiMocks.listSecurityMasters,
}));

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

const TRADE: SecurityTradeResponse = {
  id: 'trade-1',
  portfolioId: 'pf-1',
  securityId: 's-a',
  date: '2025-07-15',
  side: 'BUY_SEC',
  quantity: '100',
  costPrice: '1500.45',
  commission: '0',
  stampTax: '0',
  other: '0',
  feeTotal: '0',
  note: '建仓',
  createdAt: '2025-07-15T00:00:00.000Z',
  updatedAt: '2025-07-15T00:00:00.000Z',
} as unknown as SecurityTradeResponse;

let wrapper: VueWrapper | null = null;

function mountForm(props: Record<string, unknown> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wrapper = mount(SecurityTradeForm, {
    props: { portfolioId: 'pf-1', ...props },
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], createPinia()],
    },
  });
  return wrapper;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await flushPromises();
}

function securityInput(): HTMLInputElement {
  return wrapper!.find('input#st-security').element as HTMLInputElement;
}

/** 可手动 resolve 的 Promise，用于确定性地驱动「加载中 → 已加载」状态切换 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.createSecurityTrade.mockReset();
  apiMocks.updateSecurityTrade.mockReset();
  apiMocks.resolveSecurity.mockReset();
  apiMocks.listSecurities.mockReset();
  apiMocks.listSecurityMasters.mockReset();
  apiMocks.listSecurityTrades.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  apiMocks.listSecurityMasters.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  apiMocks.resolveSecurity.mockResolvedValue({ id: 's-a' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('INC-02 标的回填竞态（编辑态）', () => {
  it('securities 未加载完即打开编辑 → 输入框回显「当前标的（加载中…）」，不被禁用', async () => {
    // 永不 resolve → isLoading 恒为 true
    apiMocks.listSecurities.mockReturnValue(new Promise<unknown>(() => {}));

    mountForm({ trade: TRADE });
    await settle();

    const input = securityInput();
    expect(input.value).toBe('当前标的（加载中…）');
    expect(input.disabled).toBe(false);
  });

  it('securities 已加载且含当前标的 → 回显「名称（代码）」', async () => {
    apiMocks.listSecurities.mockResolvedValue({
      items: [{ id: 's-a', name: '贵州茅台', code: '600519' }],
      total: 1,
      page: 1,
      pageSize: 50,
    });

    mountForm({ trade: TRADE });
    await settle();

    expect(securityInput().value).toBe('贵州茅台（600519）');
  });

  it('无串号：当前标的已不在可选列表 → 回显「当前标的（已不在可选列表）」', async () => {
    apiMocks.listSecurities.mockResolvedValue({
      items: [{ id: 's-b', name: '其它股票', code: '000001' }],
      total: 1,
      page: 1,
      pageSize: 50,
    });

    mountForm({ trade: TRADE });
    await settle();

    const input = securityInput();
    expect(input.value).toBe('当前标的（已不在可选列表）');
    expect(input.value).not.toBe('其它股票（000001）');
  });

  it('加载完成后回填项被真实标的覆盖（不再显示「加载中」）', async () => {
    // 用可手动 resolve 的 deferred 驱动：先保持 pending（加载中），再注入含当前标的的列表
    const d = deferred<{
      items: Array<{ id: string; name: string; code: string }>;
      total: number;
      page: number;
      pageSize: number;
    }>();
    apiMocks.listSecurities.mockReturnValue(d.promise);

    mountForm({ trade: TRADE });
    await settle();
    expect(securityInput().value).toBe('当前标的（加载中…）');

    d.resolve({
      items: [{ id: 's-a', name: '贵州茅台', code: '600519' }],
      total: 1,
      page: 1,
      pageSize: 50,
    });
    await settle();
    expect(securityInput().value).toBe('贵州茅台（600519）');
  });
});
