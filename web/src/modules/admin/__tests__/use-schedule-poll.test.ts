/**
 * modules/admin/__tests__/use-schedule-poll.test.ts
 *
 * 守护「定时任务执行完成后，列表「最近一次执行」状态自动更新」的轮询策略：
 * 任务执行是 fire-and-forget（POST /trigger 立即返回、后台异步跑），若无轮询，
 * 前端只能靠手动刷新页面才能看到结果。
 *
 * 直接取 vue-query 的 query.options.refetchInterval 回调求值（不依赖真实定时器）：
 * - 有 RUNNING 任务 → 3000（快轮询，直到落定）
 * - 无 RUNNING 且不在观察窗口 → false（停止，避免无谓请求）
 * - 手动触发后的观察窗口内 → 5000（兜底，覆盖执行日志落库竞态）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

vi.mock('@/api/schedule.api', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  listTaskHandlers: vi.fn(async () => []),
  listTaskLogs: vi.fn(async () => ({
    items: [
      {
        id: 'l1',
        job_id: 't1',
        status: 'SUCCESS',
        trigger_source: 'MANUAL',
        started_at: '2026-09-14T00:00:00Z',
        finished_at: null,
        message: null,
        error: null,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
  })),
  listTasks: vi.fn(async () => [{ id: 't1', last_run_status: 'SUCCESS' }]),
  triggerTask: vi.fn(async () => ({ id: 't1', triggered: true })),
  updateTask: vi.fn(),
}));
vi.mock('@/composables/use-toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/stores/auth.store', () => ({ useIsAdmin: () => true }));

import {
  useTaskLogs,
  useTasks,
  useTriggerTask,
} from '@/modules/admin/composables/use-schedule';

function setupHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const Comp = defineComponent({
    setup() {
      useTasks();
      useTaskLogs(
        computed(() => 't1'),
        computed(() => ({ page: 1, pageSize: 20 })),
      );
      const trigger = useTriggerTask();
      return { trigger };
    },
    template: '<div />',
  });
  const wrapper = mount(Comp, {
    global: { plugins: [[VueQueryPlugin, { queryClient }]] },
  });
  return { queryClient, wrapper };
}

/** 取当前任务列表 query 的 refetchInterval 回调 */
function intervalFn(queryClient: QueryClient) {
  const q = queryClient.getQueryCache().find({ queryKey: ['admin', 'tasks'] });
  expect(q).toBeTruthy();
  // vue-query 的 QueryOptions 类型未暴露 refetchInterval，按运行时实际结构取
  const opts = q!.options as unknown as {
    refetchInterval?: (query: unknown) => number | false | undefined;
  };
  return opts.refetchInterval!;
}

describe('use-schedule 轮询策略', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('存在 RUNNING 任务时按 3s 快轮询', async () => {
    const { queryClient } = setupHarness();
    await flushPromises();

    const q = queryClient.getQueryCache().find({ queryKey: ['admin', 'tasks'] })!;
    q.state.data = [{ id: 't1', last_run_status: 'RUNNING' }] as never;
    expect(intervalFn(queryClient)(q)).toBe(3000);
  });

  it('无 RUNNING 且不在观察窗口时停止轮询', async () => {
    const { queryClient } = setupHarness();
    await flushPromises();

    const q = queryClient.getQueryCache().find({ queryKey: ['admin', 'tasks'] })!;
    q.state.data = [{ id: 't1', last_run_status: 'SUCCESS' }] as never;
    expect(intervalFn(queryClient)(q)).toBe(false);
  });

  it('手动触发后进入观察窗口，按 5s 兜底轮询（覆盖日志落库竞态）', async () => {
    const { queryClient, wrapper } = setupHarness();
    await flushPromises();

    const trigger = (wrapper.vm as unknown as { trigger: ReturnType<typeof useTriggerTask> })
      .trigger;
    trigger.mutate('t1');
    await flushPromises();

    const q = queryClient.getQueryCache().find({ queryKey: ['admin', 'tasks'] })!;
    q.state.data = [{ id: 't1', last_run_status: 'SUCCESS' }] as never;
    expect(intervalFn(queryClient)(q)).toBe(5000);
  });
});

/** 取任意 query 的 refetchInterval 回调（vue-query 类型未暴露，按运行时结构取） */
function intervalFnOf(q: { options: unknown; state: { data?: unknown } }) {
  const opts = q.options as unknown as {
    refetchInterval?: (query: unknown) => number | false | undefined;
  };
  return opts.refetchInterval!;
}

describe('useTaskLogs 轮询策略（执行日志弹窗）', () => {
  const LOGS_KEY = ['admin', 'task-logs', 't1', 1, 20];

  it('最新一条为 RUNNING 时按 3s 轮询', async () => {
    const { queryClient } = setupHarness();
    await flushPromises();

    const q = queryClient.getQueryCache().find({ queryKey: LOGS_KEY })!;
    expect(q).toBeTruthy();
    q.state.data = {
      items: [{ id: 'l1', job_id: 't1', status: 'RUNNING' }],
      total: 1,
      page: 1,
      pageSize: 20,
    } as never;
    expect(intervalFnOf(q)(q)).toBe(3000);
  });

  it('最新一条已落定（SUCCESS）时停止轮询', async () => {
    const { queryClient } = setupHarness();
    await flushPromises();

    const q = queryClient.getQueryCache().find({ queryKey: LOGS_KEY })!;
    q.state.data = {
      items: [{ id: 'l1', job_id: 't1', status: 'SUCCESS' }],
      total: 1,
      page: 1,
      pageSize: 20,
    } as never;
    expect(intervalFnOf(q)(q)).toBe(false);
  });
});
