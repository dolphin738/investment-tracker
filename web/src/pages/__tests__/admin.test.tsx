/**
 * pages/__tests__/admin.test.tsx — 系统管理页 RBAC 与表单行为验收
 *
 * 验收点：
 * 1. 非管理员：页面不渲染「证券行情 API 地址」配置卡，改为展示「无权限访问」；
 *    且侧边栏不展示「系统管理」入口（useIsAdmin === false → 过滤 admin 项）。
 * 2. 管理员：配置卡可见，表单回填已保存的 url；点击「保存」调用 admin 端点
 *    updateSystemConfig(key, { url })。
 *
 * Mock 策略（稳健模式）：
 * - @/stores/auth.store：useIsAdmin 由模块级 adminFlag 控制，useAuthStore 提供空实现；
 * - @/api/admin.api：importOriginal + 内部 vi.fn() 覆盖，断言走 vi.mocked(...)；
 * - sonner：toast 置空实现，避免副作用。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// 模块级开关：控制 useIsAdmin 的返回值（在测试间切换）
let adminFlag = false;

const QUOTE_KEY = 'securities_quote_api_base_url';
const SAMPLE_CONFIG = {
  key: QUOTE_KEY,
  value: { url: 'https://old.example.com/api' },
  description: null,
  updatedAt: null,
};

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

vi.mock('@/api/admin.api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    getSystemConfig: vi.fn(),
    updateSystemConfig: vi.fn(),
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import AdminPage from '@/pages/admin';
import { Sidebar } from '@/components/layout/sidebar';
import { getSystemConfig, updateSystemConfig } from '@/api/admin.api';

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

describe('AdminPage — RBAC 与表单', () => {
  beforeEach(() => {
    adminFlag = false;
    vi.mocked(getSystemConfig).mockResolvedValue(SAMPLE_CONFIG);
    vi.mocked(updateSystemConfig).mockResolvedValue(SAMPLE_CONFIG);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('① 非管理员：不渲染配置卡，展示「无权限访问」', () => {
    adminFlag = false;
    renderWithProviders(<AdminPage />);
    expect(screen.queryByText('证券行情 API 地址')).toBeNull();
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

  it('③ 管理员：配置卡可见，且表单回填已保存的 url', async () => {
    adminFlag = true;
    renderWithProviders(<AdminPage />);
    expect(await screen.findByText('证券行情 API 地址')).toBeTruthy();
    const input = (await screen.findByLabelText('API 基础地址')) as HTMLInputElement;
    expect(input.value).toBe('https://old.example.com/api');
  });

  it('④ 管理员：点击「保存」调用 admin 端点 updateSystemConfig(key, { url })', async () => {
    adminFlag = true;
    renderWithProviders(<AdminPage />);
    // 等待表单与数据就绪：input 出现即代表数据已加载、url 已通过 useEffect 回填（见 ③）。
    await screen.findByLabelText('API 基础地址');
    // 确保 React 完成所有 pending 更新（含 useEffect 回填与 mutation 绑定）。
    await act(async () => {
      await Promise.resolve();
    });

    const saveBtn = screen.getByRole('button', { name: '保存' });
    // 将 click 包在 act 中，确保 mutate 触发的状态更新与异步调度被 flush。
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // 全量测试在慢速环境下需更大超时；mutate 必然触发 mutationFn。
    await waitFor(
      () => {
        expect(vi.mocked(updateSystemConfig)).toHaveBeenCalledWith(QUOTE_KEY, {
          url: 'https://old.example.com/api',
        });
      },
      { timeout: 5000 },
    );
  });
});
