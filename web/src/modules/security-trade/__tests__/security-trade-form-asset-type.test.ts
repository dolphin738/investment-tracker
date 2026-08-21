/**
 * modules/security-trade/__tests__/security-trade-form-asset-type.test.ts
 * — BugFix 回归：资产类型栏「无法推断类型」占位符
 *
 * 用户报告：持仓页「买卖明细」→ 交易记录「编辑」→ 弹窗「资产类型」栏显示占位符
 * 「无法推断类型」，不显示实际资产类型。
 *
 * 根因：后端可合法下发 SecurityType.UNCATEGORIZED（代码无法可靠归类时的兜底值），
 * 但 SecurityTradeForm.vue 的 SECURITY_TYPE_OPTIONS 曾缺失该项 → reka-ui Select
 * 匹配不到 SelectItem → SelectValue 回退显示占位符「无法推断类型」。
 * 修复：types.ts 将 UNCATEGORIZED 纳入 SecurityType const 镜像，
 * SecurityTradeForm.vue 补 { value: SecurityType.UNCATEGORIZED, label: '未分类' }。
 *
 * 本文件验证两条真实触发路径（修复前必失败、修复后通过）：
 * - 场景 A（getSecurity 兜底路径）：listSecurities 返回的列表不含 trade.securityId，
 *   getSecurity 返回 { type: 'UNCATEGORIZED', ... } → 资产类型栏显示「未分类」，
 *   wrapper.html() 不含「无法推断类型」。
 * - 场景 B（列表命中路径）：listSecurities 返回含 trade.securityId 的标的且
 *   type: 'UNCATEGORIZED' → 同样显示「未分类」、无占位符。
 *
 * mock 结构与 security-trade-form-inc02.test.ts 一致（vue-sonner、@/api/security-trade.api、
 * @/api/security.api、@/api/security-master.api）；reka-ui SelectContent 走 Portal 渲染，
 * 断言一律基于 wrapper.html() 字符串，不查询 portal DOM。
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
  getSecurity: vi.fn(),
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
  getSecurity: apiMocks.getSecurity,
}));

vi.mock('@/api/security-master.api', () => ({
  listSecurityMasters: apiMocks.listSecurityMasters,
}));

/** jsdom 缺失的浏览器 API 兜底（reka-ui Select / 下拉需要） */
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

/** 编辑态交易记录：securityId = 's-a'（不在证券字典 / 或命中字典两种场景由用例控制） */
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

/** getSecurity 兜底详情：type = UNCATEGORIZED（后端可合法下发） */
const UNCategorizedDetail = {
  id: 's-a',
  code: '600519',
  name: '贵州茅台',
  type: 'UNCATEGORIZED',
  exchange: 'SH',
  currency: 'CNY',
  masterId: null,
  createdAt: '2025-07-15T00:00:00.000Z',
  updatedAt: '2025-07-15T00:00:00.000Z',
};

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

/**
 * 等待微任务与宏任务队列排空。场景 A 为两级异步链
 * （listSecurities → secDetailQuery 使能 → getSecurity → resolvedSecurity → currentSecurityType），
 * 比单级查询需要更多轮次。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await flushPromises();
}

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.createSecurityTrade.mockReset();
  apiMocks.updateSecurityTrade.mockReset();
  apiMocks.resolveSecurity.mockReset();
  apiMocks.listSecurities.mockReset();
  apiMocks.listSecurityMasters.mockReset();
  apiMocks.getSecurity.mockReset();
  apiMocks.listSecurityTrades.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  apiMocks.listSecurityMasters.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  apiMocks.resolveSecurity.mockResolvedValue({ id: 's-a' });
  apiMocks.getSecurity.mockResolvedValue(UNCategorizedDetail);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('BugFix 回归：资产类型栏显示「未分类」而非「无法推断类型」', () => {
  it('场景 A（getSecurity 兜底路径）：列表不含当前标的、详情 type=UNCATEGORIZED → 显示「未分类」', async () => {
    // 组合证券字典不含 trade.securityId（如懒实例化新标的 / 分页未覆盖 / 缓存滞后）
    apiMocks.listSecurities.mockResolvedValue({
      items: [
        { id: 's-other', portfolioId: 'pf-1', code: '000001', name: '其它股票', type: 'STOCK', note: null, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    });

    mountForm({ trade: TRADE });
    await settle();

    // 走 getSecurity 兜底拉取详情
    expect(apiMocks.getSecurity).toHaveBeenCalledWith('pf-1', 's-a');
    // 修复后：UNCATEGORIZED 命中下拉项 → 显示「未分类」
    expect(wrapper!.html()).toContain('未分类');
    // 关键回归断言：不再出现占位符「无法推断类型」
    expect(wrapper!.html()).not.toContain('无法推断类型');
  });

  it('场景 B（列表命中路径）：列表含当前标的且 type=UNCATEGORIZED → 显示「未分类」', async () => {
    // 组合证券字典命中 trade.securityId，type 为后端兜底值 UNCATEGORIZED
    apiMocks.listSecurities.mockResolvedValue({
      items: [
        { id: 's-a', portfolioId: 'pf-1', code: '600519', name: '贵州茅台', type: 'UNCATEGORIZED', note: null, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    });

    mountForm({ trade: TRADE });
    await settle();

    // 注：不在此断言 getSecurity 未被调用 —— 组件 secDetailQuery 的 enabled 在
    // listSecurities 到达前（securities 仍为空）即评估为 true，挂载早期会发起一次
    // 详情兜底拉取（无害竞态）；列表到达后 list-hit 路径仍驱动 currentSecurityType，
    // 详情返回被 currentSecurityType 已置位守卫忽略。本场景的契约是展示结果而非请求次数。
    // 修复后：UNCATEGORIZED 命中下拉项 → 显示「未分类」
    expect(wrapper!.html()).toContain('未分类');
    // 关键回归断言：不再出现占位符「无法推断类型」
    expect(wrapper!.html()).not.toContain('无法推断类型');
  });
});
