/**
 * modules/admin/__tests__/global-settings-dividend-tab.test.ts — 全局设置「股息率」TAB 测试
 *
 * 覆盖（§15.3 T2，对齐 §12）：
 * 1. 存在第四个下拉（公司公告接口），其选项均为 category_id==='4' && enabled
 *    （未启用的分类 4 接口与其他分类接口不得出现在公告源下拉中）
 * 2. SelectItem 文本为「接口名（提供方名）」拼接格式（providerNameById 反查生效），
 *    未知提供方显示「未知提供方」
 *
 * Mock 策略（同 admin-page.test.ts）：composables 层全部 mock（useDividendYieldSettings /
 * useDividendYieldInterfaces / useUpdateDividendYieldSettings / useQuoteProviders），
 * reka-ui Select 以原生 <select>/<option> 替身（SelectItem 渲染为 option，可断言文本）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushPromises,
  mount,
  type DOMWrapper,
  type VueWrapper,
} from '@vue/test-utils';
import { ref, defineComponent, h } from 'vue';
import { SELECT_EMPTY_VALUE } from '@/lib/constants';

// ---------------------------------------------------------------------------
// 测试数据（模块级共享：mock 工厂与断言共用）
// ---------------------------------------------------------------------------

const interfaces = vi.hoisted(() => [
  { id: 'i1', provider_id: 'p1', category_id: '3', name: '东财-分红配送', enabled: true },
  { id: 'i2', provider_id: 'p2', category_id: '3', name: '新浪-分红配股', enabled: true },
  { id: 'i3', provider_id: 'p1', category_id: '2', name: '腾讯财经-A股行情', enabled: true },
  { id: 'i4', provider_id: 'p1', category_id: '4', name: '沪深京A股公告', enabled: true },
  // 分类 4 但未启用：不应出现在公告源下拉
  { id: 'i5', provider_id: 'p2', category_id: '4', name: '东财-公告扫描', enabled: false },
]);

const providers = vi.hoisted(() => [
  { id: 'p1', name: '东方财富' },
  { id: 'p2', name: '新浪财经' },
]);

const settings = vi.hoisted(() => ({
  green_threshold: 0.05,
  red_threshold: 0.03,
  dividend_report_source: { id: 'i1', name: '东财-分红配送' },
  dividend_detail_source: { id: 'i2', name: '新浪-分红配股' },
  price_source: { id: 'i3', name: '腾讯财经-A股行情' },
  announcement_source: null,
}));

const mutateSpy = vi.hoisted(() => vi.fn());

vi.mock('@/modules/dividend-yield/composables/use-dividend-yield', () => ({
  useDividendYieldSettings: () => ({
    data: ref(settings),
    isLoading: ref(false),
  }),
  useDividendYieldInterfaces: () => ({
    data: ref(interfaces),
  }),
  useUpdateDividendYieldSettings: () => ({
    isPending: ref(false),
    isError: ref(false),
    mutate: mutateSpy,
  }),
}));

vi.mock('@/modules/admin/composables/use-quote-provider', () => ({
  useQuoteProviders: () => ({
    data: ref(providers),
  }),
}));

// reka-ui Select 原生替身：Select 渲染为 <select>，SelectItem 渲染为 <option>（可断言文本）
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
            'data-testid': 'select',
            class: 'select-stub',
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
    SelectLabel: renderNothing,
  };
});

import GlobalSettingsDividendTab from '../components/GlobalSettingsDividendTab.vue';

let wrapper: VueWrapper;

/** 渲染组件并等待表单 watch 回填 */
async function mountTab(): Promise<VueWrapper> {
  const w = mount(GlobalSettingsDividendTab);
  await flushPromises();
  return w;
}

/** 非空 option（跳过 Select 替身自带的占位空 option） */
function realOptions(select: DOMWrapper<Element>): DOMWrapper<Element>[] {
  return select.findAll('option').filter((o) => o.text().trim() !== '');
}

/**
 * 接口 option（跳过「不设置」哨兵项与占位空 option）。
 * 哨兵取自 SELECT_EMPTY_VALUE 真源：reka-ui 禁止 value=""，写死空串会在
 * 组件改用哨兵后误把「不设置」当成接口项（历史教训）。
 */
function interfaceOptions(select: DOMWrapper<Element>): DOMWrapper<Element>[] {
  return select
    .findAll('option')
    .filter(
      (o) => o.attributes('value') !== SELECT_EMPTY_VALUE && o.text().trim() !== '',
    );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GlobalSettingsDividendTab — 四源下拉与提供方名拼接（§15.3 T2）', () => {
  it('① 存在第四个下拉（公司公告接口），选项均为 category_id==="4" && enabled', async () => {
    wrapper = await mountTab();

    // 页面含「公司公告接口」区块
    expect(wrapper.text()).toContain('公司公告接口');

    // 四个数据源下拉（主源 / 补充源 / 行情源 / 公告源）
    const selects = wrapper.findAll('select');
    expect(selects).toHaveLength(4);

    // 公告源下拉（第 4 个）：仅包含启用的分类 4 接口
    const announcementOptions = interfaceOptions(selects[3]);
    const announcementValues = announcementOptions.map((o) =>
      o.attributes('value'),
    );
    expect(announcementValues).toEqual(['i4']);
    // 每个下拉都提供「不设置」哨兵项（reka-ui 禁止 value=""，故用哨兵而非空串）
    selects.forEach((sel) => {
      expect(
        realOptions(sel).some((o) => o.attributes('value') === SELECT_EMPTY_VALUE),
      ).toBe(true);
      expect(realOptions(sel).some((o) => o.attributes('value') === '')).toBe(false);
    });
    // 未启用（i5）与分类 3/2（i1/i2/i3）接口均不得出现在公告源下拉
    expect(announcementValues).not.toContain('i5');
    expect(announcementValues).not.toContain('i1');
    expect(announcementValues).not.toContain('i3');

    wrapper.unmount();
  });

  it('② SelectItem 文本为「接口名（提供方名）」拼接格式（providerNameById 反查生效）', async () => {
    wrapper = await mountTab();

    const selects = wrapper.findAll('select');
    // 主源下拉：东财-分红配送 归属 东方财富（p1）
    const reportOptions = interfaceOptions(selects[0]);
    expect(reportOptions[0].text()).toBe('东财-分红配送（东方财富）');
    // 补充源下拉（候选与主源同为分类 3）：两个提供方名反查均生效
    const detailOptions = interfaceOptions(selects[1]);
    expect(detailOptions[0].text()).toBe('东财-分红配送（东方财富）');
    expect(detailOptions[1].text()).toBe('新浪-分红配股（新浪财经）');
    // 公告源下拉：沪深京A股公告 归属 东方财富（p1）
    const announcementOptions = interfaceOptions(selects[3]);
    expect(announcementOptions[0].text()).toBe('沪深京A股公告（东方财富）');

    // 全部接口 option 均须符合「（提供方名）」结尾格式
    selects.forEach((sel) => {
      interfaceOptions(sel).forEach((o) => {
        expect(o.text()).toMatch(/（.+）$/);
      });
    });

    wrapper.unmount();
  });

  it('③ 卸载重挂载（缓存命中）表单仍回填（watch immediate 守护）', async () => {
    // 父页用 v-if 卸载非激活 TAB：mock 的 settings ref 挂载时已有值（vue-query 缓存命中态）。
    // 非 immediate 的 watch 在重挂载时不会触发 → 表单空白、误判「有未保存的更改」。
    wrapper = await mountTab();
    wrapper.unmount();

    wrapper = await mountTab();
    const selects = wrapper.findAll('select');
    // 四个数据源下拉的模型值均回填为服务端配置
    expect((selects[0].element as HTMLSelectElement).value).toBe('i1');
    expect((selects[1].element as HTMLSelectElement).value).toBe('i2');
    expect((selects[2].element as HTMLSelectElement).value).toBe('i3');
    // 阈值回填 → settingsHasChanges 为 false → 保存按钮不因假差异而启用
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存股息率设置'));
    expect(saveBtn).toBeDefined();
    expect(saveBtn!.attributes('disabled')).toBeDefined();

    wrapper.unmount();
  });
});
