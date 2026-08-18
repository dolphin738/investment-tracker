/**
 * modules/account/__tests__/account-page.test.ts — 账户页验收（对齐 React account-portfolio-table.test.tsx）
 *
 * 锁死对齐 React 版 web/src/pages/AccountPage.tsx 的行为契约：
 * 1. 四卡结构：个人信息（只读 + 跳转设置）/ 资产全景 / 数据统计 / 我的组合
 * 2. 我的组合统一表格：9 列表头 + 管理操作列（设为默认 / 编辑 / 归档 / 删除）
 * 3. 已归档组合：显示「已归档」标记，「设为默认」disabled（后端不允许归档组合为默认）
 * 4. SYS-P0-05 四态：净值 / 当年% / 更新日为 null 渲染「—」，绝不渲染成 0
 * 5. 删除是破坏性操作：点击后必须弹二次确认，确认后才落到删除 mutation
 * 6. 资产全景：组合数 / 合计总资产 / 合计净投入 / 合计浮动盈亏
 * 7. 数据统计：出入金笔数 / 证券买卖笔数 / 总资产记录天数 / 账户使用天数
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import AccountPage from '../pages/AccountPage.vue';
import type { AccountStats, PortfolioSummary, UserPreference } from '@/api/types';
import type { Portfolio } from '@/lib/types';

// ---------------------------------------------------------------------------
// 夹具（vi.hoisted：vi.mock 工厂在 import 之前执行，必须用 hoisted 防 TDZ）
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
  const activeSummary: PortfolioSummary = {
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
  const archivedSummary: PortfolioSummary = {
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

  const portfolios: Portfolio[] = [
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

  const preferences: UserPreference = {
    id: 'pref-1',
    userId: 'user-1',
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

  const stats: AccountStats = {
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
const apiMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getAccountStats: vi.fn(),
  getPortfoliosSummary: vi.fn(),
  listPortfolios: vi.fn(),
  createPortfolio: vi.fn(),
  updatePortfolio: vi.fn(),
  archivePortfolio: vi.fn(),
  deletePortfolio: vi.fn(),
  setDefaultPortfolio: vi.fn(),
  clearPortfolioData: vi.fn(),
  getPreferences: vi.fn(),
}));

vi.mock('@/api/auth.api', () => ({
  getProfile: apiMocks.getProfile,
  login: vi.fn(),
  register: vi.fn(),
  updatePassword: vi.fn(),
  updateEmail: vi.fn(),
  updateProfile: vi.fn(),
  deleteAccount: vi.fn(),
  restoreAccount: vi.fn(),
}));

vi.mock('@/api/account.api', () => ({
  getAccountStats: apiMocks.getAccountStats,
}));

vi.mock('@/api/overview.api', () => ({
  getPortfoliosSummary: apiMocks.getPortfoliosSummary,
  getOverview: vi.fn(),
}));

vi.mock('@/api/portfolio.api', () => ({
  ...apiMocks,
  listPortfolios: apiMocks.listPortfolios,
}));

vi.mock('@/api/preference.api', () => ({
  getPreferences: apiMocks.getPreferences,
  updatePreferences: vi.fn(),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// 挂载脚手架
// ---------------------------------------------------------------------------

let wrapper: VueWrapper | null = null;

/** 无数据统一占位符（与组件内 NO_DATA 一致） */
const NO_DATA = '—';

async function settle(): Promise<void> {
  await flushPromises();
  await flushPromises();
}

function mountAccountPage(): VueWrapper {
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/settings', component: { template: '<div />' } },
      { path: '/account', component: { template: '<div />' } },
    ],
  });
  return mount(AccountPage, {
    attachTo: document.body,
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], pinia, router],
    },
  });
}

/** 定位「我的组合」表格里某个组合名对应的那一行（wrapper 内） */
function findPortfolioRow(name: string): ReturnType<VueWrapper['findAll']>[number] {
  const row = wrapper!.findAll('tr').find((r) => r.text().includes(name));
  if (!row) {
    throw new Error(`未找到组合「${name}」所在的表格行`);
  }
  return row;
}

beforeEach(() => {
  localStorage.clear();
  // seed 登录态：auth store 初始化从 localStorage 恢复；useProfile 也会因 token 存在而启用
  localStorage.setItem('investment_tracker_token', 'e2e-token');
  localStorage.setItem('investment_tracker_user', JSON.stringify(fixtures.user));
  vi.clearAllMocks();
  apiMocks.getProfile.mockResolvedValue(fixtures.user);
  apiMocks.getAccountStats.mockResolvedValue(fixtures.stats);
  apiMocks.getPortfoliosSummary.mockResolvedValue([
    fixtures.activeSummary,
    fixtures.archivedSummary,
  ]);
  apiMocks.listPortfolios.mockResolvedValue(fixtures.portfolios);
  apiMocks.getPreferences.mockResolvedValue(fixtures.preferences);
  apiMocks.archivePortfolio.mockResolvedValue({ ok: true });
  apiMocks.deletePortfolio.mockResolvedValue({ ok: true });
  apiMocks.setDefaultPortfolio.mockResolvedValue({
    ...fixtures.preferences,
    defaultPortfolioId: null,
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('AccountPage — 账户中心（对齐 React 4 卡契约）', () => {
  it('个人信息卡只读：无编辑入口，仅「前往设置修改 →」跳转', async () => {
    wrapper = mountAccountPage();
    await settle();

    expect(wrapper.text()).toContain('个人信息');
    expect(wrapper.text()).toContain('爱丽丝');
    expect(wrapper.text()).toContain('alice@example.com');
    expect(wrapper.text()).toContain('前往设置修改 →');
    // 卡内不得出现编辑 / 改邮箱 / 改密码入口（契约：修改在设置页）
    expect(wrapper.text()).not.toContain('编辑资料');
    expect(wrapper.text()).not.toContain('修改邮箱');
    expect(wrapper.text()).not.toContain('修改密码');
  });

  it('资产全景卡渲染四格合计（组合数 / 总资产 / 净投入 / 浮动盈亏）', async () => {
    wrapper = mountAccountPage();
    await settle();

    const overview = wrapper.find('.xl\\:col-span-5');
    // 组合数 2；总资产 123456.78+0 = 123456.78；净投入 100000.00；浮动盈亏 23456.78
    expect(overview.text()).toContain('资产全景');
    expect(overview.text()).toContain('组合数');
    expect(overview.text()).toContain('2');
    expect(overview.text()).toContain('¥123,456.78');
    expect(overview.text()).toContain('¥100,000.00');
    expect(overview.text()).toContain('¥23,456.78');
    // 提示：归档组合无总资产记录（totalAsset=0 且无更新日）→ 未计入合计
    expect(overview.text()).toContain('1 个组合暂无总资产记录，未计入合计');
  });

  it('数据统计卡渲染六格（出入金 / 买卖笔数 / 记录天数 / 使用天数 / 起止日期）', async () => {
    wrapper = mountAccountPage();
    await settle();

    const statsCard = wrapper.find('.xl\\:col-span-4');
    expect(statsCard.text()).toContain('数据统计');
    expect(statsCard.text()).toContain('出入金笔数');
    expect(statsCard.text()).toContain('12');
    expect(statsCard.text()).toContain('证券买卖笔数');
    expect(statsCard.text()).toContain('34');
    expect(statsCard.text()).toContain('总资产记录天数');
    expect(statsCard.text()).toContain('56');
    expect(statsCard.text()).toContain('账户使用天数');
    expect(statsCard.text()).toContain('78');
    expect(statsCard.text()).toContain('起始日期');
    expect(statsCard.text()).toContain('最近日期');
  });
});

describe('AccountPage — 「我的组合」统一表格（唯一组合管理平面）', () => {
  it('统一表格渲染出业绩列 + 管理操作列（设为默认 / 编辑 / 归档 / 删除）', async () => {
    wrapper = mountAccountPage();
    await settle();

    // 表头 9 列：业绩列与管理列同表
    const headers = wrapper!.findAll('th').map((th) => th.text());
    expect(headers).toEqual([
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

    // 描述列取自组合元信息（summary 里没有，靠 id 合并补上）
    expect(wrapper.text()).toContain('长线核心仓位');

    // 未归档行的四个管理按钮齐全（icon 按钮文本为空，按 aria-label 定位）
    const activeRowEl = wrapper!.findAll('tr').find((r) => r.text().includes('主力组合'))!;
    expect(activeRowEl.find('[aria-label="设为默认"]').exists()).toBe(true);
    expect(activeRowEl.find('[aria-label="编辑"]').exists()).toBe(true);
    expect(activeRowEl.find('[aria-label="归档"]').exists()).toBe(true);
    expect(activeRowEl.find('[aria-label="删除"]').exists()).toBe(true);
  });

  it('已归档组合显示「已归档」标记，且「设为默认」按钮 disabled', async () => {
    wrapper = mountAccountPage();
    await settle();

    const row = await findPortfolioRow('已归档组合');

    // 归档标记
    expect(row.text()).toContain('已归档');

    // 归档组合不能设为默认：按钮禁用 + title 说明原因
    const starButton = row.find('[aria-label="设为默认"]');
    expect(starButton.exists()).toBe(true);
    expect((starButton.element as HTMLButtonElement).disabled).toBe(true);
    expect(starButton.attributes('title')).toBe('已归档组合不能设为默认');

    // 归档按钮在已归档行上是「取消归档」（toggle 语义）
    expect(row.find('[aria-label="取消归档"]').exists()).toBe(true);

    // 点了也不该触发 mutation
    await starButton.trigger('click');
    expect(apiMocks.setDefaultPortfolio).not.toHaveBeenCalled();
  });

  it('性能列 null 渲染为「—」而非 0（SYS-P0-05 四态）', async () => {
    wrapper = mountAccountPage();
    await settle();

    const archivedRow = wrapper!
      .findAll('tr')
      .find((r) => r.text().includes('已归档组合'))!;
    // 净值 / 当年% / 更新日 三列均为 null → 三个「—」
    const emCount = (archivedRow.text().match(new RegExp(NO_DATA, 'g')) ?? []).length;
    expect(emCount).toBe(3);

    // 反向护栏：该行绝不能出现伪造零值
    const cellTexts = archivedRow.findAll('td').map((td) => td.text());
    expect(cellTexts).not.toContain('0.0000');
    expect(cellTexts).not.toContain('0.00%');

    // 对照组：有数据的行按偏好小数位正常格式化
    const activeRow = wrapper!
      .findAll('tr')
      .find((r) => r.text().includes('主力组合'))!;
    expect(activeRow.text()).toContain('1.2345');
    expect(activeRow.text()).toContain('5.23%');
  });

  it('点击删除弹出二次确认，确认前不会调用删除 mutation', async () => {
    wrapper = mountAccountPage();
    await settle();

    const activeRow = wrapper!
      .findAll('tr')
      .find((r) => r.text().includes('主力组合'))!;
    await activeRow.find('[aria-label="删除"]').trigger('click');

    // 二次确认弹窗出现（Portal 传送到 body）
    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('确认删除该组合？');
    expect(bodyText).toContain(
      '删除组合将级联删除其下所有交易、快照、净值与 XIRR 数据，此操作不可撤销。',
    );

    // 只点「删除」图标不应真的删
    expect(apiMocks.deletePortfolio).not.toHaveBeenCalled();

    // 点「确认删除」才落到 mutation（AlertDialogAction 经 reka-ui Portal 渲染）
    const confirmBtn = Array.from(
      document.querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('确认删除'));
    expect(confirmBtn).toBeDefined();
    confirmBtn!.click();
    await settle();

    expect(apiMocks.deletePortfolio).toHaveBeenCalledTimes(1);
    expect(apiMocks.deletePortfolio.mock.calls[0][0]).toBe('pf-1');
  });
});
