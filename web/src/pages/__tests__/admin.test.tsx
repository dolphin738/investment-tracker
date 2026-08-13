/**
 * pages/__tests__/admin.test.tsx — 系统管理页（多提供方）RBAC 与表单行为验收
 *
 * 验收点：
 * 1. 非管理员：页面不渲染「新增数据来源」按钮，改为展示「无权限访问」；
 *    且侧边栏不展示「系统管理」入口（useIsAdmin === false → 过滤 admin 项）。
 * 2. 管理员：表格可见并列出提供方，且展示「新增数据来源」按钮。
 * 3. 管理员：点击「新增数据来源」打开对话框，填写并提交调用 createQuoteProvider
 *    且请求体含 name / access_method=https / config.base_url / enabled。
 *
 * Mock 策略（稳健模式）：
 * - @/stores/auth.store：useIsAdmin 由模块级 adminFlag 控制，useAuthStore 提供空实现；
 * - @/api/quote-provider.api：importOriginal + 内部 vi.fn() 覆盖各读写函数，断言走 vi.mocked(...)；
 * - sonner：toast 置空实现，避免副作用。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// 模块级开关：控制 useIsAdmin 的返回值（在测试间切换）
let adminFlag = false;

const SAMPLE_LIST = [
  {
    id: 'p1',
    name: '新浪财经',
    access_method: 'https',
    config: { base_url: 'https://finance.sina.com.cn/api' },
    enabled: true,
    description: '默认源',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

vi.mock('@/stores/auth.store', () => ({
  useIsAdmin: () => adminFlag,
  useAuthStore: () => ({
    user: null,
    token: null,
    isAuthenticated: false,
    login: () => {},
    logout: () => {},
    setUser: () => {},
  }),
}));

vi.mock('@/api/quote-provider.api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    listQuoteProviders: vi.fn(),
    createQuoteProvider: vi.fn(),
    updateQuoteProvider: vi.fn(),
    deleteQuoteProvider: vi.fn(),
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import AdminPage from '@/pages/admin';
import { Sidebar } from '@/components/layout/sidebar';
import {
  listQuoteProviders,
  createQuoteProvider,
} from '@/api/quote-provider.api';

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/admin']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AdminPage — 多提供方管理 RBAC 与表单', () => {
  beforeEach(() => {
    adminFlag = false;
    vi.mocked(listQuoteProviders).mockResolvedValue(SAMPLE_LIST as never);
    vi.mocked(createQuoteProvider).mockResolvedValue({
      ...SAMPLE_LIST[0],
      id: 'new',
      name: '新建源',
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('① 非管理员：不渲染「新增数据来源」，展示「无权限访问」', () => {
    adminFlag = false;
    renderWithProviders(<AdminPage />);
    expect(screen.queryByText('新增数据来源')).toBeNull();
    expect(screen.getByText('无权限访问该页面')).toBeTruthy();
  });

  it('② 非管理员：侧边栏不展示「系统管理」入口', () => {
    adminFlag = false;
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(screen.queryByText('系统管理')).toBeNull();
  });

  it('③ 管理员：表格可见并列出提供方，且展示「新增数据来源」按钮', async () => {
    adminFlag = true;
    renderWithProviders(<AdminPage />);
    expect(await screen.findByText('新浪财经')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '新增数据来源' }),
    ).toBeTruthy();
  });

  it('④ 管理员：新增数据来源填写并提交调用 createQuoteProvider', async () => {
    adminFlag = true;
    renderWithProviders(<AdminPage />);
    // 等待列表加载完成
    await screen.findByText('新浪财经');

    const addBtn = screen.getByRole('button', { name: '新增数据来源' });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    // 对话框表单出现（input 的 Label 关联）
    const nameInput = (await screen.findByLabelText('名称')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: '新建源' } });
    });
    const urlInput = (await screen.findByLabelText(
      'API 基础地址',
    )) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(urlInput, { target: { value: 'https://x.com/api' } });
    });

    const saveBtn = screen.getByRole('button', { name: '保存' });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(
      () => {
        expect(vi.mocked(createQuoteProvider)).toHaveBeenCalledWith(
          expect.objectContaining({
            name: '新建源',
            access_method: 'https',
            config: { base_url: 'https://x.com/api' },
            enabled: true,
          }),
        );
      },
      { timeout: 5000 },
    );
  });
});
