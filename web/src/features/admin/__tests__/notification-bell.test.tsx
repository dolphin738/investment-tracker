/**
 * features/admin/__tests__/notification-bell.test.tsx — 顶栏通知铃铛验收（T11）
 *
 * 验收点：
 * 1. 铃铛渲染；有未读时显示红色未读角标（数量 = 未读数）；
 * 2. 点击铃铛展开下拉，列出全部通知标题；
 * 3. 点击某条「标记已读」按钮 → 调用 markNotificationRead(该通知 id)；
 * 4. 仅管理员可见（useIsAdmin=false 时不渲染铃铛）。
 *
 * Mock 策略：仅 mock 网络层（notification.api + auth + sonner），保留真实
 * use-notification（useNotifications / useMarkNotificationRead）与组件渲染。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let adminFlag = true;

const SAMPLE_NOTIFS = [
  {
    id: 'n1',
    level: 'warning',
    title: '接口A连续失败',
    message: '已连续3次无响应',
    related_type: 'quote_interface',
    related_id: 'i1',
    read: false,
    created_at: '2026-08-01T01:00:00Z',
  },
  {
    id: 'n2',
    level: 'warning',
    title: '接口B连续失败',
    message: '已连续3次无响应',
    related_type: 'quote_interface',
    related_id: 'i2',
    read: false,
    created_at: '2026-08-01T02:00:00Z',
  },
  {
    id: 'n3',
    level: 'info',
    title: '系统维护通知',
    message: '本周末系统维护',
    related_type: null,
    related_id: null,
    read: true,
    created_at: '2026-08-01T03:00:00Z',
  },
];

vi.mock('@/stores/auth.store', () => ({
  useIsAdmin: () => adminFlag,
  useAuthStore: () => ({
    user: { role: 'admin' },
    token: null,
    isAuthenticated: true,
    login: () => {},
    logout: () => {},
    setUser: () => {},
  }),
}));

vi.mock('@/api/notification.api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    listNotifications: vi.fn().mockResolvedValue(SAMPLE_NOTIFS),
    markNotificationRead: vi.fn().mockResolvedValue({ ...SAMPLE_NOTIFS[0], read: true }),
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { NotificationBell } from '@/features/admin/notification-bell';
import { listNotifications, markNotificationRead } from '@/api/notification.api';

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NotificationBell — 通知铃铛', () => {
  beforeEach(() => {
    adminFlag = true;
    vi.mocked(listNotifications).mockResolvedValue(SAMPLE_NOTIFS as never);
    vi.mocked(markNotificationRead).mockResolvedValue({
      ...SAMPLE_NOTIFS[0],
      read: true,
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('① 管理员：渲染铃铛且未读角标显示数量 2', async () => {
    renderWithProviders(<NotificationBell />);
    const bell = await screen.findByLabelText(/通知（2 条未读）/);
    expect(bell).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('② 点击铃铛展开下拉，列出全部通知标题', async () => {
    renderWithProviders(<NotificationBell />);
    const bell = await screen.findByLabelText(/通知（2 条未读）/);
    await act(async () => {
      fireEvent.click(bell);
    });
    expect(await screen.findByText('接口A连续失败')).toBeTruthy();
    expect(screen.getByText('接口B连续失败')).toBeTruthy();
    expect(screen.getByText('系统维护通知')).toBeTruthy();
  });

  it('③ 点击某条「标记已读」→ 调用 markNotificationRead(id)', async () => {
    renderWithProviders(<NotificationBell />);
    const bell = await screen.findByLabelText(/通知（2 条未读）/);
    await act(async () => {
      fireEvent.click(bell);
    });
    await screen.findByText('接口A连续失败');
    const markBtns = screen.getAllByRole('button', { name: '标记已读' });
    expect(markBtns.length).toBe(2); // 两条未读
    await act(async () => {
      fireEvent.click(markBtns[0]);
    });
    await waitFor(() => {
      expect(vi.mocked(markNotificationRead)).toHaveBeenCalledWith('n1');
    });
  });

  it('④ 非管理员：不渲染铃铛', async () => {
    adminFlag = false;
    renderWithProviders(<NotificationBell />);
    // 等待一拍，确认无铃铛出现
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByLabelText(/通知/)).toBeNull();
  });
});
