/**
 * modules/admin/__tests__/schedule-page-empty-state.test.ts — 定时任务页空态渲染回归护栏
 *
 * 背景（缺陷 329b02a）：`<script setup>` 的 import 不向下传递。SchedulePage 拆分后，
 * EmptyState 由接收方 ScheduleTaskTable / ScheduleTaskLogsDialog 各自 import；任一接收方
 * 漏 import 时，Vue 运行时解析不到组件 → 空态文案「静默不渲染」（页面无报错、无声失败）。
 *
 * 本测试 mount 页面级 SchedulePage（非子组件），令 tasks=[] 且 loading=false，断言空态
 * 文案确实渲染；配合「删掉接收方 EmptyState import」的变异即可复现并锁死该缺陷。
 *
 * Mock 手法沿用 admin-page.test.ts（auth.store / api / use-toast 模块级 mock +
 * VueQueryPlugin + pinia + installJsdomPolyfills）；断言沿用 use-schedule-poll.test.ts
 * 的挂载风格。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// 管理员访问 + 空任务列表 + 空 handler 清单：页面进入「普通任务」页签且 loading=false
vi.mock('@/stores/auth.store', () => ({
  useIsAdmin: () => true,
  useAuthStore: () => ({
    user: { role: 'admin' },
    token: null,
    isAuthenticated: true,
    login: () => {},
    logout: () => {},
    setUser: () => {},
  }),
}));

vi.mock('@/api/schedule.api', () => ({
  listTasks: vi.fn(async () => []),
  listTaskHandlers: vi.fn(async () => []),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  triggerTask: vi.fn(),
  listTaskLogs: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import SchedulePage from '../pages/SchedulePage.vue';

let queryClient: QueryClient;
let pinia: Pinia;

async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(SchedulePage, {
    attachTo: document.body,
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  await nextTick();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  installJsdomPolyfills();
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

describe('SchedulePage 空态渲染（EmptyState import 回归护栏 · 329b02a）', () => {
  it('普通任务页签：无任务时渲染「暂无定时任务」及描述文案', async () => {
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('暂无定时任务');
    expect(wrapper.text()).toContain(
      '系统任务由系统预置且不可删除；普通任务可点击上方「新建任务」创建',
    );

    wrapper.unmount();
  });

  it('系统任务页签：无任务时渲染「暂无系统任务」空态', async () => {
    const wrapper = await mountPage();

    // reka-ui TabsTrigger 以 mousedown 切换激活页签（jsdom 下触发 mousedown 驱动切换）
    const systemTrigger = wrapper
      .findAll('button')
      .find((b) => b.text().includes('系统任务'));
    if (!systemTrigger) throw new Error('未找到「系统任务」页签');
    await systemTrigger.trigger('mousedown');
    await nextTick();
    await flushPromises();

    expect(wrapper.text()).toContain('暂无系统任务');

    wrapper.unmount();
  });

  it('空态出现时表格不渲染（v-if / v-else-if / v-else 互斥）', async () => {
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('暂无定时任务');
    expect(wrapper.find('table').exists()).toBe(false);

    wrapper.unmount();
  });
});
