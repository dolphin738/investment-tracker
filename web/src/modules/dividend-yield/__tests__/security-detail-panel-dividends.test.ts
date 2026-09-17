/**
 * modules/dividend-yield/__tests__/security-detail-panel-dividends.test.ts
 * — 详情面板「分红明细」区块（按报告期，仅显示有分红的期次）
 *
 * 守护：报告期命名（2025年报 / 2025半年报 / 2025三季报 / 2023特别分配）与
 * 分红方案（10派3元）逐条渲染；无分红时走空态；非 PAID 状态带标记。
 * 曲线数据传空 → 不挂载 BaseChart（jsdom 不初始化 echarts），只验证明细区块。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SecurityDetailPanel from '../components/SecurityDetailPanel.vue';
import type { SecurityDividendItem } from '@/api/dividend-yield.api';

const dividendItems = vi.hoisted(() => ({ list: [] as SecurityDividendItem[] }));

vi.mock('@/api/dividend-yield.api', () => ({
  getDividendYieldCurve: vi.fn(async () => ({ items: [] })),
  getSecurityDividends: vi.fn(async () => ({
    masterId: 'm-1',
    items: dividendItems.list,
  })),
}));

function item(over: Partial<SecurityDividendItem>): SecurityDividendItem {
  return {
    reportYear: 2025,
    reportQuarter: 4,
    periodType: 'ANNUAL',
    periodLabel: '2025年报',
    planLabel: '10派3元',
    cashPerShare: '0.300000',
    status: 'PAID',
    exDividendDate: '2026-06-10',
    announcementDate: null,
    ...over,
  };
}

async function mountPanel() {
  const wrapper = mount(SecurityDetailPanel, {
    props: { security: { master_id: 'm-1', code: '600001', name: '证券A' } },
    global: {
      plugins: [
        createPinia(),
        [VueQueryPlugin, { queryClient: new QueryClient() }],
      ],
    },
  });
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
  return wrapper;
}

describe('SecurityDetailPanel 分红明细', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    dividendItems.list = [];
  });

  it('按报告期逐条渲染：报告期 + 分红方案（含三季报 / 特别分配命名）', async () => {
    dividendItems.list = [
      item({}),
      item({
        reportYear: 2025,
        reportQuarter: 3,
        periodType: 'QUARTERLY',
        periodLabel: '2025三季报',
        planLabel: '10派1.5元',
      }),
      item({
        reportYear: 2023,
        reportQuarter: 4,
        periodType: 'SPECIAL',
        periodLabel: '2023特别分配',
        planLabel: '10派8元',
      }),
    ];
    const wrapper = await mountPanel();
    const rows = wrapper.findAll('li');
    expect(rows.length).toBe(3);
    expect(rows[0].text()).toContain('2025年报');
    expect(rows[0].text()).toContain('10派3元');
    expect(rows[1].text()).toContain('2025三季报');
    expect(rows[2].text()).toContain('2023特别分配');
    expect(wrapper.text()).toContain('仅显示有分红的报告期');
  });

  it('无分红记录 → 空态文案（不渲染空列表）', async () => {
    dividendItems.list = [];
    const wrapper = await mountPanel();
    expect(wrapper.text()).toContain('暂无分红记录');
    expect(wrapper.findAll('li').length).toBe(0);
  });

  it('非 PAID 状态带标记（预案 / 否决），已派发不显示', async () => {
    dividendItems.list = [
      item({ status: 'PROPOSED', periodLabel: '2026年报' }),
      item({ status: 'PAID', periodLabel: '2025年报' }),
    ];
    const wrapper = await mountPanel();
    const rows = wrapper.findAll('li');
    expect(rows[0].text()).toContain('预案');
    expect(rows[1].text()).not.toContain('预案');
  });
});
