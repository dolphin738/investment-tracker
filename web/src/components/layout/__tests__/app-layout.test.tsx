/**
 * components/layout/__tests__/app-layout.test.tsx — 顶栏「项目基准日期时间」验收测试
 *
 * 验收点（对应需求：在「项目基准日期」基础上新增实时时间部分）：
 * 1. 顶栏「组合选择」**左侧**展示基准日期时间文本（YYYY-MM-DD HH:mm:ss），带 CalendarDays 图标；
 * 2. title 提示为「项目基准日期时间（北京时间 UTC+8）」；
 * 3. 日期时间文本内容 === nowInAppTzIso()（UTC+8 口径，含时间部分）；
 * 4. 响应式：窄屏隐藏（hidden）、sm 及以上显示（sm:flex）；
 * 5. 顶栏其余元素（PortfolioSelector、用户菜单）不受影响；
 * 6. 实时时钟：首次渲染即显示当前北京时间（无需等待 1s 间隔）；
 * 7. 实时走动：每秒自动刷新，且跨午夜正确翻日；
 * 8. 卸载清理：unmount 时 clearInterval，定时器不再回调（无内存泄漏）；
 * 9. 等宽数字排版：font-mono + tabular-nums（秒位跳动时不抖动）。
 *
 * Mock 策略：只 mock 网络层 hook（use-portfolios），保留真实的 store 与 UI 组件，
 * 保证 DOM 结构、className、渲染顺序都是真实的，断言才有意义。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Mock：组合列表（避免真实 HTTP）
// ---------------------------------------------------------------------------
vi.mock('@/hooks/use-portfolios', () => ({
  PORTFOLIOS_KEY: ['portfolios'],
  usePortfolios: () => ({
    data: [
      { id: 'pf-1', name: '主组合', archivedAt: null },
      { id: 'pf-2', name: '备用组合', archivedAt: null },
    ],
    isLoading: false,
  }),
  useCreatePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useArchivePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeletePortfolio: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useClearPortfolioData: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { AppLayout } from '@/components/layout/app-layout';
import { nowInAppTzIso, todayInAppTzIso } from '@/lib/constants';

const BASE_DATE_TITLE = '项目基准日期时间（北京时间 UTC+8）';

function renderLayout() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <AppLayout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 取顶栏基准日期 span（以 title 精确定位，避免误匹配） */
function getBaseDateEl(): HTMLElement {
  const el = document.querySelector(`[title="${BASE_DATE_TITLE}"]`);
  expect(el, '未找到 title 为「项目基准日期（北京时间 UTC+8）」的元素').not.toBeNull();
  return el as HTMLElement;
}

describe('AppLayout 顶栏 — 项目基准日期', () => {
  beforeEach(() => {
    // 固定时刻：2026-08-05T23:00:00Z ＝ 北京时间 2026-08-06 07:00
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 5, 23, 0, 0)));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('① 顶栏渲染基准日期，且 title 提示正确', () => {
    renderLayout();
    const el = getBaseDateEl();
    expect(el.getAttribute('title')).toBe(BASE_DATE_TITLE);
  });

  it('② 日期时间文本为 UTC+8 当天（YYYY-MM-DD HH:mm:ss），与 nowInAppTzIso() 一致', () => {
    renderLayout();
    const el = getBaseDateEl();
    expect(el.textContent?.trim()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(el.textContent?.trim()).toBe(nowInAppTzIso());
    // 固定时刻下的期望值：北京时间 2026-08-06 07:00:00
    expect(el.textContent?.trim()).toBe('2026-08-06 07:00:00');
    // 日期部分口径与 todayInAppTzIso() 一致
    expect(el.textContent?.trim().slice(0, 10)).toBe(todayInAppTzIso());
  });

  it('③ 位于「组合选择」左侧（DOM 顺序在 PortfolioSelector 之前）', () => {
    renderLayout();
    const dateEl = getBaseDateEl();
    const selectorTrigger = screen.getByRole('combobox');

    // Node.DOCUMENT_POSITION_FOLLOWING = 4：selectorTrigger 在 dateEl 之后
    const pos = dateEl.compareDocumentPosition(selectorTrigger);
    expect(
      pos & Node.DOCUMENT_POSITION_FOLLOWING,
      '基准日期应位于组合选择器之前（左侧）',
    ).toBeTruthy();
  });

  it('④ 样式：text-xs + muted-foreground + 等宽数字 + CalendarDays 小图标', () => {
    renderLayout();
    const el = getBaseDateEl();
    expect(el.className).toContain('text-xs');
    expect(el.className).toContain('text-muted-foreground');
    // 秒位每秒跳动，必须等宽字体 + 表格数字，避免文本宽度抖动导致顶栏元素左右晃动
    expect(el.className, '时钟应使用 font-mono 等宽字体').toContain('font-mono');
    expect(el.className, '时钟应使用 tabular-nums 等宽数字').toContain('tabular-nums');

    const icon = el.querySelector('svg');
    expect(icon, '基准日期应带 CalendarDays 图标').not.toBeNull();
    expect(icon?.getAttribute('class') ?? '').toContain('h-3.5');
    expect(icon?.getAttribute('class') ?? '').toContain('w-3.5');
    // lucide-react 会给 svg 加 lucide-calendar-days / lucide-calendar-days 类名
    expect((icon?.getAttribute('class') ?? '').toLowerCase()).toContain('calendar');
  });

  it('⑤ 响应式：窄屏 hidden、sm 及以上 flex', () => {
    renderLayout();
    const el = getBaseDateEl();
    expect(el.className).toContain('hidden');
    expect(el.className).toContain('sm:flex');
  });

  it('⑥ 组合选择器不受影响：正常渲染并显示占位/选项', () => {
    renderLayout();
    const trigger = screen.getByRole('combobox');
    expect(trigger).toBeTruthy();
    // 未选中任何组合时展示占位符
    expect(trigger.textContent).toContain('选择组合');
  });

  it('⑦ 用户菜单不受影响：aria-label="用户菜单" 按钮存在', () => {
    renderLayout();
    expect(screen.getByLabelText('用户菜单')).toBeTruthy();
  });

  it('⑧ 顶栏右区结构：仅 基准日 span + 组合选择器 + 用户菜单', () => {
    renderLayout();
    const dateEl = getBaseDateEl();
    const rightZone = dateEl.parentElement as HTMLElement;
    expect(rightZone.children.length).toBe(3);
    expect(rightZone.children[0]).toBe(dateEl);
    // 第 3 个是用户菜单触发器所在容器
    expect(within(rightZone).getByLabelText('用户菜单')).toBeTruthy();
  });

  it('⑨ 顶栏左区（Logo/标题）不受影响', () => {
    renderLayout();
    expect(screen.getByText('投资收益统计')).toBeTruthy();
  });

  it('⑩ 实时时钟：首次渲染即显示当前北京时间（含时间部分，无需等待间隔）', () => {
    renderLayout();
    const el = getBaseDateEl();
    // 首次渲染的 useState 初始化即调用 nowInAppTzIso()，不应为空也不应仅为日期
    const text = el.textContent?.trim() ?? '';
    expect(text).not.toBe('');
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // 与 nowInAppTzIso() 当前值一致（固定时刻下为 2026-08-06 07:00:00）
    expect(text).toBe(nowInAppTzIso());
  });

  it('⑪ 实时走动：每秒自动刷新，文本随时间前进（1s / 2s / 1min）', () => {
    renderLayout();
    expect(getBaseDateEl().textContent?.trim()).toBe('2026-08-06 07:00:00');

    // 推进 1s：秒位 +1
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(getBaseDateEl().textContent?.trim()).toBe('2026-08-06 07:00:01');

    // 再推进 1s：秒位再 +1（证明是持续 interval，而非一次性 timeout）
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(getBaseDateEl().textContent?.trim()).toBe('2026-08-06 07:00:02');

    // 推进 58s：进位到下一分钟
    act(() => {
      vi.advanceTimersByTime(58_000);
    });
    expect(getBaseDateEl().textContent?.trim()).toBe('2026-08-06 07:01:00');

    // 全程保持 YYYY-MM-DD HH:mm:ss 格式
    expect(getBaseDateEl().textContent?.trim()).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
  });

  it('⑫ 实时走动跨午夜：北京 23:59:59 → 00:00:00 正确翻日', () => {
    // UTC 15:59:59 ＝ 北京 2026-08-05 23:59:59（下一秒即跨日）
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 5, 15, 59, 59)));
    renderLayout();
    expect(getBaseDateEl().textContent?.trim()).toBe('2026-08-05 23:59:59');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 日期翻到 08-06 且时间归零，而不是停留在 08-05
    expect(getBaseDateEl().textContent?.trim()).toBe('2026-08-06 00:00:00');
    // 与纯函数口径保持一致
    expect(getBaseDateEl().textContent?.trim()).toBe(nowInAppTzIso());
    expect(getBaseDateEl().textContent?.trim().slice(0, 10)).toBe(todayInAppTzIso());
  });

  it('⑬ 卸载清理：unmount 时 clearInterval，且回调不再触发（无泄漏）', () => {
    const nativeSetInterval = window.setInterval.bind(window);
    let tickCount = 0;
    let clockTimerId: number | undefined;

    // 包装时钟的 1s interval 回调，以便统计其真实触发次数
    const setSpy = vi
      .spyOn(window, 'setInterval')
      .mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (ms === 1000 && typeof handler === 'function') {
          clockTimerId = nativeSetInterval(
            () => {
              tickCount += 1;
              (handler as () => void)();
            },
            ms,
            ...args,
          ) as unknown as number;
          return clockTimerId;
        }
        return nativeSetInterval(handler, ms, ...args);
      }) as typeof window.setInterval);
    const clearSpy = vi.spyOn(window, 'clearInterval');

    const { unmount } = renderLayout();

    // 时钟确实注册了 1000ms 间隔定时器
    expect(setSpy.mock.calls.some(([, ms]) => ms === 1000), '时钟应注册 1000ms interval').toBe(true);
    expect(clockTimerId).toBeDefined();

    // 挂载期间正常走动
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(tickCount).toBe(2);

    unmount();

    // 卸载时以正确的 timer id 调用 clearInterval
    expect(clearSpy, 'unmount 应调用 clearInterval 清理时钟').toHaveBeenCalledWith(clockTimerId);

    // 卸载后继续推进时间，回调不应再触发（证明定时器已真正移除）
    const ticksAtUnmount = tickCount;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(tickCount, 'unmount 后定时器回调不应再触发（内存泄漏）').toBe(ticksAtUnmount);
  });
});
