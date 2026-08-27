/**
 * modules/security-trade/__tests__/security-trade-form-fee.test.ts — 三项费用物理并表（INC-03/INC-04）
 *
 * 对齐 React 版 security-trade-form-fee.test.tsx 的验收点：
 * 1. 提交时 feeTotal = commission + stampTax + other（前端公式提交），
 *    costPrice 按含费单价公式推导（买入=(成交额+费用合计)/数量），
 *    费用三项直接写 security_trades 一行（不再有「删旧 FeeRecord 插新 FeeRecord」逻辑）。
 * 2. 编辑态三项费用正确回填（trade.commission/stampTax/other）+ 费用合计预览。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SecurityTradeForm from '../components/SecurityTradeForm.vue';
import type { SecurityTradeResponse } from '@/api/types';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

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

const securities = [
  { id: 'sec-1', name: '贵州茅台', code: '600519', type: 'STOCK', exchange: 'SH' },
];
const master = {
  id: 'master-1',
  code: '600519',
  name: '贵州茅台',
  exchange: 'SH',
  assetClass: 'STOCK',
  updatedAt: '2024-01-01T00:00:00.000Z',
};
const resolved = {
  id: 'sec-1',
  code: '600519',
  name: '贵州茅台',
  type: 'STOCK',
  exchange: 'SH',
  isNew: true,
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

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flushPromises();
}

async function submitForm(): Promise<void> {
  await wrapper!.find('form').trigger('submit');
  await settle();
}

async function pickSecurity(): Promise<void> {
  await settle();
  const combobox = wrapper!.find('input#st-security');
  await combobox.setValue('茅台');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settle();
  const candidate = wrapper!.find('[data-security-candidate]');
  expect(candidate.exists()).toBe(true);
  await candidate.trigger('click');
  await settle();
}

const TRADE: SecurityTradeResponse = {
  id: 'trade-1',
  portfolioId: 'pf-1',
  securityId: 's-a',
  date: '2025-07-15',
  side: 'BUY_SEC',
  quantity: '100',
  costPrice: '1500.45',
  commission: '3',
  stampTax: '1.5',
  other: '0.5',
  feeTotal: '5',
  note: '建仓',
  createdAt: '2025-07-15T00:00:00.000Z',
  updatedAt: '2025-07-15T00:00:00.000Z',
} as unknown as SecurityTradeResponse;

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.createSecurityTrade.mockReset();
  apiMocks.updateSecurityTrade.mockReset();
  apiMocks.resolveSecurity.mockReset();
  apiMocks.listSecurities.mockReset();
  apiMocks.listSecurityMasters.mockReset();
  apiMocks.listSecurities.mockResolvedValue({
    items: securities,
    total: 1,
    page: 1,
    pageSize: 50,
  });
  apiMocks.listSecurityMasters.mockResolvedValue({
    items: [master],
    total: 1,
    page: 1,
    pageSize: 20,
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('证券买卖录入 · 三项费用物理并表（INC-03/INC-04）', () => {
  it('提交时 feeTotal = 三项之和，costPrice 由含费单价公式推导，直接写 security_trades（无 fee/price 旧字段）', async () => {
    apiMocks.resolveSecurity.mockResolvedValue(resolved);
    apiMocks.createSecurityTrade.mockResolvedValue({ id: 'new-id' });
    mountForm();

    await pickSecurity();
    await wrapper!.find('input#st-quantity').setValue('100');
    await wrapper!.find('input#st-trade-amount').setValue('100000');
    await wrapper!.find('input#st-commission').setValue('3');
    await wrapper!.find('input#st-stamp-tax').setValue('1.5');
    await wrapper!.find('input#st-other').setValue('0.5');

    await submitForm();

    expect(apiMocks.createSecurityTrade).toHaveBeenCalledTimes(1);
    const payload = apiMocks.createSecurityTrade.mock.calls[0][1] as Record<
      string,
      unknown
    >;

    // resolve 回填的 securityId 被正确提交
    expect(payload.securityId).toBe('sec-1');
    // feeTotal = 3 + 1.5 + 0.5 = 5
    expect(payload.commission).toBe(3);
    expect(payload.stampTax).toBe(1.5);
    expect(payload.other).toBe(0.5);
    expect(payload.feeTotal).toBe(5);
    // 买入含费单价 = (成交额 100000 + 费用合计 5) / 数量 100 = 1000.05
    expect(payload.costPrice).toBe(1000.05);
    // 物理并表：直接写 security_trades 行，无 fee/price 旧字段
    expect(payload).not.toHaveProperty('fee');
    expect(payload).not.toHaveProperty('price');
  });

  it('编辑态三项费用正确回填（trade.commission/stampTax/other）+ 费用合计预览', async () => {
    mountForm({ trade: TRADE });
    await flushPromises();

    expect((wrapper!.find('input#st-commission').element as HTMLInputElement).value).toBe('3');
    expect((wrapper!.find('input#st-stamp-tax').element as HTMLInputElement).value).toBe('1.5');
    expect((wrapper!.find('input#st-other').element as HTMLInputElement).value).toBe('0.5');
    // 费用合计预览 = 5
    expect(wrapper!.find('[data-testid="fee-total"]').text()).toContain('5');
  });
});
