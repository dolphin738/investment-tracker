/**
 * modules/settings/__tests__/settings-default-date-range.test.ts — I-04 默认日期范围下拉
 *
 * 平移自 React 版 web/src/pages/__tests__/settings-default-date-range.test.tsx，
 * 覆盖（增量 PRD I-04 验收 1/5/7）：
 * 1. 设置页「默认日期范围」下拉恰为 7 项，value/label 与 QUICK_RANGE_OPTIONS 逐项一致
 * 2. 修改下拉为「近一周」→ 点「保存偏好」调用偏好更新 mutation（payload.defaultDateRange = 1w）
 * 3. 「近6月 / 近1周」同样可选（后端白名单扩展 1w/6m 的前端载体）
 *
 * 脚手架与 settings-page.test.ts 完全一致：真实 composables（usePreferences /
 * useUpdatePreferences / usePortfolios）+ mock api 层 + reka-ui Select 原生
 * <select> 替身（select-stub）。日期范围下拉通过 option 集合与 QUICK_RANGE_OPTIONS
 * 逐项相等识别（select-stub 不渲染 id/label 关联，React 侧 getByLabelText 无法平移）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushPromises,
  mount,
  type DOMWrapper,
  type VueWrapper,
} from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { defineComponent, h, nextTick, ref } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { UserPreference } from '@/api/types';
import SettingsPage from '../pages/SettingsPage.vue';
import { usePreferenceStore } from '@/stores/preference.store';
import { QUICK_RANGE_OPTIONS } from '@/modules/query/quick-range';

const SERVER_PREFS: UserPreference = {
  id: 'pref-1',
  userId: 'u-1',
  defaultPortfolioId: null,
  defaultGranularity: 'month',
  defaultDateRange: '1y',
  aggregation: 'last',
  weekStartsOn: 1,
  navDecimals: 4,
  xirrDecimals: 2,
  theme: 'system',
  staleDays: 3,
  showLiquidated: false,
  cashHintOnCashflow: true,
  cashHintOnTrade: true,
  amountThousands: true,
  amountAbbrev: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// 有状态的「后端」偏好：保存后会更新，供 getPreferences 刷新读取
const prefBackend = vi.hoisted(() => ({
  saved: {
    id: 'pref-1',
    userId: 'u-1',
    defaultPortfolioId: null as string | null,
    defaultGranularity: 'month',
    defaultDateRange: '1y',
    aggregation: 'last',
    weekStartsOn: 1,
    navDecimals: 4,
    xirrDecimals: 2,
    theme: 'system',
    staleDays: 3,
    showLiquidated: false,
    cashHintOnCashflow: true as boolean,
    cashHintOnTrade: true,
    amountThousands: true,
    amountAbbrev: false,
  },
}));

const paginationlessPortfolios = vi.hoisted(() => [
  {
    id: 'pf-X',
    name: '组合X',
    archivedAt: null as string | null,
    baseDate: '2025-01-01',
  },
]);

// ---------------------------------------------------------------------------
// vi.mock：api 层（真实 composable 消费）
// ---------------------------------------------------------------------------

vi.mock('@/api/preference.api', () => ({
  getPreferences: vi.fn(() => Promise.resolve({ ...prefBackend.saved })),
  updatePreferences: vi.fn((payload: Partial<UserPreference>) => {
    Object.assign(prefBackend.saved, payload);
    return Promise.resolve({ ...prefBackend.saved });
  }),
}));

vi.mock('@/api/portfolio.api', () => ({
  listPortfolios: vi.fn(() => Promise.resolve(paginationlessPortfolios)),
  clearPortfolioData: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/api/auth.api', () => ({
  deleteAccount: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ query: {} }),
}));

// ---------------------------------------------------------------------------
// vi.mock：reka-ui Select 原生替身（同 settings-page.test.ts）
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

// ---------------------------------------------------------------------------
// vi.mock：无关对话框 / 数据管理组件（替身，同 settings-page.test.ts）
// ---------------------------------------------------------------------------

vi.mock('@/modules/account/components/ChangeEmailDialog.vue', () => ({
  default: defineComponent({
    name: 'ChangeEmailDialogStub',
    props: { open: Boolean },
    setup() {
      return () => null;
    },
  }),
}));
vi.mock('@/modules/account/components/ChangePasswordDialog.vue', () => ({
  default: defineComponent({
    name: 'ChangePasswordDialogStub',
    props: { open: Boolean },
    setup() {
      return () => null;
    },
  }),
}));
vi.mock('@/modules/account/components/EditProfileDialog.vue', () => ({
  default: defineComponent({
    name: 'EditProfileDialogStub',
    props: { open: Boolean },
    setup() {
      return () => null;
    },
  }),
}));
vi.mock('@/modules/data-transfer/components/ExportPanel.vue', () => ({
  default: defineComponent({
    name: 'ExportPanelStub',
    setup() {
      return () => h('div', { class: 'export-stub' });
    },
  }),
}));
vi.mock('@/modules/data-transfer/components/ImportDialog.vue', () => ({
  default: defineComponent({
    name: 'ImportDialogStub',
    setup() {
      return () => null;
    },
  }),
}));
vi.mock('@/modules/data-transfer/components/ImportTemplateButtons.vue', () => ({
  default: defineComponent({
    name: 'ImportTemplateButtonsStub',
    setup() {
      return () => null;
    },
  }),
}));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let queryClient: QueryClient;
let pinia: Pinia;

async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(SettingsPage, {
    attachTo: document.body,
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
      stubs: {
        teleport: true,
      },
    },
  });
  await flushPromises();
  await nextTick();
  return wrapper;
}

/** 找到「保存偏好」按钮 */
function saveButton(wrapper: VueWrapper): DOMWrapper<HTMLButtonElement> {
  const btns = wrapper.findAll('button');
  const target = btns.find((b) => b.text().includes('保存偏好'));
  if (!target) throw new Error('未找到「保存偏好」按钮');
  return target;
}

/**
 * 定位「默认日期范围」下拉：select-stub 不渲染 id/label，故用 option 集合识别——
 * 其非空 option 恰与 QUICK_RANGE_OPTIONS 逐项一致（默认组合/默认粒度/默认聚合
 * 下拉的 option 集合均不同，不会误匹配）。
 */
function findDateRangeSelect(wrapper: VueWrapper): DOMWrapper<HTMLSelectElement> {
  const selects = wrapper.findAll('select.select-stub');
  const target = selects.find((s) => {
    const values = s
      .findAll('option')
      .filter((o) => (o.element as HTMLOptionElement).value !== '')
      .map((o) => (o.element as HTMLOptionElement).value);
    return (
      values.length === QUICK_RANGE_OPTIONS.length &&
      values.every((v, i) => v === QUICK_RANGE_OPTIONS[i].value)
    );
  });
  if (!target) throw new Error('未找到「默认日期范围」下拉（select-stub）');
  return target as DOMWrapper<HTMLSelectElement>;
}

beforeEach(() => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

describe('SettingsPage — I-04 默认日期范围下拉（QUICK_RANGE_OPTIONS 单一真相源）', () => {
  it('「默认日期范围」下拉恰为 7 项，value/label 与 QUICK_RANGE_OPTIONS 逐项一致', async () => {
    const wrapper = await mountPage();

    const select = findDateRangeSelect(wrapper);
    const options = Array.from(select.element.querySelectorAll('option')).filter(
      (o) => (o as HTMLOptionElement).value !== '',
    );

    expect(options).toHaveLength(QUICK_RANGE_OPTIONS.length);
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(
      QUICK_RANGE_OPTIONS.map((o) => o.value),
    );
    expect(options.map((o) => o.textContent?.trim())).toEqual(
      QUICK_RANGE_OPTIONS.map((o) => o.label),
    );

    wrapper.unmount();
  });

  it('修改下拉为「近一周」→ 点「保存偏好」调用偏好更新 mutation（payload.defaultDateRange = 1w）', async () => {
    const wrapper = await mountPage();

    const select = findDateRangeSelect(wrapper);
    (select.element as HTMLSelectElement).value = '1w';
    await select.trigger('change');
    await nextTick();

    // 有变更 → 保存按钮解锁
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    const { updatePreferences } = await import('@/api/preference.api');
    expect(updatePreferences).toHaveBeenCalledTimes(1);
    const payload = (updatePreferences as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { defaultDateRange: string };
    expect(payload.defaultDateRange).toBe('1w');

    wrapper.unmount();
  });

  it('「近6月」「近1周」同样可选（后端白名单扩展 1w/6m 的前端载体）', async () => {
    const wrapper = await mountPage();

    const select = findDateRangeSelect(wrapper);
    const values = Array.from(select.element.querySelectorAll('option')).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).toContain('6m');
    expect(values).toContain('1w');

    wrapper.unmount();
  });
});
