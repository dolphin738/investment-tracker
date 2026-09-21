/**
 * modules/admin/__tests__/pending-dividends-page.test.ts — 待划分分红页（批次 D）
 *
 * 覆盖（设计 §5.3.2 / §5.3.7 / §5.3.8）：
 * 1. 权限门控：非 admin/auditor → 整页「无权限访问该页面」且**不发起**任何查询；
 *    auditor → 只读可见（无写操作按钮）；admin → 可见写操作。
 * 2. 筛选变化 / 翻页 → 清空选中集（防跨筛选批量误操作）。
 * 3. 批量忽略：二次确认（AlertDialog，正文写明「不写入主表」）→ 调 batch-ignore。
 *
 * 数据层策略：mock `@/api/dividend-yield.api`（7 端点）与 toast；真实 vue-query /
 * Pinia；reka-ui AlertDialog 走真实实现（内容经自研 Portal 渲染到 body）。
 * 指定弹窗（reka-ui Dialog）以轻量替身替换，避免与本组断言无关的弹层干扰。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';
import type { components } from '@/types/api';

type PendingDividendOut = components['schemas']['PendingDividendOut'];

// ── mock：toast ──
vi.mock('@/composables/use-toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// ── mock：数据层 api（7 端点 + settings） ──
const apiMocks = vi.hoisted(() => ({
  listPendingDividends: vi.fn(),
  getPendingDividendSummary: vi.fn(),
  assignPendingDividend: vi.fn(),
  batchAssignPendingDividends: vi.fn(),
  ignorePendingDividend: vi.fn(),
  batchIgnorePendingDividends: vi.fn(),
  reopenPendingDividend: vi.fn(),
  getDividendYieldSettings: vi.fn(),
}));
vi.mock('@/api/dividend-yield.api', () => apiMocks);

// ── mock：角色（可控） ──
const authState = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'auditor' | 'user' }));
vi.mock('@/stores/auth.store', () => ({
  useHasRole: (...roles: string[]) => roles.includes(authState.role),
  useIsAdmin: () => authState.role === 'admin',
}));

// ── mock：指定弹窗（reka-ui Dialog 替身，避免无关弹层） ──
vi.mock('@/modules/admin/components/PendingDividendAssignDialog.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'PendingDividendAssignDialog',
      props: ['open', 'row', 'retentionYears', 'pending'],
      emits: ['submit', 'update:open'],
      setup() {
        return () => h('div', { class: 'assign-dialog-stub' });
      },
    }),
  };
});

import PendingDividendsPage from '../pages/PendingDividendsPage.vue';

function row(over: Partial<PendingDividendOut>): PendingDividendOut {
  return {
    id: 'p1',
    masterId: 'm1',
    code: '600001',
    name: '证券A',
    exchange: 'SH',
    dividendLabel: '特别分红',
    cashPerShare: '1.000000',
    bonusShareRatio: null,
    convertRatio: null,
    recordDate: null,
    exDividendDate: '2024-11-26',
    payDate: null,
    announcementDate: null,
    reportPeriodRaw: '特别分红',
    status: 'PENDING',
    resolvedPeriodType: null,
    resolvedReportYear: null,
    resolvedReportQuarter: null,
    createdAt: '2024-12-01T00:00:00Z',
    resolvedAt: null,
    ...over,
  };
}

let wrapper: VueWrapper | null = null;
let pinia: Pinia;
let queryClient: QueryClient;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await nextTick();
}

async function mountPage(): Promise<VueWrapper> {
  const w = mount(PendingDividendsPage, {
    attachTo: document.body,
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
    },
  });
  await settle();
  return w;
}

/** 在 document 范围按精确文案找按钮（reka-ui AlertDialog 内容在 body） */
function buttonByText(text: string): HTMLButtonElement {
  const btns = Array.from(document.querySelectorAll('button'));
  const target = btns.find((b) => (b.textContent ?? '').trim() === text);
  if (!target) throw new Error(`未找到文案为「${text}」的按钮`);
  return target;
}

beforeEach(() => {
  installJsdomPolyfills();
  vi.clearAllMocks();
  authState.role = 'admin';
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  apiMocks.listPendingDividends.mockResolvedValue({
    items: [row({ id: 'p1' }), row({ id: 'p2' })],
    total: 2,
    page: 1,
    pageSize: 20,
  });
  apiMocks.getPendingDividendSummary.mockResolvedValue({
    pending: 2,
    assigned: 0,
    ignored: 0,
    total: 2,
    labels: ['特别分红'],
  });
  apiMocks.getDividendYieldSettings.mockResolvedValue({
    dividend_detail_source: null,
    price_source: null,
    announcement_source: null,
    trade_calendar_start_date: null,
    dividend_retention_years: 5,
  });
  apiMocks.batchIgnorePendingDividends.mockResolvedValue({ succeeded: 2, failed: [] });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('PendingDividendsPage — 权限门控', () => {
  it('非 admin/auditor → 整页无权限 Card，且不发任何查询', async () => {
    authState.role = 'user';
    wrapper = await mountPage();
    expect(wrapper.text()).toContain('无权限访问该页面');
    expect(wrapper.find('table').exists()).toBe(false);
    expect(apiMocks.listPendingDividends).not.toHaveBeenCalled();
    expect(apiMocks.getPendingDividendSummary).not.toHaveBeenCalled();
  });

  it('auditor → 只读可见（表渲染、无写操作按钮）', async () => {
    authState.role = 'auditor';
    wrapper = await mountPage();
    expect(wrapper.find('table').exists()).toBe(true);
    expect(wrapper.text()).toContain('只读');
    // 行内写操作（忽略）不应出现
    expect(
      wrapper.findAll('button').some((b) => b.text().trim() === '忽略'),
    ).toBe(false);
  });

  it('admin → 可见行内写操作与批量入口', async () => {
    wrapper = await mountPage();
    expect(wrapper.find('table').exists()).toBe(true);
    expect(
      wrapper.findAll('button').some((b) => b.text().trim() === '忽略'),
    ).toBe(true);
  });
});

describe('PendingDividendsPage — 选中集与筛选联动', () => {
  it('筛选变化 → 清空选中集（批量条消失）', async () => {
    wrapper = await mountPage();

    // 选中两行 → 出现批量条
    const boxes = wrapper.findAll('tbody input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    await boxes[0].setValue(true);
    await boxes[1].setValue(true);
    await nextTick();
    expect(wrapper.text()).toContain('已选 2 笔');

    // 切换状态筛选 → page=1 且清空选中
    await wrapper.find('#pd-filter-status').setValue('ASSIGNED');
    await settle();
    expect(wrapper.text()).not.toContain('已选 2 笔');
  });
});

describe('PendingDividendsPage — 批量忽略二次确认', () => {
  it('勾选 → 忽略 → 确认弹窗（写明不写主表）→ 调 batch-ignore', async () => {
    wrapper = await mountPage();

    const boxes = wrapper.findAll('tbody input[type="checkbox"]');
    await boxes[0].setValue(true);
    await boxes[1].setValue(true);
    await nextTick();

    // 批量条「忽略 (2)」
    const ignoreBtn = wrapper
      .findAll('button')
      .find((b) => b.text().trim().startsWith('忽略 ('))!;
    await ignoreBtn.trigger('click');
    await settle();

    expect(document.body.textContent).toContain('不会写入分红主表');

    buttonByText('确认').click();
    await settle();

    expect(apiMocks.batchIgnorePendingDividends).toHaveBeenCalledTimes(1);
    expect(apiMocks.batchIgnorePendingDividends).toHaveBeenCalledWith(['p1', 'p2']);
  });
});
