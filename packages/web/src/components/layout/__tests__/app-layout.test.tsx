/**
 * components/layout/__tests__/app-layout.test.tsx — 顶栏「项目基准日期」验收测试
 *
 * 验收点（对应需求）：
 * 1. 顶栏「组合选择」**左侧**展示基准日期文本（YYYY-MM-DD），带 CalendarDays 图标；
 * 2. title 提示为「项目基准日期（北京时间 UTC+8）」；
 * 3. 日期文本内容 === todayInAppTzIso()（UTC+8 口径）；
 * 4. 响应式：窄屏隐藏（hidden）、sm 及以上显示（sm:flex）；
 * 5. 顶栏其余元素（PortfolioSelector、用户菜单）不受影响。
 *
 * Mock 策略：只 mock 网络层 hook（use-portfolios），保留真实的 store 与 UI 组件，
 * 保证 DOM 结构、className、渲染顺序都是真实的，断言才有意义。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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
import { todayInAppTzIso } from '@/lib/constants';

const BASE_DATE_TITLE = '项目基准日期（北京时间 UTC+8）';

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

  it('② 日期文本为 UTC+8 当天（YYYY-MM-DD），与 todayInAppTzIso() 一致', () => {
    renderLayout();
    const el = getBaseDateEl();
    expect(el.textContent?.trim()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(el.textContent?.trim()).toBe(todayInAppTzIso());
    // 固定时刻下的期望值：北京时间 2026-08-06
    expect(el.textContent?.trim()).toBe('2026-08-06');
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

  it('④ 样式：text-xs + muted-foreground + CalendarDays 小图标', () => {
    renderLayout();
    const el = getBaseDateEl();
    expect(el.className).toContain('text-xs');
    expect(el.className).toContain('text-muted-foreground');

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
});
