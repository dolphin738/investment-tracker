/**
 * modules/dividend-yield/__tests__/implied-price-calculator.test.ts — 股息价格推算契约
 *
 * 守护（审查 M-2/M-3/L-2 收口）：候选渲染（榜单前 200 语义）与本地过滤、
 * 选中带出每股分红 + 快速参考折算、目标股息率换算与边界校验、
 * 键入即清残留选中（M-3）、候选加载失败错误态（L-2）。mock api 层，vue-query 真实。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import ImpliedPriceCalculator from '../components/ImpliedPriceCalculator.vue';
import type { DividendYieldRankItem } from '@/api/types';

const fixtures = vi.hoisted(() => {
  const rankItem = (over: Partial<DividendYieldRankItem>): DividendYieldRankItem => ({
    master_id: 'm-0',
    code: '600000',
    name: '证券600000',
    exchange: 'SH',
    mode: 'TTM',
    dividend_yield: 0.08,
    numerator_per_share: 0.5,
    latest_price: 10,
    latest_trade_date: '2026-09-04',
    consecutive_years: 3,
    last_dividend_year: 2026,
    stale: false,
    suspicious: false,
    computed_at: null,
    ...over,
  });
  return {
    failRank: false,
    impliedCalls: [] as Array<{ id: string; ratio: number }>,
    ranks: [
      rankItem({ master_id: 'm-1', code: '600001', name: '证券600001' }),
      rankItem({ master_id: 'm-2', code: '000002', name: '万科A' }),
      rankItem({ master_id: 'm-3', code: '600519', name: '贵州茅台', numerator_per_share: 6 }),
    ],
  };
});

vi.mock('@/api/dividend-yield.api', () => ({
  getDividendYieldRank: vi.fn(async () => {
    if (fixtures.failRank) throw new Error('boom');
    return {
      items: fixtures.ranks,
      total: fixtures.ranks.length,
      page: 1,
      pageSize: 200,
    };
  }),
  getDividendYieldImpliedPrice: vi.fn(
    async (masterId: string, targetRatio: number) => {
      fixtures.impliedCalls.push({ id: masterId, ratio: targetRatio });
      return {
        master_id: masterId,
        code: '600001',
        name: '证券600001',
        numerator_per_share: 0.5,
        target_ratio: targetRatio,
        implied_price: 0.5 / targetRatio,
        current_price: 10,
        current_dividend_yield: 0.05,
      };
    },
  ),
}));

function mountCalc(retry = true) {
  return mount(ImpliedPriceCalculator, {
    global: {
      plugins: [
        [
          VueQueryPlugin,
          {
            queryClient: new QueryClient({
              defaultOptions: { queries: { retry } },
            }),
          },
        ],
      ],
    },
  });
}

async function openCandidates(wrapper: ReturnType<typeof mountCalc>) {
  await wrapper.find('#dy-calc-security').trigger('focus');
  await flushPromises();
}

async function pickFirst(wrapper: ReturnType<typeof mountCalc>) {
  await openCandidates(wrapper);
  await wrapper.find('[data-combobox-candidate]').trigger('click');
  await flushPromises();
}

/** 模拟真实键入：test-utils setValue 对 type=number 输入会强转 number，与生产（组件 v-model 始终 string）不符 */
async function typeRatio(wrapper: ReturnType<typeof mountCalc>, v: string) {
  const el = wrapper.find('#dy-calc-ratio');
  (el.element as HTMLInputElement).value = v;
  await el.trigger('input');
  await flushPromises();
}

describe('ImpliedPriceCalculator（§10.2 股息价格推算 TAB）', () => {
  beforeEach(() => {
    fixtures.failRank = false;
    fixtures.impliedCalls.length = 0;
  });

  it('候选渲染（榜单前 200 语义）与本地过滤（代码/名称）', async () => {
    const wrapper = mountCalc();
    await flushPromises();
    await openCandidates(wrapper);
    expect(wrapper.findAll('[data-combobox-candidate]').length).toBe(3);

    // 代码过滤
    await wrapper.find('#dy-calc-security').setValue('6005');
    expect(wrapper.findAll('[data-combobox-candidate]').length).toBe(1);
    expect(wrapper.text()).toContain('贵州茅台');

    // 名称过滤
    await wrapper.find('#dy-calc-security').setValue('万科');
    expect(wrapper.findAll('[data-combobox-candidate]').length).toBe(1);
    expect(wrapper.text()).toContain('万科A');
  });

  it('M-3：键入即清残留选中（结果卡不再显示旧股）', async () => {
    const wrapper = mountCalc();
    await flushPromises();
    await pickFirst(wrapper);

    // 选中 + 有效目标股息率 → 结果卡出现（implied 请求发出）
    await typeRatio(wrapper, '6');
    await flushPromises();
    expect(fixtures.impliedCalls.length).toBe(1);
    expect(wrapper.find('[aria-label="隐含价格"]').exists()).toBe(true);

    // 开始键入新搜索词 → 选中被清 → 结果卡立即消失
    await wrapper.find('#dy-calc-security').setValue('6005');
    expect(wrapper.find('[aria-label="隐含价格"]').exists()).toBe(false);
  });

  it('选中带出每股分红（只读）+ 快速参考 3%~8% 六档折算', async () => {
    const wrapper = mountCalc();
    await flushPromises();
    await pickFirst(wrapper);

    const numeratorInput = wrapper.find('#dy-calc-numerator');
    expect((numeratorInput.element as HTMLInputElement).value).toBe('0.5');
    // 只读
    expect(numeratorInput.attributes('readonly')).toBeDefined();

    // 快速参考：0.5 ÷ 0.05 = 10（5% 档）
    const cards = wrapper.findAll('.grid.grid-cols-2 > div');
    expect(cards.length).toBe(6);
    expect(wrapper.text()).toContain('10.00');
  });

  it('目标股息率换算与边界校验（0 / >100 / 正常值）', async () => {
    const wrapper = mountCalc();
    await flushPromises();
    await pickFirst(wrapper);

    const ratio = wrapper.find('#dy-calc-ratio');
    // number 路径：test-utils setValue 对 type=number 输入强转 number（与真实浏览器 ui/Input v-model 行为一致）
    await ratio.setValue('0');
    expect(wrapper.text()).toContain('须为 0 < 目标股息率 ≤ 100 的数值');
    // string 路径：原生 input 事件
    await typeRatio(wrapper, '150');
    expect(wrapper.text()).toContain('须为 0 < 目标股息率 ≤ 100 的数值');
    expect(fixtures.impliedCalls.length).toBe(0);

    await typeRatio(wrapper, '6');
    await flushPromises();
    expect(fixtures.impliedCalls[0]).toEqual({ id: 'm-1', ratio: 0.06 });
    // 服务端权威：隐含价 = 0.5 / 0.06
    expect(wrapper.text()).toContain('8.33');
  });

  it('清除叉：清选中与搜索词', async () => {
    const wrapper = mountCalc();
    await flushPromises();
    await pickFirst(wrapper);
    expect((wrapper.find('#dy-calc-numerator').element as HTMLInputElement).value).toBe('0.5');

    await wrapper.find('[aria-label="清除"]').trigger('click');
    await flushPromises();
    expect((wrapper.find('#dy-calc-numerator').element as HTMLInputElement).value).toBe('');
  });

  it('L-2：候选加载失败展示错误态（不误显「无匹配结果」）', async () => {
    fixtures.failRank = true;
    const wrapper = mountCalc(false);
    await flushPromises();
    await openCandidates(wrapper);
    expect(wrapper.text()).toContain('加载失败');
    expect(wrapper.text()).not.toContain('无匹配结果');
  });
});
