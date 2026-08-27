/**
 * modules/portfolio/__tests__/portfolio-dialog.test.ts — 组合创建/编辑对话框测试
 *
 * 覆盖（B3 批次验收：渲染 / 校验 / 提交）：
 * 1. 渲染：新建态标题「新建组合」、按钮「创建」、输入框为空；
 *    编辑态标题「编辑组合」、值回填、按钮「保存」
 * 2. 校验：空名称提交 →「请输入组合名称」；名称 51 字 →「名称最多 50 字」；
 *    描述 201 字 →「描述最多 200 字」（schema 消息逐字锁定）
 * 3. 提交成功：新建走 createPortfolio、编辑走 updatePortfolio(回传 id)，
 *    成功后向父组件 emit open-change(false) 关闭对话框
 *
 * Dialog 内容经 reka-ui Portal 传送到 document.body，
 * 统一从 body 查询 DOM；API 层与 toast 全部 mock 隔离网络。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import PortfolioDialog from '../components/PortfolioDialog.vue';
import {
  createPortfolio,
  updatePortfolio,
} from '@/api/portfolio.api';
import type { Portfolio } from '@/lib/types';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// ---------------------------------------------------------------------------
// mock：组合 API + toast（隔离网络与 sonner 全局提示副作用）
// ---------------------------------------------------------------------------

const apiMocks = vi.hoisted(() => ({
  listPortfolios: vi.fn(),
  createPortfolio: vi.fn(),
  updatePortfolio: vi.fn(),
}));

vi.mock('@/api/portfolio.api', () => ({
  ...apiMocks,
  archivePortfolio: vi.fn(),
  deletePortfolio: vi.fn(),
  clearPortfolioData: vi.fn(),
  setDefaultPortfolio: vi.fn(),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

/** jsdom 缺失的浏览器 API 兜底（reka-ui Dialog 需要） */

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 编辑态夹具（Portfolio 契约） */
const EDITING_PORTFOLIO: Portfolio = {
  id: 'p1',
  userId: 'u1',
  name: '主组合',
  description: '旧描述',
  baseDate: '2024-01-01',
  currency: 'CNY',
  archivedAt: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

let wrapper: VueWrapper | null = null;
let queryClient: QueryClient;

/** body 内文本（Portal 传送目的地） */
const bodyText = (): string => document.body.textContent ?? '';

/**
 * 挂载对话框并打开。
 * 对齐真实使用方式（AppLayout 常驻挂载、open 由 false → true 触发回填 reset）：
 * 先以 open=false 挂载，再 setProps 打开。
 */
async function mountDialog(props: { portfolio?: Portfolio | null } = {}) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wrapper = mount(PortfolioDialog, {
    props: { open: false, portfolio: props.portfolio ?? null },
    attachTo: document.body,
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], createPinia()],
    },
  });
  await wrapper.setProps({ open: true });
  await flushPromises();
  return wrapper;
}

/** 原生设置输入值（v-model 经 input 事件同步） */
async function setInput(selector: string, value: string): Promise<void> {
  const el = document.body.querySelector(selector) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

/**
 * 完整沉降：vue-query 的 notifyManager 用 setTimeout 调度 mutationFn，
 * 单次 flushPromises + 单次 setTimeout 断言会跑在 mutation 执行之前
 * （与 auth/cash-balance 模块 settle 同模式）。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flushPromises();
}

/** 触发提交并等待 vee-validate 异步校验 + mutation 微/宏任务链完全落定 */
async function submitForm(): Promise<void> {
  const form = document.body.querySelector('form') as HTMLFormElement;
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.createPortfolio.mockReset().mockResolvedValue(EDITING_PORTFOLIO);
  apiMocks.updatePortfolio.mockReset().mockResolvedValue(EDITING_PORTFOLIO);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// ---------------------------------------------------------------------------

describe('PortfolioDialog — 组合创建/编辑对话框', () => {
  it('渲染：新建态标题「新建组合」、按钮「创建」、输入框为空', async () => {
    await mountDialog();

    expect(bodyText()).toContain('新建组合');
    expect(bodyText()).toContain('创建一个新的投资组合');
    const submit = document.body.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submit.textContent).toContain('创建');
    expect(
      (document.body.querySelector('#portfolio-name') as HTMLInputElement)
        .value,
    ).toBe('');
  });

  it('校验：空名称提交显示「请输入组合名称」且不调创建接口', async () => {
    await mountDialog();
    await submitForm();

    expect(bodyText()).toContain('请输入组合名称');
    expect(createPortfolio).not.toHaveBeenCalled();
  });

  it('校验：名称 51 字与描述 201 字分别显示超长错误消息', async () => {
    await mountDialog();
    await setInput('#portfolio-name', '长'.repeat(51));
    await setInput('#portfolio-description', '长'.repeat(201));
    await submitForm();

    expect(bodyText()).toContain('名称最多 50 字');
    expect(bodyText()).toContain('描述最多 200 字');
    expect(createPortfolio).not.toHaveBeenCalled();
  });

  it('提交成功：新建携带名称与描述调用 createPortfolio，并 emit open-change(false)', async () => {
    const w = await mountDialog();
    await setInput('#portfolio-name', 'A股长线组合');
    await setInput('#portfolio-description', '定投宽基');
    await submitForm();

    expect(createPortfolio).toHaveBeenCalledTimes(1);
    expect(createPortfolio).toHaveBeenCalledWith({
      name: 'A股长线组合',
      description: '定投宽基',
    });
    // mutation onSuccess 后关闭对话框
    expect(w.emitted('openChange')?.at(-1)).toEqual([false]);
  });

  it('编辑态：回填原值、按钮「保存」，提交走 updatePortfolio 并回传 id', async () => {
    const w = await mountDialog({ portfolio: EDITING_PORTFOLIO });

    expect(bodyText()).toContain('编辑组合');
    const submit = document.body.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submit.textContent).toContain('保存');
    expect(
      (document.body.querySelector('#portfolio-name') as HTMLInputElement)
        .value,
    ).toBe('主组合');

    await setInput('#portfolio-name', '主组合改名');
    await submitForm();

    expect(updatePortfolio).toHaveBeenCalledTimes(1);
    expect(updatePortfolio).toHaveBeenCalledWith('p1', {
      name: '主组合改名',
      description: '旧描述',
    });
    expect(w.emitted('openChange')?.at(-1)).toEqual([false]);
  });
});
