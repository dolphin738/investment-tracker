/**
 * e2e/fixtures/mock-api.ts — Playwright API 路由拦截 fixture
 *
 * 拦截浏览器发出的全部 `/api/**` 请求并按「方法 + 路径」返回 fixture JSON，
 * 使 E2E 验收完全不依赖真实后端 / 数据库：
 * - 数据契约对齐 web-vue/src/api/types.ts（字段名/类型与生成 schema 一致）；
 * - 金额一律字符串（后端 NUMERIC 序列化约定），缺失字段 formatCurrency 返回 '-'
 *   不会崩溃，故 fixture 只保证「被页面消费的字段」完整。
 *
 * 新增端点时：在 ROUTE_HANDLERS 里追加一个 pattern 即可。
 */

import type { Page, Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// fixture 数据（§12 矩阵验收用）
// ---------------------------------------------------------------------------

export const MOCK_TOKEN = 'e2e-fake-jwt-token';

export const MOCK_USER = {
  id: 'u1',
  name: '验收用户',
  email: 'user@example.com',
  role: 'admin',
  avatar: null,
  phone: null,
  bio: null,
  createdAt: '2024-01-01T00:00:00Z',
};

export const MOCK_PORTFOLIOS = [
  {
    id: 'pf-1',
    userId: 'u1',
    name: '主组合',
    description: '验收数据',
    baseDate: '2024-01-01',
    currency: 'CNY',
    archivedAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2026-08-16T00:00:00Z',
  },
];

export const MOCK_SUMMARY = [
  {
    id: 'pf-1',
    name: '主组合',
    totalAsset: '128000.00',
    holdingsCount: 1,
    lastUpdatedAt: '2026-08-16',
    baseDate: '2024-01-01',
    currency: 'CNY',
    createdAt: '2024-01-01T00:00:00Z',
    cumulativeNav: '1.234567',
    yearReturnRate: '0.12345678',
    cumulativeReturnRate: '0.23456789',
    xirr: '0.12',
    netInvested: '100000.00',
    floatingProfit: '28000.00',
  },
];

export const MOCK_OVERVIEW = {
  totalAsset: '128000.00',
  cumulativeNav: '1.234567',
  yearNav: '1.123456',
  xirr: '0.12',
  netInvested: '100000.00',
  totalReturnRate: '0.23456789',
  yearReturnRate: '0.12345678',
  latestDate: '2026-08-16',
};

export const MOCK_HOLDINGS = {
  items: [
    {
      securityId: 'sec-1',
      securityCode: '600519',
      securityName: '贵州茅台',
      securityType: 'STOCK',
      quantity: 100,
      avgCost: 1500,
      costTotal: 150000,
      marketPrice: 1680,
      priceAsOf: '2026-08-16',
      marketValue: 168000,
      pnl: 18000,
      pnlRate: 0.12,
      flag: 'EXACT',
    },
  ],
  aggregate: {
    totalMarketValue: 168000,
    totalCost: 150000,
    totalProfit: 18000,
    totalProfitRate: 0.12,
    securityCount: 1,
  },
};

export const MOCK_SECURITIES = {
  items: [
    {
      id: 'sec-1',
      portfolioId: 'pf-1',
      code: '600519',
      name: '贵州茅台',
      type: 'STOCK',
      note: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
};

/** 买卖流水：买入 100×1500.5=150050 / 卖出 50×1600=80000 / 费用 6+4.8=10.8 */
export const MOCK_TRADES = {
  items: [
    {
      id: 't-1',
      portfolioId: 'pf-1',
      securityId: 'sec-1',
      date: '2026-08-01',
      side: 'BUY_SEC',
      quantity: '100',
      costPrice: '1500.500000',
      commission: '5.00',
      stampTax: '0.00',
      other: '1.00',
      feeTotal: '6.00',
      note: '首笔买入',
      createdAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-01T10:00:00Z',
    },
    {
      id: 't-2',
      portfolioId: 'pf-1',
      securityId: 'sec-1',
      date: '2026-08-10',
      side: 'SELL_SEC',
      quantity: '50',
      costPrice: '1600.000000',
      commission: '4.00',
      stampTax: '0.80',
      other: '0.00',
      feeTotal: '4.80',
      note: null,
      createdAt: '2026-08-10T10:00:00Z',
      updatedAt: '2026-08-10T10:00:00Z',
    },
  ],
  total: 2,
  page: 1,
  pageSize: 20,
};

export const MOCK_TRANSACTIONS = {
  items: [
    {
      id: 'c-1',
      portfolioId: 'pf-1',
      date: '2026-08-15',
      type: 'BUY',
      amount: '50000.00',
      note: null,
      createdAt: '2026-08-15T10:00:00Z',
      updatedAt: '2026-08-15T10:00:00Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

/** 用户偏好（defaultPortfolioId 指向 pf-1，驱动组合选择器自动选中） */
export const MOCK_PREFERENCES = {
  id: 'pref-1',
  userId: 'u1',
  defaultPortfolioId: 'pf-1',
  defaultGranularity: 'month',
  defaultDateRange: '1y',
  aggregation: 'end',
  weekStartsOn: 1,
  navDecimals: 6,
  xirrDecimals: 2,
  theme: 'system',
  staleDays: 7,
  showClosedHoldings: false,
};

export const MOCK_PROVIDERS = [
  {
    id: 'pvd-1',
    name: '腾讯财经',
    description: '验收提供方',
    access_method: 'https',
    enabled: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
];

export const MOCK_INTERFACES = [
  {
    id: 'itf-1',
    providerId: 'pvd-1',
    name: '腾讯行情',
    categoryId: '2',
    enabled: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
];

export const MOCK_CATEGORIES = [
  { id: '1', label: '证券列表', icon: 'ListChecks', sort: 1, system: true },
  { id: '2', label: '证券行情', icon: 'LineChart', sort: 2, system: true },
  { id: '3', label: '自定义分类', icon: 'Tag', sort: 3, system: false },
];

// ---------------------------------------------------------------------------
// 路由处理
// ---------------------------------------------------------------------------

type Handler = (route: Route, path: string) => Promise<void> | void;

const json = (route: Route, data: unknown, status = 200): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(data),
  });

const ROUTE_HANDLERS: Array<[RegExp, Handler]> = [
  // ---- 认证 ----
  [/^\/api\/auth\/login$/, (r) => json(r, { accessToken: MOCK_TOKEN, user: MOCK_USER })],
  [/^\/api\/auth\/register$/, (r) => json(r, MOCK_USER)],
  // ---- 组合 ----
  [/^\/api\/portfolios\/summary$/, (r) => json(r, MOCK_SUMMARY)],
  [/^\/api\/portfolios$/, (r) => json(r, MOCK_PORTFOLIOS)],
  [/^\/api\/users\/preferences$/, (r) => json(r, MOCK_PREFERENCES)],
  [/^\/api\/portfolios\/[^/]+\/overview$/, (r) => json(r, MOCK_OVERVIEW)],
  [/^\/api\/portfolios\/[^/]+\/holdings/, (r) => json(r, MOCK_HOLDINGS)],
  [/^\/api\/portfolios\/[^/]+\/security-trades/, (r) => json(r, MOCK_TRADES)],
  [/^\/api\/portfolios\/[^/]+\/securities/, (r) => json(r, MOCK_SECURITIES)],
  [/^\/api\/portfolios\/[^/]+\/transactions/, (r) => json(r, MOCK_TRANSACTIONS)],
  // ---- 管理端（仅管理员可见） ----
  [/^\/api\/admin\/quote-providers$/, (r) => json(r, MOCK_PROVIDERS)],
  [/^\/api\/admin\/quote-providers\/interfaces$/, (r) => json(r, MOCK_INTERFACES)],
  [/^\/api\/admin\/interface-categories$/, (r) => json(r, MOCK_CATEGORIES)],
];

/**
 * 在页面上安装 API 拦截；未匹配的请求返回 404 信封（便于发现漏 mock）。
 *
 * 注意：不要用 page.route 的 glob 通配「双星号 + api + 双星号」写法拦 API——
 * glob 的「双星号」可跨斜杠，会把源码目录 src/api 下的模块请求也拦截掉，
 * 返回 404 直接炸掉 vite 模块图（动态 import 失败 → 应用空白）。
 * 必须按 pathname 前缀精确匹配 /api/。
 */
export function installMockApi(page: Page): void {
  page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      for (const [pattern, handler] of ROUTE_HANDLERS) {
        if (pattern.test(path)) {
          await handler(route, path);
          return;
        }
      }
      // 兜底：POST 等写操作也返回 200 空信封，避免页面卡在 pending
      if (req.method() !== 'GET') {
        await json(route, { ok: true });
        return;
      }
      await json(route, { message: `e2e mock fallback: ${req.method()} ${path}` }, 404);
    },
  );
}

/**
 * 预置登录态：token + user 写入 localStorage，并预置当前组合 id
 * （与偏好 defaultPortfolioId 一致，双重保险，绕开偏好流时序）。
 */
export function seedAuth(page: Page): void {
  page.addInitScript(
    ([token, user]) => {
      localStorage.setItem('investment_tracker_token', token);
      localStorage.setItem('investment_tracker_user', JSON.stringify(user));
      localStorage.setItem('investment_tracker_current_portfolio', 'pf-1');
    },
    [MOCK_TOKEN, MOCK_USER] as const,
  );
}
