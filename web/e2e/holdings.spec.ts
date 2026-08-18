/**
 * e2e/holdings.spec.ts — 持仓页冒烟（§12 矩阵 · holdings/security-trade 域）
 *
 * 覆盖：
 * 1. 持仓列表渲染（贵州茅台 + 汇总）
 * 2. 「买卖明细」Tab → SecurityTradeList（Task #20 补齐的组件）：
 *    三统计块口径（买入金额含费 150050 / 卖出金额含费 80000 / 累计费用 10.8）
 *    + 流水行（日期/方向徽标/标的映射/备注/成交额）
 */

import { test, expect } from '@playwright/test';
import { installMockApi, seedAuth } from './fixtures/mock-api';

test.describe('持仓页', () => {
  test.beforeEach(async ({ page }) => {
    installMockApi(page);
    seedAuth(page);
  });

  test('持仓列表渲染标的与汇总', async ({ page }) => {
    await page.goto('/holdings');
    await expect(page.getByText('贵州茅台').first()).toBeVisible();
    // 持仓市值汇总（aggregate.totalMarketValue = 168000）
    await expect(page.getByText('¥168,000.00').first()).toBeVisible();
  });

  test('买卖明细 Tab：三统计块 + 流水行（Task #20 验收）', async ({ page }) => {
    await page.goto('/holdings');
    // 切到「买卖明细」页签
    await page.getByRole('tab', { name: '买卖明细' }).click();

    // 三统计块标题
    await expect(page.getByText('买入金额（含费）')).toBeVisible();
    await expect(page.getByText('卖出金额（含费）')).toBeVisible();
    await expect(page.getByText('累计费用合计')).toBeVisible();

    // 口径：买入 100×1500.5=150050 / 卖出 50×1600=80000 / 费用 6+4.8=10.8
    // （成交额列会复现同样的金额，用 first() 取统计块，避免 strict mode 冲突）
    await expect(page.getByText('¥150,050.00').first()).toBeVisible();
    await expect(page.getByText('¥80,000.00').first()).toBeVisible();
    await expect(page.getByText('¥10.80').first()).toBeVisible();

    // 流水行：标的字典映射（sec-1 → 贵州茅台 600519）+ 方向徽标 + 备注
    await expect(page.getByText('贵州茅台').first()).toBeVisible();
    await expect(page.getByText('600519').first()).toBeVisible();
    await expect(page.getByText('买入').first()).toBeVisible();
    await expect(page.getByText('卖出').first()).toBeVisible();
    await expect(page.getByText('首笔买入')).toBeVisible();
  });
});
