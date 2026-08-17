/**
 * modules/analysis/composables/use-range-preference-sync.ts — 偏好对齐守卫单测（移植自 React 版）
 *
 * 验证点（决策 E 统一范式）：
 * 1. 偏好异步对齐：currentQuick='' 且偏好 defaultDateRange='1y' 时，挂载后 onAlign 调用一次。
 * 2. currentQuick 已等于偏好值 → 不再回写（已对齐）。
 * 3. markInteracted 守卫：用户一旦交互，即便偏好/依赖项变化也不再对齐。
 * 4. URL 参数守卫：挂载瞬间 URL 含 range/from/to → 全程不对齐。
 * 5. enabled=false → 不对齐。
 * 6. 'all' 二次对齐：baseDate（allRangeStart）到位后，若当前 startDate 仍是兜底值，再对齐一次。
 *
 * 时间控制：用 fake timers 钉死系统时间，便于断言精确起止日。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, reactive } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import {
  useRangePreferenceSync,
  type RangePreferenceAlignment,
  type UseRangePreferenceSyncResult,
} from '../composables/use-range-preference-sync';

/** 可控偏好默认值（mock useDefaultDateRange） */
const pref = vi.hoisted(() => ({ value: '1y' }));

vi.mock('@/composables/use-default-date-range', () => ({
  useDefaultDateRange: () => computed(() => pref.value),
}));

/** 基准「今天」：2026-06-15（与 quick-range.test.ts 对齐） */
const BASE_NOW = new Date(2026, 5, 15, 12, 0, 0);

interface HarnessState {
  currentQuick: string;
  currentStartDate?: string;
  allRangeStart?: string | null;
}

interface HarnessVm {
  state: HarnessState;
  api: UseRangePreferenceSyncResult;
  onAlign: ReturnType<typeof vi.fn>;
}

/** 受控载体：以 reactive state 驱动 composable 的 getter 入参（initial 在挂载前注入，避免多出一次立即对齐） */
const Harness = defineComponent({
  props: {
    initial: {
      type: Object as () => Partial<HarnessState>,
      default: () => ({}),
    },
  },
  setup(props) {
    const state = reactive<HarnessState>({
      currentQuick: '',
      currentStartDate: undefined,
      allRangeStart: null,
      ...props.initial,
    });
    const onAlign = vi.fn();
    const api = useRangePreferenceSync({
      currentQuick: () => state.currentQuick,
      currentStartDate: () => state.currentStartDate,
      allRangeStart: () => state.allRangeStart,
      onAlign,
    });
    return { state, api, onAlign };
  },
  template: '<div />',
});

let wrapper: VueWrapper | null = null;

function mountHarness(initial: Partial<HarnessState> = {}): VueWrapper {
  wrapper = mount(Harness, { props: { initial }, attachTo: document.body });
  return wrapper;
}

/** 类型安全的 vm 访问器（wrapper.vm 默认不含 setup 返回的内部属性类型） */
function vm(): HarnessVm {
  return wrapper!.vm as unknown as HarnessVm;
}

beforeEach(() => {
  pref.value = '1y';
  vi.useFakeTimers();
  vi.setSystemTime(BASE_NOW);
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useRangePreferenceSync — 偏好异步对齐', () => {
  it('currentQuick 为空 + 偏好 1y → 挂载后 onAlign 调用一次，写入 1y 起止日', async () => {
    mountHarness();
    await flushPromises();

    expect(vm().api.defaultRange.value).toBe('1y');
    expect(vm().onAlign).toHaveBeenCalledTimes(1);
    expect(vm().onAlign).toHaveBeenCalledWith({
      quick: '1y',
      startDate: '2025-06-15',
      endDate: '2026-06-15',
    } satisfies RangePreferenceAlignment);
  });

  it('currentQuick 已等于偏好值 → 不再回写（已对齐）', async () => {
    mountHarness({ currentQuick: '1y' });
    await flushPromises();
    expect(vm().onAlign).not.toHaveBeenCalled();
  });
});

describe('useRangePreferenceSync — markInteracted 守卫', () => {
  it('用户交互后，即便偏好变化也不再对齐', async () => {
    mountHarness();
    await flushPromises();
    expect(vm().onAlign).toHaveBeenCalledTimes(1);

    // 用户先手动交互
    const api = vm().api;
    api.markInteracted();

    // 偏好变化触发 watch 再次评估；交互守卫应阻止对齐
    pref.value = 'all';
    await flushPromises();
    expect(api.hasInteracted.value).toBe(true);
    expect(vm().onAlign).toHaveBeenCalledTimes(1);
  });

  it('未交互时，依赖项（allRangeStart）变化会重新对齐（幂等：仍为同一偏好值）', async () => {
    mountHarness();
    expect(vm().onAlign).toHaveBeenCalledTimes(1);

    vm().state.allRangeStart = '2024-01-01';
    await flushPromises();
    // 1y 不受 allRangeStart 影响，但依赖变化触发幂等再写一次
    expect(vm().onAlign).toHaveBeenCalledTimes(2);
    expect(vm().onAlign.mock.calls[1][0].quick).toBe('1y');
  });
});

describe('useRangePreferenceSync — URL 参数守卫', () => {
  it('挂载时 URL 含 range → 不对齐（hasUrlRangeParam=true）', async () => {
    window.history.replaceState(null, '', '/?range=1y');
    mountHarness();
    await flushPromises();
    expect(vm().api.hasUrlRangeParam).toBe(true);
    expect(vm().onAlign).not.toHaveBeenCalled();
  });

  it('挂载时 URL 含 from/to → 不对齐', async () => {
    window.history.replaceState(null, '', '/?from=2024-01-01&to=2024-12-31');
    mountHarness();
    await flushPromises();
    expect(vm().onAlign).not.toHaveBeenCalled();
  });

  it('urlParamKeys=[] → 跳过 URL 判定（本地状态载体，应正常对齐）', async () => {
    window.history.replaceState(null, '', '/?range=1y');
    const LocalHarness = defineComponent({
      setup() {
        const onAlign = vi.fn();
        const api = useRangePreferenceSync({
          currentQuick: () => '',
          onAlign,
          urlParamKeys: [],
        });
        return { api, onAlign };
      },
      template: '<div />',
    });
    wrapper = mount(LocalHarness, { attachTo: document.body });
    await flushPromises();
    expect((wrapper.vm as unknown as HarnessVm).onAlign).toHaveBeenCalledTimes(1);
  });
});

describe('useRangePreferenceSync — enabled 开关', () => {
  it('enabled=false → 不对齐', async () => {
    const DisabledHarness = defineComponent({
      setup() {
        const onAlign = vi.fn();
        useRangePreferenceSync({ currentQuick: () => '', onAlign, enabled: false });
        return { onAlign };
      },
      template: '<div />',
    });
    wrapper = mount(DisabledHarness, { attachTo: document.body });
    await flushPromises();
    expect((wrapper.vm as unknown as HarnessVm).onAlign).not.toHaveBeenCalled();
  });
});

describe("useRangePreferenceSync — 「全部」二次对齐", () => {
  it('首次用兜底起点对齐，baseDate 到达后若 startDate 仍是兜底值则再对齐一次', async () => {
    pref.value = 'all';
    mountHarness();
    expect(vm().onAlign).toHaveBeenCalledTimes(1);
    expect(vm().onAlign.mock.calls[0][0].startDate).toBe('2000-01-01');

    // baseDate 到达
    vm().state.allRangeStart = '2024-01-01';
    await flushPromises();
    expect(vm().onAlign).toHaveBeenCalledTimes(2);
    expect(vm().onAlign.mock.calls[1][0].startDate).toBe('2024-01-01');
    expect(vm().onAlign.mock.calls[1][0].quick).toBe('all');
  });

  it('baseDate 到达后 startDate 已为真实起点 → 不再重复对齐', async () => {
    pref.value = 'all';
    mountHarness({
      currentQuick: 'all',
      currentStartDate: '2000-01-01',
      allRangeStart: '2024-01-01',
    });
    // 首次：startDate 仍是兜底值 → 对齐到真实起点
    expect(vm().onAlign).toHaveBeenCalledTimes(1);
    expect(vm().onAlign.mock.calls[0][0].startDate).toBe('2024-01-01');

    // 页面已把修复后的 start 回写，baseDate 不变 → 不重复对齐
    vm().state.currentStartDate = '2024-01-01';
    await flushPromises();
    expect(vm().onAlign).toHaveBeenCalledTimes(1);
  });
});
