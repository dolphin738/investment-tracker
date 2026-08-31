/**
 * modules/cashflow/__tests__/cashflow-form.test.ts — 出入金录入/编辑表单测试
 *
 * 平移自 React 版测试策略（mock 数据层、保留真实组件渲染），覆盖：
 * 1. 渲染默认值：类型默认「存入」、日期默认今天、金额占位 0.00、按钮「录入」
 * 2. 校验错误：空金额 / 非正金额 / 备注超长（schema 错误消息逐条锁定）
 * 3. 提交成功：调用 createTransaction、表单重置、onSuccess 透传响应
 * 4. 编辑回填：传 cashflow 后值回填、按钮「保存」、走 updateTransaction
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import CashflowForm from '../components/CashflowForm.vue';
import { toIsoDate } from '@/lib/constants';
import type { TransactionResponse } from '@/api/types';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// ---------------------------------------------------------------------------
// mock：数据层 api + toast（避免真实网络与 sonner 渲染副作用）
// ---------------------------------------------------------------------------

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const apiMocks = vi.hoisted(() => ({
  listTransactions: vi.fn(),
  createTransaction: vi.fn(),
  updateTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
}));

vi.mock('@/api/transaction.api', () => apiMocks);

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** jsdom 缺失的浏览器 API 兜底（reka-ui Dialog / Select 需要） */

const today = toIsoDate(new Date());

/** 编辑态夹具（TransactionResponse 契约） */
const editingCashflow: TransactionResponse = {
  id: 'tx-1',
  portfolioId: 'pf-1',
  date: '2024-03-01',
  type: 'SELL',
  amount: '500.00',
  note: '生活费支出',
  createdAt: '2024-03-01T00:00:00.000Z',
  updatedAt: '2024-03-01T00:00:00.000Z',
};

let wrapper: VueWrapper | null = null;

function mountForm(props: Record<string, unknown> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wrapper = mount(CashflowForm, {
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

/** 触发提交并等待 vee-validate 异步校验与 mutation 调度完成 */
async function submitForm(): Promise<void> {
  await wrapper!.find('form').trigger('submit');
  await settle();
}

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.createTransaction.mockReset();
  apiMocks.updateTransaction.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// ---------------------------------------------------------------------------

describe('CashflowForm — 出入金录入/编辑表单', () => {
  it('渲染默认值：类型默认存入、日期默认今天、金额占位 0.00、按钮「录入」', async () => {
    mountForm();
    await flushPromises();

    // 类型默认 BUY=存入（SelectValue 读取已注册选项的文本）
    expect(wrapper!.text()).toContain('存入');
    // 日期默认今天
    expect((wrapper!.find('input#cf-date').element as HTMLInputElement).value).toBe(today);
    // 金额占位与备注占位
    expect((wrapper!.find('input#cf-amount').element as HTMLInputElement).placeholder).toBe('0.00');
    expect(wrapper!.find('textarea#cf-note').attributes('placeholder')).toBe('如：工资入金 / 生活支出');
    // 新建按钮文案
    expect(wrapper!.find('button[type="submit"]').text()).toBe('录入');
  });

  it('校验错误：金额为空 / 非正数时显示 schema 错误消息', async () => {
    mountForm();
    await flushPromises();

    // 金额为空
    await submitForm();
    expect(wrapper!.text()).toContain('请输入金额');

    // 金额为 0（不大于 0）
    await wrapper!.find('input#cf-amount').setValue('0');
    await submitForm();
    expect(wrapper!.text()).toContain('金额必须大于 0');
    expect(apiMocks.createTransaction).not.toHaveBeenCalled();
  });

  it('校验错误：备注超过 200 字', async () => {
    mountForm();
    await flushPromises();

    await wrapper!.find('input#cf-amount').setValue('100');
    await wrapper!.find('textarea#cf-note').setValue('a'.repeat(201));
    await submitForm();

    expect(wrapper!.text()).toContain('备注最多 200 字');
    expect(apiMocks.createTransaction).not.toHaveBeenCalled();
  });

  it('提交成功：调用 createTransaction、表单重置、onSuccess 透传响应', async () => {
    const created: TransactionResponse = {
      id: 'tx-new',
      portfolioId: 'pf-1',
      date: today,
      type: 'BUY',
      amount: '100.00',
      note: '工资入金',
      createdAt: '2024-03-01T00:00:00.000Z',
      updatedAt: '2024-03-01T00:00:00.000Z',
    };
    apiMocks.createTransaction.mockResolvedValue(created);
    const onSuccess = vi.fn();
    mountForm({ onSuccess });

    await wrapper!.find('input#cf-amount').setValue('100');
    await wrapper!.find('textarea#cf-note').setValue('工资入金');
    await submitForm();

    expect(apiMocks.createTransaction).toHaveBeenCalledWith('pf-1', {
      date: today,
      type: 'BUY',
      amount: '100',
      note: '工资入金',
    });
    expect(onSuccess).toHaveBeenCalledWith(created);
    // 新建成功后表单重置（金额清空）
    expect((wrapper!.find('input#cf-amount').element as HTMLInputElement).value).toBe('');
  });

  it('编辑回填：值回填、按钮「保存」、提交走 updateTransaction', async () => {
    const updated: TransactionResponse = {
      ...editingCashflow,
      amount: '600.00',
    };
    apiMocks.updateTransaction.mockResolvedValue(updated);
    const onSuccess = vi.fn();
    mountForm({ cashflow: editingCashflow, onSuccess });
    await flushPromises();

    // 回填
    expect((wrapper!.find('input#cf-date').element as HTMLInputElement).value).toBe('2024-03-01');
    expect((wrapper!.find('input#cf-amount').element as HTMLInputElement).value).toBe('500.00');
    expect((wrapper!.find('textarea#cf-note').element as HTMLTextAreaElement).value).toBe('生活费支出');
    // 编辑态按钮文案
    expect(wrapper!.find('button[type="submit"]').text()).toBe('保存');

    // 修改金额后提交
    await wrapper!.find('input#cf-amount').setValue('600');
    await submitForm();

    expect(apiMocks.updateTransaction).toHaveBeenCalledWith(
      'pf-1',
      'tx-1',
      { date: '2024-03-01', type: 'SELL', amount: '600', note: '生活费支出' },
    );
    expect(apiMocks.createTransaction).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith(updated);
  });
});
