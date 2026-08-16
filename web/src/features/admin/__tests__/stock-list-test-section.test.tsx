/**
 * features/admin/__tests__/stock-list-test-section.test.tsx — 主数据列表「每页序号列 + 批量/单行删除」验收
 *
 * 验收点：
 * 1. 序号列：本页数据天然 1..N（翻页后重置）；
 * 2. 选择态：表头「全选当前页」联动每行 checkbox，批量按钮 disabled 随选择变化；
 * 3. 删除 mutation 与缓存失效：批量删除 → confirm → 以正确 ids 调用 deleteSecurityMasters，
 *    且 queryClient.invalidateQueries 命中 ['security-masters','list'] 与 ['security-masters','stats']。
 *
 * Mock 策略：仅 mock 网络层（@/api/security-master.api）、auth.store、sonner；
 * 保留真实 useSecurityMasters / useDeleteSecurityMasters hook，保证「组件 ↔ hook ↔ 缓存失效」链路真实。
 * 隔离：singleFork 共享模块注册表，beforeEach 内 vi.resetModules() + 动态 import，确保本文件 mock 优先生效。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SecurityMaster } from '@/api/security-master.api';

// jsdom 下 Radix Dialog 可能引用 ResizeObserver / matchMedia，补 no-op 垫片
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  })) as unknown as typeof window.matchMedia;
}

// 控制 useIsAdmin 的返回值
let adminFlag = true;

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

const mockList = vi.fn();
const mockStats = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/api/security-master.api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    listSecurityMasters: mockList,
    getSecurityMasterStats: mockStats,
    deleteSecurityMasters: mockDelete,
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

// 被测组件与 spy 对象均经动态 import 取得（确保 resetModules 后重新求值）
let StockListPanel: (props: {
  onPickCode: (code: string) => void;
  onSync: () => void;
  syncPending: boolean;
}) => JSX.Element;
let queryClient: QueryClient;

const SAMPLE: SecurityMaster[] = [
  { id: 'id1', code: 'sh600000', name: '浦发银行', exchange: 'SH', assetClass: 'STOCK', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'id2', code: 'sz000001', name: '平安银行', exchange: 'SZ', assetClass: 'STOCK', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'id3', code: 'hk00700', name: '腾讯控股', exchange: 'HK', assetClass: 'HK_STOCK', updatedAt: '2026-01-01T00:00:00Z' },
];

function makeWrapper(ui: JSX.Element) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/admin']}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  vi.resetModules();
  adminFlag = true;
  mockList.mockResolvedValue({
    items: SAMPLE,
    total: SAMPLE.length,
    page: 1,
    pageSize: 20,
  });
  mockStats.mockResolvedValue({ counts: {} });
  mockDelete.mockResolvedValue({ deleted: 2, skipped: [] });
  const mod = await import('@/features/admin/stock-list-test-section');
  StockListPanel = mod.StockListPanel;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 读取 tbody 每行的 # 列（第 2 个 td，index 1）文本 */
function rowNumbers(): string[] {
  const rowEls = Array.from(document.querySelectorAll('tbody tr'));
  return rowEls.map((r) =>
    (r.querySelectorAll('td')[1]?.textContent ?? '').trim(),
  );
}

describe('StockListPanel — 序号列与批量删除', () => {
  it('① 序号列显示本页 1..N', async () => {
    render(
      makeWrapper(
        <StockListPanel onPickCode={() => {}} onSync={() => {}} syncPending={false} />,
      ),
    );
    await screen.findByText('浦发银行');
    expect(rowNumbers()).toEqual(['1', '2', '3']);
  });

  it('② 翻页后序号重置为 1..N', async () => {
    // 21 条 → 第 1 页 20 条、第 2 页 1 条
    mockList.mockImplementation((params: { page?: number }) =>
      params.page === 2
        ? Promise.resolve({ items: [SAMPLE[0]], total: 21, page: 2, pageSize: 20 })
        : Promise.resolve({ items: SAMPLE, total: 21, page: 1, pageSize: 20 }),
    );
    render(
      makeWrapper(
        <StockListPanel onPickCode={() => {}} onSync={() => {}} syncPending={false} />,
      ),
    );
    await screen.findByText('浦发银行');
    expect(rowNumbers()).toEqual(['1', '2', '3']);

    fireEvent.click(screen.getByText('下一页'));
    await waitFor(() => {
      expect(rowNumbers()).toEqual(['1']);
    });
  });

  it('③ 表头「全选当前页」联动每行 checkbox，批量按钮 disabled 随选择变化', async () => {
    render(
      makeWrapper(
        <StockListPanel onPickCode={() => {}} onSync={() => {}} syncPending={false} />,
      ),
    );
    await screen.findByText('浦发银行');

    const checks = screen.getAllByRole('checkbox');
    // checks[0] = 表头全选；checks[1..3] = 每行
    expect(checks).toHaveLength(4);
    expect((checks[1] as HTMLInputElement).checked).toBe(false);

    const batchBtn = screen.getByTestId('batch-delete') as HTMLButtonElement;
    expect(batchBtn.disabled).toBe(true);
    expect(batchBtn.textContent).toContain('删除(0)');

    // 全选
    fireEvent.click(checks[0]);
    expect((checks[1] as HTMLInputElement).checked).toBe(true);
    expect((checks[2] as HTMLInputElement).checked).toBe(true);
    expect((checks[3] as HTMLInputElement).checked).toBe(true);
    expect(batchBtn.disabled).toBe(false);
    expect(batchBtn.textContent).toContain('删除(3)');

    // 取消一行 → 表头不再全选
    fireEvent.click(checks[1]);
    expect((checks[1] as HTMLInputElement).checked).toBe(false);
    expect((checks[0] as HTMLInputElement).checked).toBe(false);
    expect(batchBtn.textContent).toContain('删除(2)');

    // 再次全选 → 全选
    fireEvent.click(checks[0]);
    expect((checks[0] as HTMLInputElement).checked).toBe(true);
    expect(batchBtn.textContent).toContain('删除(3)');
  });

  it('④ 批量删除触发 deleteSecurityMasters 并调用缓存失效', async () => {
    render(
      makeWrapper(
        <StockListPanel onPickCode={() => {}} onSync={() => {}} syncPending={false} />,
      ),
    );
    await screen.findByText('浦发银行');
    // 必须在 render 之后 spy：makeWrapper 内部会新建并覆盖模块级 queryClient，
    // 提前 spy 会挂到已被替换的旧实例上，导致命中 0 次。
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    // 全选当前页
    const checks = screen.getAllByRole('checkbox');
    fireEvent.click(checks[0]);

    const batchBtn = screen.getByTestId('batch-delete') as HTMLButtonElement;
    expect(batchBtn.disabled).toBe(false);

    // 打开确认弹窗并确认
    fireEvent.click(batchBtn);
    const confirmBtn = await screen.findByTestId('confirm-delete');
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // 以正确 ids 调用（API 入参为 SecurityMasterDeleteParams 对象：{ ids }）
    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(
        expect.objectContaining({ ids: ['id1', 'id2', 'id3'] }),
      );
    });
    // 提示
    const { toast } = await import('sonner');
    expect(toast.success).toHaveBeenCalledWith('已删除 2 条');
    // 缓存失效：列表与统计均失效
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['security-masters', 'list'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['security-masters', 'stats'],
    });
  });

  it('⑤ 全选全部（跨页）以 all=true 删除并应用当前筛选', async () => {
    // 多于 1 页：total=45，当前页 3 条 → 出现「全选全部 N 条（跨页）」入口
    mockList.mockResolvedValue({ items: SAMPLE, total: 45, page: 1, pageSize: 20 });
    render(
      makeWrapper(
        <StockListPanel onPickCode={() => {}} onSync={() => {}} syncPending={false} />,
      ),
    );
    await screen.findByText('浦发银行');

    const selectAllLink = await screen.findByTestId('select-all-pages');
    expect(selectAllLink.textContent).toContain('全选全部 45 条');

    fireEvent.click(selectAllLink);
    expect(await screen.findByTestId('clear-select-all')).toBeTruthy();
    const batchBtn = screen.getByTestId('batch-delete') as HTMLButtonElement;
    expect(batchBtn.textContent).toContain('删除(45)');

    fireEvent.click(batchBtn);
    const confirmBtn = await screen.findByTestId('confirm-delete');
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({ all: true }));
    });
    const call = mockDelete.mock.calls[0][0] as Record<string, unknown>;
    expect(call.all).toBe(true);
  });

  it('⑥ 表头「全选当前页」为合并模式：翻页累加、保留他页选择 + 跨页提示', async () => {
    const PAGE2: SecurityMaster[] = [
      { id: 'id4', code: 'sh601318', name: '中国平安', exchange: 'SH', assetClass: 'STOCK', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'id5', code: 'sz000002', name: '万科A', exchange: 'SZ', assetClass: 'STOCK', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'id6', code: 'hk09988', name: '阿里巴巴', exchange: 'HK', assetClass: 'HK_STOCK', updatedAt: '2026-01-01T00:00:00Z' },
    ];
    // total=40 → 共 2 页（pageSize=20），但每页只返回 3 条用于渲染
    mockList.mockImplementation((params: { page?: number }) =>
      params.page === 2
        ? Promise.resolve({ items: PAGE2, total: 40, page: 2, pageSize: 20 })
        : Promise.resolve({ items: SAMPLE, total: 40, page: 1, pageSize: 20 }),
    );
    render(
      makeWrapper(
        <StockListPanel onPickCode={() => {}} onSync={() => {}} syncPending={false} />,
      ),
    );
    await screen.findByText('浦发银行');

    // 第 1 页：仅勾选首行 id1
    const page1 = screen.getAllByRole('checkbox');
    fireEvent.click(page1[1]);
    expect((page1[1] as HTMLInputElement).checked).toBe(true);

    // 翻到第 2 页（选择态跨页保留，page 变化不重置）
    fireEvent.click(screen.getByText('下一页'));
    await waitFor(() => expect(screen.getByText('中国平安')).toBeTruthy());

    // 第 2 页：表头全选（合并模式，不应清除第 1 页的 id1）
    const page2 = screen.getAllByRole('checkbox');
    fireEvent.click(page2[0]);

    // 跨页提示：已选 4 条（跨 2 页）
    const summary = await screen.findByTestId('selection-summary');
    expect(summary.textContent).toContain('已选 4 条');
    expect(summary.textContent).toContain('跨 2 页');

    // 批量删除：ids 应包含 id1（第 1 页）与第 2 页全部
    fireEvent.click(screen.getByTestId('batch-delete'));
    const confirmBtn = await screen.findByTestId('confirm-delete');
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: expect.arrayContaining(['id1', 'id4', 'id5', 'id6']),
        }),
      );
    });
  });

  it('⑦ 表头 checkbox 部分选中时显示半选(indeterminate)', async () => {
    render(
      makeWrapper(
        <StockListPanel onPickCode={() => {}} onSync={() => {}} syncPending={false} />,
      ),
    );
    await screen.findByText('浦发银行');

    const checks = screen.getAllByRole('checkbox');
    // 仅勾选第 1 行 → 表头应为 indeterminate、checked=false
    fireEvent.click(checks[1]);
    const header = checks[0] as HTMLInputElement;
    expect(header.checked).toBe(false);
    expect(header.indeterminate).toBe(true);

    // 表头全选 → 全部选中，indeterminate 清除、checked=true
    fireEvent.click(checks[0]);
    expect(header.indeterminate).toBe(false);
    expect(header.checked).toBe(true);
  });

  it('⑧ 选中行高亮(bg-muted)', async () => {
    render(
      makeWrapper(
        <StockListPanel onPickCode={() => {}} onSync={() => {}} syncPending={false} />,
      ),
    );
    await screen.findByText('浦发银行');

    const checks = screen.getAllByRole('checkbox');
    fireEvent.click(checks[1]); // 选中首行

    const rows = Array.from(document.querySelectorAll('tbody tr'));
    // 选中行带专属高亮 token bg-muted/40（TableRow 基础样式另有 hover:bg-muted/50，故用专属 token 断言）
    expect(rows[0].className).toContain('bg-muted/40');
    // 未选中的第 2 行不应有高亮
    expect(rows[1].className).not.toContain('bg-muted/40');
  });
});
