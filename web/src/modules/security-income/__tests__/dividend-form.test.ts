/**
 * modules/security-income/__tests__/dividend-form.test.ts — 分红录入/编辑表单测试
 *
 * 功能矩阵（字段级等价，见 B10 批次需求）：
 * 1. 渲染默认值：日期默认今天、金额占位 0.00、录入态类型固定「现金分红」、按钮「保存」
 * 2. 校验：金额 ≤ 0 →「金额必须大于 0」
 * 3. 校验：税 > 额 →「净额不能为负」（path=tax）
 * 4. 净额负数红框：税 > 税前时 data-testid=dividend-net-amount 命中 text-destructive
 * 5. 提交成功 payload 必带 type（防 forbidNonWhitelisted 400）：通过证券搜索选中标的
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import DividendForm from '../components/DividendForm.vue';
import { toIsoDate } from '@/lib/constants';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// ---------------------------------------------------------------------------
// mock：数据层 api + toast（避免真实网络与 sonner 渲染副作用）
// ---------------------------------------------------------------------------

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const apiMocks = vi.hoisted(() => ({
  // dividend.api
  listDividends: vi.fn(),
  createDividend: vi.fn(),
  updateDividend: vi.fn(),
  deleteDividend: vi.fn(),
  // security.api
  listSecurities: vi.fn(),
  resolveSecurity: vi.fn(),
  // security-master.api
  listSecurityMasters: vi.fn(),
}));

vi.mock('@/api/dividend.api', () => ({
  listDividends: apiMocks.listDividends,
  createDividend: apiMocks.createDividend,
  updateDividend: apiMocks.updateDividend,
  deleteDividend: apiMocks.deleteDividend,
}));

vi.mock('@/api/security.api', () => ({
  listSecurities: apiMocks.listSecurities,
  resolveSecurity: apiMocks.resolveSecurity,
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
  wrapper = mount(DividendForm, {
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
  const combobox = wrapper!.find('input#income-security');
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

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.createDividend.mockReset();
  apiMocks.updateDividend.mockReset();
  apiMocks.resolveSecurity.mockReset();
  apiMocks.listSecurities.mockReset();
  apiMocks.listSecurityMasters.mockReset();
  // 默认数据层桩
  apiMocks.listSecurities.mockResolvedValue({ items: securities, total: 1, page: 1, pageSize: 50 });
  apiMocks.listSecurityMasters.mockResolvedValue({ items: [master], total: 1, page: 1, pageSize: 20 });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// ---------------------------------------------------------------------------

describe('DividendForm — 分红录入/编辑表单', () => {
  it('渲染默认值：日期默认今天、金额占位 0.00、录入态类型固定现金分红、按钮「保存」', async () => {
    mountForm();
    await flushPromises();

    expect((wrapper!.find('input#income-date').element as HTMLInputElement).value).toBe(today);
    expect((wrapper!.find('input#income-amount').element as HTMLInputElement).placeholder).toBe('0.00');
    expect((wrapper!.find('input#income-tax').element as HTMLInputElement).placeholder).toBe('0.00');
    // 录入态类型固定「现金分红（红利再投不录入）」
    expect(wrapper!.text()).toContain('现金分红（红利再投不录入）');
    expect(wrapper!.find('button[type="submit"]').text()).toBe('保存');
  });

  it('校验错误：金额 0（不大于 0）→「金额必须大于 0」', async () => {
    mountForm();
    await flushPromises();

    await wrapper!.find('input#income-amount').setValue('0');
    await submitForm();

    expect(wrapper!.text()).toContain('金额必须大于 0');
    expect(apiMocks.createDividend).not.toHaveBeenCalled();
  });

  it('校验错误：税 > 税前额 →「净额不能为负」（path=tax）', async () => {
    mountForm();
    await flushPromises();

    await wrapper!.find('input#income-amount').setValue('100');
    await wrapper!.find('input#income-tax').setValue('200');
    await submitForm();

    expect(wrapper!.text()).toContain('净额不能为负');
    expect(apiMocks.createDividend).not.toHaveBeenCalled();
  });

  it('净额负数预览红框：税 > 税前时 data-testid=dividend-net-amount 命中 text-destructive', async () => {
    mountForm();
    await flushPromises();

    await wrapper!.find('input#income-amount').setValue('100');
    await wrapper!.find('input#income-tax').setValue('150');
    await settle();

    const net = wrapper!.find('[data-testid="dividend-net-amount"]');
    expect(net.exists()).toBe(true);
    expect(net.element.classList.contains('text-destructive')).toBe(true);
    // 净额应显示负值（税前 100 − 税 150 = −50）
    expect(net.text()).toContain('-50');
  });

  it('提交成功 payload 必带 type=CASH（防 forbidNonWhitelisted 400）；选中标的调用 resolveSecurity', async () => {
    const created = {
      id: 'dv-1',
      portfolioId: 'pf-1',
      securityId: 'sec-1',
      securityName: '贵州茅台',
      securityCode: '600519',
      date: today,
      type: 'CASH',
      amount: '100.00',
      tax: '0.00',
      netAmount: '100.00',
      note: null,
    };
    apiMocks.resolveSecurity.mockResolvedValue(resolved);
    apiMocks.createDividend.mockResolvedValue(created);
    const onSuccess = vi.fn();
    mountForm({ onSuccess });

    await pickSecurity();
    await wrapper!.find('input#income-amount').setValue('100');
    await submitForm();

    expect(apiMocks.resolveSecurity).toHaveBeenCalledWith('pf-1', { masterId: 'master-1' });
    expect(apiMocks.createDividend).toHaveBeenCalledWith('pf-1', {
      securityId: 'sec-1',
      date: today,
      amount: '100',
      type: 'CASH',
      tax: undefined,
      note: undefined,
    });
    expect(onSuccess).toHaveBeenCalled();
  });
});