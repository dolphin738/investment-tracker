/**
 * modules/cash-balance/__tests__/cash-balance-form.test.ts — 现金余额录入/编辑表单测试
 *
 * 平移自 React 版测试策略（mock 数据层、保留真实组件渲染），覆盖：
 * 1. 新增渲染：生效日可选（date 输入）、金额占位 0.00、按钮「录入」
 * 2. 编辑锁定：生效日显示 formatDate 且不可修改提示、无 date 输入、按钮「保存」
 * 3. 校验错误：空金额 / 负数金额（允许 0）
 * 4. 提交成功：金额 0 合法（清空现金）、新增后表单重置、onSuccess 透传
 * 5. 提交失败：就地 role=alert 显示后端错误、不触发 onSuccess（弹窗不关）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import CashBalanceForm from '../components/CashBalanceForm.vue';
import { toIsoDate } from '@/lib/constants';
import type { CashBalanceResponse } from '@/api/types';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// ---------------------------------------------------------------------------
// mock：数据层 api + toast（避免真实网络与 sonner 渲染副作用）
// ---------------------------------------------------------------------------

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const apiMocks = vi.hoisted(() => ({
  listCashBalances: vi.fn(),
  getLatestCashBalance: vi.fn(),
  upsertCashBalance: vi.fn(),
  deleteCashBalance: vi.fn(),
}));

vi.mock('@/api/cash-balance.api', () => apiMocks);

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** jsdom 缺失的浏览器 API 兜底（reka-ui 组件需要） */

const today = toIsoDate(new Date());

/** 编辑态夹具（CashBalanceResponse 契约） */
const editingBalance: CashBalanceResponse = {
  id: 'cb-1',
  portfolioId: 'pf-1',
  asOf: '2024-01-15',
  amount: '2000.00',
  note: '券商账户可用余额对账',
  createdAt: '2024-01-15T00:00:00.000Z',
};

let wrapper: VueWrapper | null = null;

function mountForm(props: Record<string, unknown> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wrapper = mount(CashBalanceForm, {
    props: { portfolioId: 'pf-1', ...props },
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], createPinia()],
    },
  });
  return wrapper;
}

/**
 * 等待微任务与宏任务队列排空（与 auth 模块 settle 同模式）：
 * vue-query 的 notifyManager 用 setTimeout 调度 mutationFn，
 * 单次 flushPromises 断言会跑在 mutation 执行之前。
 */
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

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.upsertCashBalance.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// ---------------------------------------------------------------------------

describe('CashBalanceForm — 现金余额录入/编辑表单', () => {
  it('新增渲染：生效日为 date 输入（默认今天）、金额占位 0.00、按钮「录入」', async () => {
    mountForm();
    await flushPromises();

    const asOfInput = wrapper!.find('input#cb-as-of');
    expect(asOfInput.exists()).toBe(true);
    expect(asOfInput.attributes('type')).toBe('date');
    expect((asOfInput.element as HTMLInputElement).value).toBe(today);
    expect((wrapper!.find('input#cb-amount').element as HTMLInputElement).placeholder).toBe('0.00');
    expect(wrapper!.find('textarea#cb-note').attributes('placeholder')).toBe('如：券商账户可用余额对账');
    expect(wrapper!.find('button[type="submit"]').text()).toBe('录入');
  });

  it('编辑锁定：生效日显示 formatDate 且带「生效日不可修改」提示、按钮「保存」', async () => {
    mountForm({ balance: editingBalance });
    await flushPromises();

    // 编辑态不渲染 date 输入
    expect(wrapper!.find('input#cb-as-of').exists()).toBe(false);
    // 显示生效日与锁定提示
    expect(wrapper!.text()).toContain('2024-01-15');
    expect(wrapper!.text()).toContain('生效日不可修改');
    expect(wrapper!.text()).toContain('如需改日期请删除该条后重新录入');
    // 金额回填与按钮文案
    expect((wrapper!.find('input#cb-amount').element as HTMLInputElement).value).toBe('2000.00');
    expect(wrapper!.find('button[type="submit"]').text()).toBe('保存');
  });

  it('校验错误：金额为空 / 负数时显示 schema 错误消息（0 合法不报错）', async () => {
    mountForm();
    await flushPromises();

    // 金额为空
    await submitForm();
    expect(wrapper!.text()).toContain('请输入金额');

    // 负数：金额必须为不小于 0 的数字
    await wrapper!.find('input#cb-amount').setValue('-5');
    await submitForm();
    expect(wrapper!.text()).toContain('金额必须为不小于 0 的数字');
    expect(apiMocks.upsertCashBalance).not.toHaveBeenCalled();

    // 0 合法：校验通过（无错误消息）并提交成功
    apiMocks.upsertCashBalance.mockResolvedValue({
      ...editingBalance,
      amount: '0',
    });
    await wrapper!.find('input#cb-amount').setValue('0');
    await submitForm();
    expect(wrapper!.text()).not.toContain('金额必须为不小于 0 的数字');
    expect(apiMocks.upsertCashBalance).toHaveBeenCalledTimes(1);
  });

  it('提交成功：金额 0 允许（清空现金）、新增后表单重置、onSuccess 透传响应', async () => {
    const saved: CashBalanceResponse = {
      ...editingBalance,
      amount: '0',
    };
    apiMocks.upsertCashBalance.mockResolvedValue(saved);
    const onSuccess = vi.fn();
    mountForm({ onSuccess });

    await wrapper!.find('input#cb-amount').setValue('0');
    await wrapper!.find('textarea#cb-note').setValue('清空现金');
    await submitForm();

    expect(apiMocks.upsertCashBalance).toHaveBeenCalledWith('pf-1', {
      asOf: today,
      amount: 0,
      note: '清空现金',
    });
    expect(onSuccess).toHaveBeenCalledWith(saved);
    // 新增成功后表单重置（金额清空）
    expect((wrapper!.find('input#cb-amount').element as HTMLInputElement).value).toBe('');
  });

  it('编辑提交：生效日锁定为原记录 asOf（改日期 = 新建语义防呆）', async () => {
    apiMocks.upsertCashBalance.mockResolvedValue(editingBalance);
    const onSuccess = vi.fn();
    mountForm({ balance: editingBalance, onSuccess });

    await wrapper!.find('input#cb-amount').setValue('3000');
    await submitForm();

    expect(apiMocks.upsertCashBalance).toHaveBeenCalledWith('pf-1', {
      asOf: '2024-01-15',
      amount: 3000,
      note: '券商账户可用余额对账',
    });
    expect(onSuccess).toHaveBeenCalledWith(editingBalance);
  });

  it('提交失败：就地 role=alert 显示后端错误、不触发 onSuccess（弹窗不关）', async () => {
    apiMocks.upsertCashBalance.mockRejectedValue(
      new Error('生效日期不能为未来'),
    );
    const onSuccess = vi.fn();
    mountForm({ onSuccess });

    await wrapper!.find('input#cb-amount').setValue('100');
    await submitForm();

    const alertEl = wrapper!.find('[role="alert"]');
    expect(alertEl.exists()).toBe(true);
    expect(alertEl.text()).toContain('生效日期不能为未来');
    expect(onSuccess).not.toHaveBeenCalled();
    // 失败后输入保留（金额不丢）
    expect((wrapper!.find('input#cb-amount').element as HTMLInputElement).value).toBe('100');
  });
});
