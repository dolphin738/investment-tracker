/**
 * modules/analysis/__tests__/xirr-analysis-page.test.ts — XIRR 分析页渲染测试
 *
 * 覆盖（B12 批次验收：无组合空态 / 数据渲染 / 无数据空态）：
 * 1. 无组合：引导文案「请先选择一个投资组合」
 * 2. 有组合 + 序列数据：标题、当前累计 XIRR 卡、明细表行（倒序）
 * 3. 有组合 + 空序列：明细区空态「暂无数据」
 *
 * 数据层 mock：query api + 图表组件（echarts canvas 在 jsdom 不可用）+
 * reka-ui Select 原生替身；Pinia store（portfolio/preference）真实。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import XirrAnalysisPage from '../pages/XirrAnalysisPage.vue';
import { usePortfolioStore } from '@/stores/portfolio.store';
import type { Portfolio } from '@/lib/types';
import type { XirrSeriesPoint } from '@/lib/types';

// ---------------------------------------------------------------------------
// mock：图表组件（echarts canvas 渲染在 jsdom 不可用，替身为纯文本节点）
// ---------------------------------------------------------------------------

vi.mock('@/components/charts/XirrTrendChart.vue', () => ({
  default: defineComponent({
    name: 'XirrTrendChartStub',
    props: { data: { type: Array, default: () => [] }, title: String },
    setup(props) {
      return () => h('div', { class: 'xirr-chart-stub' }, props.title);
    },
  }),
}));

vi.mock('@/components/charts/YearlyBarChart.vue', () => ({
  default: defineComponent({
    name: 'YearlyBarChartStub',
    setup() {
      return () => h('div', { class: 'yearly-chart-stub' });
    },
  }),
}));

// ---------------------------------------------------------------------------
// mock：reka-ui Select 原生替身（页面测试不与其交互，仅为 jsdom 挂载稳健）
// ---------------------------------------------------------------------------

vi.mock('@/components/ui/select', async () => {
  await import('vue');
  const Select = defineComponent({
    props: { modelValue: { type: String, default: '' } },
    emits: ['update:modelValue'],
    setup(props, { emit, slots }) {
      return () =>
        h(
          'select',
          {
            value: props.modelValue ?? '',
            onChange: (e: Event) =>
              emit('update:modelValue', (e.target as HTMLSelectElement).value),
          },
          [h('option', { key: '__ph', value: '' }, ''), slots.default?.()],
        );
    },
  });
  const SelectItem = defineComponent({
    props: { value: { type: String, required: true } },
    setup(props, { slots }) {
      return () => h('option', { value: props.value }, slots.default?.());
    },
  });
  const passthrough = defineComponent({
    setup(_, { slots }) {
      return () => slots.default?.();
    },
  });
  const renderNothing = defineComponent({
    setup() {
      return () => null;
    },
  });
  return {
    Select,
    SelectItem,
    SelectTrigger: renderNothing,
    SelectValue: renderNothing,
    SelectContent: passthrough,
    SelectGroup: passthrough,
    SelectLabel: passthrough,
    SelectSeparator: renderNothing,
    SelectScrollUpButton: renderNothing,
    SelectScrollDownButton: renderNothing,
  };
});

// ---------------------------------------------------------------------------
// 数据层 mock（可变夹具：各用例按需覆写）
// ---------------------------------------------------------------------------

const PORTFOLIO: Portfolio = {
  id: 'p1',
  userId: 'u1',
  name: '主组合',
  description: null,
  baseDate: '2024-01-01',
  currency: 'CNY',
  archivedAt: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

/** 序列点（页面维度默认取偏好 defaultGranularity，用日粒度夹具） */
const SERIES: XirrSeriesPoint[] = [
  { date: '2026-06-30', label: '2026-06-30', xirrValue: 0.1 },
  { date: '2026-07-31', label: '2026-07-31', xirrValue: 0.12 },
];

const fixtures = vi.hoisted(() => ({
  series: [] as XirrSeriesPoint[],
  latest: { date: '2026-07-31', xirrValue: 0.12 },
}));

vi.mock('@/api/query.api', () => ({
  getXirrSeries: vi.fn(async (_pid: string, params: { granularity?: string }) => {
    // useYearStartXirr 以日粒度独立查询「较年初」基准，与页面序列区分返回
    return params?.granularity === 'day' ? [] : fixtures.series;
  }),
  getLatestXirr: vi.fn(async () => fixtures.latest),
  getNavSeries: vi.fn(async () => []),
  getLatestNav: vi.fn(async () => ({
    date: '2026-07-31',
    cumulativeNav: null,
    yearNav: null,
    shares: null,
  })),
}));

// ---------------------------------------------------------------------------
// 挂载
// ---------------------------------------------------------------------------

/** jsdom 缺失的浏览器 API 兜底（reka-ui / 图表容器挂载需要） */
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
}

let pinia: Pinia;
let queryClient: QueryClient;

async function mountPage() {
  const wrapper = mount(XirrAnalysisPage, {
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
    },
  });
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  installJsdomPolyfills();
  window.history.replaceState(null, '', '/');
  fixtures.series = SERIES;
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const portfolioStore = usePortfolioStore();
  portfolioStore.setPortfolios([PORTFOLIO]);
  portfolioStore.setCurrentPortfolio('p1');
});

// ---------------------------------------------------------------------------

describe('XirrAnalysisPage 收益分析页', () => {
  it('无组合：渲染引导文案「请先选择一个投资组合」', async () => {
    const portfolioStore = usePortfolioStore();
    portfolioStore.clearCurrent();
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('请先选择一个投资组合');
    expect(wrapper.text()).not.toContain('收益分析（XIRR）');
  });

  it('有组合 + 序列数据：渲染标题、当前累计 XIRR 卡与明细表（倒序）', async () => {
    const wrapper = await mountPage();
    const text = wrapper.text();

    // 页面标题与指标卡
    expect(text).toContain('收益分析（XIRR）');
    expect(text).toContain('当前累计 XIRR');
    expect(text).toContain('12.00%');
    expect(text).toContain('较年初变化');
    // 明细表头与倒序行（07-31 在前）
    expect(text).toContain('明细数据');
    expect(text).toContain('日期');
    const rows = wrapper.findAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('2026-07-31');
    expect(rows[1]!.text()).toContain('2026-06-30');
  });

  it('有组合 + 空序列：明细区展示空态「暂无数据」', async () => {
    fixtures.series = [];
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('暂无数据');
    expect(wrapper.findAll('tbody tr')).toHaveLength(0);
  });
});
