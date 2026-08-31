/**
 * modules/security-trade/__tests__/security-trade-form.test.ts — 证券买卖录入/编辑表单测试
 *
 * 功能矩阵（字段级等价，见 B9 批次需求）：
 * 1. 渲染默认值：日期默认今天、成交额占位 0.00、方向默认买入、支付按钮「录入」
 * 2. 校验错误：数量 ≤ 0 →「数量必须大于 0」
 * 3. 校验错误：成交额 ≤ 0 →「成交额必须大于 0」
 * 4. 校验错误（卖出）：费用合计 > 成交额 →「费用合计不能超过成交额」（path=tradeAmount）
 * 5. 提交成功：通过证券搜索选中标的（resolve 懒实例化），payload 字段级对齐并触发 success
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SecurityTradeForm from '../components/SecurityTradeForm.vue';
import { toIsoDate } from '@/lib/constants';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// ---------------------------------------------------------------------------
// mock：数据层 api + toast（避免真实网络与 sonner 渲染副作用）
// ---------------------------------------------------------------------------

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const apiMocks = vi.hoisted(() => ({
  // security-trade.api
  listSecurityTrades: vi.fn(),
  createSecurityTrade: vi.fn(),
  updateSecurityTrade: vi.fn(),
  deleteSecurityTrade: vi.fn(),
  // security.api
  listSecurities: vi.fn(),
  resolveSecurity: vi.fn(),
  updateSecurity: vi.fn(),
  // security-master.api
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

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** jsdom 缺失的浏览器 API 兜底（reka-ui Select / 下拉需要） */

const today = toIsoDate(new Date());

/** 组合标的字典（useSecurities 返回） */
const securities = [
  {
    id: 'sec-1',
    name: '贵州茅台',
    code: '600519',
    type: 'STOCK',
    exchange: 'SH',
  },
];

/** 目录主数据候选（SecuritySearchCombobox 搜索返回） */
const master = {
  id: 'master-1',
  code: '600519',
  name: '贵州茅台',
  exchange: 'SH',
  assetClass: 'STOCK',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

/** 已解析组合标的（resolveSecurity 响应） */
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

/**
 * 等待微任务与宏任务队列排空（与 auth/cashflow 模块 settle 同模式）：
 * vue-query 的 notifyManager 用 setTimeout 调度 mutationFn / query，
 * 单次 flushPromises 断言会跑在数据层执行之前。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flushPromises();
}

/** 触发提交并等待 vee-validate 异步校验与 mutation 调度完成 */
async function submitForm(): Promise<void> {
  await wrapper!.find('form').trigger('submit');
  await settle();
}

/** 通过证券搜索选中组合标的（走「录入买卖」同款 resolve 懒实例化） */
async function pickSecurity(): Promise<void> {
  // 先等 useSecurities 加载完成，组合标的加载中时输入框 disabled（secLoading && !securityIdRef）
  await settle();
  const combobox = wrapper!.find('input#st-security');
  expect((combobox.element as HTMLInputElement).disabled).toBe(false);
  await combobox.setValue('茅台');
  // 等防抖（250ms）触发 master 搜索
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settle();
  const candidate = wrapper!.find('[data-security-candidate]');
  expect(candidate.exists()).toBe(true);
  await candidate.trigger('click');
  await settle();
}

/** 切换方向为卖出（第一个 Select 为方向），返回当前 wrapper */
async function switchSideToSell(): Promise<void> {
  const sideSelect = wrapper!.findAllComponents({ name: 'Select' })[0];
  await sideSelect.setValue('SELL_SEC');
  await settle();
}

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.createSecurityTrade.mockReset();
  apiMocks.updateSecurityTrade.mockReset();
  apiMocks.resolveSecurity.mockReset();
  apiMocks.listSecurities.mockReset();
  apiMocks.listSecurityMasters.mockReset();
  // 默认数据层桩
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

// ---------------------------------------------------------------------------

describe('SecurityTradeForm — 证券买卖录入/编辑表单', () => {
  it('渲染默认值：日期默认今天、成交额占位 0.00、方向默认买入、按钮「录入」', async () => {
    mountForm();
    await flushPromises();

    expect((wrapper!.find('input#st-date').element as HTMLInputElement).value).toBe(
      today,
    );
    expect(
      (wrapper!.find('input#st-trade-amount').element as HTMLInputElement)
        .placeholder,
    ).toBe('0.00');
    // 方向默认买入
    expect(wrapper!.find('[role="combobox"]').text()).toContain('买入');
    expect(wrapper!.find('button[type="submit"]').text()).toBe('录入');
  });

  it('校验错误：数量 0（不大于 0）→「数量必须大于 0」', async () => {
    mountForm();
    await flushPromises();

    await wrapper!.find('input#st-quantity').setValue('0');
    await submitForm();

    expect(wrapper!.text()).toContain('数量必须大于 0');
    expect(apiMocks.createSecurityTrade).not.toHaveBeenCalled();
  });

  it('校验错误：成交额 0（不大于 0）→「成交额必须大于 0」', async () => {
    mountForm();
    await flushPromises();

    await wrapper!.find('input#st-quantity').setValue('1');
    await wrapper!.find('input#st-trade-amount').setValue('0');
    await submitForm();

    expect(wrapper!.text()).toContain('成交额必须大于 0');
    expect(apiMocks.createSecurityTrade).not.toHaveBeenCalled();
  });

  it('校验错误（卖出）：费用合计超过成交额 →「费用合计不能超过成交额」（path=tradeAmount）', async () => {
    mountForm();
    await flushPromises();

    await switchSideToSell();
    await wrapper!.find('input#st-quantity').setValue('1');
    await wrapper!.find('input#st-trade-amount').setValue('100');
    await wrapper!.find('input#st-commission').setValue('150');
    await submitForm();

    expect(wrapper!.text()).toContain('费用合计不能超过成交额');
    expect(apiMocks.createSecurityTrade).not.toHaveBeenCalled();
  });

  it('提交成功：选中标的 resolve 懒实例化，payload 字段级对齐并触发 success', async () => {
    const created = {
      id: 'st-1',
      portfolioId: 'pf-1',
      securityId: 'sec-1',
      securityName: '贵州茅台',
      securityCode: '600519',
      date: today,
      side: 'BUY_SEC',
      quantity: 100,
      costPrice: 10,
      commission: '0.00',
      stampTax: '0.00',
      other: '0.00',
      feeTotal: '0.00',
      note: null,
    };
    apiMocks.resolveSecurity.mockResolvedValue(resolved);
    apiMocks.createSecurityTrade.mockResolvedValue(created);
    mountForm();

    await pickSecurity();
    await wrapper!.find('input#st-quantity').setValue('100');
    await wrapper!.find('input#st-trade-amount').setValue('1000');
    await submitForm();

    expect(apiMocks.resolveSecurity).toHaveBeenCalledWith('pf-1', {
      masterId: 'master-1',
    });
    expect(apiMocks.createSecurityTrade).toHaveBeenCalledWith('pf-1', {
      securityId: 'sec-1',
      date: today,
      side: 'BUY_SEC',
      quantity: 100,
      costPrice: 10,
      commission: 0,
      stampTax: 0,
      other: 0,
      feeTotal: 0,
      note: undefined,
    });
    expect(wrapper!.emitted('success')).toBeTruthy();
  });
});