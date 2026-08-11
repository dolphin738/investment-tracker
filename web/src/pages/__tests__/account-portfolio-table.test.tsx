/**
 * pages/AccountPage.tsx — 「我的组合」统一表格验收（组合管理平面收敛）
 *
 * 背景：组合管理（设为默认 / 编辑 / 归档 / 删除）原本住在设置页，账户页「我的组合」
 * 只有一张 7 列的只读业绩表，两处并存导致口径漂移。本次收敛后：
 * - 设置页「组合管理」整块删除（见 settings.test.tsx 的「不再存在」断言）
 * - 账户页「我的组合」升级为统一表格 = 业绩列（/portfolios/summary）
 *   + 管理列（/portfolios 的 description / archivedAt），前端按 id 合并
 *
 * 本文件锁死四条不能回退的行为：
 * 1. 管理操作列存在：设为默认 / 编辑 / 归档 / 删除 四个 icon 按钮（按 aria-label 定位）
 * 2. 已归档组合：行内显示「已归档」标记，且「设为默认」按钮 disabled
 *    （后端不允许归档组合作为默认组合，UI 必须先拦住）
 * 3. SYS-P0-05 四态：净值 / 当年% / 更新日为 null 时渲染「—」，**绝不能渲染成 0**
 * 4. 删除是破坏性操作：点击后必须弹二次确认，不得直接删
 *
 * 策略：与同目录 dashboard-*.test.tsx 一致 —— vi.mock 掉 API 模块与数据 hooks，
 * 保留真实 QueryClientProvider + MemoryRouter 与真实的表格/按钮/弹窗组件，
 * 这样断言打在真实 DOM 上而不是 mock 的影子上。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccountStats, PortfolioSummary, UserPreference } from '@/api/types';

// ---------------------------------------------------------------------------
// 夹具（vi.hoisted：vi.mock 工厂被提升到 import 之前执行，
// 普通 const 那时仍在 TDZ，必须用 hoisted 才能被工厂安全引用）
// ---------------------------------------------------------------------------
const fixtures = vi.hoisted(() => {
  const user = {
    id: 'user-1',
    email: 'alice@example.com',
    name: '爱丽丝',
    avatar: null,
    phone: '13800001234',
    bio: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  /** 正常组合：有净值 / 当年% / 更新日，且不是默认组合 */
  const activeSummary = {
    id: 'pf-1',
    name: '主力组合',
    totalAsset: '123456.78',
    holdingsCount: 3,
    lastUpdatedAt: '2026-08-10',
    baseDate: '2024-01-05',
    currency: 'CNY',
    createdAt: '2024-01-01T00:00:00.000Z',
    cumulativeNav: '1.234500',
    yearReturnRate: '0.05230000',
    netInvested: '100000.00',
    floatingProfit: '23456.78',
  };

  /** 已归档组合：业绩三态全 null（SYS-P0-05 四态验证载体） */
  const archivedSummary = {
    id: 'pf-2',
    name: '已归档组合',
    totalAsset: '0',
    holdingsCount: 0,
    lastUpdatedAt: null,
    baseDate: null,
    currency: 'CNY',
    createdAt: '2023-06-01T00:00:00.000Z',
    cumulativeNav: null,
    yearReturnRate: null,
    netInvested: '0.00',
    floatingProfit: null,
  };

  const portfolios = [
    {
      id: 'pf-1',
      userId: 'user-1',
      name: '主力组合',
      description: '长线核心仓位',
      baseDate: '2024-01-05',
      currency: 'CNY',
      archivedAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
    {
      id: 'pf-2',
      userId: 'user-1',
      name: '已归档组合',
      description: null,
      baseDate: null,
      currency: 'CNY',
      archivedAt: '2025-12-31T00:00:00.000Z',
      createdAt: '2023-06-01T00:00:00.000Z',
      updatedAt: '2025-12-31T00:00:00.000Z',
    },
  ];

  const preferences = {
    id: 'pref-1',
    userId: 'user-1',
    // 两行都不是默认组合 → 星标 aria-label 统一为「设为默认」，断言不受 toggle 文案干扰
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
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const stats = {
    portfolioCount: 2,
    cashflowCount: 12,
    tradeCount: 34,
    snapshotDays: 56,
    recordDays: 78,
    firstDate: '2024-01-05',
    lastDate: '2026-08-10',
  };

  return { user, activeSummary, archivedSummary, portfolios, preferences, stats };
});

/** mutation 桩：断言「点了哪个按钮」时用得上 */
const mutations = vi.hoisted(() => ({
  deleteMutate: vi.fn(),
  archiveMutate: vi.fn(),
  setDefaultMutate: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/account.api', () => ({
  getAccountStats: (): Promise<AccountStats> =>
    Promise.resolve(fixtures.stats as AccountStats),
}));

vi.mock('@/api/overview.api', () => ({
  getPortfoliosSummary: (): Promise<PortfolioSummary[]> =>
    Promise.resolve([
      fixtures.activeSummary,
      fixtures.archivedSummary,
    ] as PortfolioSummary[]),
}));

vi.mock('@/hooks/use-auth', () => ({
  useProfile: () => ({
    data: fixtures.user,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-preferences', () => ({
  PREFERENCE_KEY: ['users', 'preferences'],
  usePreferences: () => ({ data: fixtures.preferences, isLoading: false }),
  useUpdatePreferences: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
}));

// PortfolioDialog（即使 open=false，组件函数体也会执行）同样依赖本模块，
// create/update 两个 mutation 必须一并提供桩，否则渲染即崩。
vi.mock('@/hooks/use-portfolios', () => ({
  PORTFOLIOS_KEY: ['portfolios'],
  usePortfolios: () => ({ data: fixtures.portfolios, isLoading: false }),
  useCreatePortfolio: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdatePortfolio: () => ({ mutate: vi.fn(), isPending: false }),
  useDeletePortfolio: () => ({
    mutate: mutations.deleteMutate,
    isPending: false,
  }),
  useArchivePortfolio: () => ({
    mutate: mutations.archiveMutate,
    isPending: false,
  }),
  useSetDefaultPortfolio: () => ({
    mutate: mutations.setDefaultMutate,
    isPending: false,
  }),
}));

// 必须在 vi.mock 之后再导入被测页面
import AccountPage from '@/pages/AccountPage';
import { usePreferenceStore } from '@/stores/preference.store';
import { usePortfolioStore } from '@/stores/portfolio.store';

/** 无数据统一占位符（与 AccountPage 内 NO_DATA 保持一致，em dash） */
const NO_DATA = '—';

/** jsdom 缺失的浏览器 API 兜底（Radix Dialog / AlertDialog 需要） */
function installJsdomPolyfills(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
      return false;
    };
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function setPointerCapture(): void {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture =
      function releasePointerCapture(): void {};
  }
}

/** 用 MemoryRouter + QueryClientProvider 包裹渲染账户页 */
function renderAccountPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/account']}>
        <AccountPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 定位「我的组合」表格里某个组合名对应的那一行 <tr> */
async function findPortfolioRow(name: string): Promise<HTMLElement> {
  const nameNode = await screen.findByText(name);
  const row = nameNode.closest('tr');
  if (!row) {
    throw new Error(`未找到组合「${name}」所在的表格行`);
  }
  return row as HTMLElement;
}

describe('AccountPage — 「我的组合」统一表格（唯一组合管理平面）', () => {
  beforeEach(() => {
    installJsdomPolyfills();
    // 偏好 store 用真实实现：净值 / XIRR 小数位走系统默认值即可
    usePreferenceStore.setState({
      preferences: fixtures.preferences as UserPreference,
      loaded: true,
    });
    usePortfolioStore.setState({ currentPortfolioId: 'pf-1' });
  });

  afterEach(() => {
    cleanup();
    usePreferenceStore.setState({ preferences: null, loaded: false });
    usePortfolioStore.setState({ currentPortfolioId: null });
    vi.clearAllMocks();
  });

  it('统一表格渲染出业绩列 + 管理操作列（设为默认 / 编辑 / 归档 / 删除）', async () => {
    renderAccountPage();

    // 表头：业绩列与管理列同表（「描述」「操作」是本次从设置页搬来的两列）
    const headerTexts = (await screen.findAllByRole('columnheader')).map(
      (th) => th.textContent,
    );
    expect(headerTexts).toEqual([
      '组合名称',
      '描述',
      '成立日',
      '币种',
      '最新总资产',
      '净值',
      '当年%',
      '更新日',
      '操作',
    ]);

    // 描述列取自 usePortfolios()（summary 里没有这个字段，靠 id 合并补上）
    expect(screen.getByText('长线核心仓位')).toBeDefined();

    // 未归档行的四个管理按钮齐全
    const activeRow = await findPortfolioRow('主力组合');
    const scope = within(activeRow);
    expect(scope.getByRole('button', { name: '设为默认' })).toBeDefined();
    expect(scope.getByRole('button', { name: '编辑' })).toBeDefined();
    expect(scope.getByRole('button', { name: '归档' })).toBeDefined();
    expect(scope.getByRole('button', { name: '删除' })).toBeDefined();
  });

  it('已归档组合显示「已归档」标记，且「设为默认」按钮 disabled', async () => {
    renderAccountPage();

    const archivedRow = await findPortfolioRow('已归档组合');
    const scope = within(archivedRow);

    // 归档标记（口径与原设置页一致：archivedAt 非空时在组合名后跟一段小字）
    expect(scope.getByText('已归档')).toBeDefined();

    // 归档组合不能设为默认：按钮禁用 + title 说明原因
    const starButton = scope.getByRole('button', { name: '设为默认' });
    expect((starButton as HTMLButtonElement).disabled).toBe(true);
    expect(starButton.getAttribute('title')).toBe('已归档组合不能设为默认');

    // 归档按钮在已归档行上是「取消归档」（toggle 语义）
    expect(scope.getByRole('button', { name: '取消归档' })).toBeDefined();

    // 点了也不该触发 mutation
    fireEvent.click(starButton);
    expect(mutations.setDefaultMutate).not.toHaveBeenCalled();
  });

  it('性能列 null 渲染为「—」而非 0（SYS-P0-05 四态）', async () => {
    renderAccountPage();

    const archivedRow = await findPortfolioRow('已归档组合');
    const scope = within(archivedRow);

    // 净值 / 当年% / 更新日 三列均为 null → 三个「—」
    expect(scope.getAllByText(NO_DATA)).toHaveLength(3);

    // 反向护栏：这三格绝不能出现 '0' / '0.0000' / '0.00%' 这类伪造零值
    const cellTexts = Array.from(archivedRow.querySelectorAll('td')).map(
      (td) => td.textContent ?? '',
    );
    expect(cellTexts).not.toContain('0.0000');
    expect(cellTexts).not.toContain('0.00%');

    // 对照组：有数据的行按偏好小数位正常格式化，不受影响
    const activeRow = await findPortfolioRow('主力组合');
    const activeTexts = Array.from(activeRow.querySelectorAll('td')).map(
      (td) => td.textContent ?? '',
    );
    expect(activeTexts).toContain('1.2345');
    expect(activeTexts).toContain('5.23%');
  });

  it('点击删除弹出二次确认，确认前不会调用删除 mutation', async () => {
    renderAccountPage();

    const activeRow = await findPortfolioRow('主力组合');
    fireEvent.click(within(activeRow).getByRole('button', { name: '删除' }));

    // 二次确认弹窗出现
    expect(await screen.findByText('确认删除该组合？')).toBeDefined();
    expect(
      screen.getByText(
        '删除组合将级联删除其下所有交易、快照、净值与 XIRR 数据，此操作不可撤销。',
      ),
    ).toBeDefined();

    // 只点「删除」图标不应真的删
    expect(mutations.deleteMutate).not.toHaveBeenCalled();

    // 点「确认删除」才落到 mutation
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(mutations.deleteMutate).toHaveBeenCalledTimes(1);
    expect(mutations.deleteMutate.mock.calls[0][0]).toBe('pf-1');
  });
});
